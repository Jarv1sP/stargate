"""Directory model end-to-end: bytes, key recovery, team trash and disk wall."""
import base64,importlib.util,json,os,stat,tempfile,time,unittest,uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]

def module(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'node'/(name+'.py'))
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


class DirectoryContract(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name);os.chmod(self.base,0o700)
        self.config={'root':str(self.base/'state'),'datasetsRoot':str(self.base/'datasets'),'workspacesRoot':str(self.base/'workspaces'),
                     'dataMountPoints':[str(self.base)],'machine':'test-node','cards':2}
        for n in ('root','datasetsRoot','workspacesRoot'):Path(self.config[n]).mkdir(mode=0o700)
        original_stat=os.stat;original_read=Path.read_text
        def stat_fake(path,*args,**kwargs):
            v=original_stat(path,*args,**kwargs)
            if os.fspath(path)=='/':v=os.stat_result([v.st_mode,v.st_ino,v.st_dev+1,v.st_nlink,v.st_uid,v.st_gid,v.st_size,v.st_atime,v.st_mtime,v.st_ctime])
            return v
        def read_fake(path,*args,**kwargs):
            if str(path)=='/proc/self/mountinfo':return f'1 0 0:1 / / rw - ext4 root rw\n2 1 0:2 / {self.base} rw - ext4 data rw\n'
            return original_read(path,*args,**kwargs)
        self.patches=[patch('os.stat',stat_fake),patch.object(Path,'read_text',read_fake),patch('os.fstatvfs',return_value=SimpleNamespace(f_bavail=100*1024**3,f_frsize=1,f_blocks=200*1024**3,f_bfree=100*1024**3))]
        for p in self.patches:p.start();self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)
        self.data=module('local-data');self.files=module('dataset-files');self.uploads=module('data-uploads').Uploads(self.config,'alice')
        self.trash=module('project-purge').Trash(self.config)

    def key(self):return str(uuid.uuid4())
    def upload(self,name,raw,key=None,**extra):
        key=key or self.key();request={'key':key,'dataset':'shared','path':name,'totalSize':len(raw),**extra}
        self.uploads.process('begin',request)
        for offset in range(0,len(raw),1024**2):self.uploads.process('chunk',{'key':key,'offset':offset,'data':base64.b64encode(raw[offset:offset+1024**2]).decode()})
        return self.uploads.process('finish',{'key':key})

    def test_upload_without_sha_same_size_new_operation_replaces_content(self):
        a=self.upload('a.txt',b'old',sha256='wrong',fingerprint='wrong');b=self.upload('a.txt',b'new')
        self.assertNotEqual(a['key'],b['key']);self.assertEqual(Path(self.config['datasetsRoot'],'shared/a.txt').read_bytes(),b'new')
        self.assertNotIn('version',self.files.datasets(self.config)['datasets'][0])

    def test_same_key_resumes_original_offsets_and_unknown_fields_are_ignored(self):
        key=self.key();request={'key':key,'dataset':'shared','path':'a.txt','totalSize':6,'extra':'ok'}
        self.uploads.process('begin',request)
        self.uploads.process('chunk',{'key':key,'offset':0,'data':base64.b64encode(b'abc').decode()})
        self.assertEqual(self.uploads.process('begin',{**request,'sha256':'ignored'})['offset'],3)
        self.uploads.process('chunk',{'key':key,'offset':3,'data':base64.b64encode(b'def').decode()});self.uploads.process('finish',{'key':key})
        self.assertEqual(Path(self.config['datasetsRoot'],'shared/a.txt').read_bytes(),b'abcdef')

    def test_same_key_different_parameters_is_rejected_once(self):
        key=self.key();self.upload('a.txt',b'old',key)
        with self.assertRaisesRegex(ValueError,'原上传编号'):self.uploads.process('begin',{'key':key,'dataset':'shared','path':'b.txt','totalSize':3})

    def test_incomplete_commit_keeps_temporary_file_and_previous_content(self):
        self.upload('a.txt',b'old');key=self.key();self.uploads.process('begin',{'key':key,'dataset':'shared','path':'a.txt','totalSize':6})
        self.uploads.process('chunk',{'key':key,'offset':0,'data':base64.b64encode(b'new').decode()})
        with self.assertRaisesRegex(ValueError,'尚未完成'):self.uploads.process('finish',{'key':key})
        self.assertEqual(Path(self.config['datasetsRoot'],'shared/a.txt').read_bytes(),b'old');self.assertEqual(self.uploads.process('status',{'key':key})['offset'],3)

    def test_commit_crash_after_rename_finishes_by_size_without_hash(self):
        key=self.key();self.upload('a.txt',b'new',key);row=self.uploads.s.read_json(self.uploads.record(key));row['state']='COMMITTING'
        self.uploads.s.atomic_json(self.uploads.record(key),row)
        self.assertEqual(self.uploads.process('finish',{'key':key})['state'],'COMPLETE')

    def test_orphaned_begin_can_restart_with_same_uuid(self):
        folder=self.data.dataset_root(self.config,'shared',create=True);key=self.key();(folder/('.upload-'+key)).write_bytes(b'partial')
        row=self.uploads.process('begin',{'key':key,'dataset':'shared','path':'a.txt','totalSize':3})
        self.assertEqual(row['offset'],0)

    def test_regular_mode000_output_moves_without_content_read(self):
        folder=Path(self.config['root'],'outputs');folder.mkdir(mode=0o700);job=folder/self.key();job.mkdir(mode=0o700);file=job/'locked.txt';file.write_bytes(b'payload');file.chmod(0)
        key=self.key();row=self.trash.delete(file,key,'output',{'userId':'bob'},jobId=job.name,path='locked.txt')
        self.assertEqual(row['state'],'TRASHED');self.assertFalse(file.exists());self.assertEqual(row['actor']['userId'],'bob')
        self.trash.restore({'key':key,'actor':{'userId':'alice'}});self.assertEqual(stat.S_IMODE(file.stat().st_mode),0)

    def test_delete_last_directory_while_open_then_team_restore_and_expired_purge(self):
        self.upload('a.txt',b'data');folder=Path(self.config['datasetsRoot'],'shared');fd=self.data.open_directory(folder);self.addCleanup(os.close,fd)
        key=self.key();row=self.trash.delete(folder,key,'dataset',{'userId':'bob'},dataset='shared')
        self.assertEqual(self.files.datasets(self.config)['datasets'],[])
        file=os.open('a.txt',os.O_RDONLY,dir_fd=fd)
        try:self.assertEqual(os.read(file,4),b'data')
        finally:os.close(file)
        self.trash.restore({'key':key,'actor':{'userId':'carol'}});self.assertEqual((folder/'a.txt').read_bytes(),b'data')
        key=self.key();row=self.trash.delete(folder,key,'dataset',{'userId':'alice'},dataset='shared')
        with self.assertRaisesRegex(ValueError,'管理员'):self.trash.purge({'key':key,'actor':{'userId':'bob','isAdmin':False}})
        with patch('time.time',return_value=row['retainUntil']+1):self.assertEqual(self.trash.collect()[0]['state'],'PURGED')
        self.assertFalse((Path(self.config['datasetsRoot'])/'.trash'/(key+'.data')).exists())

    def test_admin_can_empty_early_and_delete_key_replay_does_not_extend_retention(self):
        self.upload('a.txt',b'data');folder=Path(self.config['datasetsRoot'],'shared');key=self.key()
        first=self.trash.delete(folder,key,'dataset',{'userId':'alice'})
        later=self.trash.delete(folder,key,'dataset',{'userId':'bob'})
        self.assertEqual(later['retainUntil'],first['retainUntil'])
        self.assertEqual(self.trash.purge({'key':key,'actor':{'userId':'admin','isAdmin':True}})['state'],'PURGED')

    def test_directory_purge_does_not_follow_symlinks_outside_payload(self):
        self.upload('a.txt',b'data');folder=Path(self.config['datasetsRoot'],'shared')
        outside=self.base/'outside';outside.mkdir();(outside/'keep.txt').write_bytes(b'keep')
        (folder/'link').symlink_to(outside,target_is_directory=True)
        key=self.key();row=self.trash.delete(folder,key,'dataset',{'userId':'alice'})
        self.assertEqual(self.trash.purge({'key':key,'actor':{'userId':'admin','isAdmin':True}})['state'],'PURGED')
        self.assertFalse((Path(self.config['datasetsRoot'])/'.trash'/(key+'.data')).exists())
        self.assertEqual((outside/'keep.txt').read_bytes(),b'keep')

    def test_paths_cannot_escape_or_follow_symlink_into_system_disk(self):
        folder=self.data.dataset_root(self.config,'shared',create=True);(folder/'escape').symlink_to('/etc',target_is_directory=True)
        for path in ('../etc/passwd','/etc/passwd','escape/passwd'):
            with self.subTest(path=path),self.assertRaises((ValueError,OSError)):self.files.process(self.config,'files.get',{'dataset':'shared','path':path})
        with self.assertRaisesRegex(ValueError,'系统盘'):self.data.require_data_path(self.config,'/etc')

    def test_download_and_listing_report_actual_bytes_no_fingerprint(self):
        self.upload('a.txt',b'data');row=self.files.process(self.config,'files.get',{'dataset':'shared','path':'a.txt','fingerprint':'ignored'})
        self.assertEqual(base64.b64decode(row['data']),b'data');self.assertEqual(row['size'],4)
        self.assertEqual(self.files.process(self.config,'files.list',{'dataset':'shared'})['entries'][0]['name'],'a.txt')

    def test_projects_share_live_workspace_and_each_task_has_own_output(self):
        store=module('project-store').ProjectStore(Path(self.config['root']),config=self.config)
        store.create('alice','demo');self.assertEqual(store.list('bob')[0]['ownerId'],'alice')
        a=store.runtime_paths({'userId':'alice','project':'demo'},self.key());b=store.runtime_paths({'userId':'alice','project':'demo'},self.key())
        self.assertEqual(a['code'],b['code']);self.assertNotEqual(a['output'],b['output'])
        key=self.key();path,_=store._project('alice','demo');self.trash.delete(path,key,'project',{'userId':'bob'})
        self.assertEqual(store.list(),[]);self.trash.restore({'key':key,'actor':{'userId':'carol'}});self.assertEqual(len(store.list()),1)

    def test_disk_low_space_retains_64gib_floor(self):
        with patch('os.fstatvfs',return_value=SimpleNamespace(f_bavail=63*1024**3,f_frsize=1)):
            with self.assertRaisesRegex(ValueError,'hard floor'):self.uploads.process('begin',{'key':self.key(),'dataset':'shared','path':'a.txt','totalSize':3})

    def test_cancel_import_cannot_be_overwritten_by_late_progress_or_commit(self):
        imports=module('data-import');executor=SimpleNamespace(CONFIG=self.config,run=lambda *a,**k:None)
        jobs=imports.DataImports(executor);key=self.key()
        jobs.process('datasets.import.start',{'key':key,'url':'https://example.invalid/file','path':'late.bin','dataset':'shared','userId':'bob'})
        class Reply:
            status=200
            def getheader(_,name):return '6' if name=='Content-Length' else None
            def read(_,size):jobs.process('datasets.import.cancel',{'operationId':key});return b'abc'
        with patch.object(imports,'open_download',return_value=(SimpleNamespace(close=lambda:None),Reply())):self.assertEqual(jobs.worker(key),0)
        self.assertEqual(jobs.process('datasets.import.status',{'operationId':key})['state'],'CANCELED')
        self.assertFalse(Path(self.config['datasetsRoot'],'shared/late.bin').exists())

    def test_cloud_download_publishes_real_bytes_by_size_and_original_key(self):
        import sys
        executor=SimpleNamespace(CONFIG={**self.config,'cloudFiles':{'enabled':True}},ENV=dict(os.environ),run=lambda *a,**k:None)
        cloud=module('cloud-files').CloudFiles(executor);key=self.key()
        cloud.process('datasets.cloud.download',{'key':key,'fileId':'actual:remote-id','size':3,'path':'cloud.bin','dataset':'shared','userId':'bob','receipt':'ignored'})
        script="import os,sys,json;r=json.load(sys.stdin);os.write(int(os.environ['GPUQ_CLOUD_FILE_FD']),b'abc');print(json.dumps({'kind':'result','result':{'id':r['fileId'],'size':3}}))"
        cloud.command=lambda:[sys.executable,'-c',script]
        self.assertEqual(cloud.worker(key),0);self.assertEqual(cloud.process('datasets.cloud.status',{'operationId':key})['state'],'COMPLETE')
        self.assertEqual(Path(self.config['datasetsRoot'],'shared/cloud.bin').read_bytes(),b'abc')
        self.assertEqual(self.files.datasets(self.config)['datasets'][0]['uploadedBy'],'bob')

    def test_import_resume_keeps_partial_bytes_and_refreshes_source_without_duplicate_workers(self):
        imports=module('data-import')
        for state in ('PAUSED','CANCELED'):
            with self.subTest(state=state):
                launches=[];jobs=imports.DataImports(SimpleNamespace(CONFIG=self.config,run=lambda *a,**k:launches.append(a)))
                key=self.key();path=state.lower()+'.bin';original='https://example.invalid/file';fresh=original+'?fresh=1'
                jobs.process('datasets.import.start',{'key':key,'url':original,'path':path,'dataset':'shared','userId':'bob'})
                class Interrupted:
                    status=200
                    reads=0
                    def getheader(_,name):return '6' if name=='Content-Length' else None
                    def read(_,size):
                        _.reads+=1
                        if _.reads==1:return b'abc'
                        raise TimeoutError('interrupted download')
                with patch.object(imports,'open_download',return_value=(SimpleNamespace(close=lambda:None),Interrupted())):self.assertEqual(jobs.worker(key),1)
                if state=='CANCELED':jobs.process('datasets.import.cancel',{'operationId':key})
                self.assertEqual(jobs.process('datasets.import.status',{'operationId':key})['state'],state)
                self.assertEqual(self.uploads.process('status',{'key':key})['offset'],3)
                self.assertFalse(Path(self.config['datasetsRoot'],'shared',path).exists())
                args={'operationId':key,'url':fresh,'path':'ignored-new-target.bin','dataset':'ignored-new-dataset'}
                resumed=jobs.process('datasets.import.resume',args);self.assertEqual(resumed['bytes'],3);self.assertEqual(resumed['state'],'PENDING');self.assertIsNone(resumed['error'])
                jobs.process('datasets.import.resume',args);self.assertEqual(len(launches),2)
                class Remainder:
                    status=206
                    reads=0
                    def getheader(_,name):return 'bytes 3-5/6' if name=='Content-Range' else '3' if name=='Content-Length' else None
                    def read(_,size):_.reads+=1;return b'def' if _.reads==1 else b''
                with patch.object(imports,'open_download',return_value=(SimpleNamespace(close=lambda:None),Remainder())) as opened:
                    self.assertEqual(jobs.worker(key),0);self.assertEqual(opened.call_args.args[0],fresh);self.assertEqual(opened.call_args.kwargs['offset'],3)
                complete=jobs.process('datasets.import.status',{'operationId':key});self.assertEqual(complete['state'],'SUCCEEDED');self.assertEqual(complete['bytes'],6)
                self.assertEqual(Path(self.config['datasetsRoot'],'shared',path).read_bytes(),b'abcdef')
                jobs.process('datasets.import.resume',args);self.assertEqual(len(launches),2)

    def test_import_resume_launch_failure_remains_retryable(self):
        imports=module('data-import');jobs=imports.DataImports(SimpleNamespace(CONFIG=self.config,run=lambda *a,**k:None));key=self.key()
        jobs.process('datasets.import.start',{'key':key,'url':'https://example.invalid/file','path':'retry.bin','dataset':'shared','userId':'bob'})
        jobs.update(key,state='PAUSED',bytes=3,totalBytes=6)
        with patch.object(jobs,'launch',side_effect=RuntimeError('worker launch failed')):
            with self.assertRaisesRegex(RuntimeError,'worker launch failed'):jobs.process('datasets.import.resume',{'operationId':key})
        status=jobs.process('datasets.import.status',{'operationId':key});self.assertEqual(status['state'],'PAUSED');self.assertEqual(status['bytes'],3)
        with patch.object(jobs,'launch') as launch:
            self.assertEqual(jobs.process('datasets.import.resume',{'operationId':key})['state'],'PENDING');launch.assert_called_once_with(key)

    def test_ranged_import_downloads_concurrently_and_commits_original_order(self):
        import threading
        imports=module('data-import');jobs=imports.DataImports(SimpleNamespace(CONFIG=self.config,run=lambda *a,**k:None));key=self.key();raw=b'prefix'+bytes(range(27))
        jobs.process('datasets.import.start',{'key':key,'url':'https://example.invalid/file','path':'parallel.bin','dataset':'shared','userId':'bob'})
        self.uploads.process('begin',{'key':key,'path':'parallel.bin','totalSize':len(raw),'dataset':'shared'})
        self.uploads.process('chunk',{'key':key,'offset':0,'data':base64.b64encode(raw[:6]).decode()});jobs.update(key,state='PAUSED',bytes=6,totalBytes=len(raw))
        calls=[];barrier=threading.Barrier(4,timeout=3)
        def opened(url,offset=0,end=None,**kwargs):
            calls.append((offset,end));at=offset;last=len(raw)-1 if end is None else end
            class Reply:
                status=206
                def getheader(_,name):return f'bytes {offset}-{last}/{len(raw)}' if name=='Content-Range' else str(last-offset+1) if name=='Content-Length' else None
                def read(_,size):
                    nonlocal at
                    if end is not None:
                        barrier.wait()
                        if (offset-9)%12==0:time.sleep(.03)
                    result=raw[at:min(at+size,last+1)];at+=len(result);return result
            return SimpleNamespace(close=lambda:None),Reply()
        jobs.process('datasets.import.resume',{'operationId':key})
        with patch.object(imports,'BLOCK',3),patch.object(imports,'open_download',side_effect=opened):self.assertEqual(jobs.worker(key),0)
        self.assertEqual(Path(self.config['datasetsRoot'],'shared/parallel.bin').read_bytes(),raw)
        self.assertEqual(sorted((a,b) for a,b in calls if b is not None),[(a,a+2) for a in range(9,33,3)])
        self.assertEqual(jobs.process('datasets.import.status',{'operationId':key})['state'],'SUCCEEDED')

    def test_parallel_failure_retains_contiguous_prefix_for_original_resume(self):
        imports=module('data-import');jobs=imports.DataImports(SimpleNamespace(CONFIG=self.config,run=lambda *a,**k:None));key=self.key();raw=b'prefix'+bytes(range(27))
        jobs.process('datasets.import.start',{'key':key,'url':'https://example.invalid/file','path':'retry-range.bin','dataset':'shared','userId':'bob'})
        fail=True;calls=[]
        def opened(url,offset=0,end=None,**kwargs):
            calls.append((offset,end));at=offset;last=len(raw)-1 if end is None else end
            if end is not None and offset==6 and fail:raise TimeoutError('range interrupted')
            class Reply:
                status=206 if offset or end is not None else 200
                def getheader(_,name):return f'bytes {offset}-{last}/{len(raw)}' if name=='Content-Range' else str(last-offset+1) if name=='Content-Length' else 'bytes' if name=='Accept-Ranges' else None
                def read(_,size):
                    nonlocal at
                    result=raw[at:min(at+size,last+1)];at+=len(result);return result
            return SimpleNamespace(close=lambda:None),Reply()
        with patch.object(imports,'BLOCK',3),patch.object(imports,'open_download',side_effect=opened):
            self.assertEqual(jobs.worker(key),1);self.assertEqual(self.uploads.process('status',{'key':key})['offset'],6)
            self.assertFalse(Path(self.config['datasetsRoot'],'shared/retry-range.bin').exists())
            self.assertEqual(jobs.process('datasets.import.status',{'operationId':key})['state'],'PAUSED')
            fail=False;jobs.process('datasets.import.resume',{'operationId':key});self.assertEqual(jobs.worker(key),0)
        self.assertIn((6,None),calls);self.assertEqual(Path(self.config['datasetsRoot'],'shared/retry-range.bin').read_bytes(),raw)

    def test_same_node_directory_copy_needs_no_self_peer(self):
        raw=b'same-node data';self.upload('train/data.bin',raw)
        (Path(self.config['datasetsRoot'])/'shared/empty').mkdir()
        self.config['transferPeers']={}
        transfers=module('transfer-jobs')
        jobs=transfers.TransferJobs(SimpleNamespace(CONFIG=self.config,run=lambda *a,**k:''))
        key=self.key();source={'dataset':'shared'}
        ticket=jobs.prepare({'key':key,'source':source})
        jobs.start({'key':key,'sourceMachine':self.config['machine'],'ticket':ticket,'source':source,'target':{'dataset':'copy'}})
        with patch.object(transfers,'PeerClient',side_effect=AssertionError('same-node copy must not use LAN')):
            self.assertEqual(jobs.worker(key),0,jobs.status({'key':key}))
        self.assertEqual(jobs.status({'key':key})['state'],'SUCCEEDED')
        for dataset in ['shared','copy']:
            self.assertEqual((Path(self.config['datasetsRoot'])/dataset/'train/data.bin').read_bytes(),raw)
            self.assertTrue((Path(self.config['datasetsRoot'])/dataset/'empty').is_dir())

    def test_cross_node_directory_copy_resumes_uuid_and_keeps_empty_directories(self):
        raw=b'a'*(1024**2)+b'end';self.upload('train/data.bin',raw)
        (Path(self.config['datasetsRoot'])/'shared/empty').mkdir()
        executor=SimpleNamespace(CONFIG=self.config,run=lambda *a,**k:None)
        transfers=module('transfer-jobs');jobs=transfers.TransferJobs(executor);source_key=self.key()
        ticket=jobs.prepare({'key':source_key,'source':{'dataset':'shared'}})
        executor.CONFIG['transferPeers']={'source':{}}
        failed=[False]
        class LocalPeer:
            def __init__(_,config,ticket):pass
            def close(_):pass
            def call(_,action,**fields):
                if action=='file' and fields['offset']>0 and not failed[0]:failed[0]=True;raise TimeoutError('test interruption')
                return jobs.read({'id':source_key,'action':action,**fields},ticket['token'])
        key=self.key();jobs.start({'key':key,'sourceMachine':'source','ticket':ticket,'source':{'dataset':'shared'},'target':{'dataset':'copy'}})
        with patch.object(transfers,'PeerClient',LocalPeer):
            self.assertEqual(jobs.worker(key),1);self.assertEqual(jobs.status({'key':key})['state'],'PAUSED')
            upload_key=jobs.file_key(key,'train/data.bin',jobs.file_keys(key))
            uploads=module('data-uploads').Uploads(self.config,'alice')
            self.assertEqual(jobs.s.read_json(uploads.record(upload_key))['offset'],1024**2)
            jobs.resume({'key':key});self.assertEqual(jobs.worker(key),0)
            self.assertEqual(jobs.s.read_json(uploads.record(upload_key))['state'],'COMPLETE')
        self.assertEqual((Path(self.config['datasetsRoot'])/'copy/train/data.bin').read_bytes(),raw)
        self.assertTrue((Path(self.config['datasetsRoot'])/'copy/empty').is_dir())
        self.assertEqual(jobs.status({'key':key})['state'],'SUCCEEDED')

if __name__=='__main__':unittest.main()
