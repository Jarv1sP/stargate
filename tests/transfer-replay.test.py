"""Directory retries reuse UUID/path keys without a persistent file-key index."""
import base64,importlib.util,json,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class Replay(unittest.TestCase):
    setUp=f.DirectoryContract.setUp
    key=f.DirectoryContract.key

    def target(self):
        executor=SimpleNamespace(CONFIG=self.config,run=lambda *args,**kwargs:None)
        module=f.module('transfer-jobs');jobs=module.TransferJobs(executor);key=self.key()
        jobs.start({'id':key,'sourceMachine':'source','ticket':{'id':key,'token':'fixture'},
                    'source':{'dataset':'source'},'target':{'dataset':'target','userId':'alice'}})
        root=self.data.dataset_root(self.config,'target',create=True)
        uploads=module.module('data-uploads').Uploads(self.config,'alice',root=root)
        return jobs,key,root,uploads

    def test_replaying_completed_prefix_skips_bytes_and_progress_rewrites(self):
        jobs,key,root,uploads=self.target();entries=[]
        for index in range(20):
            path='files/'+str(index);upload=jobs.file_key(key,path)
            entries.append({'path':path,'type':'file','size':1})
            uploads.process('begin',{'key':upload,'path':path,'totalSize':1})
            uploads.process('chunk',{'key':upload,'offset':0,'data':base64.b64encode(b'x').decode()})
            uploads.process('finish',{'key':upload})
        file=jobs.path(key);row=jobs.s.read_json(file)
        row.update(state='RUNNING',phase='传输文件',bytes=20);jobs.s.atomic_json(file,row)
        writes=[];write=jobs.s.atomic_json
        def counted_write(path,value):
            if path==file:writes.append(len(jobs.s.canonical(value)))
            return write(path,value)
        peer=SimpleNamespace(call=lambda *args,**kwargs:self.fail('completed bytes were sent again'))
        with patch.object(jobs.s,'atomic_json',counted_write):
            self.assertEqual(jobs.receive(key,root,peer,entries,0,uploads),20)
        print('REPLAY_METADATA '+json.dumps({'files':len(entries),
              'progressWrites':len(writes),'progressWriteBytes':sum(writes)}))
        self.assertLessEqual(len(writes),2,'completed-file replay rewrites progress on every file')
        self.assertTrue(all((root/entry['path']).read_bytes()==b'x' for entry in entries))

    def test_finished_legacy_transfer_fields_are_ignored_and_files_use_new_keys(self):
        jobs,key,root,uploads=self.target();upload=self.key();raw=b'a'*(1024**2)+b'tail';path='files/original'
        uploads.process('begin',{'key':upload,'path':path,'totalSize':len(raw)})
        uploads.process('chunk',{'key':upload,'offset':0,'data':base64.b64encode(raw[:1024**2]).decode()})
        row=jobs.s.read_json(jobs.path(key));row.update(state='FAILED',uploadKeys={path:upload});jobs.s.atomic_json(jobs.path(key),row)
        side=jobs.path(key,'.upload-keys');side.write_text('{unreadable old metadata')
        calls=[]
        def read(action,**request):
            calls.append(request['offset']);return {'data':base64.b64encode(raw[request['offset']:request['offset']+request['length']]).decode()}
        self.assertEqual(jobs.receive(key,root,SimpleNamespace(call=read),[{'path':path,'type':'file','size':len(raw)}],0,uploads),len(raw))
        self.assertEqual(calls,[0,1024**2]);self.assertEqual((root/path).read_bytes(),raw)
        self.assertEqual(uploads.process('status',{'key':jobs.file_key(key,path)})['state'],'COMPLETE')
        self.assertEqual(uploads.process('status',{'key':upload})['state'],'UPLOADING')
        self.assertEqual(jobs.s.read_json(jobs.path(key))['uploadKeys'],row['uploadKeys'])
        self.assertEqual(side.read_text(),'{unreadable old metadata')

    def test_new_file_key_and_offset_survive_a_fresh_worker(self):
        jobs,key,root,uploads=self.target();path='files/new';raw=b'x'*(1024**2)+b'tail';calls=[]
        def interrupted(action,**request):
            calls.append(request['offset'])
            if request['offset']:raise TimeoutError('fixture interruption')
            return {'data':base64.b64encode(raw[:request['length']]).decode()}
        entry={'path':path,'type':'file','size':len(raw)}
        with self.assertRaises(TimeoutError):jobs.receive(key,root,SimpleNamespace(call=interrupted),[entry],0,uploads)
        fresh=type(jobs)(jobs.e);calls.clear()
        def read(action,**request):
            calls.append(request['offset']);return {'data':base64.b64encode(raw[request['offset']:request['offset']+request['length']]).decode()}
        self.assertEqual(fresh.receive(key,root,SimpleNamespace(call=read),[entry],0,uploads),len(raw))
        self.assertEqual(calls,[1024**2]);self.assertEqual((root/path).read_bytes(),raw)

    def test_upload_metadata_cleanup_handles_complete_and_partial_staging_files(self):
        jobs,key,root,uploads=self.target();paths=['files/complete','files/partial','files/new-complete']
        for path in paths:
            upload=jobs.file_key(key,path);uploads.process('begin',{'key':upload,'path':path,'totalSize':1})
            uploads.process('chunk',{'key':upload,'offset':0,'data':base64.b64encode(b'x').decode()})
        uploads.process('finish',{'key':jobs.file_key(key,paths[0])})
        uploads.process('finish',{'key':jobs.file_key(key,paths[2])})
        old=self.key();uploads.process('begin',{'key':old,'path':'files/old-partial','totalSize':1})
        row=jobs.s.read_json(jobs.path(key));row['uploadKeys']={'unrelated':self.key()};jobs.s.atomic_json(jobs.path(key),row)
        side=jobs.path(key,'.upload-keys');side.write_text('{old metadata, not read')
        other=self.key();elsewhere=self.data.dataset_root(self.config,'elsewhere',create=True)
        unrelated=type(uploads)(self.config,'alice',root=elsewhere);unrelated.process('begin',{'key':other,'path':'file','totalSize':0})
        jobs.cleanup_uploads(jobs.s.read_json(jobs.path(key)),[root])
        self.assertFalse(uploads.record(old).exists());self.assertTrue(uploads.record(other).exists())
        self.assertTrue(all(not uploads.record(jobs.file_key(key,path)).exists() for path in paths))
        self.assertEqual(jobs.s.read_json(jobs.path(key))['uploadKeys'],row['uploadKeys'])
        self.assertEqual(side.read_text(),'{old metadata, not read')


if __name__=='__main__':unittest.main()
