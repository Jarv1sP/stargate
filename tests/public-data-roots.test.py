"""Real directories/flocks and project fixtures; no production paths or GPUs."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parent
DEPLOY = HERE.parent/'deploy'


def load(path):
    spec = importlib.util.spec_from_file_location('roots_'+uuid.uuid4().hex, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


class Roots(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        for name in ('control', 'data', 'fast', 'cache', 'warehouse'):
            (self.base/name).mkdir()
        self.config = {'root': str(self.base/'control'), 'datasets': {'root': str(self.base/'cache')},
                       'storageWarehouse': {'root': str(self.base/'warehouse')},
                       'publicDataRoots': {'enabled': True, 'roots': {
                           'data': {'path': str(self.base/'data'), 'mountPoint': str(self.base)},
                           'fast': {'path': str(self.base/'fast'), 'mountPoint': str(self.base)}}}}
        self.m = load(DEPLOY/'public-data-roots.py')
        mounted = patch.object(self.m, 'mount'); mounted.start(); self.addCleanup(mounted.stop)

    def test_multiple_consumers_share_original_inode_and_hold_maintenance_lock(self):
        data = self.base/'data/example'; data.write_bytes(b'shared original')
        saved = self.m.capture(self.config)
        with self.m.opened(self.config, saved) as (one, _), self.m.opened(self.config, saved) as (two, _):
            self.assertEqual([p for _, p in one], ['/data', '/fast-data'])
            a = os.open('example', os.O_RDONLY, dir_fd=one[0][0]); b = os.open('example', os.O_RDONLY, dir_fd=two[0][0])
            try:
                self.assertEqual(os.fstat(a).st_ino, data.stat().st_ino)
                self.assertEqual(os.fstat(a).st_ino, os.fstat(b).st_ino)
                self.assertEqual(os.read(b, 100), b'shared original')
            finally:os.close(a); os.close(b)
            with self.assertRaisesRegex(ValueError, 'in use'):
                with self.m.root_lock(self.config, saved['roots'][0], exclusive=True):pass
        with self.m.root_lock(self.config, saved['roots'][0], exclusive=True):
            with self.assertRaisesRegex(ValueError, 'maintenance'):
                with self.m.opened(self.config, saved):pass
        self.assertEqual(data.read_bytes(), b'shared original')

    def test_aliases_of_the_same_root_share_the_maintenance_lock(self):
        root = self.m.capture(self.config)['roots'][0]
        alias = {**root, 'path': str(self.base/'another-bind-name')}
        with self.m.root_lock(self.config, root):
            with self.assertRaisesRegex(ValueError, 'in use'):
                with self.m.root_lock(self.config, alias, exclusive=True):pass

    def test_optional_missing_root_and_required_missing_mount(self):
        (self.base/'fast').rmdir()
        saved = self.m.capture(self.config)
        self.assertEqual(self.m.public(saved)['unavailable'], ['/fast-data'])
        with self.m.opened(self.config, saved) as (fds, unavailable):
            self.assertEqual(len(fds), 1); self.assertEqual(unavailable, ['/fast-data'])
        with patch.object(self.m, 'mount', side_effect=ValueError('unmounted')):
            with self.assertRaisesRegex(ValueError, 'Main local'):self.m.capture(self.config)

    def test_crashed_parent_does_not_release_a_live_container_for_maintenance(self):
        saved = self.m.capture(self.config)
        consumer = {'unit': 'gpuq-fixture.service', 'cgroup': '/test/gpuq-fixture.service'}
        with patch.object(self.m, 'consumer_quiet', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'runner stopped'):
                with self.m.opened(self.config, saved, consumer=consumer):raise RuntimeError('runner stopped')
            with self.assertRaisesRegex(ValueError, 'still active'):
                with self.m.root_lock(self.config, saved['roots'][0], exclusive=True):pass
        with patch.object(self.m, 'consumer_quiet', return_value=True):
            with self.m.root_lock(self.config, saved['roots'][0], exclusive=True):pass

    def test_saved_root_not_retargeted_and_private_tree_never_exported(self):
        saved = self.m.capture(self.config)
        (self.base/'data').rename(self.base/'old'); (self.base/'data').mkdir()
        with self.assertRaisesRegex(ValueError, 'Saved main'):
            with self.m.opened(self.config, saved):pass
        for private in ('control', 'cache', 'warehouse'):
            self.config['publicDataRoots']['roots']['data']['path'] = str(self.base/private)
            with self.assertRaisesRegex(ValueError, 'metadata'):self.m.capture(self.config)

    def test_public_projection_has_no_host_paths_and_reads_do_not_require_reserve(self):
        with patch.object(os, 'statvfs', side_effect=AssertionError('read admission must not query writable headroom')):
            saved = self.m.capture(self.config)
            with self.m.opened(self.config, saved):pass
        view = self.m.public(saved)
        self.assertNotIn(str(self.base), json.dumps(view))
        self.assertTrue(all(row['readOnly'] for row in view['roots']))

    @unittest.skipUnless(shutil.which('bwrap'), 'bubblewrap is unavailable')
    def test_real_container_reads_shared_root_and_cannot_write_it(self):
        probe = subprocess.run(['bwrap', '--unshare-user', '--ro-bind', '/', '/', '--', '/bin/true'], capture_output=True)
        if probe.returncode:
            self.skipTest('kernel user namespaces unavailable for real container test')
        (self.base/'data/example').write_bytes(b'original')
        saved = self.m.capture(self.config)
        code = "import pathlib; p=pathlib.Path('/data/example'); assert p.read_bytes()==b'original';\ntry: p.write_bytes(b'changed')\nexcept OSError: pass\nelse: raise AssertionError('public mount was writable')"
        with self.m.opened(self.config, saved) as (fds, _):
            command = ['bwrap', '--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev']
            for fd, target in fds:command += ['--ro-bind-fd', str(fd), target]
            children = [subprocess.Popen([*command, '--', '/usr/bin/python3', '-c', code], pass_fds=tuple(fd for fd, _ in fds), stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
            for child in children:
                _, error = child.communicate(timeout=15)
                self.assertEqual(child.returncode, 0, error.decode())
        self.assertEqual((self.base/'data/example').read_bytes(), b'original')


class Projects(unittest.TestCase):
    def test_new_modes_legacy_and_restart_keep_separate_workspace_contracts(self):
        fixture = load(HERE/'node-projects.test.py').NodeProjects(); fixture.setUp()
        self.addCleanup(fixture.tearDown)
        shutil.copy2(DEPLOY/'public-data-roots.py', fixture.base/'public-data-roots.py')
        root = fixture.base/'public'; root.mkdir(); (root/'image.bin').write_bytes(b'one copy')
        fixture.n.CONFIG['publicDataRoots'] = {'enabled': True, 'roots': {'data': {'path': str(root), 'mountPoint': str(fixture.base)}}}
        module = fixture.ops.store_module.public_roots_module()
        self.assertNotIn('localStorage', fixture.call('projects.status'))
        for mode in ('project', 'task'):
            fixture.args['project'] = 'roots-'+mode
            with patch.object(module, 'mount'):
                created = fixture.call('projects.create', storageMode='local-roots', workspaceMode=mode)
            self.assertEqual(created['localStorage']['workspaceMode'], mode)
            with self.assertRaisesRegex(ValueError, 'cannot be changed'):
                fixture.call('projects.create', storageMode='local-roots', workspaceMode='task' if mode=='project' else 'project')
            fixture.upload(b'original code')
            env = fixture.ops.store.dev_paths(*fixture.ops.identity(fixture.args))['env']
            (env/'bin').mkdir(); (env/'bin/python').write_text('fixture venv')
            (env/'pyvenv.cfg').write_text('home = /opt/conda/bin\n')
            release = fixture.ops.store.publish(*fixture.ops.identity(fixture.args))['release']
            jid = str(uuid.uuid4())
            workspace = fixture.ops.store.local_run_workspace(*fixture.ops.identity(fixture.args), release, jid)
            (workspace/'result').write_bytes(b'keep on restart')
            self.assertEqual(fixture.ops.store.local_run_workspace(*fixture.ops.identity(fixture.args), release, jid), workspace)
            self.assertEqual((workspace/'result').read_bytes(), b'keep on restart')
            self.assertEqual((fixture.ops.store.release(*fixture.ops.identity(fixture.args), release)['code']/'train.py').read_bytes(), b'original code')
            self.assertFalse((workspace/'image.bin').exists())
            if mode=='project':self.assertEqual(workspace, fixture.ops.store.dev_paths(*fixture.ops.identity(fixture.args))['code'])
            else:self.assertNotEqual(workspace, fixture.ops.store.dev_paths(*fixture.ops.identity(fixture.args))['code'])


if __name__ == '__main__':unittest.main()
