"""One-job read lane: real SQLite and Unix sockets, no GPU or systemd actions."""
import importlib.util
import json
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('job_observation_fixture', Path(__file__).with_name('gpuq-execution-snapshot.test.py'))
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)
from gpuq.protocol import Client
from gpuq.rpc import ApiError, _ThreadingUnixServer
from gpuq.store import StoreCorruptError


class JobObservationTests(unittest.TestCase):
    snapshot = F.ExecutionSnapshotTests.snapshot
    managed = F.ExecutionSnapshotTests.managed
    attempt = F.ExecutionSnapshotTests.attempt

    def setUp(self):
        F.ExecutionSnapshotTests.setUp(self)
        self.observed_at = self.coordinator.clock()
        self.coordinator.clock = lambda: self.observed_at

    def read(self, job):
        return self.coordinator.handle_api('job_observation', {'submit_key': job['submit_key']})

    def progress(self, job, attempt, sequence=1):
        self.store.accept_attempt_progress({'version': 1, 'job_id': job['id'], 'attempt_id': attempt['id'],
            'sequence': sequence, 'phase': 'train', 'epochs_completed': 3, 'epochs_total': 10,
            'steps_completed': 30, 'steps_total': 100, 'metrics': {'loss': 0.25}, 'eta_seconds': 60,
            'stall_timeout_seconds': 30, 'severity': 'info', 'message': None}, observed_at=self.coordinator.clock())

    def test_pending_job_has_no_invented_attempt_or_progress_and_keeps_original_identity(self):
        job = self.managed()
        result = self.read(job)
        self.assertEqual(result['job']['id'], job['id'])
        self.assertEqual(result['job']['submit_key'], job['submit_key'])
        self.assertEqual(result['job']['submit_digest'], self.store.get_submission_receipt(job['submit_key'])['submit_digest'])
        self.assertEqual(result['job']['state'], 'PENDING')
        self.assertIsNone(result['latest_attempt'])
        self.assertIsNone(result['progress'])
        self.assertEqual(result['latest_event_id'], 0)
        self.assertIsNone(self.coordinator.handle_api('job_observation', {'submit_key': 'missing'}))
        for private in ('private-command-not-returned', 'private-env-not-returned', 'cwd', 'argv', 'control_dir', 'unit_token', 'log_path'):
            self.assertNotIn(private, json.dumps(result))

    def test_one_read_only_statement_joins_latest_attempt_and_validated_progress(self):
        job = self.managed()
        attempt = self.attempt(job)
        self.progress(job, attempt)
        self.store.append_event('fixture-event', job_id=job['id'])
        connection = self.store._get_connection()
        before, changes, queries = '\n'.join(connection.iterdump()), connection.total_changes, []
        connection.set_trace_callback(queries.append)
        connection.execute('PRAGMA query_only=ON')
        try:
            result = self.read(job)
        finally:
            connection.execute('PRAGMA query_only=OFF')
            connection.set_trace_callback(None)
        self.assertEqual(len([query for query in queries if query.lstrip().upper().startswith('SELECT')]), 1)
        self.assertEqual(connection.total_changes, changes)
        self.assertEqual('\n'.join(connection.iterdump()), before)
        old = self.coordinator.handle_api('job_watch', {'job_id': job['id']})
        self.assertEqual(result['progress'], old['progress'])
        self.assertEqual(result['latest_event_id'], old['latest_event_id'])
        self.assertEqual(result['latest_attempt']['id'], attempt['id'])
        self.assertEqual(result['latest_attempt']['gpu_uuids'], ['GPU-0', 'GPU-1'])
        self.assertEqual(result['progress']['snapshot']['epochs_completed'], 3)
        self.assertEqual(result['progress']['snapshot']['metrics'], {'loss': 0.25})
        self.assertEqual(result['progress']['source'], 'training-self-report')
        self.assertNotIn('attempt_id', result['progress']['snapshot'])
        self.systemd.start.assert_not_called()

    def test_new_attempt_never_inherits_the_previous_attempts_progress_or_error(self):
        job = self.managed()
        old = self.attempt(job)
        self.progress(job, old)
        self.coordinator._progress_errors[old['id']] = 'old report error'
        self.store.release_leases(attempt_id=old['id'])
        self.store.update_attempt(old['id'], state='PREEMPTED')
        current = self.attempt(job)
        result = self.read(job)
        self.assertEqual(result['latest_attempt']['id'], current['id'])
        self.assertEqual(result['latest_attempt']['ordinal'], 2)
        self.assertFalse(result['progress']['reported'])
        self.assertIsNone(result['progress']['snapshot'])
        self.assertIsNone(result['progress']['error'])
        self.assertEqual(len(self.store.list_attempt_progress(job_id=job['id'])), 1)

    def test_terminal_intent_and_still_running_attempt_remain_distinct_without_release(self):
        job = self.managed()
        attempt = self.attempt(job)
        self.progress(job, attempt)
        self.store.update_job(job['id'], state='CANCELED')
        leases = self.store.list_leases(job_id=job['id'])
        result = self.read(job)
        self.assertEqual(result['job']['state'], 'CANCELED')
        self.assertEqual(result['latest_attempt']['state'], 'RUNNING')
        self.assertIsNone(result['latest_attempt']['exit_code'])
        self.assertEqual(self.store.list_leases(job_id=job['id']), leases)
        self.assertEqual(self.store.list_actions(), [])

    def test_progress_corruption_is_rejected_instead_of_bypassing_existing_store_validation(self):
        job = self.managed()
        attempt = self.attempt(job)
        self.progress(job, attempt)
        self.store._get_connection().execute('UPDATE attempt_progress SET sequence=sequence+1 WHERE attempt_id=?', (attempt['id'],))
        with self.assertRaises(StoreCorruptError):
            self.read(job)
        self.assertEqual(self.store.get_job(job['id'])['state'], 'RUNNING')
        self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 2)

    def test_invalid_arguments_do_not_write_and_the_read_lane_does_not_run_maintenance_or_dashboard(self):
        job = self.managed()
        before = '\n'.join(self.store._get_connection().iterdump())
        for arguments in [{}, {'submit_key': ''}, {'submit_key': []}, {'submit_key': 'bad\0'},
                          {'submit_key': job['submit_key'], 'job_id': job['id']}]:
            with self.subTest(arguments=arguments), self.assertRaises(ApiError) as failure:
                self.coordinator.handle_api('job_observation', arguments)
            self.assertEqual(failure.exception.code, 'BAD_REQUEST')
        with (patch.object(self.coordinator, '_require_release_open', side_effect=AssertionError('write gate')),
              patch.object(self.coordinator, '_api_status', side_effect=AssertionError('dashboard'))):
            self.assertEqual(self.read(job)['job']['id'], job['id'])
        self.assertEqual('\n'.join(self.store._get_connection().iterdump()), before)
        self.assertIn('job-observation-v1', self.coordinator.handle_api('status', {})['daemon']['capabilities'])

    def test_real_socket_read_bypasses_coordinator_work_lock_and_never_starts_a_job(self):
        job = self.managed()
        attempt = self.attempt(job)
        self.progress(job, attempt)
        path = self.root / 'job-observation.sock'
        server = _ThreadingUnixServer(path, self.coordinator.handle_api, os.getuid(), 262144)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        before = '\n'.join(self.store._get_connection().iterdump())
        try:
            with self.coordinator._lock:
                result = Client(path, timeout=3).call('job_observation', {'submit_key': job['submit_key']})
            self.assertEqual(result, self.read(job))
            self.assertEqual('\n'.join(self.store._get_connection().iterdump()), before)
        finally:
            server.shutdown(); server.server_close(); thread.join(5)
        self.assertFalse(thread.is_alive())
        self.systemd.start.assert_not_called()


if __name__ == '__main__':
    unittest.main()
