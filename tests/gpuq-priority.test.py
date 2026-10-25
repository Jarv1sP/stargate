"""Priority/yield contracts against real temporary SQLite state; no GPU or systemd."""
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import io
import json
import sqlite3
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'gpuq'))
from gpuq.backends import GpuDevice, UnitIdentityError
from gpuq.config import Config
from gpuq.constants import AttemptState, JobState, STORE_SCHEMA_VERSION
from gpuq.coordinator import Coordinator
from gpuq import cli, cluster_node, fleet, store as store_module
from gpuq.rpc import ApiError
from gpuq.policy import VictimCandidate, preemption_mode, select_victims, priority_class_contract
from gpuq.store import Store, StoreConflictError
from gpuq.submission import SUBMISSION_KEYS, validate_submission


class YieldPolicyTests(unittest.TestCase):
    def candidate(self, name='A1', **overrides):
        return VictimCandidate(**{
            'attempt_id': name, 'job_id': 'J' + name, 'priority': 0,
            'gpu_count': 1, 'checkpoint_capability': 'none',
            'yield_policy': 'now', 'restart_policy': 'never', 'preempt_idle_only': True, **overrides,
        })

    def select(self, candidates, **overrides):
        return select_victims(**{
            'requester_priority': 2, 'requester_gpu_count': 1,
            'free_gpu_count': 0, 'dispatch_mode': 'queue',
            'candidates': candidates, **overrides,
        })

    def test_queue_only_interrupts_explicit_yield_contract(self):
        for policy, mode in [('legacy', None), ('never', None), ('now', 'preempt-now')]:
            with self.subTest(policy=policy):
                self.assertEqual(preemption_mode('queue', self.candidate(yield_policy=policy)), mode)

    def test_never_is_protected_even_from_legacy_hard_preemption(self):
        self.assertIsNone(preemption_mode('preempt-now', self.candidate(yield_policy='never')))

    def test_checkpoint_only_contract_never_becomes_hard_preemption(self):
        candidate = self.candidate(yield_policy='save', checkpoint_capability='epoch-v1')
        for mode in ['queue', 'preempt-now', 'preempt-save']:
            self.assertEqual(preemption_mode(mode, candidate), 'preempt-save')

    def test_equal_or_higher_priority_is_never_a_victim(self):
        self.assertEqual(self.select([self.candidate(priority=2), self.candidate('A2', priority=4)]), ())
        self.assertEqual(self.select([self.candidate()], requester_priority=0), ())

    def test_waiting_for_more_than_eligible_capacity_does_not_kill_anything(self):
        self.assertEqual(self.select([self.candidate()], requester_gpu_count=2), ())

    def test_uses_idle_capacity_and_minimizes_victims(self):
        candidates = [self.candidate('A1'), self.candidate('A2'), self.candidate('A3')]
        self.assertEqual(self.select(candidates, requester_gpu_count=2, free_gpu_count=1), (candidates[0],))
        self.assertEqual(self.select(candidates, free_gpu_count=1), ())

    def test_prefers_exact_capacity_to_interrupting_large_gang(self):
        large = self.candidate('A1', gpu_count=4)
        small = self.candidate('A2')
        self.assertEqual(self.select([large, small]), (small,))

    def test_pinned_request_never_interrupts_unrelated_gpu(self):
        unrelated = self.candidate('A1', gpu_uuids=('GPU-0',))
        target = self.candidate('A2', gpu_uuids=('GPU-1',))
        self.assertEqual(self.select([unrelated, target], required_gpu_uuids=frozenset({'GPU-1'})), (target,))
        self.assertEqual(self.select([unrelated], required_gpu_uuids=frozenset({'GPU-1'})), ())

    def test_elastic_request_only_preempts_its_launch_floor(self):
        candidates = [self.candidate('A1'), self.candidate('A2'), self.candidate('A3')]
        self.assertEqual(self.select(candidates, requester_gpu_count=4, requester_min_gpu_count=1), (candidates[0],))

    def test_idle_only_request_excludes_every_non_idle_contract(self):
        idle = self.candidate('Aid')
        protected = [
            self.candidate('Ap2', priority=2),
            self.candidate('Asave', yield_policy='save', checkpoint_capability='epoch-v1'),
            self.candidate('Alegacy', yield_policy='legacy'),
            self.candidate('Aoldidle', preempt_idle_only=False),
        ]
        self.assertEqual(self.select([*protected, idle], requester_priority=4,
                                     dispatch_mode='preempt-now', preempt_idle_only=True), (idle,))
        self.assertEqual(self.select(protected, requester_priority=4, preempt_idle_only=True), ())

    def test_idle_only_request_can_preempt_a_requeueing_idle_volunteer(self):
        idle=self.candidate(restart_policy='on-preempt')
        self.assertEqual(self.select([idle],requester_priority=4,preempt_idle_only=True),(idle,))


class SchedulerPriorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = Config(
            root=self.root, db_path=self.root / 'state.db',
            log_dir=self.root / 'logs', control_dir=self.root / 'control',
            socket_path=Path(f'/run/user/{os.getuid()}/gpuq-test.sock'),
            managed_gpu_uuids=tuple(f'GPU-{i}' for i in range(4)),
            allowed_uid=os.getuid(), observe_only=False,
        )
        self.config.log_dir.mkdir()
        self.config.control_dir.mkdir()
        self.store = Store(self.config.db_path).initialize()
        self.addCleanup(self.store.close)
        self.systemd = Mock()
        self.coordinator = Coordinator(self.config, self.store, Mock(), self.systemd, boot_id='test-boot')
        self.snapshot()

    def snapshot(self, *, occupied=(), memory=None):
        memory = memory or {}
        self.coordinator._snapshot = tuple(
            GpuDevice(i, f'GPU-{i}', 24000, memory.get(i, 1000 if i in occupied else 0),
                      24000 - memory.get(i, 1000 if i in occupied else 0), 0,
                      (1000 + i,) if i in occupied else ())
            for i in range(4)
        )
        self.coordinator._idle_counts = {f'GPU-{i}': 2 for i in range(4)}

    def submit(self, **overrides):
        raw = {
            'submit_key': str(uuid.uuid4()), 'name': 'test', 'owner': 'test-user',
            'priority': 2, 'dispatch_mode': 'queue', 'yield_policy': 'never',
            'checkpoint_capability': 'none', 'restart_policy': 'never',
            'gpu_count': 1, 'placement': 'any', 'requested_gpu_uuids': [],
            'argv': [sys.executable, '-c', 'pass'], 'cwd': str(self.root), 'env': {},
            **overrides,
        }
        if raw.get('yield_policy') is None:
            del raw['yield_policy']
        return self.store.submit_job(validate_submission(raw, 4, managed_gpu_uuids=self.config.managed_gpu_uuids))

    def running(self, indices=(0,), **overrides):
        job = self.submit(gpu_count=len(indices), **overrides)
        attempt_id = 'A' + uuid.uuid4().hex
        control, log = self.coordinator._create_attempt_paths(job['id'], attempt_id)
        attempt = self.store.create_attempt(
            job['id'], attempt_id=attempt_id, state=AttemptState.RUNNING,
            gpu_uuids=[f'GPU-{i}' for i in indices], gpu_indices=list(indices),
            unit_name='gpuq-' + attempt_id.lower(), unit_token='attempt:' + attempt_id,
            boot_id='test-boot', invocation_id='a' * 32,
            control_dir=str(control), log_path=str(log),
        )
        self.store.acquire_leases(job['id'], attempt['id'], {f'GPU-{i}': i for i in indices})
        self.store.update_job(job['id'], state=JobState.RUNNING)
        return self.store.get_job(job['id']), attempt

    def pinned(self, index=0, **overrides):
        return self.submit(placement='pinned', requested_gpu_uuids=[f'GPU-{index}'], **overrides)

    def state(self, job):
        return self.store.get_job(job['id'])['state']

    def test_priority_then_fifo_is_durable(self):
        first = self.submit(priority=2)
        last = self.submit(priority=2)
        high = self.submit(priority=4)
        idle = self.submit(priority=0, yield_policy='now')
        expected = [high['id'], first['id'], last['id'], idle['id']]
        self.assertEqual([job['id'] for job in self.store.list_jobs()], expected)
        self.store.close()
        self.store.open()
        self.assertEqual([job['id'] for job in self.store.list_jobs()], expected)

    def test_missing_policy_remains_legacy_without_implicit_opt_in(self):
        legacy, _ = self.running(priority=0, yield_policy=None)
        requester = self.pinned()
        self.coordinator._schedule()
        self.assertEqual(self.store.get_job(legacy['id'])['yield_policy'], 'legacy')
        self.assertEqual(self.state(legacy), 'RUNNING')
        self.assertEqual(self.state(requester), 'PENDING')
        self.assertEqual(self.store.list_actions(), [])

    def test_idle_is_preempted_but_normal_is_protected(self):
        idle, idle_attempt = self.running((0,), priority=0, yield_policy='now')
        normal, _ = self.running((1,))
        requester = self.pinned(0, priority=4)
        self.coordinator._schedule()
        self.assertEqual(self.state(idle), 'PREEMPTING')
        self.assertEqual(self.state(normal), 'RUNNING')
        self.assertEqual(self.state(requester), 'PENDING')
        actions = self.store.list_actions()
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]['action_type'], 'TERM_UNIT')
        self.assertEqual(actions[0]['attempt_id'], idle_attempt['id'])

    def test_default_idle_requeues_same_job_at_original_rank_and_fifo_after_preemption(self):
        policy=priority_class_contract('idle')
        self.assertEqual(policy['restart_policy'],'on-preempt')
        idle,attempt=self.running((0,),**policy,placement='pinned',requested_gpu_uuids=['GPU-0'],preempt_idle_only=True)
        later=self.pinned(0,**policy,preempt_idle_only=True)
        requester=self.pinned(0,priority=4,preempt_idle_only=True)
        self.coordinator._schedule()
        self.assertEqual(self.state(idle),'PREEMPTING')
        self.assertEqual(self.state(requester),'PENDING')
        self.store.update_attempt(attempt['id'],state=AttemptState.DRAINING,exit_code=-15)
        self.coordinator._finalize_attempt(self.store.get_attempt(attempt['id']))
        queued=self.store.get_job(idle['id'])
        self.assertEqual(queued['state'],'PENDING')
        self.assertEqual((queued['priority'],queued['sequence']),(idle['priority'],idle['sequence']))
        self.assertEqual(self.store.get_attempt(attempt['id'])['state'],'PREEMPTED')
        self.coordinator._schedule()
        self.assertEqual(self.state(requester),'STARTING')
        self.assertEqual(self.state(idle),'PENDING')
        self.assertEqual(self.state(later),'PENDING')
        high=self.store.list_attempts(job_id=requester['id'])[0]
        self.store.release_leases(attempt_id=high['id'],reason='synthetic requester finished')
        self.store.update_attempt(high['id'],state=AttemptState.EXITED_SUCCESS)
        self.store.update_job(requester['id'],state=JobState.SUCCEEDED)
        self.coordinator._schedule()
        self.assertEqual(self.state(idle),'STARTING')
        self.assertEqual(self.state(later),'PENDING')
        resumed=self.store.list_attempts(job_id=idle['id'])[0]
        self.assertEqual(resumed['ordinal'],2)
        self.assertIsNone(resumed['launch_resume_checkpoint_path'])

    def test_requeue_policy_does_not_retry_an_ordinary_failure_or_manual_cancel(self):
        for canceled in (False,True):
            with self.subTest(canceled=canceled):
                job,attempt=self.running(**priority_class_contract('idle'),preempt_idle_only=True)
                if canceled:self.store.update_job(job['id'],state=JobState.CANCELED)
                self.store.update_attempt(attempt['id'],state=AttemptState.DRAINING,exit_code=1)
                self.coordinator._finalize_attempt(self.store.get_attempt(attempt['id']))
                self.assertEqual(self.state(job),'CANCELED' if canceled else 'FAILED')
                self.assertEqual(len(self.store.list_attempts(job_id=job['id'])),1)

    def test_same_priority_idle_job_waits_without_interrupting_first(self):
        first, _ = self.running(priority=0, yield_policy='now')
        second = self.pinned(priority=0, yield_policy='now')
        self.coordinator._schedule()
        self.assertEqual(self.state(first), 'RUNNING')
        self.assertEqual(self.state(second), 'PENDING')
        self.assertEqual(self.store.list_actions(), [])

    def test_free_gpu_starts_requester_without_interrupting_idle_job(self):
        idle, _ = self.running(priority=0, yield_policy='now')
        requester = self.submit()
        self.coordinator._schedule()
        self.assertEqual(self.state(idle), 'RUNNING')
        self.assertEqual(self.state(requester), 'STARTING')
        self.assertEqual([a['action_type'] for a in self.store.list_actions()], ['START_UNIT'])

    def test_external_work_and_insufficient_capacity_do_not_trigger_partial_kill(self):
        idle, _ = self.running(priority=0, yield_policy='now')
        self.snapshot(occupied=(1, 2, 3))
        self.coordinator._external = {f'GPU-{i}': {1000 + i} for i in (1, 2, 3)}
        requester = self.submit(gpu_count=2)
        self.coordinator._schedule()
        self.assertEqual(self.state(idle), 'RUNNING')
        self.assertEqual(self.state(requester), 'PENDING')
        self.assertEqual(self.store.list_actions(), [])
        self.systemd.terminate.assert_not_called()
        self.systemd.kill.assert_not_called()

    def test_quarantined_attempt_is_never_a_victim(self):
        idle, attempt = self.running(priority=0, yield_policy='now')
        self.coordinator._quarantine_affected_attempt_ids.add(attempt['id'])
        self.pinned()
        self.coordinator._schedule()
        self.assertEqual(self.state(idle), 'RUNNING')
        self.assertEqual(self.store.list_actions(), [])


    def test_repeated_ticks_do_not_expand_preemption_blast_radius(self):
        jobs = [self.running((i,), priority=0, yield_policy='now')[0] for i in range(4)]
        requester = self.submit()
        for _ in range(5):
            self.coordinator._schedule()
        self.assertEqual(sum(self.state(job) == 'PREEMPTING' for job in jobs), 1)
        self.assertEqual(self.state(requester), 'PENDING')
        self.assertEqual(len(self.store.list_actions()), 1)

    def test_canceling_waiter_withdraws_undelivered_preemption(self):
        idle, _ = self.running(priority=0, yield_policy='now')
        requester = self.pinned()
        self.coordinator._schedule()
        action = self.store.list_actions()[0]
        self.store.update_job(requester['id'], state=JobState.CANCELED)
        self.assertEqual(self.coordinator._execute_signal(action, kill=False), {'withdrawn': True})
        self.assertEqual(self.state(idle), 'RUNNING')
        self.systemd.terminate.assert_not_called()

    def test_identity_mismatch_prevents_sending_signal(self):
        self.running(priority=0, yield_policy='now')
        self.pinned()
        self.coordinator._schedule()
        action = self.store.list_actions()[0]
        self.systemd.status.side_effect = UnitIdentityError('changed invocation')
        with self.assertRaises(UnitIdentityError):
            self.coordinator._execute_signal(action, kill=False)
        self.systemd.terminate.assert_not_called()

    def test_gpu_must_fully_drain_before_lease_release_and_next_start(self):
        idle, attempt = self.running(priority=0, yield_policy='now')
        Path(attempt['log_path']).write_text('saved training output\n')
        requester = self.pinned()
        self.coordinator._schedule()
        self.store.update_attempt(attempt['id'], state=AttemptState.DRAINING, exit_code=-15)
        clean = SimpleNamespace(is_cleanup_ready=True, control_group='', main_pid=0)
        self.coordinator._statuses[attempt['id']] = clean
        self.snapshot(occupied=(0,))
        for _ in range(3):
            self.coordinator._finalize_draining_attempts()
            self.coordinator._schedule()
            self.assertEqual(self.state(requester), 'PENDING')
        self.snapshot(memory={0: 129})
        self.coordinator._finalize_draining_attempts()
        self.assertEqual(self.state(idle), 'PREEMPTING')
        self.snapshot()
        self.coordinator._finalize_draining_attempts()
        self.coordinator._schedule()
        self.assertEqual(self.state(requester), 'PENDING')
        self.coordinator._finalize_draining_attempts()
        self.assertEqual(self.state(idle), 'CANCELED')
        finished = self.store.get_attempt(attempt['id'])
        self.assertEqual(finished['state'], 'PREEMPTED')
        self.assertTrue(Path(finished['log_path']).exists())
        self.assertEqual(Path(finished['log_path']).read_text(), 'saved training output\n')
        self.assertIn('restart disabled', self.store.get_job(idle['id'])['state_reason'])
        self.coordinator._schedule()
        self.assertEqual(self.state(requester), 'STARTING')
        self.assertEqual(len(self.store.list_attempts(job_id=idle['id'])), 1)

    def test_non_quiescent_unit_blocks_release_even_when_gpu_looks_idle(self):
        _, attempt = self.running(priority=0, yield_policy='now')
        self.coordinator._statuses[attempt['id']] = SimpleNamespace(is_cleanup_ready=False)
        for _ in range(3):
            self.assertFalse(self.coordinator._attempt_gpus_released(attempt))

    def test_remaining_cgroup_process_blocks_release_even_when_gpu_looks_idle(self):
        _, attempt = self.running(priority=0, yield_policy='now')
        self.coordinator._statuses[attempt['id']] = SimpleNamespace(is_cleanup_ready=True, control_group='/fake')
        with patch('gpuq.coordinator.read_cgroup_tree_processes', return_value=[12345]):
            self.assertFalse(self.coordinator._attempt_gpus_released(attempt))

    def test_status_exposes_priority_order_and_yield_contract(self):
        idle = self.submit(priority=0, yield_policy='now')
        normal = self.submit()
        high = self.submit(priority=4)
        result = self.coordinator._api_status({'all': False, 'limit': 1000})
        self.assertEqual([job['id'] for job in result['jobs']], [high['id'], normal['id'], idle['id']])
        last = result['jobs'][-1]
        self.assertEqual((last['priority'], last['priority_name'], last['yield_policy'], last['restart_policy']),
                         (0, 'P0', 'now', 'never'))
        self.assertEqual(last['sequence'], idle['sequence'])

    def test_yield_contract_is_part_of_submission_idempotency(self):
        key = str(uuid.uuid4())
        job = self.submit(submit_key=key, priority=0, yield_policy='now')
        self.assertEqual(self.submit(submit_key=key, priority=0, yield_policy='now')['id'], job['id'])
        with self.assertRaises(StoreConflictError):
            self.submit(submit_key=key, priority=0, yield_policy='never')

    def test_shared_tasks_cannot_opt_into_automatic_interruption(self):
        with self.assertRaisesRegex(ValueError, 'automatic yielding'):
            self.pinned(priority=0, yield_policy='now', share_gpu=True, vram_mb=1024)

    def expected(self, job):
        return {key: job[key] for key in ('priority', 'yield_policy', 'restart_policy', 'dispatch_mode')}

    def set_priority(self, job, priority_class, **options):
        return self.coordinator.handle_api('set_priority', {
            'job_id': job['id'], 'priority_class': priority_class, **options,
        })

    def test_pending_priority_change_updates_complete_contract_without_new_sequence(self):
        job = self.submit(priority=1, yield_policy=None, dispatch_mode='preempt-now', restart_policy='on-preempt')
        for priority_class, priority, policy in [('idle', 0, 'now'), ('high', 4, 'never'), ('normal', 2, 'never')]:
            result = self.set_priority(job, priority_class)
            self.assertEqual(result, {
                'job_id': job['id'], 'state': 'PENDING', 'priority_class': priority_class,
                'priority': priority, 'priority_name': f'P{priority}', 'yield_policy': policy,
                'restart_policy': 'on-preempt' if priority_class=='idle' else 'never', 'dispatch_mode': 'queue',
                'preempt_idle_only': False,
            })
            self.assertEqual(self.store.get_job(job['id'])['sequence'], job['sequence'])
        self.assertEqual(len([event for event in self.store.list_events(job_id=job['id'])
                              if event['event_type'] == 'PRIORITY_CHANGED']), 3)
        self.assertEqual(self.store.list_actions(), [])

    def test_running_or_terminal_priority_changes_are_rejected(self):
        for state in ['STARTING', 'RUNNING', 'PREEMPTING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'LOST']:
            with self.subTest(state=state):
                job = self.submit()
                self.store.update_job(job['id'], state=state)
                with self.assertRaises(ApiError) as raised:
                    self.set_priority(job, 'idle')
                self.assertEqual(raised.exception.code, 'CONFLICT')
                self.assertEqual(self.expected(self.store.get_job(job['id'])), self.expected(job))

    def test_pending_preemption_requester_cannot_change_policy_mid_drain(self):
        self.running(priority=0, yield_policy='now')
        requester = self.pinned()
        self.coordinator._schedule()
        self.assertEqual(self.state(requester), 'PENDING')
        with self.assertRaises(ApiError) as raised:
            self.set_priority(requester, 'idle')
        self.assertEqual(raised.exception.code, 'CONFLICT')
        self.assertEqual(self.expected(self.store.get_job(requester['id'])), self.expected(requester))

    def test_pending_job_with_own_active_attempt_cannot_change_policy(self):
        job, _ = self.running()
        self.store.update_job(job['id'], state=JobState.PENDING)
        with self.assertRaises(ApiError) as raised:
            self.set_priority(job, 'idle')
        self.assertEqual(raised.exception.code, 'CONFLICT')


    def test_invalid_priority_rpc_inputs_fail_without_mutation(self):
        job = self.submit()
        invalid = [
            {'priority_class': 'urgent'}, {'priority_class': None}, {'priority_class': []},
            {'job_id': ''}, {'job_id': 1},
        ]
        for options in invalid:
            with self.subTest(options=options), self.assertRaises(ApiError) as raised:
                self.coordinator.handle_api('set_priority', {'job_id': job['id'], 'priority_class': 'idle', **options})
            self.assertEqual(raised.exception.code, 'BAD_REQUEST')
            self.assertEqual(self.expected(self.store.get_job(job['id'])), self.expected(job))

    def test_shared_idle_priority_change_is_rejected_but_high_is_allowed(self):
        job = self.pinned(share_gpu=True, vram_mb=1024)
        with self.assertRaises(ApiError) as raised:
            self.set_priority(job, 'idle')
        self.assertEqual(raised.exception.code, 'BAD_REQUEST')
        self.assertEqual(self.set_priority(job, 'high')['yield_policy'], 'never')

    def test_priority_change_rolls_back_if_audit_event_cannot_be_written(self):
        job = self.submit()
        with patch.object(self.store, 'append_event', side_effect=RuntimeError('test disk failure')):
            with self.assertRaisesRegex(RuntimeError, 'disk failure'):
                self.set_priority(job, 'idle')
        self.assertEqual(self.expected(self.store.get_job(job['id'])), self.expected(job))


    def test_unknown_job_returns_not_found(self):
        with self.assertRaises(ApiError) as raised:
            self.set_priority({'id': 'Jmissing'}, 'normal')
        self.assertEqual(raised.exception.code, 'NOT_FOUND')

    def test_rank_only_edit_preserves_checkpoint_restart_dispatch_and_fifo(self):
        job = self.submit(priority=1, yield_policy='save', checkpoint_capability='epoch-v1',
                          dispatch_mode='preempt-save', restart_policy='on-preempt')
        for rank in [0, 1, 2, 3, 4]:
            before = self.store.get_job(job['id'])
            changed = self.coordinator.handle_api('set_priority_rank', {
                'job_id': job['id'], 'priority': rank,
            })
            self.assertEqual(changed['priority'], rank)
            after = self.store.get_job(job['id'])
            for key in ('yield_policy', 'checkpoint_capability', 'restart_policy', 'dispatch_mode', 'sequence', 'preempt_idle_only'):
                self.assertEqual(after[key], before[key], key)
        self.assertEqual(self.store.list_actions(), [])

    def test_rank_only_edit_never_opts_a_protected_job_into_yielding(self):
        job = self.submit(yield_policy='never', restart_policy='never')
        changed = self.coordinator.handle_api('set_priority_rank', {'job_id': job['id'], 'priority': 0})
        self.assertEqual(changed['yield_policy'], 'never')
        self.assertEqual(changed['restart_policy'], 'never')

    def test_rank_only_edit_preserves_shared_contract(self):
        job = self.pinned(share_gpu=True, vram_mb=1024, yield_policy='never')
        changed = self.coordinator.handle_api('set_priority_rank', {'job_id': job['id'], 'priority': 0})
        self.assertEqual(changed['yield_policy'], 'never')
        self.assertTrue(self.store.get_job(job['id'])['share_gpu'])

    def test_rank_only_cli_and_remote_route_use_distinct_safe_operation(self):
        client = Mock()
        client.call.return_value = {'state': 'PENDING'}
        with patch('gpuq.cli.get_client', return_value=client), redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['--json', 'set-rank', 'Jtest', 'P3']), 0)
        client.call.assert_called_once_with('set_priority_rank', {'job_id': 'Jtest', 'priority': 3})
        self.assertEqual(fleet.validate_remote_argv(['set-rank', 'Jtest', 'P1']), 'set-rank')

    def test_rank_only_running_updates_fail_without_policy_mutation(self):
        job = self.submit(yield_policy='save', checkpoint_capability='epoch-v1', restart_policy='on-preempt')
        self.coordinator.handle_api('set_priority_rank', {'job_id': job['id'], 'priority': 3})
        self.store.update_job(job['id'], state='RUNNING')
        with self.assertRaises(ApiError):
            self.coordinator.handle_api('set_priority_rank', {'job_id': job['id'], 'priority': 0})
        self.assertEqual(self.store.get_job(job['id'])['yield_policy'], 'save')

    def test_set_priority_cli_sends_current_request_and_prints_json(self):
        job = self.submit()
        client = Mock()
        client.call.side_effect = self.coordinator.handle_api
        output = io.StringIO()
        with patch('gpuq.cli.get_client', return_value=client), redirect_stdout(output):
            result = cli.main(['--json', 'set-priority', job['id'], 'idle'])
        self.assertEqual(result, 0)
        client.call.assert_called_once_with('set_priority', {
            'job_id': job['id'], 'priority_class': 'idle',
        })
        self.assertEqual(json.loads(output.getvalue())['priority_class'], 'idle')
        self.assertEqual(fleet.validate_remote_argv(['--json', 'set-priority', job['id'], 'normal']), 'set-priority')


    def test_new_console_high_protects_existing_checkpoint_yield_job(self):
        legacy, _ = self.running(priority=2, yield_policy='save', checkpoint_capability='epoch-v1', restart_policy='on-preempt')
        requester = self.pinned(priority=4, preempt_idle_only=True)
        self.coordinator._schedule()
        self.assertEqual(self.state(legacy), 'RUNNING')
        self.assertEqual(self.state(requester), 'PENDING')
        self.assertEqual(self.store.list_actions(), [])

    def test_existing_unrestricted_queue_retains_checkpoint_yield_behavior(self):
        legacy, _ = self.running(priority=2, yield_policy='save', checkpoint_capability='epoch-v1', restart_policy='on-preempt')
        self.pinned(priority=4)
        self.coordinator._schedule()
        self.assertEqual(self.state(legacy), 'PREEMPTING')
        self.assertEqual(self.store.list_actions()[0]['action_type'], 'REQUEST_SAVE')

    def test_restricted_console_request_can_interrupt_explicit_idle_job(self):
        idle, _ = self.running(priority=0, yield_policy='now', restart_policy='never', preempt_idle_only=True)
        self.pinned(priority=4, preempt_idle_only=True)
        self.coordinator._schedule()
        self.assertEqual(self.state(idle), 'PREEMPTING')
        self.assertEqual(self.store.list_actions()[0]['action_type'], 'TERM_UNIT')

    def test_final_planning_guard_rejects_non_idle_victim_even_if_selection_is_bypassed(self):
        legacy, _ = self.running(priority=2, yield_policy='save', checkpoint_capability='epoch-v1', restart_policy='on-preempt')
        requester = self.pinned(priority=4, preempt_idle_only=True)
        with self.assertRaisesRegex(StoreConflictError, 'only interrupt explicit idle'):
            self.coordinator._plan_preemption(requester, self.coordinator._running_candidates())
        self.assertEqual(self.state(legacy), 'RUNNING')
        self.assertEqual(self.store.list_actions(), [])

    def test_restricted_console_request_does_not_enroll_historical_p0_now_never_job(self):
        old, _ = self.running(priority=0, yield_policy='now', restart_policy='never', preempt_idle_only=False)
        requester = self.pinned(priority=4, preempt_idle_only=True)
        self.coordinator._schedule()
        self.assertEqual(self.state(old), 'RUNNING')
        self.assertEqual(self.state(requester), 'PENDING')
        self.assertEqual(self.store.list_actions(), [])
        with self.assertRaisesRegex(StoreConflictError, 'only interrupt explicit idle'):
            self.coordinator._plan_preemption(requester, self.coordinator._running_candidates())

    def test_unrestricted_legacy_request_retains_historical_p0_now_never_behavior(self):
        old, _ = self.running(priority=0, yield_policy='now', restart_policy='never', preempt_idle_only=False)
        self.pinned(priority=2, preempt_idle_only=False)
        self.coordinator._schedule()
        self.assertEqual(self.state(old), 'PREEMPTING')
        self.assertEqual(self.store.list_actions()[0]['action_type'], 'TERM_UNIT')

    def test_cluster_offer_obeys_victim_scope_without_changing_legacy_offers(self):
        self.running(priority=0, yield_policy='now', restart_policy='never', preempt_idle_only=False)
        requester = self.pinned(priority=4, preempt_idle_only=True)
        self.store.update_job(requester['id'], state=JobState.CANCELED)
        self.coordinator._health = 'ok'
        self.assertEqual(cluster_node.offer(self.coordinator, requester)['kind'], 'busy')
        self.assertEqual(cluster_node.offer(self.coordinator, {**requester, 'preempt_idle_only': False})['kind'], 'preempt')

    def test_restricted_request_never_borrows_old_idle_promise_or_signals_it(self):
        _, attempt = self.running(priority=0, yield_policy='now', restart_policy='never', preempt_idle_only=False)
        self.pinned(priority=2, preempt_idle_only=False)
        self.coordinator._schedule()
        requester = self.pinned(priority=4, preempt_idle_only=True)
        self.assertEqual(self.coordinator._promised_preemption_gpu_uuids(requester), set())
        current = self.store.get_attempt(attempt['id'])
        self.assertFalse(self.coordinator._preemption_is_still_needed({
            **current, 'preempt_requested_by_job_id': requester['id'],
        }))

    def test_restricted_request_does_not_take_over_or_borrow_old_checkpoint_promise(self):
        _, attempt = self.running(priority=1, yield_policy='save', checkpoint_capability='epoch-v1', restart_policy='on-preempt')
        self.pinned(priority=2)
        self.coordinator._schedule()
        requester = self.pinned(priority=4, preempt_idle_only=True, dispatch_mode='preempt-now')
        self.assertEqual(self.coordinator._save_takeover_candidates(requester), [])
        self.assertEqual(self.coordinator._promised_preemption_gpu_uuids(requester), set())
        self.coordinator._schedule()
        self.assertEqual(self.store.get_attempt(attempt['id'])['state'], 'SAVE_REQUESTED')
        self.assertEqual(len(self.store.list_actions()), 1)

    def test_idle_restriction_is_persisted_idempotent_and_preserved_by_priority_change(self):
        key = str(uuid.uuid4())
        job = self.submit(submit_key=key, preempt_idle_only=True)
        self.assertTrue(self.store.get_job(job['id'])['preempt_idle_only'])
        self.assertTrue(self.set_priority(job, 'idle')['preempt_idle_only'])
        self.assertTrue(self.set_priority(job, 'high')['preempt_idle_only'])
        with self.assertRaises(StoreConflictError):
            self.submit(submit_key=key, preempt_idle_only=False)
        with self.assertRaisesRegex(ValueError, 'boolean'):
            self.submit(preempt_idle_only=1)

    def test_daemon_capabilities_and_status_are_explicit(self):
        job = self.submit(preempt_idle_only=True)
        result = self.coordinator.handle_api('status', {})
        self.assertTrue({'priority-policy-v1','preempt-idle-only-v1','priority-rank-v1','preempt-opt-in-only-v1','elastic-batch-v1','gpu-placement-v1','gpu-sharing-v1'}.issubset(result['daemon']['capabilities']))
        self.assertEqual(result['jobs'][0]['id'], job['id'])
        self.assertIs(result['jobs'][0]['preempt_idle_only'], True)
        parsed = cli.build_parser().parse_args(['submit', '-g', '1', '--preempt-idle-only', '--', 'python', 'train.py'])
        self.assertTrue(parsed.preempt_idle_only)



if __name__ == '__main__':
    unittest.main()
