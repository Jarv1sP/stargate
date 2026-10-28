"""Small copy members share reads and durable commits without losing merge/resume semantics."""
import base64,importlib.util,io,json,os,tarfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class Batches(unittest.TestCase):
    setUp=f.DirectoryContract.setUp
    key=f.DirectoryContract.key

    def prepare(self,count=20,size=4096):
        self.sync=f.module('project-sync');self.bundle=self.base/'received';self.bundle.mkdir(mode=0o700)
        self.paths={name:self.base/name for name in ('rootfs','code','home')}
        for path in self.paths.values():path.mkdir(mode=0o700)
        self.expected={};archive=self.bundle/'workspace.tar'
        with tarfile.open(archive,'w',format=tarfile.PAX_FORMAT) as stream:
            for index in range(count):
                raw=bytes([index%251])*size;name='member-'+str(index);self.expected[name]=raw
                row=tarfile.TarInfo('workspace/'+name);row.size=len(raw);row.mode=0o751
                row.uid=os.getuid();row.gid=os.getgid();row.mtime=123456
                stream.addfile(row,io.BytesIO(raw))
        self.sync.index(self.bundle)
        self.request={'paths':{k:str(v) for k,v in self.paths.items() if k!='rootfs'},
                      'index':str(self.bundle/'index.jsonl'),'plan':str(self.bundle/'plan.jsonl'),
                      'bundle':str(self.bundle),'incremental':True}
        self.sync.plan(self.request,self.paths['rootfs'])
        self.entries=[{**row,'path':row['body'],'remotePath':row['archive'],'remoteOffset':row['offset']}
                      for row in self.sync.entries(self.request['plan'])]
        self.jobs=f.module('transfer-jobs').TransferJobs(SimpleNamespace(CONFIG=self.config))
        self.id=self.key();self.jobs.s.atomic_json(self.jobs.path(self.id),{'id':self.id,'state':'PENDING','bytes':0,
            'target':{'environment':True,'mode':'incremental','userId':'alice'},'actor':{'userId':'alice'}})
        self.uploads=f.module('data-uploads').Uploads(self.config,'alice',root=self.bundle);self.calls=[]
        def read(action,**args):
            self.calls.append(args)
            with (self.bundle/args['path']).open('rb') as stream:
                stream.seek(args['offset']);raw=stream.read(args['length'])
            return {'data':base64.b64encode(raw).decode()}
        self.peer=SimpleNamespace(call=read)
        return self.entries

    def receive(self,jobs=None,peer=None):
        return (jobs or self.jobs).receive(self.id,self.bundle,peer or self.peer,self.entries,0,self.uploads)

    def verify_merge(self):
        (self.paths['code']/'target-only').write_text('keep')
        self.sync.apply(self.request,self.paths['rootfs'])
        for name,raw in self.expected.items():
            file=self.paths['code']/name;self.assertEqual(file.read_bytes(),raw)
            self.assertEqual(file.stat().st_mode&0o777,0o751)
        self.assertEqual((self.paths['code']/'target-only').read_text(),'keep')
        self.sync.plan(self.request,self.paths['rootfs']);self.assertEqual(list(self.sync.entries(self.request['plan'])),[])

    def test_adjacent_small_members_share_one_read_and_merge_preserves_metadata(self):
        self.prepare();self.assertEqual(self.receive(),20*4096)
        self.assertEqual(len(self.calls),1,'small members still require one request each')
        self.assertLessEqual(self.calls[0]['length'],1024**2);self.verify_merge()

    def test_committed_batch_reopens_after_lost_progress_without_resending_bytes(self):
        self.prepare();write=self.jobs.s.atomic_json
        def interrupted(path,row):
            if path==self.jobs.path(self.id) and row.get('bytes',0)>0:raise OSError('lost progress publication')
            return write(path,row)
        with patch.object(self.jobs.s,'atomic_json',interrupted):
            with self.assertRaises(OSError):self.receive()
        fresh=type(self.jobs)(self.jobs.e)
        peer=SimpleNamespace(call=lambda *args,**kwargs:self.fail('committed batch bytes were resent'))
        self.assertEqual(self.receive(fresh,peer),20*4096)
        self.assertEqual(fresh.s.read_json(fresh.path(self.id))['bytes'],20*4096);self.verify_merge()

    def test_short_source_response_does_not_commit_a_partial_batch(self):
        self.prepare();read=self.peer.call
        def short(action,**args):
            result=read(action,**args);raw=base64.b64decode(result['data'])[:-1]
            return {'data':base64.b64encode(raw).decode()}
        with self.assertRaises(ConnectionError):self.receive(peer=SimpleNamespace(call=short))
        self.assertEqual(self.jobs.s.read_json(self.jobs.path(self.id))['bytes'],0)
        self.calls.clear();self.assertEqual(self.receive(),20*4096)
        self.assertEqual(len(self.calls),1);self.verify_merge()

    def test_cancellation_during_batch_read_publishes_no_payload_or_progress(self):
        self.prepare();read=self.peer.call
        def canceled(action,**args):
            result=read(action,**args);row=self.jobs.s.read_json(self.jobs.path(self.id))
            row['state']='CANCELED';self.jobs.s.atomic_json(self.jobs.path(self.id),row);return result
        self.assertIsNone(self.receive(peer=SimpleNamespace(call=canceled)))
        row=self.jobs.s.read_json(self.jobs.path(self.id));self.assertEqual((row['state'],row['bytes']),('CANCELED',0))
        with f.module('copy-batches').CopyBatches(self.bundle) as saved:
            self.assertTrue(all(saved.size(row['path']) is None for row in self.entries))

    def test_small_partial_upload_keeps_its_original_key_and_offset(self):
        self.prepare();entry=self.entries[0];key=self.jobs.file_key(self.id,entry['path'])
        self.uploads.process('begin',{'key':key,'path':entry['path'],'totalSize':entry['size']})
        self.uploads.process('chunk',{'key':key,'offset':0,'data':base64.b64encode(b'\0'*5).decode()})
        self.assertEqual(self.receive(),20*4096)
        self.assertEqual(self.calls[0]['offset'],entry['remoteOffset']+5)
        self.assertEqual(self.uploads.process('status',{'key':key})['state'],'COMPLETE');self.verify_merge()

    def test_groups_remain_bounded_and_empty_members_survive(self):
        self.prepare(200,8192);self.assertEqual(self.receive(),200*8192)
        self.assertGreater(len(self.calls),1);self.assertTrue(all(row['length']<=1024**2 for row in self.calls))
        self.verify_merge()

    def test_empty_members_need_no_source_payload(self):
        self.prepare(4,0);self.assertEqual(self.receive(),0);self.assertEqual(self.calls,[]);self.verify_merge()

    def test_streamed_post_plan_members_do_not_require_a_materialized_list(self):
        self.prepare();self.entries=(entry for entry in self.entries)
        self.assertEqual(self.receive(),20*4096);self.assertEqual(len(self.calls),1);self.verify_merge()

    def test_sparse_or_different_archive_members_are_not_read_as_one_large_range(self):
        self.prepare(3,4096);self.entries[1]['remoteOffset']+=2*1024**2
        self.entries[2]['remotePath']='another.tar'
        def read(action,**args):
            self.calls.append(args);return {'data':base64.b64encode(b'x'*args['length']).decode()}
        self.assertEqual(self.receive(peer=SimpleNamespace(call=read)),3*4096)
        self.assertEqual(len(self.calls),3);self.assertTrue(all(row['length']==4096 for row in self.calls))

    def test_batch_database_cannot_follow_a_link_outside_the_private_copy(self):
        self.prepare();outside=self.base/'unrelated';outside.write_bytes(b'keep')
        (self.bundle/'.copy-batches.sqlite3').symlink_to(outside)
        with self.assertRaises(OSError):self.receive()
        self.assertEqual(outside.read_bytes(),b'keep');self.assertEqual(self.calls,[])


if __name__=='__main__':unittest.main()
