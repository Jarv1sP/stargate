"""Explicit requester scope against real SQLite and native coordinator plans."""
import importlib.util
from pathlib import Path
import sqlite3
import sys
import unittest
import uuid
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('request_fixture',ROOT/'tests/gpuq-priority.test.py')
F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
from gpuq.policy import select_victims,VictimCandidate
from gpuq.store import StoreConflictError,Store,STORE_SCHEMA_VERSION,_schema_signature,_EXPECTED_SCHEMA_SIGNATURE_V11
from gpuq.submission import validate_submission

class RequestModes(F.SchedulerPriorityTests):
    def test_hard_opt_in_request_never_interrupts_a_legacy_victim(self):
        old,attempt=self.running(priority=0,yield_policy='legacy')
        request=self.pinned(priority=4,dispatch_mode='preempt-now',preempt_opt_in_only=True)
        self.coordinator._schedule()
        self.assertEqual(self.state(old),'RUNNING')
        self.assertEqual(self.state(request),'PENDING')
        self.assertEqual(self.store.list_actions(),[])
        with self.assertRaisesRegex(StoreConflictError,'scope'):
            self.coordinator._plan_preemption(request,self.coordinator._running_candidates())

    def test_hard_request_respects_save_only_victim(self):
        saved,attempt=self.running(priority=1,yield_policy='save',checkpoint_capability='epoch-v1',restart_policy='on-preempt')
        request=self.pinned(priority=4,dispatch_mode='preempt-now',preempt_opt_in_only=True)
        self.coordinator._schedule()
        self.assertIn('requested preempt-save',self.store.get_job(saved['id'])['state_reason'])
        self.assertEqual(self.store.get_attempt(attempt['id'])['state'],'SAVE_REQUESTED')

    def test_scope_is_part_of_submission_identity_and_defaults_are_compatible(self):
        key=str(uuid.uuid4())
        job=self.submit(submit_key=key,preempt_opt_in_only=True,dispatch_mode='preempt-now')
        self.assertTrue(job['preempt_opt_in_only'])
        self.assertEqual(self.submit(submit_key=key,preempt_opt_in_only=True,dispatch_mode='preempt-now')['id'],job['id'])
        with self.assertRaises(StoreConflictError):
            self.submit(submit_key=key,preempt_opt_in_only=False,dispatch_mode='preempt-now')
        with self.assertRaises(ValueError):self.submit(preempt_opt_in_only=1)

    def test_v11_upgrade_preserves_rows_and_adds_no_opt_in_consent(self):
        job,attempt=self.running(priority=1,yield_policy='save',checkpoint_capability='epoch-v1')
        old=self.root/'v11.db';source=sqlite3.connect(self.config.db_path);target=sqlite3.connect(old)
        source.backup(target);source.close()
        target.execute('DROP TRIGGER jobs_allocation_authority_immutable')
        target.execute('DROP TABLE allocation_grants')
        target.execute('ALTER TABLE jobs DROP COLUMN allocation_authority')
        target.execute('ALTER TABLE jobs DROP COLUMN preempt_opt_in_only')
        target.execute('ALTER TABLE jobs DROP COLUMN display_json')
        target.execute('UPDATE schema_meta SET schema_version=11')
        target.execute('PRAGMA user_version=11')
        self.assertEqual(_schema_signature(target), _EXPECTED_SCHEMA_SIGNATURE_V11)
        before=target.execute('SELECT * FROM leases').fetchall();target.commit();target.close()
        migrated=Store(old).initialize()
        try:
            self.assertFalse(migrated.get_job(job['id'])['preempt_opt_in_only'])
            self.assertEqual(migrated.get_attempt(attempt['id']),self.store.get_attempt(attempt['id']))
            self.assertEqual(migrated.list_leases(),self.store.list_leases())
            self.assertEqual(migrated.check_integrity()['schema_version'],STORE_SCHEMA_VERSION)
            self.assertIsNone(migrated.get_job(job['id'])['allocation_authority'])
        finally:migrated.close()

class ScopePolicy(unittest.TestCase):
    def test_all_priority_mode_and_victim_contract_combinations(self):
        for mode in ('queue','preempt-now','preempt-save'):
            for yielding in ('legacy','never','now','save'):
                for rank in range(5):
                    victim=VictimCandidate('A1','J1',rank,1,'epoch-v1',yield_policy=yielding)
                    result=select_victims(requester_priority=3,requester_gpu_count=1,free_gpu_count=0,dispatch_mode=mode,candidates=[victim],preempt_opt_in_only=True)
                    self.assertEqual(bool(result),rank<3 and yielding in ('now','save'))

if __name__=='__main__':unittest.main()
