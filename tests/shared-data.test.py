"""Existing source bytes/FDs are real; no production node, copy, or GPU job."""
import fcntl
import importlib.util
import os
from pathlib import Path
import tempfile
import shutil
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

DEPLOY = Path(__file__).resolve().parents[1]/'deploy'


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), DEPLOY/(name+'.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


s = load('shared-data')


class SharedData(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root/'existing-imagenet'
        self.source.mkdir()
        (self.source/'sample.jpg').write_bytes(b'existing original sample')
        self.cfg = {'sharedDataDirectories': {'imagenet': str(self.source)}}

    def close(self, mounts):
        for fd, _ in mounts:
            os.close(fd)

    def test_many_consumers_read_the_same_inode_without_copy_or_free_space_check(self):
        original = (self.source/'sample.jpg').stat()
        # A busy managed-cache lock and full-disk admission cannot affect this
        # path: no DatasetCache/materialize/registration method is involved.
        with open(self.root/'cache.lock', 'w') as lock, patch.object(os, 'statvfs', side_effect=AssertionError('no write admission')), patch.object(os, 'fstatvfs', side_effect=AssertionError('no write admission')):
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for _ in range(100):
                mounts = s.open_mounts(self.cfg)
                try:
                    self.assertEqual(mounts[0][1], '/datasets/imagenet')
                    fd = os.open('sample.jpg', os.O_RDONLY, dir_fd=mounts[0][0])
                    try:
                        self.assertEqual(os.read(fd, 100), b'existing original sample')
                        self.assertEqual((os.fstat(fd).st_dev, os.fstat(fd).st_ino), (original.st_dev, original.st_ino))
                    finally:
                        os.close(fd)
                finally:
                    self.close(mounts)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['cache.lock', 'existing-imagenet'])
        self.assertEqual((self.source/'sample.jpg').stat().st_mode, original.st_mode)

    def test_development_and_training_both_receive_default_shared_read_mounts(self):
        for profile in ('sandbox-runner', 'sandbox-runner-common-p0'):
            runner = load(profile)
            for terminal in (True, False):
                with self.subTest(profile=profile, terminal=terminal), patch.object(runner, 'open_dataset_mounts', return_value=[]) as managed:
                    mounts = runner.open_input_mounts(self.cfg, {'userId': 'demo-user-1'}, terminal)
                    try:
                        self.assertEqual(mounts[0][1], '/datasets/imagenet')
                        self.assertEqual(os.fstat(mounts[0][0]).st_ino, self.source.stat().st_ino)
                    finally:
                        self.close(mounts)
                    self.assertEqual(managed.call_count, 0 if terminal else 1)

    def test_missing_directory_is_reported_without_creating_or_publishing_it(self):
        self.cfg['sharedDataDirectories']['absent'] = str(self.root/'absent')
        with self.assertRaisesRegex(ValueError, 'unavailable: absent'):
            s.open_mounts(self.cfg)
        self.assertFalse((self.root/'absent').exists())
        description = s.describe(self.cfg)
        self.assertEqual(description['directories'][0]['state'], 'UNAVAILABLE')
        self.assertNotIn(str(self.root), str(description))

    def test_bad_config_and_symlink_do_not_expose_an_unapproved_target(self):
        link = self.root/'link'; link.symlink_to(self.source, target_is_directory=True)
        for value in (None, [], {'../bad': str(self.source)}, {'data': '/'}, {'data': '/etc/ssh'}, {'data': str(link)}):
            with self.subTest(value=value), self.assertRaises((ValueError, OSError)):
                s.open_mounts({'sharedDataDirectories': value})

    def test_missing_shared_source_closes_previously_opened_managed_inputs(self):
        for profile in ('sandbox-runner', 'sandbox-runner-common-p0'):
            runner = load(profile); fd = os.open(self.source, os.O_RDONLY | os.O_DIRECTORY)
            with patch.object(runner, 'open_dataset_mounts', return_value=[(fd, '/data2/fixed')]):
                with self.assertRaises(ValueError):
                    runner.open_input_mounts({'sharedDataDirectories': {'gone': str(self.root/'gone')}}, {}, False)
            with self.assertRaises(OSError):os.fstat(fd)

    def test_unconfigured_nodes_keep_the_original_input_selection(self):
        for profile in ('sandbox-runner', 'sandbox-runner-common-p0'):
            runner = load(profile)
            with patch.object(runner, 'local_module', side_effect=AssertionError('no new dependency at runtime')), patch.object(runner, 'open_dataset_mounts', return_value=[]) as managed:
                self.assertEqual(runner.open_input_mounts({}, {}, True), [])
                managed.assert_not_called()
                self.assertEqual(runner.open_input_mounts({}, {}, False), [])
                managed.assert_called_once_with({})

    def test_managed_cache_cannot_be_mounted_without_its_existing_read_lease(self):
        for policy in ('datasets','storageWarehouse'):
            config={**self.cfg,policy:{'root':str(self.root)}}
            with self.assertRaisesRegex(ValueError,'normal dataset reader'):s.open_mounts(config)

    def test_project_status_advertises_real_paths_only_with_matching_runner(self):
        path=Path(__file__).with_name('node-projects.test.py')
        definition=importlib.util.spec_from_file_location('shared_data_project_fixture',path)
        fixture=importlib.util.module_from_spec(definition);definition.loader.exec_module(fixture)
        f=fixture.NodeProjects();f.setUp()
        try:
            shutil.copy2(DEPLOY/'shared-data.py',f.base/'shared-data.py')
            f.n.CONFIG.update(self.cfg)
            result=f.call('projects.status')['sharedData']
            self.assertTrue(result['available'])
            self.assertEqual(result['directories'],[{'name':'imagenet','path':'/datasets/imagenet','state':'READABLE','readOnly':True}])
            self.assertNotIn(str(self.source),str(result))
            with self.assertRaises(ValueError):f.call('projects.status',userId='demo-user-4')
            (f.base/'sandbox-runner.py').write_text('TRAINING_CONTROL_PROTOCOL=1\n')
            unsupported=f.call('projects.status')['sharedData']
            self.assertFalse(unsupported['available']);self.assertEqual(unsupported['directories'],[])
        finally:f.tearDown();f.doCleanups()

    def test_real_readonly_namespace_reads_original_and_refuses_writes(self):
        bwrap=shutil.which('bwrap')
        if not bwrap:self.skipTest('bubblewrap is not installed')
        mounts=s.open_mounts(self.cfg)
        script="import errno; p='/datasets/imagenet/sample.jpg'; assert open(p,'rb').read()==b'existing original sample'\ntry:\n open(p,'wb')\nexcept OSError as e:\n assert e.errno==errno.EROFS,e\nelse:\n raise AssertionError('source mount is writable')\nprint('READ_ONLY_CONFIRMED')"
        try:
            result=subprocess.run([bwrap,'--unshare-user','--unshare-net','--tmpfs','/',
                '--ro-bind','/usr','/usr','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
                '--ro-bind',sys.prefix,sys.prefix,'--dir','/datasets','--chdir','/',
                '--ro-bind-fd',str(mounts[0][0]),mounts[0][1],
                '--',sys.executable,'-c',script],pass_fds=(mounts[0][0],),text=True,capture_output=True,timeout=15)
        finally:self.close(mounts)
        if result.returncode and any(value in result.stderr for value in ('No permissions to create','Creating new namespace failed','Operation not permitted')):
            self.skipTest('local kernel does not allow the unprivileged namespace test')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),'READ_ONLY_CONFIRMED')
        self.assertEqual((self.source/'sample.jpg').read_bytes(),b'existing original sample')

    def test_oci_development_and_training_keep_shared_inputs_readonly(self):
        oci=load('personal-oci')
        for terminal in (True,False):
            mounts=s.open_mounts(self.cfg)
            owner=SimpleNamespace(load=lambda project:{'image':'unpulled-development-image'},execute=Mock(return_value=0),
                                  run=Mock(return_value='[]'))
            project={'code':self.source,'meta':{'oci':{'image':'sha256:'+'a'*64}}}
            try:
                with patch.object(oci,'PersonalOCI',return_value=owner),patch.object(oci,'module',return_value=SimpleNamespace(prepare=lambda *a:([],[]))):
                    self.assertEqual(oci.run_project({}, {'userId':'demo-user-1','project':'project'},project,terminal,[],0,{'home':1,'output':2},mounts),0)
                passed=owner.execute.call_args.args[4]
                self.assertIn((mounts[0][0],'/datasets/imagenet',True),passed)
            finally:self.close(mounts)


if __name__ == '__main__':unittest.main()
