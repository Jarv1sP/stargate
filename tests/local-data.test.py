"""Local input mounting is independent of dataset/cache metadata and capacity."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('local_data', Path(__file__).parents[1]/'deploy/local-data.py')
data = importlib.util.module_from_spec(spec)
spec.loader.exec_module(data)


class LocalDataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root/'hdd'
        self.source.mkdir()
        (self.source/'sample').write_bytes(b'original-data')
        self.personal = self.root/'personal'
        self.personal.mkdir()
        self.config = {'localDataDirectories': {'hdd': str(self.source)}, 'personalDataRoot': str(self.personal)}

    def mounts(self, config=None):
        result = data.open_mounts(config or self.config)
        for fd, _ in result:
            self.addCleanup(os.close, fd)
        return result

    def test_mounts_original_inode_without_copy_or_capacity_query(self):
        before = sorted(self.root.rglob('*'))
        with patch('os.statvfs', side_effect=AssertionError('Reads must not query capacity')):
            mounts = self.mounts()
        self.assertEqual(mounts[0][1], '/data/hdd')
        self.assertEqual(os.fstat(mounts[0][0]).st_ino, self.source.stat().st_ino)
        self.assertEqual(sorted(self.root.rglob('*')), before)
        fd = os.open('sample', os.O_RDONLY, dir_fd=mounts[0][0])
        try:
            self.assertEqual(os.read(fd, 30), b'original-data')
        finally:
            os.close(fd)

    def test_two_tasks_share_same_data(self):
        first, second = self.mounts()[0][0], self.mounts()[0][0]
        self.assertEqual(os.fstat(first).st_ino, os.fstat(second).st_ino)
        (self.source/'new-dataset').mkdir()
        self.assertIn('new-dataset', os.listdir(first))
        self.assertIn('new-dataset', os.listdir(second))

    def test_no_host_paths_in_public_description(self):
        self.assertEqual(data.describe(self.config), {'directories': [
            {'name': 'hdd', 'path': '/data/hdd', 'readOnly': True}],
            'personal': {'path': '/data/mine', 'readOnly': False}})

    def test_personal_data_is_persistent_and_separate_for_each_account(self):
        first = data.personal_directory(self.config, 'demo-user-1')
        second = data.personal_directory(self.config, 'demo-user-2')
        self.assertNotEqual(first, second)
        (first/'processed').write_text('mine')
        self.assertEqual(first, data.personal_directory(self.config, 'demo-user-1'))
        self.assertFalse((second/'processed').exists())
        with self.assertRaises(ValueError):
            data.personal_directory(self.config, '../other')

    def test_file_upload_uses_destination_volume_not_cache_admission(self):
        def operation(name, args, *, root, space_check):
            self.assertEqual(name, 'files.put')
            self.assertEqual(root, data.personal_directory(self.config, 'demo-user-1'))
            self.assertIs(space_check, data.require_write_space)
            return {'size': 3}
        result = data.process(self.config, 'datasets.workspace.put',
            {'userId': 'demo-user-1', 'hostAdmin': False, 'path': 'file', 'offset': 0, 'data': 'YWJj'}, operation)
        self.assertEqual(result, {'size': 3})
        with self.assertRaises(ValueError):
            data.process(self.config, 'datasets.workspace.publish',
                {'userId': 'demo-user-1', 'hostAdmin': False}, operation)

    def test_bad_configuration_and_symlink_are_rejected(self):
        for config in ({'../escape': str(self.source)}, {'mine': str(self.source)}, {'hdd': '/'}, {'hdd': '/x/../y'}):
            with self.assertRaises(ValueError):
                data.open_mounts({'localDataDirectories': config})
        link = self.root/'link'
        link.symlink_to(self.source)
        with self.assertRaises(OSError):
            data.open_mounts({'localDataDirectories': {'hdd': str(link)}})

    def test_partial_failure_closes_open_descriptors(self):
        opened = []
        real_open = data.open_directory
        def observe(path):
            fd = real_open(path)
            opened.append(fd)
            return fd
        with patch.object(data, 'open_directory', side_effect=observe):
            with self.assertRaises(FileNotFoundError):
                data.open_mounts({'localDataDirectories': {'a': str(self.source), 'z': str(self.root/'missing')}})
        self.assertEqual(len(opened), 1)
        with self.assertRaises(OSError):
            os.fstat(opened[0])

    @unittest.skipUnless(shutil.which('bwrap'), 'bubblewrap is not installed')
    def test_real_sandbox_can_read_but_not_write_original(self):
        fd, target = self.mounts()[0]
        script = 'test "$(cat /data/hdd/sample)" = original-data && ! touch /data/hdd/forbidden'
        result = subprocess.run(['bwrap', '--ro-bind', '/usr', '/usr',
            '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib64', '/lib64', '--dir', '/data',
            '--ro-bind-fd', str(fd), target, '--', '/bin/sh', '-c', script],
            pass_fds=(fd,), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.source/'forbidden').exists())


if __name__ == '__main__':
    unittest.main()
