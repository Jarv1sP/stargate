import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location('personal_uploads',Path(__file__).parents[1]/'deploy/data-uploads.py')
uploads=importlib.util.module_from_spec(spec);spec.loader.exec_module(uploads)

class PersonalUploads(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.config={'personalDataRoot':self.temp.name}
        self.u=uploads.Uploads(self.config,'demo-user-1')
        self.payload=b'original contents\0'*3000
        self.args={'path':'nested/data.bin','key':str(uuid.uuid4()),'totalSize':len(self.payload),
                   'sha256':hashlib.sha256(self.payload).hexdigest(),'overwrite':False}
    def put(self,offset,data):
        return self.u.process('chunk',{'key':self.args['key'],'offset':offset,'data':base64.b64encode(data).decode()})
    def test_resume_retains_uuid_and_durable_offset_without_visible_partial_file(self):
        self.u.process('begin',self.args)
        self.put(0,self.payload[:1024])
        fresh=uploads.Uploads(self.config,'demo-user-1')
        state=fresh.process('status',{'path':self.args['path']})
        self.assertEqual(state['key'],self.args['key']);self.assertEqual(state['receivedBytes'],1024)
        self.assertFalse((self.u.root/self.args['path']).exists())
        self.put(0,self.payload[:1024])
        self.assertEqual(self.u.process('status',{'path':self.args['path']})['receivedBytes'],1024)
        self.put(1024,self.payload[1024:])
        self.u.verify(self.args['key'])
        self.assertEqual((self.u.root/self.args['path']).read_bytes(),self.payload)
        self.assertEqual(self.u.process('status',{'path':self.args['path']})['state'],'COMPLETE')
    def test_wrong_content_or_uuid_cannot_reset_original_upload(self):
        self.u.process('begin',self.args);self.put(0,b'original')
        with self.assertRaises(ValueError):self.put(0,b'changed!')
        with self.assertRaises(ValueError):self.u.process('begin',{**self.args,'key':str(uuid.uuid4())})
        with self.assertRaises(ValueError):self.u.process('begin',{**self.args,'sha256':'a'*64})
        self.assertEqual(self.u.part(self.u.read(self.args['key'])).read_bytes(),b'original')
    def test_verification_is_background_and_lost_finish_does_not_launch_twice(self):
        self.u.process('begin',self.args);self.put(0,self.payload)
        with patch.object(uploads,'active',return_value=False),patch.object(uploads.subprocess,'run',return_value=SimpleNamespace(returncode=0)) as launch:
            result=self.u.process('finish',{'key':self.args['key']})
            self.assertEqual(result['state'],'VERIFYING');self.assertEqual(launch.call_count,1)
        with patch.object(uploads,'active',return_value=True),patch.object(uploads.subprocess,'run') as launch:
            self.u.process('finish',{'key':self.args['key']});launch.assert_not_called()
    def test_checksum_failure_preserves_original_and_staged_bytes(self):
        self.u.root.joinpath('nested').mkdir();target=self.u.root/self.args['path'];target.write_bytes(b'old')
        self.u.process('begin',{**self.args,'overwrite':True});self.put(0,b'x'*len(self.payload))
        with self.assertRaisesRegex(ValueError,'checksum'):self.u.verify(self.args['key'])
        self.assertEqual(target.read_bytes(),b'old');self.assertTrue(self.u.part(self.u.read(self.args['key'])).exists())
    def test_lost_completion_after_atomic_rename_recovers_original_receipt(self):
        self.u.process('begin',self.args);self.put(0,self.payload)
        save=uploads.save
        def lose(path,row):
            if row['state']=='COMPLETE':raise OSError('lost final receipt')
            return save(path,row)
        with patch.object(uploads,'save',side_effect=lose),self.assertRaises(OSError):self.u.verify(self.args['key'])
        result=self.u.process('status',{'path':self.args['path']})
        self.assertEqual(result['state'],'COMPLETE');self.assertEqual(result['key'],self.args['key'])
        self.assertEqual((self.u.root/self.args['path']).read_bytes(),self.payload)
    def test_cross_account_and_path_escape_are_rejected(self):
        self.u.process('begin',self.args)
        other=uploads.Uploads(self.config,'demo-user-2')
        self.assertEqual(other.process('status',{'path':self.args['path']})['state'],'ABSENT')
        with self.assertRaises(FileNotFoundError):other.process('chunk',{'key':self.args['key'],'offset':0,'data':'YWJj'})
        for path in ('../other','/etc/file','a//b'):
            with self.assertRaises(ValueError):self.u.process('begin',{**self.args,'path':path})
    def test_committed_file_without_final_record_allows_next_explicit_overwrite(self):
        self.u.process('begin',self.args);self.put(0,self.payload)
        self.u.verify(self.args['key'])
        row=self.u.read(self.args['key']);row['state']='COMMITTING'
        uploads.save(self.u.record(row['key']),row)
        self.assertEqual(self.u.process('status',{'key':row['key']})['state'],'COMPLETE')
        new={**self.args,'key':str(uuid.uuid4()),'overwrite':True}
        self.assertEqual(self.u.process('begin',new)['state'],'UPLOADING')
        self.assertEqual((self.u.root/self.args['path']).read_bytes(),self.payload)
    def test_changed_completed_destination_requires_explicit_overwrite(self):
        self.u.process('begin',self.args);self.put(0,self.payload);self.u.verify(self.args['key'])
        (self.u.root/self.args['path']).write_bytes(b'edited in terminal')
        self.assertEqual(self.u.process('status',{'key':self.args['key']})['state'],'CONFLICT')
        new={**self.args,'key':str(uuid.uuid4())}
        with self.assertRaisesRegex(ValueError,'overwrite'):self.u.process('begin',new)
        self.assertEqual(self.u.process('begin',{**new,'overwrite':True})['state'],'UPLOADING')
    def test_destination_symlinks_cannot_escape_personal_root(self):
        outside=Path(self.temp.name)/'outside';outside.mkdir()
        self.u.root.joinpath('nested').symlink_to(outside)
        with self.assertRaises(OSError):self.u.process('begin',self.args)
        self.assertEqual(list(outside.iterdir()),[])

if __name__=='__main__':unittest.main()
