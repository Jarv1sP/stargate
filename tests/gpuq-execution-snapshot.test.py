"""Fixed native attempt observations; real SQLite/socket, no service or GPU launch."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
import uuid

loader = importlib.util.spec_from_file_location('execution_snapshot_fixture', Path(__file__).with_name('gpuq-priority.test.py'))
F = importlib.util.module_from_spec(loader)
loader.loader.exec_module(F)
from gpuq.protocol import Client
from gpuq.rpc import ApiError, _ThreadingUnixServer
from gpuq.store import Store
from gpuq.submission import validate_submission


class ExecutionSnapshotTests(unittest.TestCase):
    setUp = F.SchedulerPriorityTests.setUp
    snapshot = F.SchedulerPriorityTests.snapshot
    submit = F.SchedulerPriorityTests.submit
    running = F.SchedulerPriorityTests.running

    def managed(self, maximum=2):
        key = str(uuid.uuid4())
        raw = {'submit_key': key, 'name': 'managed-run', 'owner': 'test-user', 'priority': 2,
            'dispatch_mode': 'queue', 'yield_policy': 'never', 'checkpoint_capability': 'none',
            'restart_policy': 'never', 'gpu_count': 2, 'placement': 'any', 'requested_gpu_uuids': [],
            'argv': [sys.executable, '-c', 'private-command-not-returned'], 'cwd': str(self.root),
            'env': {'PRIVATE_TOKEN': 'private-env-not-returned'}}
        clean = validate_submission(raw, 4, managed_gpu_uuids=self.config.managed_gpu_uuids)
        return self.store.submit_managed_job(clean, grant_id=key, max_gpu_count=maximum)

    def attempt(self, job, *, state='RUNNING', leased=True):
        identifier = 'A' + uuid.uuid4().hex
        control, log = self.coordinator._create_attempt_paths(job['id'], identifier)
        result = self.store.create_attempt(job['id'], attempt_id=identifier, state=state,
            gpu_uuids=['GPU-1', 'GPU-0'], gpu_indices=[1, 0], unit_name='gpuq-' + identifier.lower(),
            unit_token='attempt:' + identifier, boot_id='test-boot', invocation_id='b' * 32,
            control_dir=str(control), log_path=str(log))
        if leased:
            self.store.acquire_leases(job['id'], identifier, {'GPU-1': 1, 'GPU-0': 0})
        self.store.update_job(job['id'], state=state)
        return result

    def read(self, job, attempt):
        return self.coordinator.handle_api('execution_snapshot', {'submit_key': job['submit_key'], 'attempt_id': attempt['id']})

    def test_exact_job_attempt_grant_and_leases_come_from_one_read_only_statement(self):
        job = self.managed()
        attempt = self.attempt(job)
        connection = self.store._get_connection()
        before, changes, queries = '\n'.join(connection.iterdump()), connection.total_changes, []
        connection.set_trace_callback(queries.append)
        connection.execute('PRAGMA query_only=ON')
        try:
            result = self.read(job, attempt)
        finally:
            connection.execute('PRAGMA query_only=OFF')
            connection.set_trace_callback(None)
        reads = [query for query in queries if query.lstrip().upper().startswith('SELECT')]
        self.assertEqual(len(reads), 1)
        self.assertEqual(connection.total_changes, changes)
        self.assertEqual('\n'.join(connection.iterdump()), before)
        self.assertEqual(set(result), {'job', 'attempt', 'latest_attempt_id', 'grant', 'leases'})
        self.assertEqual(result['job'], {'id': job['id'], 'submit_key': job['submit_key'],
            'submit_digest': self.store.get_submission_receipt(job['submit_key'])['submit_digest'],
            'owner': 'test-user', 'name': 'managed-run', 'state': 'RUNNING',
            'version': self.store.get_job(job['id'])['version'], 'allocation_authority': 'external-v1'})
        self.assertEqual(result['attempt'], {key: attempt[key] for key in ('id', 'ordinal', 'state', 'version', 'unit_name',
            'unit_token', 'boot_id', 'invocation_id', 'main_pid', 'start_ticks', 'control_dir', 'gpu_uuids', 'gpu_indices')})
        self.assertEqual(result['latest_attempt_id'], attempt['id'])
        self.assertEqual(result['leases'], [{'gpu_uuid': 'GPU-0', 'gpu_index': 0}, {'gpu_uuid': 'GPU-1', 'gpu_index': 1}])
        self.assertEqual(result['grant'], {'grant_id': job['submit_key'], 'revision': 1, 'max_gpu_count': 2})
        self.assertNotIn('private-command-not-returned', json.dumps(result))
        self.assertNotIn('private-env-not-returned', json.dumps(result))
        self.assertNotIn('log_path', result['attempt'])
        self.systemd.start.assert_not_called()

    def test_unknown_and_cross_job_attempts_return_no_snapshot(self):
        first, first_attempt = self.running((0,), owner='first-owner')
        second, second_attempt = self.running((1,), owner='second-owner')
        for arguments in [{'submit_key': first['submit_key'], 'attempt_id': second_attempt['id']},
                          {'submit_key': second['submit_key'], 'attempt_id': first_attempt['id']},
                          {'submit_key': 'unknown', 'attempt_id': first_attempt['id']},
                          {'submit_key': first['submit_key'], 'attempt_id': 'missing'}]:
            with self.subTest(arguments=arguments):
                self.assertIsNone(self.coordinator.handle_api('execution_snapshot', arguments))

    def test_native_zero_and_missing_external_grants_remain_distinct(self):
        native, native_attempt = self.running()
        self.assertIsNone(self.read(native, native_attempt)['job']['allocation_authority'])
        self.assertIsNone(self.read(native, native_attempt)['grant'])
        managed = self.managed(maximum=0)
        attempt = self.attempt(managed, state='STARTING', leased=False)
        zero = self.read(managed, attempt)
        self.assertEqual(zero['job']['allocation_authority'], 'external-v1')
        self.assertEqual(zero['grant']['max_gpu_count'], 0)
        self.assertEqual(zero['leases'], [])
        self.assertEqual(zero['attempt']['gpu_uuids'], ['GPU-0', 'GPU-1'])
        self.assertEqual(zero['attempt']['gpu_indices'], [0, 1])
        self.store._get_connection().execute('DELETE FROM allocation_grants WHERE job_id=?', (managed['id'],))
        missing = self.read(managed, attempt)
        self.assertEqual(missing['job']['allocation_authority'], 'external-v1')
        self.assertIsNone(missing['grant'])
        self.assertEqual(missing['leases'], [])

    def test_released_lease_and_lower_grant_are_not_reconstructed_from_attempt_assignment(self):
        job = self.managed()
        attempt = self.attempt(job)
        self.store.release_leases(attempt_id=attempt['id'])
        self.store.update_allocation_grant(job['id'], grant_id=job['submit_key'], expected_revision=1, max_gpu_count=0)
        result = self.read(job, attempt)
        self.assertEqual(result['leases'], [])
        self.assertEqual(result['attempt']['gpu_uuids'], ['GPU-0', 'GPU-1'])
        self.assertEqual(result['attempt']['state'], 'RUNNING')
        self.assertEqual(result['grant'], {'grant_id': job['submit_key'], 'revision': 2, 'max_gpu_count': 0})

    def test_historical_attempt_never_silently_becomes_the_latest_attempt(self):
        job = self.managed()
        old = self.attempt(job)
        self.store.release_leases(attempt_id=old['id'])
        self.store.update_attempt(old['id'], state='CANCELED')
        latest = self.attempt(job, state='STARTING')
        previous = self.read(job, old)
        current = self.read(job, latest)
        self.assertEqual(previous['attempt']['id'], old['id'])
        self.assertEqual(previous['attempt']['state'], 'CANCELED')
        self.assertEqual(previous['leases'], [])
        self.assertEqual(previous['latest_attempt_id'], latest['id'])
        self.assertEqual(current['attempt']['id'], latest['id'])
        self.assertEqual(len(current['leases']), 2)
        reopened = Store(self.config.db_path)
        try:
            self.assertEqual(reopened.get_execution_snapshot(job['submit_key'], old['id']), previous)
        finally:
            reopened.close()

    def test_query_does_not_need_mutation_gate_and_invalid_requests_cannot_change_state(self):
        job, attempt = self.running()
        before = '\n'.join(self.store._get_connection().iterdump())
        with patch.object(self.coordinator, '_require_release_open', side_effect=AssertionError('write gate called')):
            self.assertEqual(self.read(job, attempt)['attempt']['id'], attempt['id'])
        invalid = [{}, {'submit_key': job['submit_key']}, {'submit_key': '', 'attempt_id': attempt['id']},
            {'submit_key': job['submit_key'], 'attempt_id': []}, {'submit_key': job['submit_key'], 'attempt_id': 'x' * 257},
            {'submit_key': job['submit_key'], 'attempt_id': 'bad\0'},
            {'submit_key': job['submit_key'], 'attempt_id': attempt['id'], 'job_id': job['id']}]
        for arguments in invalid:
            with self.subTest(arguments=arguments), self.assertRaises(ApiError) as error:
                self.coordinator.handle_api('execution_snapshot', arguments)
            self.assertEqual(error.exception.code, 'BAD_REQUEST')
        self.assertEqual('\n'.join(self.store._get_connection().iterdump()), before)
        self.assertIn('execution-snapshot-v1', self.coordinator.handle_api('status', {})['daemon']['capabilities'])

    def test_real_native_socket_returns_the_same_snapshot_without_execution(self):
        job = self.managed()
        attempt = self.attempt(job)
        path = self.root / 'execution.sock'
        server = _ThreadingUnixServer(path, self.coordinator.handle_api, os.getuid(), 262144)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = Client(path, timeout=3).call('execution_snapshot', {'submit_key': job['submit_key'], 'attempt_id': attempt['id']})
            self.assertEqual(result, self.store.get_execution_snapshot(job['submit_key'], attempt['id']))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.systemd.start.assert_not_called()
        self.assertEqual(len(self.store.list_jobs()), 1)


if __name__ == '__main__':
    unittest.main()
