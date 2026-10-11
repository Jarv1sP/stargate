"""Cancellation uncertainty stays within its gang; no real signals or GPUs."""
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import sys
import unittest
import uuid

loader = importlib.util.spec_from_file_location('cancel_isolation_fixture', Path(__file__).with_name('gpuq-cancel-draining.test.py'))
F = importlib.util.module_from_spec(loader)
loader.loader.exec_module(F)
from gpuq.constants import AttemptState
from gpuq.coordinator import CollisionFinding, GpuQuarantine, StartCapacityBlocked


class CancelIsolationTests(unittest.TestCase):
    canceled = F.CancelDrainingTests.canceled
    kills = F.CancelDrainingTests.kills

    def setUp(self):
        F.CancelDrainingTests.setUp(self)
        self.config = replace(self.config, managed_gpu_uuids=('GPU-0', 'GPU-1', 'GPU-2'))
        self.coordinator.config = self.config
        self.devices = tuple(F.GpuDevice(i, f'GPU-{i}', 24000, 0, 24000, 0, ()) for i in range(3))
        self.coordinator._snapshot = self.devices
        self.coordinator.gpu_provider.snapshot.return_value = self.devices
        self.coordinator._idle_counts = {gpu.uuid: 2 for gpu in self.devices}
        self.coordinator._recovery_scans = 2
        self.coordinator._health = 'ok'

    def pending(self, index, *, shared=False):
        raw = {'submit_key': str(uuid.uuid4()), 'name': 'waiting-on-selected-gpu', 'owner': 'test-user',
            'priority': 2, 'dispatch_mode': 'queue', 'yield_policy': 'never', 'checkpoint_capability': 'none',
            'restart_policy': 'never', 'gpu_count': 1, 'placement': 'pinned', 'requested_gpu_uuids': [f'GPU-{index}'],
            'argv': [sys.executable, '-c', 'never executed'], 'cwd': str(self.config.root), 'env': {},
            **({'share_gpu': True, 'vram_mb': 1024} if shared else {})}
        return self.store.submit_job(F.validate_submission(raw, 3, managed_gpu_uuids=self.config.managed_gpu_uuids))

    def unreadable(self):
        self.read_cgroup.side_effect = RuntimeError('private fixture /unreadable/cgroup')

    def test_unknown_cancel_group_isolates_only_its_gpu_and_healthy_gpu_is_scheduled(self):
        job, attempt = self.canceled()
        self.store.update_attempt(attempt['id'], failure_reason='original training failure')
        healthy, shared = self.pending(1), self.pending(0, shared=True)
        self.unreadable()
        self.coordinator.tick()
        self.assertEqual(self.coordinator.health_name, 'ok')
        self.assertEqual(self.store.get_job(healthy['id'])['state'], 'STARTING')
        self.assertEqual(self.store.list_attempts(job_id=healthy['id'])[0]['gpu_uuids'], ['GPU-1'])
        self.assertEqual(self.store.get_job(shared['id'])['state'], 'PENDING')
        self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 1)
        self.assertEqual(self.store.get_attempt(attempt['id'])['failure_reason'], 'original training failure')
        status = self.coordinator.handle_api('status', {})['daemon']
        self.assertEqual(status['capacity_health'], 'partial')
        self.assertEqual([entry['uuid'] for entry in status['quarantined_gpus']], ['GPU-0'])
        self.assertEqual(status['quarantined_gpus'][0]['reasons'][0]['kind'], 'cancel-cgroup-unavailable')
        self.assertNotIn('/unreadable/cgroup', json.dumps(status))
        self.systemd.kill.assert_not_called()
        self.systemd.terminate.assert_not_called()
        self.systemd.start.assert_not_called()

    def test_whole_uncertain_gang_is_fenced_but_other_gpu_can_start(self):
        job, attempt = self.canceled(indices=(0, 1))
        healthy = self.pending(2)
        self.unreadable()
        self.coordinator.tick()
        self.assertEqual(self.coordinator.health_name, 'ok')
        self.assertEqual(self.store.get_job(healthy['id'])['state'], 'STARTING')
        self.assertEqual(set(self.coordinator._quarantines), {'GPU-0', 'GPU-1'})
        self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 2)
        for quarantine in self.coordinator._quarantines.values():
            self.assertEqual(quarantine.affected_attempt_ids, (attempt['id'],))
        self.systemd.kill.assert_not_called()

    def test_all_affected_cards_report_blocked_capacity_without_global_health_failure(self):
        job, _ = self.canceled(indices=(0, 1, 2))
        waiting = self.pending(1)
        self.unreadable()
        self.coordinator.tick()
        status = self.coordinator.handle_api('status', {})['daemon']
        self.assertEqual(status['health'], 'ok')
        self.assertEqual(status['capacity_health'], 'blocked')
        self.assertEqual(status['schedulable_gpu_uuids'], [])
        self.assertEqual(len(status['quarantined_gpus']), 3)
        self.assertEqual(self.store.get_job(waiting['id'])['state'], 'PENDING')
        self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 3)

    def test_pending_kill_is_deferred_without_global_failure_and_recovers_on_original_action(self):
        job, attempt = self.canceled(AttemptState.TERM_REQUESTED)
        self.coordinator._enqueue_kill(attempt)
        action = self.kills(attempt)[0]
        self.unreadable()
        self.coordinator.tick()
        pending = self.kills(attempt)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]['id'], action['id'])
        self.assertEqual(pending[0]['state'], 'PENDING')
        self.assertEqual(pending[0]['attempt_count'], 1)
        self.assertGreater(pending[0]['available_at'], self.now)
        self.assertNotIn('/unreadable/cgroup', pending[0]['last_error'])
        self.assertEqual(self.coordinator.health_name, 'ok')
        self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 1)
        self.systemd.kill.assert_not_called()
        self.read_cgroup.side_effect = lambda group: list(self.children)
        self.now += 10
        self.coordinator.tick()
        self.systemd.kill.assert_called_once_with(unit_name=attempt['unit_name'], description_token=attempt['unit_token'], invocation_id='a' * 32)
        self.assertEqual(self.kills(attempt)[0]['id'], action['id'])
        self.assertEqual(self.kills(attempt)[0]['state'], 'DONE')
        self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 1)
        self.children.clear()
        for _ in range(4):
            self.now += 1
            self.coordinator.tick()
        self.assertEqual(self.store.list_leases(job_id=job['id']), [])
        self.assertEqual(self.store.get_attempt(attempt['id'])['state'], 'CANCELED')
        self.assertEqual(self.coordinator._quarantines, {})
        self.assertEqual(self.systemd.kill.call_count, 1)

    def test_cancel_api_term_waits_for_membership_without_blocking_healthy_dispatch(self):
        job, attempt = self.canceled(AttemptState.RUNNING, term=False, deadline=None, canceled=False)
        self.coordinator.handle_api('cancel', {'job_id': job['id']})
        original = self.store.list_actions(attempt_id=attempt['id'])[0]
        self.assertEqual(original['action_type'], 'TERM_UNIT')
        healthy = self.pending(1)
        self.unreadable()
        self.coordinator.tick()
        actions = self.store.list_actions(attempt_id=attempt['id'])
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]['id'], original['id'])
        self.assertEqual(actions[0]['state'], 'PENDING')
        self.assertEqual(actions[0]['attempt_count'], 1)
        self.assertGreater(actions[0]['available_at'], self.now)
        self.assertIsNone(self.store.get_attempt(attempt['id'])['term_deadline_at'])
        self.assertEqual(self.kills(attempt), [])
        self.assertEqual(self.coordinator.health_name, 'ok')
        self.assertEqual(self.store.get_job(healthy['id'])['state'], 'STARTING')
        self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 1)
        self.systemd.terminate.assert_not_called()
        self.systemd.kill.assert_not_called()

    def test_membership_becoming_unknown_just_before_signal_keeps_original_kill_pending(self):
        job, attempt = self.canceled()
        calls = 0
        def observe(group):
            nonlocal calls
            calls += 1
            if calls == 1:
                return list(self.children)
            raise RuntimeError('membership changed to unknown')
        self.read_cgroup.side_effect = observe
        healthy = self.pending(1)
        self.coordinator.tick()
        self.assertGreaterEqual(calls, 2)
        self.assertEqual(self.coordinator.health_name, 'ok')
        self.assertEqual(self.store.get_job(healthy['id'])['state'], 'STARTING')
        self.assertEqual(len(self.kills(attempt)), 1)
        self.assertEqual(self.kills(attempt)[0]['state'], 'PENDING')
        self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 1)
        self.assertFalse(any(event['event_type'] == 'SIGNAL_DELIVERY_INTENT' for event in self.store.list_events(attempt_id=attempt['id'])))
        self.systemd.kill.assert_not_called()

    def test_repeated_unknown_observations_do_not_clear_quarantine_or_duplicate_reasons(self):
        job, attempt = self.canceled()
        self.coordinator._record_start_capacity_block({'attempt_id': attempt['id']}, StartCapacityBlocked('GPU-0', 0, [1234]))
        self.unreadable()
        for _ in range(3):
            self.coordinator._reconcile_attempts()
        quarantine = self.coordinator._quarantines['GPU-0']
        self.assertEqual({finding.kind for finding in quarantine.findings}, {'start-target-busy', 'cancel-cgroup-unavailable'})
        self.assertEqual(len(quarantine.findings), 2)
        self.assertEqual(quarantine.clean_scans, 0)
        self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 1)
        self.assertEqual(self.coordinator.health_name, 'ok')

    def test_local_fault_does_not_advance_other_gpu_confirmation_or_reset_its_release_progress(self):
        _, attempt = self.canceled()
        other = 'A' + uuid.uuid4().hex
        finding = CollisionFinding('GPU-1', 1, 'start-target-busy', (), lease_attempt_id=other)
        prior = GpuQuarantine('GPU-1', 1, (finding,), (other,), False, 1)
        self.coordinator._quarantines['GPU-1'] = prior
        self.coordinator._release_counts[other] = 1
        self.unreadable()
        self.coordinator._reconcile_attempts()
        self.assertIs(self.coordinator._quarantines['GPU-1'], prior)
        self.assertEqual(self.coordinator._quarantines['GPU-1'].clean_scans, 1)
        self.assertEqual(self.coordinator._release_counts[other], 1)
        self.assertEqual(self.coordinator._quarantines['GPU-0'].affected_attempt_ids, (attempt['id'],))

    def test_recovery_requires_clean_observations_and_real_empty_group_before_release(self):
        job, attempt = self.canceled()
        self.unreadable()
        for _ in range(3):
            self.coordinator.tick()
            self.assertEqual(self.coordinator.health_name, 'ok')
            self.assertEqual(self.coordinator._quarantines['GPU-0'].clean_scans, 0)
        self.read_cgroup.side_effect = lambda group: list(self.children)
        self.children.clear()
        self.coordinator.tick()
        self.assertIn('GPU-0', self.coordinator._quarantines)
        self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 1)
        for _ in range(4):
            self.coordinator.tick()
        self.assertEqual(self.coordinator._quarantines, {})
        self.assertEqual(self.store.list_leases(job_id=job['id']), [])
        self.assertEqual(self.store.get_attempt(attempt['id'])['state'], 'CANCELED')

    def test_structurally_invalid_fence_still_stops_global_scheduling(self):
        _, attempt = self.canceled()
        healthy = self.pending(1)
        self.store._get_connection().execute('UPDATE leases SET lease_token=? WHERE attempt_id=?', ('wrong-token', attempt['id']))
        self.unreadable()
        self.coordinator.tick()
        self.assertEqual(self.coordinator.health_name, 'degraded')
        self.assertEqual(self.store.get_job(healthy['id'])['state'], 'PENDING')
        self.assertEqual(len(self.store.list_leases()), 1)
        self.read_cgroup.assert_not_called()
        self.systemd.kill.assert_not_called()


if __name__ == '__main__':
    unittest.main()
