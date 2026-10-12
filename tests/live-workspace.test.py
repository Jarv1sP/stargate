"""Mutable workspaces reuse original files, not publication or copies."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location('workspace_fixture',Path(__file__).with_name('project-store.test.py'))
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)

class LiveWorkspace(unittest.TestCase):
    def setUp(self):
        self.f=fixture.ProjectStoreTests();self.f.setUp();self.addCleanup(self.f.cleanup)
        self.store=self.f.store;self.user=self.f.user;self.project=self.f.slug

    def test_terminal_and_multiple_jobs_share_code_home_environment_and_outputs_without_release(self):
        with patch.object(self.store,'release',side_effect=AssertionError('must not require a release')), \
                patch.object(self.store,'publish',side_effect=AssertionError('must not publish')), \
                patch.object(fixture.module.shutil,'copytree',side_effect=AssertionError('must not copy')):
            terminal=self.store.workspace_paths(self.user,self.project)
            first=self.store.workspace_paths(self.user,self.project,str(uuid.uuid4()))
            second=self.store.workspace_paths(self.user,self.project,str(uuid.uuid4()))
        self.assertEqual(terminal,first);self.assertEqual(first,second)
        self.assertFalse(first['readonly'])
        (first['home']/'environment-cache').write_text('persist')
        (first['output']/'weights.bin').write_bytes(b'weights')
        (first['code']/'train.py').write_text('edited live')
        self.assertEqual((second['home']/'environment-cache').read_text(),'persist')
        self.assertEqual((second['output']/'weights.bin').read_bytes(),b'weights')
        self.assertEqual((self.f.dev['code']/'train.py').read_text(),'edited live')
        path,_=self.store._project(self.user,self.project)
        self.assertEqual(list((path/'runs').iterdir()),[])
        self.assertEqual(list((path/'releases').iterdir()),[])

    def test_retry_reuses_ownership_but_cannot_rebind_job_to_another_workspace(self):
        job=str(uuid.uuid4());first=self.store.workspace_paths(self.user,self.project,job)
        self.assertEqual(first,self.store.workspace_paths(self.user,self.project,job))
        self.store.create(self.user,'other')
        with self.assertRaises(fixture.module.ProjectError):self.store.workspace_paths(self.user,'other',job)
        with self.assertRaises(fixture.module.ProjectError):self.store.workspace_paths('demo-user-99',self.project,job)
        with self.assertRaises(fixture.module.ProjectError):self.store.workspace_paths(self.user,self.project,'invalid')

    def test_adoption_is_idempotent_and_preserves_historical_release(self):
        release=self.store.publish(self.user,self.project)['release']
        paths=self.store.activate_workspace(self.user,self.project)
        self.assertEqual(paths,self.store.activate_workspace(self.user,self.project))
        status=self.store.status(self.user,self.project)
        self.assertEqual(status['state'],'AVAILABLE')
        self.assertTrue(status['workspace']['persistent'])
        self.store.release(self.user,self.project,release)
        with self.assertRaisesRegex(fixture.module.ProjectError,'run directly'):
            self.store.publish(self.user,self.project)

    def test_runtime_and_output_download_reuse_workspace_without_creating_a_release(self):
        self.store.activate_workspace(self.user,self.project)
        job=str(uuid.uuid4());spec={'userId':self.user,'project':self.project,'workspace':True}
        paths=self.store.runtime_paths(spec,job)
        self.assertEqual(paths,self.store.runtime_paths(spec,job,terminal=True))
        output=self.store.existing_run_paths(self.user,self.project,None,job)
        self.assertEqual(paths['output'],output['output'])
        with self.assertRaises(fixture.module.ProjectError):
            self.store.existing_run_paths(self.user,self.project,'a'*64,job)
        with self.assertRaises(fixture.module.ProjectError):
            self.store.existing_run_paths(self.user,self.project,None,str(uuid.uuid4()))

    def test_historical_jobs_keep_original_snapshot_and_output_without_migration(self):
        release=self.store.publish(self.user,self.project)['release'];job=str(uuid.uuid4())
        old=self.store.run_paths(self.user,self.project,release,job)
        (old['output']/'result').write_text('historical')
        new=self.store.workspace_paths(self.user,self.project,str(uuid.uuid4()))
        self.assertNotEqual(old['output'],new['output']);self.assertNotEqual(old['home'],new['home'])
        self.assertEqual((self.store.existing_run_paths(self.user,self.project,release,job)['output']/'result').read_text(),'historical')
        with self.assertRaises(fixture.module.ProjectError):self.store.workspace_paths(self.user,self.project,job)

if __name__=='__main__':unittest.main()
