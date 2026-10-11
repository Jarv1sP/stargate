"""Real SQLite/Coordinator/CLI: human labels never mutate execution identity."""
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch
import uuid

loader=importlib.util.spec_from_file_location('display_priority_fixture',Path(__file__).with_name('gpuq-priority.test.py'))
F=importlib.util.module_from_spec(loader);loader.loader.exec_module(F)
from gpuq import cli
from gpuq.rpc import ApiError
from gpuq.constants import STORE_SCHEMA_VERSION
from gpuq.store import Store,StoreConflictError,StoreSchemaError

class Display(unittest.TestCase):
    setUp=F.SchedulerPriorityTests.setUp
    submit=F.SchedulerPriorityTests.submit
    snapshot=F.SchedulerPriorityTests.snapshot
    running=F.SchedulerPriorityTests.running

    def metadata(self, **changes):
        return {'name':'fashion-hm-teachers0-20261003','description':'当前实验\n不是执行命令',
            'submitter':{'name':'刘鹏亮','username':'刘鹏亮'},**changes}
    def args(self,job,**changes):
        return {'job_id':job['id'],'metadata':self.metadata(),'expected_submit_key':job['submit_key'],
            'expected_owner':job['owner'],'expected_name':job['name'],**changes}
    def test_running_job_display_roundtrips_without_any_lifecycle_or_idempotency_change(self):
        job,attempt=self.running((0,1),name='portal-34b24399',owner='portal-b720135b6e2fd1034922057c')
        before=self.store.get_job(job['id']);leases=self.store.list_leases();history=self.store.list_allocation_history(job_id=job['id'])
        digest=self.store._get_connection().execute('SELECT submit_digest FROM jobs WHERE id=?',(job['id'],)).fetchone()[0]
        self.coordinator.handle_api('set_job_display',self.args(job))
        after=self.store.get_job(job['id'])
        self.assertEqual({k:v for k,v in after.items() if k!='display_metadata'},{k:v for k,v in before.items() if k!='display_metadata'})
        self.assertEqual(self.store.list_leases(),leases);self.assertEqual(self.store.list_allocation_history(job_id=job['id']),history)
        self.assertEqual(self.store._get_connection().execute('SELECT submit_digest FROM jobs WHERE id=?',(job['id'],)).fetchone()[0],digest)
        self.assertEqual(self.store.list_attempts(job_id=job['id'])[0]['id'],attempt['id'])
        self.assertEqual(self.coordinator.handle_api('show',{'job_id':job['id']})['job']['display_metadata'],self.metadata())
        status=self.coordinator.handle_api('status',{});self.assertIn('job-display-v1',status['daemon']['capabilities'])
        lines='\n'.join(cli.format_status_table(status['jobs'],{}));self.assertIn('刘鹏亮',lines);self.assertIn(self.metadata()['name'],lines)
        self.assertNotIn('portal-b720',lines);self.assertEqual(status['jobs'][0]['owner'],job['owner'])
        count=len(self.store.list_events(job_id=job['id']));self.coordinator.handle_api('set_job_display',self.args(job));self.assertEqual(len(self.store.list_events(job_id=job['id'])),count)
        self.store.close();self.store.open();self.assertEqual(self.store.get_job(job['id'])['display_metadata'],self.metadata())
    def test_legacy_job_fallback_and_distinct_username_preserve_labels(self):
        job=self.submit(owner='alice',name='native-train')
        self.assertIn('alice','\n'.join(cli.format_status_table([job],{})))
        meta=self.metadata(submitter={'name':'显示姓名','username':'alice'})
        self.coordinator.handle_api('set_job_display',self.args(job,metadata=meta))
        text='\n'.join(cli.format_status_table([self.store.get_job(job['id'])],{}));self.assertIn('显示姓名 (alice)',text)
    def test_cross_job_binding_and_unsafe_text_are_rejected_without_mutation(self):
        job=self.submit()
        for extra in ({'expected_submit_key':'wrong'},{'expected_owner':'other'},{'expected_name':'other'}):
            with self.assertRaises(ApiError):self.coordinator.handle_api('set_job_display',self.args(job,**extra))
        for value in ('bad\x1b[31m','bad\u202e','bad\u0085'):
            with self.assertRaises(ApiError):self.coordinator.handle_api('set_job_display',self.args(job,metadata=self.metadata(name=value)))
        with self.assertRaises(ApiError):self.coordinator.handle_api('set_job_display',{**self.args(job),'argv':['other']})
        self.assertEqual(self.store.get_job(job['id'])['display_metadata'],{})
    def test_v12_running_schema_migration_keeps_rows_attempts_leases_and_digest(self):
        job,attempt=self.running((0,1));path=self.root/'legacy12.db'
        current=sqlite3.connect(self.config.db_path);old=sqlite3.connect(path);current.backup(old);current.close()
        old.execute('DROP TABLE managed_job_completions')
        old.execute('DROP TRIGGER jobs_allocation_authority_immutable');old.execute('DROP TABLE allocation_grants')
        old.execute('ALTER TABLE jobs DROP COLUMN allocation_authority')
        old.execute('ALTER TABLE jobs DROP COLUMN display_json');old.execute('UPDATE schema_meta SET schema_version=12');old.execute('PRAGMA user_version=12');old.commit()
        prior=old.execute('SELECT id,submit_key,submit_digest,state,owner,name FROM jobs').fetchall();leases=old.execute('SELECT * FROM leases').fetchall();old.close()
        # Ordinary daemon/store open must not silently upgrade an active DB.
        with self.assertRaises(StoreSchemaError):Store(path).open()
        with sqlite3.connect(path) as untouched:
            self.assertEqual(untouched.execute('PRAGMA user_version').fetchone()[0],12)
            self.assertNotIn('display_json',[r[1] for r in untouched.execute('PRAGMA table_info(jobs)')])
        broken=Store(path)
        with patch.object(broken,'_validate_schema',side_effect=RuntimeError('migration interrupted')):
            with self.assertRaisesRegex(RuntimeError,'migration interrupted'):broken.initialize()
        with sqlite3.connect(path) as unchanged:
            self.assertEqual(unchanged.execute('PRAGMA user_version').fetchone()[0],12)
            self.assertNotIn('display_json',[r[1] for r in unchanged.execute('PRAGMA table_info(jobs)')])
            self.assertEqual(unchanged.execute('SELECT * FROM leases').fetchall(),leases)
        migrated=Store(path).initialize()
        try:
            self.assertEqual(migrated.check_integrity()['schema_version'],STORE_SCHEMA_VERSION)
            self.assertEqual([tuple(r) for r in migrated._get_connection().execute('SELECT id,submit_key,submit_digest,state,owner,name FROM jobs')],prior)
            self.assertEqual([tuple(r) for r in migrated._get_connection().execute('SELECT * FROM leases')],leases)
            self.assertEqual(migrated.get_job(job['id'])['display_metadata'],{})
        finally:migrated.close()
    def test_cli_writes_typed_metadata_with_fences(self):
        args=cli.build_parser().parse_args(['set-display','Jjob','--expected-submit-key','key',
          '--expected-owner','portal-owner','--expected-name','portal-name','--name','中文 任务',
          '--submitter-name','刘鹏亮','--username','刘鹏亮','--description','内容'])
        with patch.object(cli,'get_client') as get:
            get.return_value.call.return_value={'job_id':'Jjob'}
            with patch('sys.stdout',new=io.StringIO()):args.func(args)
            op,payload=get.return_value.call.call_args.args
            self.assertEqual(op,'set_job_display');self.assertEqual(payload['metadata']['name'],'中文 任务');self.assertEqual(payload['expected_submit_key'],'key')
    def test_display_cas_is_atomic_and_stale_edits_do_not_mutate_execution(self):
        from gpuq.job_display import display_revision
        job,attempt=self.running((0,1));before=self.store.get_job(job['id']);leases=self.store.list_leases()
        old=display_revision({})
        changed=self.coordinator.handle_api('set_job_display',self.args(job,expected_display_revision=old))
        self.assertEqual(changed['revision'],display_revision(self.metadata()))
        for value in (old,None,'x'*64,42):
            with self.assertRaises(ApiError):self.coordinator.handle_api('set_job_display',self.args(job,metadata=self.metadata(name='冲突改名'),expected_display_revision=value))
        after=self.store.get_job(job['id'])
        self.assertEqual({k:v for k,v in before.items() if k!='display_metadata'},{k:v for k,v in after.items() if k!='display_metadata'})
        self.assertEqual(self.store.list_leases(),leases);self.assertEqual(self.store.list_attempts(job_id=job['id'])[0]['id'],attempt['id'])
        self.assertIn('job-display-cas-v1',self.coordinator.handle_api('status',{})['daemon']['capabilities'])
    def test_revision_hash_is_order_independent_and_cli_carries_exact_expectation(self):
        from gpuq.job_display import display_revision
        value=self.metadata();reordered={'submitter':{'username':value['submitter']['username'],'name':value['submitter']['name']},'description':value['description'],'name':value['name']}
        self.assertEqual(display_revision(value),display_revision(reordered))
        args=cli.build_parser().parse_args(['set-display','Jjob','--expected-submit-key','key','--expected-owner','alice',
          '--expected-name','raw','--name','标签','--submitter-name','alice','--username','alice','--expected-display-revision','a'*64])
        with patch.object(cli,'get_client') as client,patch.object(cli,'print_result'):
            args.func(args);self.assertEqual(client.return_value.call.call_args.args[1]['expected_display_revision'],'a'*64)

if __name__=='__main__':unittest.main()
