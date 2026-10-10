"""Real SQLite cancellation/outbox regression; fake systemd and cgroup only."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'gpuq'))
from gpuq.backends import GpuDevice, SystemdUnitStatus, UnitIdentityError
from gpuq.config import Config
from gpuq.constants import AttemptState, JobState
from gpuq.coordinator import Coordinator
from gpuq.rpc import ApiError
from gpuq.store import Store
from gpuq.submission import validate_submission


class CancelDrainingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.now = 1000.0
        self.config = Config(root=root, db_path=root / 'state.db', log_dir=root / 'logs',
                             control_dir=root / 'control', socket_path=root / 'gpuq.sock',
                             managed_gpu_uuids=('GPU-0',), allowed_uid=os.getuid(), observe_only=False)
        self.config.log_dir.mkdir()
        self.config.control_dir.mkdir()
        self.store = Store(self.config.db_path).initialize()
        self.addCleanup(self.store.close)
        self.systemd = Mock()
        self.coordinator = Coordinator(self.config, self.store, Mock(), self.systemd,
                                       boot_id='test-boot', clock=lambda: self.now)
        self.coordinator._snapshot = (GpuDevice(0, 'GPU-0', 24000, 0, 24000, 0, ()),)
        self.children = [4242]
        self.read_cgroup = patch('gpuq.coordinator.read_cgroup_tree_processes',
                                 side_effect=lambda group: list(self.children)).start()
        self.addCleanup(patch.stopall)

    def canceled(self, state=AttemptState.DRAINING, *, term=True, deadline=990.0, canceled=True):
        raw = {'submit_key': str(uuid.uuid4()), 'name': 'test', 'owner': 'test-user',
               'priority': 2, 'dispatch_mode': 'queue', 'yield_policy': 'never',
               'checkpoint_capability': 'none', 'restart_policy': 'never', 'gpu_count': 1,
               'placement': 'any', 'requested_gpu_uuids': [], 'argv': [sys.executable, '-c', 'pass'],
               'cwd': str(self.config.root), 'env': {}}
        job = self.store.submit_job(validate_submission(raw, 1, managed_gpu_uuids=('GPU-0',)))
        aid = 'A' + uuid.uuid4().hex
        control, log = self.coordinator._create_attempt_paths(job['id'], aid)
        attempt = self.store.create_attempt(job['id'], attempt_id=aid, state=AttemptState.RUNNING,
                    gpu_uuids=['GPU-0'], gpu_indices=[0], unit_name='gpuq-' + aid.lower(),
                    unit_token='attempt:' + aid, boot_id='test-boot', invocation_id='a' * 32,
                    control_dir=str(control), log_path=str(log))
        self.store.acquire_leases(job['id'], aid, {'GPU-0': 0})
        self.store.update_job(job['id'], state=JobState.CANCELED if canceled else JobState.RUNNING)
        self.store.update_attempt(aid, state=state, exit_code=15, term_deadline_at=deadline)
        status = SystemdUnitStatus(unit_name=attempt['unit_name'] + '.service',
                    description='GPUQ managed job token:' + attempt['unit_token'], invocation_id='a' * 32,
                    control_group='/user.slice/test/gpuq-' + aid.lower() + '.service', main_pid=0,
                    exec_main_status=15, result='success', active_state='active', sub_state='exited',
                    load_state='loaded', exec_main_code='2')
        self.systemd.status.return_value = status
        self.coordinator._statuses[aid] = status
        if term:
            self.store.append_event('SIGNAL_DELIVERED', job_id=job['id'], attempt_id=aid,
                payload={'signal': 'TERM', 'preempt_nonce': None, 'invocation_id': 'a' * 32})
        return self.store.get_job(job['id']), self.store.get_attempt(aid)

    def kills(self, attempt):
        return [a for a in self.store.list_actions(attempt_id=attempt['id']) if a['action_type'] == 'KILL_UNIT']

    def test_canceled_draining_children_escalate_after_confirmed_term(self):
        job, attempt = self.canceled()
        self.coordinator._reconcile_attempts()
        self.assertEqual(self.store.get_attempt(attempt['id'])['state'], 'KILL_REQUESTED')
        self.assertEqual(len(self.kills(attempt)), 1)
        self.assertEqual(len(self.store.list_leases()), 1)
        self.assertIsNone(self.store.get_attempt(attempt['id'])['finished_at'])
        self.assertEqual(self.store.get_job(job['id'])['state'], 'CANCELED')

    def test_term_parent_exit_keeps_escalation_for_live_children(self):
        _, attempt = self.canceled(AttemptState.TERM_REQUESTED)
        self.coordinator._reconcile_attempts()
        self.assertEqual(self.store.get_attempt(attempt['id'])['state'], 'KILL_REQUESTED')
        self.assertEqual(len(self.kills(attempt)), 1)

    def test_kill_worker_checks_exact_exited_unit_and_records_delivery(self):
        _, attempt = self.canceled(AttemptState.KILL_REQUESTED)
        action = {'id': str(uuid.uuid4()), 'attempt_id': attempt['id'], 'payload': {}}
        result = self.coordinator._execute_signal(action, kill=True)
        self.assertEqual(result.get('signal'), 'KILL')
        self.systemd.kill.assert_called_once_with(unit_name=attempt['unit_name'],
            description_token=attempt['unit_token'], invocation_id='a' * 32)
        events = self.store.list_events(attempt_id=attempt['id'])
        self.assertTrue(any(e['event_type'] == 'SIGNAL_DELIVERED' and e['payload']['signal'] == 'KILL' for e in events))
        self.assertEqual(len(self.store.list_leases()), 1)

    def test_canceled_drain_reaches_terminal_only_after_children_exit(self):
        job, attempt = self.canceled()
        self.coordinator._reconcile_attempts()
        self.assertEqual(len(self.kills(attempt)), 1)
        self.coordinator._execute_signal(self.kills(attempt)[0], kill=True)
        self.coordinator._reconcile_attempts()
        self.assertEqual(len(self.store.list_leases()), 1)
        self.assertIsNone(self.store.get_attempt(attempt['id'])['finished_at'])
        self.children.clear()
        for _ in range(3):
            self.coordinator._reconcile_attempts()
        finished = self.store.get_attempt(attempt['id'])
        self.assertEqual(finished['state'], 'CANCELED')
        self.assertIsNotNone(finished['finished_at'])
        self.assertEqual(self.store.list_leases(), [])
        self.assertEqual(self.store.get_job(job['id'])['state'], 'CANCELED')
        self.assertEqual(len(self.store.list_attempts(job_id=job['id'])), 1)

    def test_no_escalation_without_confirmed_term_delivery(self):
        _, attempt = self.canceled(term=False)
        self.coordinator._reconcile_attempts()
        self.assertEqual(self.kills(attempt), [])
        self.assertIsNone(self.store.get_attempt(attempt['id'])['finished_at'])

    def test_no_escalation_before_term_deadline(self):
        _, attempt = self.canceled(deadline=1010.0)
        self.coordinator._reconcile_attempts()
        self.assertEqual(self.kills(attempt), [])
        self.assertIsNone(self.store.get_attempt(attempt['id'])['finished_at'])

    def test_unreadable_cgroup_never_authorizes_signal_or_release(self):
        _, attempt = self.canceled()
        self.read_cgroup.side_effect = RuntimeError('cgroup unreadable')
        self.coordinator._reconcile_attempts()
        self.assertEqual(self.kills(attempt), [])
        self.systemd.kill.assert_not_called()
        self.assertEqual(len(self.store.list_leases()), 1)

    def test_non_cancelled_draining_job_does_not_get_new_kill(self):
        job, attempt = self.canceled(canceled=False)
        # A natural exit still waits for cleanup; no cancellation authority.
        self.coordinator._reconcile_attempts()
        self.assertEqual(self.kills(attempt), [])
        self.systemd.kill.assert_not_called()
        self.assertEqual(len(self.store.list_leases()), 1)

    def test_identity_failure_prevents_kill_and_keeps_reservation(self):
        _, attempt = self.canceled(AttemptState.KILL_REQUESTED)
        self.systemd.status.side_effect = UnitIdentityError('invocation changed')
        with self.assertRaisesRegex(UnitIdentityError, 'invocation changed'):
            self.coordinator._execute_signal({'id': str(uuid.uuid4()), 'attempt_id': attempt['id'], 'payload': {}}, kill=True)
        self.systemd.kill.assert_not_called()
        self.assertEqual(len(self.store.list_leases()), 1)

    def test_reconciliation_deduplicates_kill_without_releasing_early(self):
        _, attempt = self.canceled()
        for _ in range(3):
            self.coordinator._reconcile_attempts()
        self.assertEqual(len(self.kills(attempt)), 1)
        self.assertEqual(len(self.store.list_leases()), 1)

    def test_closed_release_gate_blocks_canceled_drain_mutations(self):
        _, attempt = self.canceled()
        before = '\n'.join(self.store._get_connection().iterdump())
        gate = {'state': 'CLOSED', 'valid': True,
                'release_id': '22222222-2222-4222-8222-222222222222'}
        with patch('gpuq.coordinator._read_release_gate', return_value=gate):
            with self.assertRaises(ApiError) as caught:
                self.coordinator._reconcile_attempts()
            self.assertEqual(caught.exception.code, 'MAINTENANCE')
        self.assertEqual('\n'.join(self.store._get_connection().iterdump()), before)
        self.assertEqual(self.kills(attempt), [])
        self.systemd.terminate.assert_not_called()
        self.systemd.kill.assert_not_called()
        self.systemd.cleanup.assert_not_called()


if __name__ == '__main__':
    unittest.main()
