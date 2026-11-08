"""Bulk import targets cannot select workspace paths, including saved operations."""
import importlib.util,os,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)

class ImportTargets(unittest.TestCase):
    setUp=f.DirectoryContract.setUp
    key=f.DirectoryContract.key

    def executor(self):
        return SimpleNamespace(CONFIG=self.config,ENV=dict(os.environ),run=lambda *a,**k:'',projects=lambda:self.fail('project workspace was accessed'))

    def test_link_start_rejects_project_even_when_area_is_dataset(self):
        jobs=f.module('data-import').DataImports(self.executor())
        for target in ({'project':'demo'},{'project':'demo','dataset':'shared','area':'dataset'},{'project':None,'dataset':'shared'},{'project':'','dataset':'shared'},{'area':'code','dataset':'shared'},{}):
            with self.subTest(target=target),self.assertRaisesRegex(ValueError,'数据集.*重新导入'):
                jobs.process('datasets.import.start',{'key':self.key(),'url':'https://example.invalid/file','path':'file','userId':'alice',**target})
        self.assertEqual(list(jobs.folder.glob('*.json')),[])

    def test_saved_project_link_import_rejects_start_resume_continue_and_worker_without_losing_bytes(self):
        imports=f.module('data-import');jobs=imports.DataImports(self.executor())
        for state in ('PAUSED','PENDING','SUCCEEDED'):
            key=self.key();request={'url':'https://example.invalid/file','path':'file','dataset':'shared','sourceKind':'https','downloadHeaders':None,'expectedBytes':None,'project':None,'ownerId':None}
            row={**request,'request':request,'operationId':key,'userId':'alice','state':state,'bytes':3}
            row['project']='demo';row['area']='dataset';jobs.s.atomic_json(jobs.path(key),row)
            for action,args in [('start',{'key':key,**request}),('resume',{'operationId':key}),('continue',{'operationId':key})]:
                if action=='start':args.pop('project')
                with self.subTest(state=state,action=action),self.assertRaisesRegex(ValueError,'数据集.*重新导入'):
                    jobs.process('datasets.import.'+action,args)
            with patch.object(imports,'open_download',side_effect=AssertionError('rejected target contacted download source')):
                self.assertEqual(jobs.worker(key),1)
            saved=jobs.s.read_json(jobs.path(key));self.assertEqual(saved['bytes'],3);self.assertIn('数据集',saved['error'])

    def test_cloud_download_rejects_project_but_upload_can_read_project(self):
        jobs=f.module('cloud-files').CloudFiles(self.executor())
        for target in ({'project':'demo'},{'project':'demo','dataset':'shared','area':'dataset'},{'project':None,'dataset':'shared'},{'project':'','dataset':'shared'},{'area':'code','dataset':'shared'},{}):
            with self.subTest(target=target),self.assertRaisesRegex(ValueError,'数据集'):
                jobs.process('datasets.cloud.download',{'key':self.key(),'fileId':'file','path':'file','size':3,'userId':'alice',**target})
        code=self.base/'workspace-code';code.mkdir();(code/'file').write_bytes(b'abc')
        jobs.n.projects=lambda:SimpleNamespace(store=SimpleNamespace(dev_paths=lambda *a:{'code':code}))
        result=jobs.process('datasets.cloud.upload',{'key':self.key(),'project':'demo','path':'file','userId':'alice'})
        self.assertEqual(result['state'],'PENDING');self.assertEqual(result['size'],3)

    def test_saved_project_cloud_download_cannot_restart_or_run_worker(self):
        jobs=f.module('cloud-files').CloudFiles(self.executor());key=self.key()
        row={'operationId':key,'action':'download','project':'demo','dataset':'shared','userId':'alice','state':'PAUSED','path':'file','bytes':3,'size':6,'fileId':'file'}
        row['request']={k:row.get(k) for k in ('dataset','project','ownerId','path','fileId','size','name','action')};jobs.s.atomic_json(jobs.path(key),row)
        with self.assertRaisesRegex(ValueError,'数据集'):
            jobs.process('datasets.cloud.download',{'key':key,'dataset':'shared','fileId':'file','path':'file','size':6,'userId':'alice'})
        self.assertEqual(jobs.worker(key),1);saved=jobs.s.read_json(jobs.path(key));self.assertEqual(saved['bytes'],3);self.assertIn('数据集',saved['error'])

    def test_environment_project_prepare_keeps_its_project_directory(self):
        jobs=f.module('transfer-jobs').TransferJobs(self.executor());key=self.key();code=self.base/'project-code';code.mkdir()
        jobs.e.projects=lambda:SimpleNamespace(store=SimpleNamespace(dev_paths=lambda *a:{'code':code}))
        row={'id':key,'token':'original-token','state':'PREPARING'}
        jobs.s.atomic_json(jobs.path(key,'.source.json'),row)
        result=jobs.prepare({'id':key,'source':{'project':'demo','environment':True}})
        self.assertEqual(result,row)

    def test_plain_project_copy_rejects_prepare_start_resume_and_worker(self):
        jobs=f.module('transfer-jobs').TransferJobs(self.executor())
        for target in ({'project':'demo'},{'project':'demo','dataset':'shared'},{'project':'demo','environment':False}):
            with self.subTest(target=target),self.assertRaisesRegex(ValueError,'项目复制'):
                jobs.prepare({'key':self.key(),'source':target})
            with self.subTest(target=target),self.assertRaisesRegex(ValueError,'项目复制'):
                jobs.start({'key':self.key(),'source':{'dataset':'source'},'target':target})
        key=self.key();row={'id':key,'key':key,'state':'PAUSED','source':{'project':'source'},'target':{'project':'demo'},'bytes':3}
        jobs.s.atomic_json(jobs.path(key),row)
        with self.assertRaisesRegex(ValueError,'项目复制'):jobs.resume({'key':key})
        with self.assertRaisesRegex(ValueError,'项目复制'):jobs.start({'key':key,'target':{'dataset':'shared'}})
        with patch.object(jobs,'peer_client',side_effect=AssertionError('rejected copy contacted peer')):
            self.assertEqual(jobs.receive_worker(key),1)
        self.assertEqual(jobs.s.read_json(jobs.path(key))['bytes'],3)

if __name__=='__main__':unittest.main()
