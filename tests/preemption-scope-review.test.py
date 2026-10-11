"""Independent requester-scope review: promises, takeover, outbox and v11 retry."""
import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('scope_review_fixture',ROOT/'tests/gpuq-priority.test.py')
F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
from gpuq import cluster_node
from gpuq.store import Store, STORE_SCHEMA_VERSION, _schema_signature, _EXPECTED_SCHEMA_SIGNATURE_V11

class ScopeReview(unittest.TestCase):
    # Reuse setup helpers without re-running every inherited fixture test.
    setUp=F.SchedulerPriorityTests.setUp
    snapshot=F.SchedulerPriorityTests.snapshot
    submit=F.SchedulerPriorityTests.submit
    running=F.SchedulerPriorityTests.running
    pinned=F.SchedulerPriorityTests.pinned
    state=F.SchedulerPriorityTests.state

    def test_shared_lease_protects_a_volunteering_holder_from_scoped_preemption(self):
        holder,attempt=self.running(priority=0,yield_policy='now')
        self.coordinator._statuses[attempt['id']]=object()
        shared=self.pinned(priority=1,share_gpu=True,vram_mb=1024)
        self.coordinator._schedule_shared()
        shared_attempt=self.store.list_attempts(job_id=shared['id'])[0]
        self.store.update_attempt(shared_attempt['id'],state='RUNNING')
        self.store.update_job(shared['id'],state='RUNNING')
        self.coordinator._statuses[shared_attempt['id']]=object()
        actions=self.store.list_actions()
        for mode in ('preempt-save','preempt-now'):
            requester=self.pinned(priority=4,dispatch_mode=mode,preempt_opt_in_only=True)
            self.coordinator._schedule()
            self.assertEqual(self.state(requester),'PENDING')
            self.assertEqual(self.state(holder),'RUNNING');self.assertEqual(self.state(shared),'RUNNING')
            self.assertEqual(self.store.list_actions(),actions)
            self.assertEqual(self.coordinator._promised_preemption_gpu_uuids(requester),set())
            self.store.update_job(requester['id'],state='CANCELED')
        self.assertEqual(len(self.store.list_leases()),2)

    def test_legacy_hard_promise_is_not_reused_by_scoped_requester(self):
        old,attempt=self.running(priority=0,yield_policy='legacy')
        self.pinned(priority=2,dispatch_mode='preempt-now')
        self.coordinator._schedule()
        restricted=self.pinned(priority=4,dispatch_mode='preempt-now',preempt_opt_in_only=True)
        self.assertEqual(self.coordinator._promised_preemption_gpu_uuids(restricted),set())
        self.coordinator._schedule()
        self.assertEqual(len(self.store.list_actions()),1)
        self.assertEqual(self.state(old),'PREEMPTING')

    def test_scoped_request_does_not_take_over_legacy_save_or_borrow_its_promise(self):
        _,attempt=self.running(priority=0,yield_policy='legacy',checkpoint_capability='epoch-v1')
        self.pinned(priority=2,dispatch_mode='preempt-save')
        self.coordinator._schedule()
        restricted=self.pinned(priority=4,dispatch_mode='preempt-now',preempt_opt_in_only=True)
        self.assertEqual(self.coordinator._save_takeover_candidates(restricted),[])
        self.assertEqual(self.coordinator._promised_preemption_gpu_uuids(restricted),set())
        self.coordinator._schedule()
        self.assertEqual(self.store.get_attempt(attempt['id'])['state'],'SAVE_REQUESTED')
        self.assertEqual(len(self.store.list_actions()),1)

    def test_explicit_now_volunteer_allows_higher_scoped_hard_takeover(self):
        _,attempt=self.running(priority=0,yield_policy='now',checkpoint_capability='epoch-v1')
        self.pinned(priority=2,dispatch_mode='preempt-save')
        self.coordinator._schedule()
        restricted=self.pinned(priority=4,dispatch_mode='preempt-now',preempt_opt_in_only=True)
        self.assertEqual([v.attempt_id for v in self.coordinator._save_takeover_candidates(restricted)],[attempt['id']])
        self.coordinator._schedule()
        current=self.store.get_attempt(attempt['id'])
        self.assertEqual(current['state'],'TERM_REQUESTED');self.assertEqual(current['preempt_requested_by_job_id'],restricted['id'])

    def test_outbox_with_unintended_out_of_scope_requester_rolls_back_before_signal(self):
        old,attempt=self.running(priority=0,yield_policy='legacy')
        self.pinned(priority=2,dispatch_mode='preempt-now');self.coordinator._schedule()
        restricted=self.pinned(priority=4,dispatch_mode='preempt-now',preempt_opt_in_only=True)
        # Temporary fault injection: persist a bad requester reference to test
        # the last check before an undelivered signal, not only the planner.
        self.store.update_attempt(attempt['id'],preempt_requested_by_job_id=restricted['id'])
        action=self.store.list_actions()[0]
        self.assertEqual(self.coordinator._execute_signal(action,kill=False),{'withdrawn':True})
        self.assertEqual(self.state(old),'RUNNING');self.systemd.terminate.assert_not_called()

    def test_cluster_offer_cannot_report_legacy_victim_capacity_to_scoped_requester(self):
        self.running(priority=0,yield_policy='legacy')
        restricted=self.pinned(priority=4,dispatch_mode='preempt-now',preempt_opt_in_only=True)
        self.store.update_job(restricted['id'],state='CANCELED');self.coordinator._health='ok'
        self.assertNotEqual(cluster_node.offer(self.coordinator,restricted)['kind'],'preempt')
        self.assertEqual(cluster_node.offer(self.coordinator,{**restricted,'preempt_opt_in_only':False})['kind'],'preempt')

    def test_v11_migration_retains_legacy_submission_digest_and_retry_identity(self):
        job=self.submit();old=self.root/'retry-v11.db'
        with closing(sqlite3.connect(self.config.db_path)) as source,closing(sqlite3.connect(old)) as target:
            source.backup(target);before=target.execute('SELECT submit_digest FROM jobs WHERE id=?',(job['id'],)).fetchone()[0]
            target.execute('DROP TRIGGER jobs_allocation_authority_immutable')
            target.execute('DROP TABLE allocation_grants')
            target.execute('ALTER TABLE jobs DROP COLUMN allocation_authority')
            target.execute('ALTER TABLE jobs DROP COLUMN display_json');target.execute('ALTER TABLE jobs DROP COLUMN preempt_opt_in_only');target.execute('UPDATE schema_meta SET schema_version=11');target.execute('PRAGMA user_version=11');target.commit()
            self.assertEqual(_schema_signature(target), _EXPECTED_SCHEMA_SIGNATURE_V11)
        migrated=Store(old).initialize()
        try:
            self.assertEqual(migrated.check_integrity()['schema_version'], STORE_SCHEMA_VERSION)
            self.assertIsNone(migrated.get_job(job['id'])['allocation_authority'])
            with closing(sqlite3.connect(old)) as db:self.assertEqual(db.execute('SELECT submit_digest FROM jobs WHERE id=?',(job['id'],)).fetchone()[0],before)
            fields={k:job[k] for k in ('submit_key','name','owner','priority','dispatch_mode','checkpoint_capability','restart_policy','gpu_count','placement','requested_gpu_uuids','argv','cwd','env','yield_policy')}
            self.assertEqual(migrated.submit_job(fields)['id'],job['id']);self.assertFalse(migrated.get_job(job['id'])['preempt_opt_in_only'])
        finally:migrated.close()

if __name__=='__main__':unittest.main()
