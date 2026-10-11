"""Managed native lifecycle sealing; temporary DB/RPC, simulated systemd only."""
import importlib.util
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sqlite3
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

loader = importlib.util.spec_from_file_location('completion_fixture', Path(__file__).with_name('gpuq-allocation-authority.test.py'))
F = importlib.util.module_from_spec(loader); loader.loader.exec_module(F)
from gpuq import coordinator as C, store as S
from gpuq.backends import UnitNotFoundError, UnitIdentityError
from gpuq.rpc import ApiError, _ThreadingUnixServer
from gpuq.protocol import Client, ProtocolError


class ManagedCompletion(unittest.TestCase):
    snapshot = F.AllocationAuthoritySchema.snapshot
    submit = F.AllocationAuthoritySchema.submit
    managed_submission = F.AllocationAuthoritySchema.managed_submission

    def setUp(self):
        F.AllocationAuthoritySchema.setUp(self)
        self.systemd.status.return_value = SimpleNamespace(main_pid=0, is_cleanup_ready=True, control_group='/fixture/group')
        process_reader = patch.object(C, 'read_cgroup_tree_processes', return_value=[])
        self.members = process_reader.start(); self.addCleanup(process_reader.stop)

    def running_job(self, **overrides):
        submission = {**self.managed_submission(), **overrides}
        job = self.store.submit_managed_job(submission, grant_id=submission['submit_key'], max_gpu_count=2)
        attempt_id = 'A' + uuid.uuid4().hex
        attempt = self.store.create_attempt(job['id'], attempt_id=attempt_id,
            gpu_uuids=['GPU-0'], gpu_indices=[0], unit_name='gpuq-' + attempt_id.lower(), unit_token='attempt:' + attempt_id,
            boot_id='test-boot', invocation_id='a' * 32)
        self.store.update_attempt(attempt['id'], state='RUNNING')
        self.store.acquire_leases(job['id'], attempt['id'], {'GPU-0': 0})
        self.store.update_job(job['id'], state='RUNNING')
        return self.store.get_job(job['id']), self.store.get_attempt(attempt['id'])

    def finished_job(self, state='SUCCEEDED'):
        job, attempt = self.running_job()
        end = {'SUCCEEDED': ('EXITED_SUCCESS', 0), 'FAILED': ('EXITED_FAILURE', 1), 'CANCELED': ('CANCELED', -15)}[state]
        self.store.update_attempt(attempt['id'], state=end[0], exit_code=end[1])
        self.store.release_leases(attempt_id=attempt['id'])
        self.store.update_job(job['id'], state=state)
        return self.store.get_job(job['id']), self.store.get_attempt(attempt['id'])

    def args(self, job):
        submission = self.store.get_submission_receipt(job['submit_key'])
        return {'submit_key': job['submit_key'], 'grant_id': job['submit_key'], 'submit_digest': submission['submit_digest']}

    def complete(self, job):
        return self.coordinator.handle_api('complete_managed', self.args(job))

    def assert_unsealed(self, job):
        self.assertIsNone(self.store.get_managed_completion(job['id']))
        self.assertEqual(self.store.get_allocation_authorization(job['id'])['grant']['max_gpu_count'], 2)

    def test_seal_preserves_original_outcome_and_replays_one_receipt_without_observing_units_again(self):
        job, attempt = self.finished_job()
        receipt = self.complete(job)
        self.assertEqual(receipt['protocol'], 'managed-completion-v1')
        self.assertEqual(receipt['job_id'], job['id']); self.assertEqual(receipt['submit_key'], job['submit_key'])
        self.assertEqual(receipt['state'], 'SUCCEEDED'); self.assertEqual(receipt['native_version'], job['version'])
        self.assertEqual(receipt['latest_attempt']['id'], attempt['id'])
        self.assertEqual(receipt['latest_attempt']['exit_code'], 0)
        self.assertEqual(self.store.get_job(job['id']), job)
        grant = self.store.get_allocation_authorization(job['id'])['grant']
        self.assertEqual(grant, {'grant_id': job['submit_key'], 'revision': 2, 'max_gpu_count': 0})
        self.systemd.status.side_effect = AssertionError('must not re-observe a sealed lifecycle')
        self.assertEqual(self.complete(job), receipt)
        self.assertEqual(self.coordinator.handle_api('managed_completion', {'submit_key': job['submit_key']}), receipt)
        self.assertEqual(len([e for e in self.store.list_events(job_id=job['id']) if e['event_type'] == 'JOB_MANAGED_COMPLETED']), 1)
        self.systemd.start.assert_not_called(); self.systemd.terminate.assert_not_called(); self.systemd.cleanup.assert_not_called()
        reopened = S.Store(self.config.db_path)
        try:
            self.assertEqual(reopened.get_managed_completion(job['id']), receipt)
        finally: reopened.close()

    def test_sealed_job_cannot_retry_or_reopen_its_grant_but_native_tasks_keep_retry_behavior(self):
        job, _ = self.finished_job('FAILED'); receipt = self.complete(job)
        with self.assertRaises(ApiError) as caught:
            self.coordinator.handle_api('retry', {'job_id': job['id']})
        self.assertEqual(caught.exception.code, 'CONFLICT')
        with self.assertRaises(S.StoreConflictError): self.store.update_job(job['id'], state='PENDING')
        with self.assertRaises(S.StoreConflictError):
            self.store.update_allocation_grant(job['id'], grant_id=job['submit_key'], expected_revision=receipt['grant_revision'], max_gpu_count=2)
        ordinary = self.submit(); self.store.update_job(ordinary['id'], state='FAILED')
        self.assertEqual(self.coordinator.handle_api('retry', {'job_id': ordinary['id']})['state'], 'PENDING')
        self.assertEqual(self.store.get_allocation_authorization(ordinary['id']), {'mode': 'native', 'grant': None})

    def test_wrong_identity_or_unmanaged_job_cannot_be_completed(self):
        job, _ = self.finished_job()
        for changes in ({'grant_id': 'another'}, {'submit_digest': '0' * 64}):
            with self.subTest(changes=changes):
                with self.assertRaises(ApiError) as caught:
                    self.coordinator.handle_api('complete_managed', {**self.args(job), **changes})
                self.assertEqual(caught.exception.code, 'ALLOCATION_CONFLICT')
        ordinary = self.submit(); self.store.update_job(ordinary['id'], state='FAILED')
        with self.assertRaises(ApiError): self.complete(ordinary)
        self.assert_unsealed(job); self.systemd.status.assert_not_called()

    def test_live_unit_descendants_identity_errors_and_unknown_cgroup_all_retain_the_grant(self):
        job, _ = self.finished_job('CANCELED')
        scenarios = [(SimpleNamespace(main_pid=99, is_cleanup_ready=True, control_group=''), None),
                     (SimpleNamespace(main_pid=0, is_cleanup_ready=False, control_group=''), None),
                     (self.systemd.status.return_value, [99]),
                     (self.systemd.status.return_value, RuntimeError('unreadable cgroup')),
                     (UnitIdentityError('wrong invocation'), None)]
        for status, members in scenarios:
            self.systemd.status.side_effect = status if isinstance(status, Exception) else None
            if not isinstance(status, Exception): self.systemd.status.return_value = status
            self.members.side_effect = members if isinstance(members, Exception) else None
            self.members.return_value = members or []
            with self.subTest(status=status, members=members), self.assertRaises(ApiError) as caught: self.complete(job)
            self.assertEqual(caught.exception.code, 'COMPLETION_UNCONFIRMED'); self.assert_unsealed(job)

    def test_held_gpu_unfinished_attempt_and_pending_action_prevent_sealing(self):
        job, attempt = self.running_job()
        self.store.update_job(job['id'], state='CANCELED')
        with self.assertRaises(ApiError): self.complete(job)
        self.store.release_leases(attempt_id=attempt['id'])
        with self.assertRaises(ApiError): self.complete(job)
        self.store.update_attempt(attempt['id'], state='CANCELED', exit_code=-15)
        action = self.store.enqueue_action(job_id=job['id'], attempt_id=attempt['id'], action_type='CLEANUP_UNIT')
        with self.assertRaises(ApiError): self.complete(job)
        self.assert_unsealed(job)
        claim = self.store.claim_actions('fixture-worker')[0]
        self.store.complete_action(action['id'], claim_token=claim['claim_token'], result={'cleaned': True})
        self.systemd.status.side_effect = AssertionError('durable successful cleanup is already sufficient')
        self.assertEqual(self.complete(job)['state'], 'CANCELED')

    def test_collected_units_and_previous_boot_attempts_are_not_permanent_cleanup_blockers(self):
        job, _ = self.finished_job(); self.systemd.status.side_effect = UnitNotFoundError('collected')
        self.assertEqual(self.complete(job)['state'], 'SUCCEEDED')
        other, attempt = self.finished_job()
        self.store.update_attempt(attempt['id'], boot_id='previous-boot')
        self.systemd.status.side_effect = AssertionError('a process cannot survive its boot')
        self.assertEqual(self.complete(other)['state'], 'SUCCEEDED')

    def test_unfinished_expansion_and_its_reserved_gpu_both_prevent_completion(self):
        job, attempt = self.running_job(auto_scale_up=True, checkpoint_capability='epoch-v1', restart_policy='on-preempt',
                                        target_global_batch_size=8, per_device_micro_batch_size=2)
        plan = self.store.create_scale_up_plan(job['id'], attempt['id'], {'GPU-0': 0, 'GPU-1': 1})
        self.store.update_attempt(attempt['id'], state='CANCELED', exit_code=-15)
        self.store.release_leases(attempt_id=attempt['id']); self.store.update_job(job['id'], state='CANCELED')
        with self.assertRaises(ApiError): self.complete(job)
        self.assert_unsealed(job)
        self.store.release_scale_up_reservations(plan_id=plan['id'])
        with self.assertRaises(ApiError): self.complete(job)
        self.assert_unsealed(job)
        self.store.update_scale_up_plan(plan['id'], state='CANCELED')
        self.assertEqual(self.complete(job)['state'], 'CANCELED')

    def test_completion_of_one_job_does_not_wait_for_or_release_a_neighbour_using_its_old_gpu(self):
        job, _ = self.finished_job(); neighbour, attempt = self.running_job()
        self.snapshot(occupied=(0,))
        before = self.store.list_leases(job_id=neighbour['id'])
        self.assertEqual(self.complete(job)['state'], 'SUCCEEDED')
        self.assertEqual(self.store.get_job(neighbour['id'])['state'], 'RUNNING')
        self.assertEqual(self.store.list_leases(job_id=neighbour['id']), before)
        self.assertEqual(before[0]['attempt_id'], attempt['id'])
        self.assert_unsealed(neighbour)

    def test_pending_or_lost_jobs_and_success_without_a_successful_attempt_are_not_completion(self):
        job, _ = self.running_job()
        for state in ('RUNNING', 'LOST'):
            self.store.update_job(job['id'], state=state)
            with self.assertRaises(ApiError): self.complete(job)
            self.assert_unsealed(job)
        submission = self.managed_submission()
        empty = self.store.submit_managed_job(submission, grant_id=submission['submit_key'], max_gpu_count=2)
        self.store.update_job(empty['id'], state='SUCCEEDED')
        with self.assertRaises(ApiError): self.complete(empty)
        self.assert_unsealed(empty)
        self.store.update_job(empty['id'], state='CANCELED')
        receipt = self.complete(empty)
        self.assertEqual(receipt['state'], 'CANCELED'); self.assertIsNone(receipt['latest_attempt'])

    def test_receipt_write_failure_rolls_back_zero_grant_and_event(self):
        job, _ = self.finished_job()
        db = self.store._get_connection()
        db.execute("CREATE TEMP TRIGGER fail_completion BEFORE INSERT ON managed_job_completions BEGIN SELECT RAISE(ABORT,'injected completion failure'); END")
        with self.assertRaises(sqlite3.IntegrityError): self.complete(job)
        self.assert_unsealed(job)
        self.assertEqual(self.store.get_allocation_authorization(job['id'])['grant']['revision'], 1)
        db.execute('DROP TRIGGER fail_completion')
        self.assertEqual(self.complete(job)['grant_revision'], 2)

    def test_gate_closing_during_unit_observation_prevents_the_final_write_but_queries_remain_readonly(self):
        job, _ = self.finished_job()
        opened = {'state': 'ABSENT', 'valid': True}; closed = {'state': 'CLOSED', 'valid': True, 'release_id': str(uuid.uuid4())}
        gate = [opened]; status = self.systemd.status.return_value
        def observed(**kwargs): gate[0] = closed; return status
        self.systemd.status.side_effect = observed
        with patch.object(C, '_read_release_gate', side_effect=lambda *_args: gate[0]):
            with self.assertRaises(ApiError) as caught: self.complete(job)
            self.assertEqual(caught.exception.code, 'MAINTENANCE'); self.assert_unsealed(job)
            before = self.store._get_connection().total_changes
            self.assertIsNone(self.coordinator.handle_api('managed_completion', {'submit_key': job['submit_key']}))
            self.assertEqual(self.store._get_connection().total_changes, before)

    def test_native_retry_and_completion_have_only_one_winning_lifecycle(self):
        job, _ = self.finished_job('FAILED'); ready = threading.Barrier(2)
        def operation(op):
            ready.wait()
            try:
                return self.coordinator.handle_api(op, self.args(job) if op == 'complete_managed' else {'job_id': job['id']})
            except ApiError: return None
        with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(operation, ['complete_managed', 'retry']))
        self.assertEqual(sum(result is not None for result in results), 1)
        if results[0] is not None:
            self.assertEqual(self.store.get_job(job['id'])['state'], 'FAILED')
            self.assertEqual(self.store.get_allocation_authorization(job['id'])['grant']['max_gpu_count'], 0)
        else:
            self.assertEqual(self.store.get_job(job['id'])['state'], 'PENDING'); self.assert_unsealed(job)

    def test_real_rpc_receipt_recovers_after_reply_loss_and_never_exposes_execution_payload(self):
        job, _ = self.finished_job(); path = self.root / 'completion.sock'; lost = threading.Event()
        def handle(op, args):
            result = self.coordinator.handle_api(op, args)
            if op == 'complete_managed' and not lost.is_set():
                lost.set(); raise ApiError('INTERNAL_ERROR', 'fixture reply lost after commit')
            return result
        server = _ThreadingUnixServer(path, handle, os.getuid(), 262144)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            client = Client(path, timeout=3)
            with self.assertRaises(ProtocolError) as caught: client.call('complete_managed', self.args(job))
            self.assertEqual(caught.exception.code, 'INTERNAL_ERROR')
            receipt = client.call('managed_completion', {'submit_key': job['submit_key']})
            self.assertEqual(receipt, self.store.get_managed_completion(job['id']))
            self.assertEqual(receipt['latest_attempt']['exit_code'], 0)
            self.assertTrue({'argv', 'env', 'control_dir', 'log_path'}.isdisjoint(receipt))
            self.assertEqual(client.call('complete_managed', self.args(job)), receipt)
        finally: server.shutdown(); server.server_close(); thread.join(5)

    def test_v15_upgrade_is_explicit_preserves_active_grants_and_rolls_back_on_failure(self):
        job, attempt = self.running_job(); path = self.root / 'v15.sqlite'
        old = sqlite3.connect(path); self.store._get_connection().backup(old)
        old.execute('DROP TABLE managed_job_completions')
        old.execute('UPDATE schema_meta SET schema_version=15'); old.execute('PRAGMA user_version=15'); old.commit(); old.close()
        store = S.Store(path)
        with self.assertRaises(S.StoreSchemaError): store.get_job(job['id'])
        with patch.object(S, '_SCHEMA_V15_TO_V16_DDL', (*S._SCHEMA_V15_TO_V16_DDL, 'INVALID MIGRATION SQL')):
            with self.assertRaises(S.StoreError): store.initialize()
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 15)
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='managed_job_completions'").fetchone())
        store.initialize()
        try:
            self.assertEqual(store.get_job(job['id']), job)
            self.assertEqual(store.get_attempt(attempt['id']), attempt)
            self.assertEqual(store.list_leases(job_id=job['id']), self.store.list_leases(job_id=job['id']))
            self.assertEqual(store.get_allocation_authorization(job['id'])['grant']['max_gpu_count'], 2)
            self.assertEqual(store.check_integrity()['schema_version'], 16)
            self.assertIsNone(store.get_managed_completion(job['id']))
        finally: store.close()


if __name__ == '__main__': unittest.main()
