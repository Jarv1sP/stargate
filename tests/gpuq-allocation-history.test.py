"""Exact durable lease boundaries, entirely local SQLite and mocked GPU/systemd."""
import importlib.util
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import Mock, patch

path = Path(__file__).with_name('gpuq-priority.test.py')
loader = importlib.util.spec_from_file_location('priority_history_fixture', path)
fixture = importlib.util.module_from_spec(loader)
loader.loader.exec_module(fixture)
from gpuq import store as S
from gpuq.rpc import ApiError


class History(unittest.TestCase):
    setUp = fixture.SchedulerPriorityTests.setUp
    submit = fixture.SchedulerPriorityTests.submit
    snapshot = fixture.SchedulerPriorityTests.snapshot
    running = fixture.SchedulerPriorityTests.running

    def history(self, job):
        return self.store.list_allocation_history(job_id=job['id'])

    def test_acquire_release_exact_times_and_retry_does_not_add_history(self):
        self.store._clock = lambda: 100.25
        job, attempt = self.running((0, 1))
        original = self.history(job)
        self.assertEqual(len(original), 2)
        self.assertTrue(all(row['acquired_at'] == 100.25 and row['released_at'] is None
                            and row['source'] == 'observed' for row in original))
        self.store._clock = lambda: 150.75
        self.store.heartbeat_leases(attempt['id'])
        self.store.acquire_leases(job['id'], attempt['id'], {'GPU-0': 0, 'GPU-1': 1})
        self.assertEqual(self.history(job), original)
        self.assertEqual(self.store.release_leases(attempt_id=attempt['id'], reason='completed'), 2)
        for row in self.history(job):
            self.assertEqual((row['acquired_at'], row['released_at'], row['release_reason']), (100.25, 150.75, 'completed'))
        self.store._clock = lambda: 200
        self.assertEqual(self.store.release_leases(attempt_id=attempt['id']), 0)
        self.assertTrue(all(row['released_at'] == 150.75 for row in self.history(job)))

    def test_wrong_token_and_other_gpu_cannot_create_fake_release(self):
        job, attempt = self.running()
        before = self.history(job)
        self.assertEqual(self.store.release_leases(attempt_id=attempt['id'], lease_token='wrong'), 0)
        self.assertEqual(self.store.release_leases(attempt_id=attempt['id'], gpu_uuids=['GPU-other']), 0)
        self.assertEqual(self.history(job), before)
        self.assertEqual(len(self.store.list_leases()), 1)

    def test_partial_release_and_reacquisition_preserve_surviving_interval(self):
        self.store._clock = lambda: 100
        job, attempt = self.running((0, 1))
        old_token = self.store.list_leases()[0]['lease_token']
        self.store._clock = lambda: 200
        self.store.release_leases(attempt_id=attempt['id'], gpu_uuids=['GPU-0'])
        self.store._clock = lambda: 300
        leases = self.store.acquire_leases(job['id'], attempt['id'], {'GPU-0': 0, 'GPU-1': 1})
        self.assertNotEqual(leases[0]['lease_token'], old_token)
        rows = self.history(job)
        self.assertEqual(len(rows), 3)
        self.assertEqual([(r['acquired_at'], r['released_at']) for r in rows if r['gpu_uuid'] == 'GPU-1'], [(100, None)])
        self.assertEqual([(r['acquired_at'], r['released_at']) for r in rows if r['gpu_uuid'] == 'GPU-0'], [(300, None), (100, 200)])

    def test_release_transaction_failure_keeps_lease_and_open_interval(self):
        job, attempt = self.running()
        before, leases = self.history(job), self.store.list_leases()
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            with self.store.transaction() as tx:
                tx.release_leases(attempt_id=attempt['id'])
                raise RuntimeError('injected')
        self.assertEqual(self.history(job), before)
        self.assertEqual(self.store.list_leases(), leases)


    def test_shared_gpu_history_is_bound_to_each_attempt(self):
        first = self.submit(share_gpu=True, vram_mb=1000, placement='pinned', requested_gpu_uuids=['GPU-0'])
        second = self.submit(share_gpu=True, vram_mb=1000, placement='pinned', requested_gpu_uuids=['GPU-0'])
        for job in (first, second):
            attempt = self.store.create_attempt(job['id'], state='RUNNING', gpu_uuids=['GPU-0'], gpu_indices=[0])
            self.store.acquire_leases(job['id'], attempt['id'], {'GPU-0': 0}, memory_capacity_mb=24000)
        a = self.history(first)[0]
        b = self.history(second)[0]
        self.assertNotEqual(a['attempt_id'], b['attempt_id'])
        self.store.release_leases(attempt_id=a['attempt_id'])
        self.assertIsNotNone(self.history(first)[0]['released_at'])
        self.assertIsNone(self.history(second)[0]['released_at'])

    def test_show_pages_are_bounded_and_job_scoped(self):
        job, attempt = self.running()
        other, _ = self.running((1,))
        for _ in range(3):
            self.store.release_leases(attempt_id=attempt['id'])
            self.store.acquire_leases(job['id'], attempt['id'], {'GPU-0': 0})
        first = self.coordinator.handle_api('show', {'job_id': job['id'], 'history_limit': 2})
        self.assertTrue(first['allocation_history_available'])
        self.assertTrue(first['allocation_history_truncated'])
        page = self.coordinator.handle_api('show', {'job_id': job['id'], 'history_limit': 2,
            'history_before_id': first['allocation_history_next_before_id']})
        self.assertFalse(page['allocation_history_truncated'])
        rows = first['allocation_history'] + page['allocation_history']
        self.assertEqual(len({row['id'] for row in rows}), 4)
        self.assertTrue(all(row['job_id'] == job['id'] for row in rows))
        for args in ({'history_limit': True}, {'history_limit': 0}, {'history_limit': 257},
                     {'history_before_id': True}, {'history_before_id': 0}):
            with self.assertRaises(ApiError):
                self.coordinator.handle_api('show', {'job_id': other['id'], **args})



if __name__ == '__main__':
    unittest.main()
