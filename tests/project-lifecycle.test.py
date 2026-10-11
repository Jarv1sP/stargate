"""Project lifecycle on synthetic private stores only; no jobs or services."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location('lifecycle_store_fixture',Path(__file__).with_name('project-store.test.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
sys.modules[base.module.__name__]=base.module
s=base.module
DEPLOY=Path(__file__).resolve().parents[1]/'deploy'
spec=importlib.util.spec_from_file_location('lifecycle_ops',DEPLOY/'project-ops.py')
o=importlib.util.module_from_spec(spec);spec.loader.exec_module(o)


class LifecycleTests(unittest.TestCase):
    initialize_env=base.ProjectStoreTests.initialize_env
    cleanup=base.ProjectStoreTests.cleanup
    publish=base.ProjectStoreTests.publish

    def setUp(self):
        base.ProjectStoreTests.setUp(self)
        self.node=SimpleNamespace(ROOT=self.root,HERE=DEPLOY,CONFIG={'conda':str(self.base)},ENV={},
                                  workspace=lambda user:s.private_dir(self.root/'users'/user,create=True),atomic_json=s.atomic_json)
        # This fixture does not start systemd or read host service state.
        self.node.workspace=lambda user:user
        self.ops=o.ProjectOperations(self.node);self.ops.store=self.store
        self.ops.active=lambda args:False
        self.ops.terminal_stopped=lambda key:True
        self.life=self.ops.lifecycle()
        self.args={'userId':self.user,'project':self.slug}

    def plan(self):return self.life.plan(self.args)

    def test_plan_includes_complete_draft_without_self_lock_false_positive(self):
        value=self.plan();self.assertEqual(value['state'],'ELIGIBLE',value)
        self.assertEqual(value['lifecycle']['revision'],0)
        self.assertGreater(value['entries'],10)
        self.assertEqual(value['manifestSha256'],self.plan()['manifestSha256'])

    def test_unused_published_project_is_eligible_and_release_identity_preserved(self):
        published=self.publish();value=self.plan()
        self.assertEqual(value['state'],'ELIGIBLE');self.assertEqual(value['releases'],[published['release']])
        self.life.archive({**self.args,'revision':0},True)
        self.assertEqual(self.store.release(self.user,self.slug,published['release'])['meta']['release'],published['release'])

    def test_archive_cas_blocks_new_writes_not_history_and_can_unarchive(self):
        version=self.publish()['release'];key=str(uuid.uuid4())
        paths=self.store.run_paths(self.user,self.slug,version,key);(paths['output']/'done').write_text('saved')
        old=self.store.status(self.user,self.slug)
        self.assertEqual(self.life.archive({**self.args,'revision':0},True)['state'],'ARCHIVED')
        self.assertEqual(self.store.status(self.user,self.slug),old)
        self.assertEqual((self.store.existing_run_paths(self.user,self.slug,version,key)['output']/'done').read_text(),'saved')
        for call in [lambda:self.store.create(self.user,self.slug),lambda:self.ops.writable(self.args),lambda:self.store.publish(self.user,self.slug)]:
            with self.assertRaises(ValueError):call()
        with self.assertRaisesRegex(ValueError,'revision'):self.life.archive({**self.args,'revision':0},False)
        self.assertEqual(self.life.archive({**self.args,'revision':1},False)['state'],'ACTIVE')
        self.ops.writable(self.args)

    def test_any_job_claim_or_output_blocks_retirement_even_finished(self):
        jobs=s.private_dir(self.root/'jobs',create=True);key=str(uuid.uuid4())
        s.atomic_json(jobs/(key+'.json'),{**self.args,'state':'SUCCEEDED'})
        self.assertIn('job-history',[x['kind'] for x in self.plan()['blockers']])
        (jobs/(key+'.json')).unlink()
        version=self.publish()['release'];self.store.run_paths(self.user,self.slug,version,key)
        self.assertEqual(set(x['kind'] for x in self.plan()['blockers']),{'run-claim','run-output'})

    def test_unknown_terminal_publication_upload_and_sync_block(self):
        terminals=s.private_dir(self.root/'terminals',create=True);key=str(uuid.uuid4())
        s.atomic_json(terminals/(key+'.json'),self.args);self.ops.terminal_stopped=lambda key:False
        s.atomic_json(self.ops.receipt_path(self.args),{'state':'UNKNOWN'})
        uploads=s.private_dir(self.ops.folder/(self.ops.key(self.args)+'.uploads'),create=True)
        s.atomic_json(uploads/(key+'.json'),{'state':'UPLOADING'})
        s.atomic_json(self.ops.folder/(self.ops.key(self.args)+'.sync.json'),{'state':'COPYING'})
        value=self.plan();self.assertEqual(value['state'],'BLOCKED')
        self.assertEqual(set(x['kind'] for x in value['blockers']),{'writer','publication','upload','terminal'})
        with self.assertRaisesRegex(ValueError,'writers'):self.life.archive({**self.args,'revision':0},True)

    def test_blocked_plan_does_not_scan_tree_or_issue_retirement_proof(self):
        jobs=s.private_dir(self.root/'jobs',create=True)
        s.atomic_json(jobs/(str(uuid.uuid4())+'.json'),{**self.args,'state':'SUCCEEDED'})
        with patch.object(self.life,'manifest',side_effect=ValueError('Retirement plan exceeds bounded scan size')) as scan:
            value=self.plan()
            self.assertEqual(value['state'],'BLOCKED')
            self.assertIn('job-history',[item['kind'] for item in value['blockers']])
            for field in ('manifestSha256','rootIdentity','entries','bytes'):
                self.assertNotIn(field,value)
            with self.assertRaisesRegex(ValueError,'execution history'):
                self.life.retire({**self.args,'key':str(uuid.uuid4()),'revision':0,'manifestSha256':'a'*64})
            scan.assert_not_called()
        self.assertTrue((self.dev['code']/'train.py').exists())

    def test_eligible_plan_still_requires_full_bounded_manifest(self):
        with patch.object(self.life,'manifest',side_effect=ValueError('Retirement plan exceeds bounded scan size')) as scan:
            with self.assertRaisesRegex(ValueError,'bounded scan size'):self.plan()
            scan.assert_called_once()

    def test_local_import_unknown_cannot_archive_even_if_old_release_ready(self):
        s.atomic_json(self.ops.folder/(self.ops.key(self.args)+'.local-import.json'),{'key':str(uuid.uuid4())})
        self.ops.local_imports=lambda:SimpleNamespace(project_writable=lambda args:(_ for _ in ()).throw(ValueError('UNKNOWN import')))
        self.assertIn('writer',[x['kind'] for x in self.plan()['blockers']])

    def test_reader_shared_lock_blocks_retirement_exclusive_across_instances(self):
        other=s.ProjectStore(self.root,self.base,reserve_bytes=0)
        with other.lifetime(self.user,self.slug):
            with self.assertRaisesRegex(ValueError,'reader'):self.plan()
            with self.assertRaisesRegex(ValueError,'reader'):self.life.archive({**self.args,'revision':0},True)
        self.assertEqual(self.plan()['state'],'ELIGIBLE')

    def test_hardlinks_special_files_and_foreign_receipts_fail_closed(self):
        os.link(self.dev['code']/'train.py',self.dev['code']/'linked')
        with self.assertRaisesRegex(ValueError,'hard links'):self.plan()
        (self.dev['code']/'linked').unlink()
        folder=self.store.lifecycle_folder(self.user,self.slug)
        s.atomic_json(folder/(self.slug+'.json'),{'schema':1,'owner':'foreign','project':self.slug,'state':'ACTIVE','revision':1})
        with self.assertRaisesRegex(ValueError,'receipt'):self.store.admit(self.user,self.slug)

    def test_plan_digest_change_and_owner_field_do_not_move_anything(self):
        plan=self.plan();(self.dev['code']/'train.py').write_text('changed')
        with self.assertRaisesRegex(ValueError,'changed'):self.life.retire({**self.args,'key':str(uuid.uuid4()),'revision':0,'manifestSha256':plan['manifestSha256']})
        self.assertTrue((self.dev['code']/'train.py').exists())
        for extra in [{'hostPath':'/data1'},{'root':True},{'key':'short'}]:
            with self.assertRaises(ValueError):self.life.plan({**self.args,**extra})

    def retire_with_fixture(self,key=None):
        plan=self.plan();args={**self.args,'key':key or str(uuid.uuid4()),'revision':plan['lifecycle']['revision'],'manifestSha256':plan['manifestSha256']}
        def rename(source_fd,source,target_fd,target):
            try:os.stat(target,dir_fd=target_fd,follow_symlinks=False)
            except FileNotFoundError:pass
            else:raise FileExistsError(target)
            os.rename(source,target,src_dir_fd=source_fd,dst_dir_fd=target_fd)
        # Mac fixture only; production has no fallback. Linux exercises the
        # actual renameat2 implementation in the dedicated test below.
        real=importlib.util.spec_from_file_location
        class Loader:
            def exec_module(self,module):module.atomic_import_available=lambda:True;module.rename_new=rename
        def load(name,path):return SimpleNamespace(loader=Loader()) if name=='gpuq_lifecycle_rename' else real(name,path)
        with patch.object(self.life.retire.__globals__['importlib'].util,'spec_from_file_location',side_effect=load),patch.object(self.life.retire.__globals__['importlib'].util,'module_from_spec',return_value=SimpleNamespace()):
            value=self.life.retire(args)
        return args,value

    def test_atomic_soft_retirement_is_idempotent_preserves_bytes_and_slug_tombstone(self):
        args,value=self.retire_with_fixture();self.assertEqual(value['state'],'RETIRED')
        target=self.store.lifecycle_folder(self.user,self.slug)/'.trash'/args['key']
        self.assertEqual((target/'dev/code/train.py').read_text(),'print("test")\n')
        self.assertEqual(self.store.list(self.user),[])
        self.assertEqual(self.life.retire(args)['state'],'RETIRED')
        with self.assertRaises(ValueError):self.store.create(self.user,self.slug)
        with self.assertRaises(ValueError):self.life.retire({**args,'key':str(uuid.uuid4())})
        with self.assertRaises(ValueError):self.life.status({**self.args,'key':str(uuid.uuid4())})
        other='demo-user-13';self.store.create(other,self.slug);self.assertEqual(self.store.status(other,self.slug)['state'],'DRAFT')

    def test_interrupted_retirement_keeps_unknown_fence_and_original_key(self):
        plan=self.plan();key=str(uuid.uuid4());folder=self.store.lifecycle_folder(self.user,self.slug)
        s.atomic_json(folder/(self.slug+'.json'),{**self.store.lifecycle(self.user,self.slug),'state':'RETIRING','revision':1,'sourceRevision':0,'retirementId':key,'manifestSha256':plan['manifestSha256'],'rootIdentity':plan['rootIdentity']})
        self.assertEqual(self.life.status({**self.args,'key':key})['state'],'RETIRING')
        with self.assertRaises(ValueError):self.store.create(self.user,self.slug)
        value=self.life.retire({**self.args,'key':key,'revision':0,'manifestSha256':plan['manifestSha256']})
        self.assertEqual(value['state'],'RETIRING');self.assertTrue(self.dev['code'].exists())

    @unittest.skipUnless(sys.platform.startswith('linux'),'actual no-replace retirement requires Linux')
    def test_real_linux_retirement_no_replace(self):
        plan=self.plan();key=str(uuid.uuid4())
        value=self.life.retire({**self.args,'key':key,'revision':0,'manifestSha256':plan['manifestSha256']})
        self.assertEqual(value['state'],'RETIRED')


if __name__=='__main__':unittest.main()
