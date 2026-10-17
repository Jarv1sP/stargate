"""afterok scheduling against real SQLite; only GPU/systemd observations are synthetic."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

loader = importlib.util.spec_from_file_location('after_scheduler_fixture', Path(__file__).with_name('gpuq-priority.test.py'))
F = importlib.util.module_from_spec(loader)
loader.loader.exec_module(F)
from gpuq.constants import AttemptState, JobState
from gpuq.store import StoreConflictError


class After(unittest.TestCase):
    setUp = F.SchedulerPriorityTests.setUp
    submit = F.SchedulerPriorityTests.submit
    running = F.SchedulerPriorityTests.running
    snapshot = F.SchedulerPriorityTests.snapshot

    def tick(self):
        self.coordinator.gpu_provider.snapshot.return_value = self.coordinator._snapshot
        self.coordinator._recovery_scans = 2
        self.coordinator.tick()
        self.assertEqual(self.coordinator.health_name, 'ok')

    def test_success_releases_high_priority_successor_in_the_same_tick(self):
        parent, attempt = self.running(indices=(0, 1, 2, 3), name='mother')
        low = self.submit(priority=1, gpu_count=4)
        child = self.submit(priority=4, gpu_count=4, after=[parent['id']])
        self.store.set_job_display(parent['id'], {'name': '母模型', 'description': '', 'submitter': {'name': 'member', 'username': 'member'}})
        self.coordinator._dependency_waiting = self.coordinator._reconcile_dependencies()
        self.coordinator._schedule()
        self.assertEqual(self.store.get_job(child['id'])['state'], 'PENDING')
        self.assertEqual(self.store.get_job(child['id'])['state_reason'], '等待依赖：母模型')
        self.assertEqual(self.store.list_attempts(job_id=child['id']), [])
        self.store.update_attempt(attempt['id'], state=AttemptState.DRAINING, exit_code=0)
        self.systemd.status.return_value = SimpleNamespace(is_cleanup_ready=True, control_group='', main_pid=0, invocation_id='a' * 32)
        self.coordinator._release_counts[attempt['id']] = self.config.release_confirmations
        # The existing hardware-idle observation has completed; this tick must
        # retire the parent, resolve the dependency and choose the high rank.
        with patch.object(self.coordinator, '_update_idle_counts'):
            self.tick()
        self.assertEqual(self.store.get_job(parent['id'])['state'], 'SUCCEEDED')
        self.assertEqual(self.store.get_job(child['id'])['state'], 'STARTING')
        self.assertEqual(self.store.get_job(low['id'])['state'], 'PENDING')
        self.assertEqual(len(self.store.list_leases(job_id=child['id'])), 4)

    def test_failed_canceled_or_terminal_lost_parent_cancels_entire_chain(self):
        for state in ('FAILED', 'CANCELED', 'LOST'):
            with self.subTest(state=state):
                parent = self.submit(name='canary-' + state)
                child = self.submit(after=[parent['id']], priority=2)
                grandchild = self.submit(after=[child['id']], priority=4)
                self.store.update_job(parent['id'], state=state)
                self.tick()
                for job in (child, grandchild):
                    row = self.store.get_job(job['id'])
                    self.assertEqual(row['state'], 'CANCELED')
                    self.assertIn('未运行', row['state_reason'])
                    self.assertIsNotNone(row['finished_at'])
                    self.assertEqual(self.store.list_attempts(job_id=job['id']), [])

    def test_all_dependencies_must_succeed_and_waiting_job_does_not_block_other_work(self):
        first, second = self.submit(), self.submit()
        child = self.submit(priority=4, gpu_count=4, after=[first['id'], second['id']])
        low = self.submit(priority=1)
        self.store.update_job(first['id'], state=JobState.SUCCEEDED)
        self.store.update_job(second['id'], state=JobState.RUNNING)
        self.tick()
        self.assertEqual(self.store.get_job(child['id'])['state'], 'PENDING')
        self.assertEqual(self.store.list_leases(job_id=child['id']), [])
        self.assertEqual(self.store.get_job(low['id'])['state'], 'STARTING')
        self.store.update_job(second['id'], state=JobState.SUCCEEDED)
        self.coordinator._dependency_waiting = self.coordinator._reconcile_dependencies()
        self.assertNotIn(child['id'], self.coordinator._dependency_waiting)
        self.assertIsNone(self.store.get_job(child['id'])['state_reason'])

    def test_dependencies_persist_across_restarts_and_original_key_is_immutable(self):
        parent, attempt = self.running()
        child = self.submit(after=[parent['id']])
        self.store.close(); self.store.open()
        self.coordinator = F.Coordinator(self.config, self.store, F.Mock(), self.systemd, boot_id='test-boot')
        self.snapshot()
        self.systemd.status.return_value = SimpleNamespace(is_cleanup_ready=False, control_group='/user.slice/gpuq-active.service', main_pid=0, invocation_id='a' * 32)
        self.assertEqual(self.store.get_job(child['id'])['after'], [parent['id']])
        self.tick()
        self.assertEqual(self.store.get_job(parent['id'])['state'], 'RUNNING')
        self.assertEqual(self.store.get_attempt(attempt['id'])['state'], 'RUNNING')
        self.systemd.terminate.assert_not_called(); self.systemd.kill.assert_not_called()
        self.assertEqual(self.store.get_job(child['id'])['state'], 'PENDING')
        with self.assertRaises(StoreConflictError):
            self.submit(submit_key=child['submit_key'], after=[])

    def test_shared_job_waits_without_reserving_vram(self):
        parent = self.submit()
        child = self.submit(after=[parent['id']], placement='pinned', requested_gpu_uuids=['GPU-0'], share_gpu=True, vram_mb=4096)
        self.tick()
        self.assertEqual(self.store.get_job(child['id'])['state'], 'PENDING')
        self.assertEqual(self.store.list_leases(job_id=child['id']), [])

    def test_gpu_submit_parser_keeps_repeated_and_comma_separated_dependencies(self):
        from gpuq.cli import build_parser
        args = build_parser().parse_args(['submit', '-g', '1', '--after', 'J000000000001,J000000000002', '--after', 'J000000000003', '--', '/bin/true'])
        self.assertEqual(args.after, ['J000000000001,J000000000002', 'J000000000003'])


if __name__ == '__main__':
    unittest.main()
