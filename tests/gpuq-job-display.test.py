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
from gpuq.store import Store

class Display(unittest.TestCase):
    setUp=F.SchedulerPriorityTests.setUp
    submit=F.SchedulerPriorityTests.submit
    snapshot=F.SchedulerPriorityTests.snapshot
    running=F.SchedulerPriorityTests.running

    def metadata(self, **changes):
        return {'name':'fashion-hm-teachers0-20261003','description':'当前实验\n不是执行命令',
            'submitter':{'name':'示例成员','username':'示例成员'},**changes}
    def args(self,job,**changes):
        return {'job_id':job['id'],'metadata':self.metadata(),**changes}
    def test_running_job_display_roundtrips_without_any_lifecycle_or_idempotency_change(self):
        job,attempt=self.running((0,1),name='portal-00000001',owner='portal-000000000000000000000001')
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
        lines='\n'.join(cli.format_status_table(status['jobs'],{}));self.assertIn('示例成员',lines);self.assertIn(self.metadata()['name'],lines)
        self.assertNotIn('portal-0000',lines);self.assertEqual(status['jobs'][0]['owner'],job['owner'])
        count=len(self.store.list_events(job_id=job['id']));self.coordinator.handle_api('set_job_display',self.args(job));self.assertEqual(len(self.store.list_events(job_id=job['id'])),count)
        self.store.close();self.store.open();self.assertEqual(self.store.get_job(job['id'])['display_metadata'],self.metadata())
    def test_legacy_job_fallback_and_distinct_username_preserve_labels(self):
        job=self.submit(owner='alice',name='native-train')
        self.assertIn('alice','\n'.join(cli.format_status_table([job],{})))
        meta=self.metadata(submitter={'name':'显示姓名','username':'alice'})
        self.coordinator.handle_api('set_job_display',self.args(job,metadata=meta))
        text='\n'.join(cli.format_status_table([self.store.get_job(job['id'])],{}));self.assertIn('显示姓名 (alice)',text)
    def test_cli_writes_typed_metadata(self):
        args=cli.build_parser().parse_args(['set-display','Jjob','--name','中文 任务',
          '--submitter-name','示例成员','--username','示例成员','--description','内容'])
        with patch.object(cli,'get_client') as get:
            get.return_value.call.return_value={'job_id':'Jjob'}
            with patch('sys.stdout',new=io.StringIO()):args.func(args)
            op,payload=get.return_value.call.call_args.args
            self.assertEqual(op,'set_job_display');self.assertEqual(payload['metadata']['name'],'中文 任务')

if __name__=='__main__':unittest.main()
