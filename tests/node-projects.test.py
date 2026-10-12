"""Project RPC boundaries, atomic uploads and backward-compatible jobs."""
import base64
import importlib.util
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

DEPLOY=Path(__file__).resolve().parents[1]/'deploy'
class NodeProjects(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name).resolve()
        for name in ('platform-root-guard.py','node-executor.py','scheduling-policy.py','project-ops.py','project-store.py','project-lifecycle.py','sandbox-runner.py'):
            shutil.copy2(DEPLOY/name,self.base/name)
        conda=self.base/'conda';(conda/'bin').mkdir(parents=True);(conda/'bin/python').write_text('fake python')
        (conda/'conda-meta').mkdir();(conda/'lib').mkdir()
        (conda/'conda-meta/python-3.10.json').write_text(json.dumps({'name':'python','version':'3.10'}))
        (self.base/'node-config.json').write_text(json.dumps({'root':str(self.base/'state'),'conda':str(conda)}))
        spec=importlib.util.spec_from_file_location('node_project_test',self.base/'node-executor.py')
        self.n=importlib.util.module_from_spec(spec);sys.modules[spec.name]=self.n;spec.loader.exec_module(self.n)
        self.n.workspace('demo-user-42');self.ops=self.n.projects();self.ops.store.reserve_bytes=0
        self.args={'userId':'demo-user-42','project':'test-project'}
        self.call('projects.create')
        self.free=patch.object(self.ops.n.os,'statvfs',return_value=SimpleNamespace(f_bavail=100000000,f_bfree=100000000,f_blocks=100000000,f_frsize=4096));self.free.start()
    def tearDown(self):
        self.free.stop()
        for folder,_,files in os.walk(self.base):
            os.chmod(folder,0o700)
            for file in files:
                path=Path(folder)/file
                if not path.is_symlink():os.chmod(path,0o600)
        self.temp.cleanup()
    def call(self,op,**args):return self.n.process(op,{**self.args,**args})
    def test_live_workspace_adoption_is_owner_bound_and_retains_lifecycle(self):
        result=self.call('projects.workspace')
        self.assertEqual(result['state'],'AVAILABLE')
        self.assertTrue(result['workspace']['persistent'])
        self.assertEqual(result['lifecycle']['state'],'ACTIVE')
        self.assertEqual(self.call('projects.workspace')['workspace'],result['workspace'])
        with self.assertRaises(ValueError):self.call('projects.workspace',release='a'*64)
        with self.assertRaises(ValueError):self.call('projects.workspace',userId='demo-user-4')
    def test_interactive_shell_cannot_claim_automatic_command_replay(self):
        job={'id':str(uuid.uuid4()),'userId':'demo-user-42','username':'alice','cards':1,
             'name':'shell','minVramGiB':0,'project':'test-project','workspace':True,'interactive':True,
             'argv':['/bin/bash','--noprofile','--norc','-i']}
        self.assertEqual(self.n.validate_job(job,readonly=True)['restart_policy'],'never')
        job['scheduling']={'rank':'P1','yieldPolicy':'save','restartPolicy':'on-preempt','checkpointable':True}
        with self.assertRaisesRegex(ValueError,'cannot be replayed'):self.n.validate_job(job,readonly=True)
    def publication_worker(self, operation):
        task=self.ops.receipt(self.args)
        return self.ops.worker(operation,task['publicationId'],task['projectGeneration'])
    def upload(self,data=b'hello',**args):
        fields={'path':'train.py','uploadId':str(uuid.uuid4()),'totalSize':len(data),'sha256':hashlib.sha256(data).hexdigest(),'final':True,'offset':0,'data':base64.b64encode(data).decode()}
        with patch.object(self.ops,'active',return_value=False):return self.call('files.put',**{**fields,**args})
    def test_listing_and_isolated_owner(self):
        result=self.n.process('projects.list',{'userId':'demo-user-42'})
        self.assertEqual(result['projects'][0]['project'],'test-project')
        self.assertEqual(result['environmentModes'], ['shared', 'isolated'])
        self.assertEqual(self.n.process('projects.list',{'userId':'demo-user-4'}),
                         {'projects':[], 'environmentModes':['shared', 'isolated']})
        with self.assertRaises(ValueError):self.call('projects.status',userId='demo-user-4')
    def test_environment_capability_is_scoped_without_engine_or_graph_creation(self):
        for name in ('personal-oci.py', 'storage-quota.py'):
            shutil.copy2(DEPLOY/name, self.base/name)
        self.n.CONFIG['storageQuota'] = {'enabled':False}
        sha = 'a'*64
        self.n.CONFIG['personalOci'] = {'enabled':True, 'owners':['demo-user-42'],
            'autoOwners':True, 'autoOwnersRevision':1,
            'baseImage':'docker.io/library/python@sha256:'+sha,
            'podmanSHA256':sha, 'runtimeSHA256':sha, 'cdiSHA256':sha}
        with patch.object(subprocess, 'run', side_effect=AssertionError('No engine probe')):
            self.assertEqual(self.ops.environment_modes('demo-user-42'), ['shared', 'isolated', 'oci'])
            self.assertEqual(self.ops.environment_modes('demo-user-4'), ['shared', 'isolated'])
            self.n.CONFIG['personalOci']['socket'] = '/var/run/docker.sock'
            self.assertEqual(self.ops.environment_modes('demo-user-42'), ['shared', 'isolated'])
        self.assertFalse((self.n.ROOT/'oci').exists())
    def test_quota_rpc_does_not_create_workspace_or_project_operations(self):
        value={'enabled':False,'enforcement':None,'owner':'demo-user-42','volumes':None}
        with patch.object(self.n,'storage_quota_status',return_value=value) as quota,patch.object(self.n,'workspace',side_effect=AssertionError),patch.object(self.n,'projects',side_effect=AssertionError):
            self.assertEqual(self.n.process('projects.quota',{'userId':'demo-user-42'}),value)
            quota.assert_called_once_with('demo-user-42')
            for extra in ({'path':'/etc'},{'project':'test-project'},{'hostAdmin':True},{'projectId':10004}):
                with self.assertRaisesRegex(ValueError,'quota status fields'):self.n.process('projects.quota',{'userId':'demo-user-42',**extra})
    def test_upload_atomic_commit_and_bad_hash_keep_old(self):
        self.upload()
        with self.assertRaisesRegex(ValueError,'SHA256'):self.upload(b'bad',sha256='a'*64)
        result=self.call('files.get',path='train.py')
        self.assertEqual(base64.b64decode(result['data']),b'hello')
        self.upload(b'new')
        self.assertEqual(base64.b64decode(self.call('files.get',path='train.py')['data']),b'new')
    def test_partial_not_visible_and_publish_blocked(self):
        data=b'complete';key=str(uuid.uuid4());sha=hashlib.sha256(data).hexdigest()
        self.upload(data[:3],totalSize=len(data),sha256=sha,uploadId=key,final=False)
        self.assertEqual(self.call('files.list')['entries'],[])
        with patch.object(self.ops,'active',return_value=False),self.assertRaisesRegex(ValueError,'Unfinished'):
            self.call('projects.publish')
        self.upload(data[3:],totalSize=len(data),sha256=sha,uploadId=key,offset=3)
        self.assertEqual(base64.b64decode(self.call('files.get',path='train.py')['data']),data)
    def test_traversal_symlink_and_size_rejected(self):
        for path in ('../secret','/root/a','x//z','x/../z','x\\z'):
            with self.subTest(path=path),self.assertRaises(ValueError):self.upload(path=path)
        root=self.ops.store.dev_paths(*self.ops.identity(self.args))['code']
        (root/'bad').symlink_to(self.base)
        with self.assertRaises(OSError):self.upload(path='bad/secret')
        with self.assertRaises(ValueError):self.upload(totalSize=5*1024**3)
    def test_partial_retry_does_not_duplicate_data(self):
        key=str(uuid.uuid4());data=b'hello';sha=hashlib.sha256(data).hexdigest()
        for _ in range(2):self.upload(data,totalSize=5,sha256=sha,uploadId=key,final=False)
        self.upload(b'',totalSize=5,sha256=sha,uploadId=key,offset=5)
        self.assertEqual(base64.b64decode(self.call('files.get',path='train.py')['data']),data)
    def test_empty_upload(self):
        self.assertTrue(self.upload(b'')['complete'])
        self.assertEqual(self.call('files.get',path='train.py')['size'],0)
    def test_publishing_blocks_new_edits(self):
        self.n.atomic_json(self.ops.receipt_path(self.args),{'state':'PUBLISHING',**self.args})
        with patch.object(self.ops,'active',return_value=True),self.assertRaisesRegex(ValueError,'publication'):
            self.call('files.put',path='x')
        with patch.object(self.ops,'active',return_value=True),self.assertRaisesRegex(ValueError,'publication'):
            self.call('terminal.open',username='alice',key=str(uuid.uuid4()))
    def test_terminal_identity_separate_from_legacy_and_other_projects(self):
        legacy=self.n.terminal_pointer({'userId':'demo-user-42'})
        a=self.n.terminal_pointer(self.args);b=self.n.terminal_pointer({**self.args,'project':'other'})
        self.assertEqual(len({legacy,a,b}),3)
        with self.assertRaises(ValueError):self.n.terminal_pointer({**self.args,'hostAdmin':True})
    def test_live_development_terminal_blocks_publish(self):
        pointer=self.n.terminal_pointer(self.args);pointer.parent.mkdir(exist_ok=True)
        pointer.write_text(str(uuid.uuid4()))
        with patch.object(self.n,'terminal_alive',return_value=True),self.assertRaisesRegex(ValueError,'Close'):
            self.call('projects.publish')
    def test_background_publish_and_readiness(self):
        paths=self.ops.store.dev_paths(*self.ops.identity(self.args))
        (paths['env']/'bin').mkdir();(paths['env']/'bin/python').write_text('fake venv')
        (paths['env']/'pyvenv.cfg').write_text('home = /opt/conda/bin\n')
        with patch.object(self.n,'run',return_value=''):
            out=self.call('projects.publish')
        self.assertEqual(out['state'],'PUBLISHING')
        self.assertEqual(self.publication_worker(out['operationId']),0)
        status=self.call('projects.status');self.assertEqual(status['state'],'READY')
        self.assertEqual(self.call('projects.verify',release=status['latestReadyRelease'])['state'],'READY')
    def test_unknown_terminal_state_blocks_publication(self):
        pointer=self.n.terminal_pointer(self.args);pointer.parent.mkdir(exist_ok=True)
        pointer.write_text(str(uuid.uuid4()))
        with patch.object(self.n,'terminal_alive',return_value=False),patch.object(self.n,'stop_terminal'),patch.object(self.ops,'terminal_stopped',return_value=False):
            with self.assertRaisesRegex(ValueError,'Cannot confirm'):self.call('projects.publish')
        self.assertTrue(pointer.exists())
    def test_failed_system_bus_is_not_inactive_terminal(self):
        with patch.object(self.ops.n.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout='')):
            self.assertFalse(self.ops.terminal_stopped(str(uuid.uuid4())))
    def test_old_spec_unchanged_and_project_spec_strict(self):
        job=dict(id=str(uuid.uuid4()),userId='demo-user-42',username='alice',cards=1,argv=['true'],name='old',minVramGiB=0)
        self.n.validate_job(job);self.n.validate_job({**job,'project':'test-project','release':'a'*64})
        for extra in ({'release':'a'*64},{'project':'test-project'},{'project':'../a','release':'a'*64}):
            with self.assertRaises(ValueError):self.n.validate_job({**job,**extra})
    def test_output_requires_owner_and_no_upload(self):
        with self.assertRaises(ValueError):self.call('files.put',area='output',runId=str(uuid.uuid4()))
        with self.assertRaises(ValueError):self.call('files.get',area='output')

if __name__=='__main__':unittest.main()
