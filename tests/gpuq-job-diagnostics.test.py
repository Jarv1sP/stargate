"""Diagnostic ledger facts, with real SQLite/socket and no host/GPU probes."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('diagnostic_fixture', Path(__file__).with_name('gpuq-job-observation.test.py'))
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)
from gpuq.protocol import Client
from gpuq.rpc import ApiError, _ThreadingUnixServer


class JobDiagnosticTests(unittest.TestCase):
    setUp = F.JobObservationTests.setUp
    snapshot = F.JobObservationTests.snapshot
    managed = F.JobObservationTests.managed
    attempt = F.JobObservationTests.attempt
    progress = F.JobObservationTests.progress

    def read(self, job):
        return self.coordinator.handle_api('job_diagnostics', {'submit_key': job['submit_key']})

    def elastic(self):
        key = str(uuid.uuid4())
        result = self.coordinator.handle_api('submit_managed', {'grant_id': key, 'max_gpu_count': 2, 'submission': {
            'submit_key': key, 'name': 'elastic-diagnostics', 'owner': 'owner', 'priority': 2, 'dispatch_mode': 'queue',
            'yield_policy': 'save', 'checkpoint_capability': 'epoch-v1', 'restart_policy': 'on-preempt',
            'gpu_count': 4, 'min_gpu_count': 1, 'elastic_gpu_count': True, 'auto_scale_up': True,
            'target_global_batch_size': 64, 'per_device_micro_batch_size': 4,
            'placement': 'any', 'requested_gpu_uuids': [], 'argv': [sys.executable, '-c', 'never-run'], 'cwd': str(self.root), 'env': {}}})
        return self.store.get_job(result['job_id'])

    def test_diagnostics_is_one_read_only_statement_and_retains_existing_progress_validation(self):
        job = self.managed(); attempt = self.attempt(job); self.progress(job, attempt)
        action = self.store.enqueue_action(job_id=job['id'], attempt_id=attempt['id'], action_type='TERM_UNIT',
            payload={'private': 'not-public-payload'}, available_at=1)
        first_claim = self.store.claim_actions('fixture-worker', now=self.coordinator.clock())[0]
        self.store.fail_action(action['id'], 'not-public-action-error', retry=True, available_at=1, claim_token=first_claim['claim_token'])
        claimed = self.store.claim_actions('fixture-worker', now=self.coordinator.clock())
        self.assertEqual(len(claimed), 1)
        db = self.store._get_connection(); before, queries = '\n'.join(db.iterdump()), []
        db.execute('PRAGMA query_only=ON'); db.set_trace_callback(queries.append)
        try: result = self.read(job)
        finally: db.set_trace_callback(None); db.execute('PRAGMA query_only=OFF')
        self.assertEqual(len([query for query in queries if query.lstrip().upper().startswith('SELECT')]), 1)
        self.assertEqual('\n'.join(db.iterdump()), before)
        self.assertEqual(result['progress']['snapshot']['epochs_completed'], 3)
        resource = result['resources']
        self.assertEqual(resource['lease_count'], 2); self.assertEqual(len(resource['leases']), 2)
        self.assertEqual(resource['allowed_gpu_counts'], [2])
        self.assertEqual(resource['pending_action_count'], 1)
        self.assertEqual(resource['pending_actions'][0]['error_recorded'], 1)
        self.assertEqual(resource['pending_actions'][0]['claim_recorded'], 1)
        for hidden in ('not-public-payload', 'not-public-action-error', claimed[0]['claim_token'], 'unit_token', 'argv', 'control_dir'):
            self.assertNotIn(hidden, json.dumps(result))
        self.systemd.start.assert_not_called()

    def test_missing_and_zero_grants_remain_distinct_and_batch_legal_counts_come_from_native_policy(self):
        job = self.elastic()
        self.assertEqual(self.read(job)['resources']['allowed_gpu_counts'], [1, 2, 4])
        self.store.update_allocation_grant(job['id'], grant_id=job['submit_key'], expected_revision=1, max_gpu_count=0)
        zero = self.read(job)['resources']
        self.assertEqual(zero['grant']['max_gpu_count'], 0)
        self.assertEqual(zero['grant']['initial_max_gpu_count'], 2)
        self.store._get_connection().execute('DELETE FROM allocation_grants WHERE job_id=?', (job['id'],))
        missing = self.read(job)['resources']
        self.assertEqual(missing['mode'], 'external-v1'); self.assertIsNone(missing['grant'])

    def test_scale_reservations_do_not_become_leases_and_plan_completion_does_not_hide_remaining_leases(self):
        job = self.elastic(); attempt = self.attempt(job)
        self.store.update_attempt(attempt['id'], state='RUNNING')
        self.store.update_allocation_grant(job['id'], grant_id=job['submit_key'], expected_revision=1, max_gpu_count=4)
        plan = self.store.create_scale_up_plan(job['id'], attempt['id'], {f'GPU-{i}': i for i in range(4)})
        result = self.read(job)['resources']
        self.assertEqual(result['lease_count'], 2); self.assertEqual(result['reservation_count'], 2)
        self.assertEqual(result['scale_plan']['id'], plan['id'])
        self.assertEqual(result['scale_plan']['target_gpu_count'], 4)
        self.store.update_scale_up_plan(plan['id'], state='FAILED')
        failed = self.read(job)['resources']
        self.assertIsNone(failed['scale_plan']); self.assertEqual(failed['reservation_count'], 0)
        self.assertEqual(failed['reservations'], []); self.assertEqual(failed['lease_count'], 2)

    def test_terminal_job_and_older_attempt_leases_are_observed_without_releasing_them(self):
        job = self.managed(); first = self.attempt(job)
        self.store.update_attempt(first['id'], state='CANCELED')
        latest = self.attempt(job, leased=False)
        self.store.update_job(job['id'], state='CANCELED')
        result = self.read(job)
        self.assertEqual(result['job']['state'], 'CANCELED')
        self.assertEqual(result['latest_attempt']['id'], latest['id'])
        self.assertEqual({lease['attempt_id'] for lease in result['resources']['leases']}, {first['id']})
        self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 2)

    def test_pending_actions_are_bounded_and_only_belong_to_this_job(self):
        job = self.managed(); other = self.managed()
        for i in range(20): self.store.enqueue_action(job_id=job['id'], action_type='CLEANUP_UNIT', payload={'i': i})
        self.store.enqueue_action(job_id=other['id'], action_type='CLEANUP_UNIT', payload={'other': True})
        result = self.read(job)['resources']
        self.assertEqual(result['pending_action_count'], 20); self.assertEqual(len(result['pending_actions']), 16)
        self.assertEqual(result['lease_count'], 0); self.assertEqual(result['leases'], [])
        self.assertNotIn('other', json.dumps(result['pending_actions']))

    def test_real_socket_diagnostics_bypass_the_work_lock_without_probes_or_mutation_gate(self):
        job = self.managed(); self.attempt(job)
        path = self.root / 'diagnostics.sock'
        server = _ThreadingUnixServer(path, self.coordinator.handle_api, os.getuid(), 262144)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with (self.coordinator._lock,
                  patch.object(self.coordinator, '_api_status', side_effect=AssertionError('no dashboard')),
                  patch.object(self.coordinator, '_require_release_open', side_effect=AssertionError('no writes'))):
                result = Client(path, timeout=3).call('job_diagnostics', {'submit_key': job['submit_key']})
            self.assertEqual(result['resources']['lease_count'], 2)
            self.assertIsNone(self.coordinator.handle_api('job_diagnostics', {'submit_key': 'missing'}))
            with self.assertRaises(ApiError): self.coordinator.handle_api('job_diagnostics', {'submit_key': job['submit_key'], 'hostPath': '/other'})
        finally: server.shutdown(); server.server_close(); thread.join(5)
        self.assertFalse(thread.is_alive()); self.systemd.start.assert_not_called()


if __name__ == '__main__':
    unittest.main()
