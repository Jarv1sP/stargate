"""Only disposable owned folders are removed; no production or service calls."""
import importlib.util
import os
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parent
DEPLOY = HERE.parent/'deploy'


def load(path):
    spec = importlib.util.spec_from_file_location('cleanup_fixture_'+uuid.uuid4().hex, path)
    module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


class Cleanup(unittest.TestCase):
    def setUp(self):
        self.f = load(HERE/'data-workspace.test.py').DataWorkspaceTests();self.f.setUp()
        self.addCleanup(self.f.tearDown)
        shutil.copy2(DEPLOY/'workspace-cleanup.py', self.f.base/'workspace-cleanup.py')
        self.f.fill('old/data.bin', b'original private bytes')
        self.f.fill('keep/train.bin', b'keep training source')
        self.key = str(uuid.uuid4());self.c = self.f.w.cleanups()

    def remove(self, **extra):
        return self.f.call('remove', path='old', recursive=True, key=self.key, **extra)

    def test_preview_and_background_cleanup_work_without_bulk_reserve(self):
        with patch.object(self.f.cache, '_free', side_effect=AssertionError('cleanup checked bulk reserve')):
            plan = self.f.call('remove-plan', path='old', recursive=True)
            self.assertEqual(plan['state'], 'PREVIEW');self.assertIsNone(plan['freedBytes'])
            self.assertEqual(self.remove()['state'], 'QUEUED')
            self.assertTrue((self.f.owner/'data/old').exists())
            self.assertEqual(self.c.worker(self.f.user, self.key), 0)
        self.assertEqual(self.f.call('remove-status', key=self.key)['state'], 'SUCCEEDED')
        self.assertFalse((self.f.owner/'data/old').exists())
        self.assertEqual((self.f.owner/'data/keep/train.bin').read_bytes(), b'keep training source')

    def test_same_key_never_removes_a_recreated_directory(self):
        self.remove();self.assertEqual(self.c.worker(self.f.user, self.key), 0)
        self.f.fill('old/new.bin', b'new object')
        self.assertEqual(self.remove()['state'], 'SUCCEEDED')
        self.assertEqual(self.c.worker(self.f.user, self.key), 0)
        self.assertEqual((self.f.owner/'data/old/new.bin').read_bytes(), b'new object')

    def test_replacement_before_worker_and_live_workspace_are_protected(self):
        lock = self.f.w.lifetime(self.f.user)
        try:
            with self.assertRaisesRegex(ValueError, 'busy'):self.remove()
        finally:os.close(lock)
        self.remove()
        (self.f.owner/'data/old').rename(self.f.owner/'data/previous')
        self.f.fill('old/new.bin', b'replacement')
        self.assertEqual(self.c.worker(self.f.user, self.key), 1)
        self.assertEqual((self.f.owner/'data/old/new.bin').read_bytes(), b'replacement')
        self.assertTrue((self.f.owner/'data/previous/data.bin').exists())

    def test_terminal_evidence_is_checked_even_if_lifetime_lock_was_lost(self):
        with patch.object(self.f.w, 'no_terminals', side_effect=ValueError('terminal not confirmed stopped')):
            with self.assertRaisesRegex(ValueError, 'terminal not confirmed'):self.remove()
        self.remove()
        with patch.object(self.f.w, 'no_terminals', side_effect=ValueError('terminal not confirmed stopped')):
            self.assertEqual(self.c.worker(self.f.user, self.key), 1)
        self.assertTrue((self.f.owner/'data/old/data.bin').exists())

    def test_wrong_owner_root_escape_and_wrong_key_target_are_rejected(self):
        for path in ['.', '..', '../operations', '/data1', 'old/../keep']:
            with self.assertRaises(ValueError):self.f.call('remove-plan', path=path, recursive=True)
        with self.assertRaises(FileNotFoundError):self.f.call('remove-plan', path='old', recursive=True, user='demo-user-2')
        self.remove()
        with self.assertRaisesRegex(ValueError, 'another target'):
            self.f.call('remove', path='keep', recursive=True, key=self.key)
        with self.assertRaises(FileNotFoundError):self.f.call('remove-status', key=self.key, user='demo-user-2')

    def test_interrupted_delete_and_lost_completion_keep_new_source_untouched(self):
        self.remove()
        real = self.c.w.storage(self.f.user)[0]._write_json
        failed = [False]
        def write(path, value):
            if value.get('state') == 'SUCCEEDED' and not failed[0]:
                failed[0] = True;raise OSError('synthetic completion loss')
            return real(path, value)
        with patch.object(self.f.module, '_write_json', side_effect=write):
            self.assertEqual(self.c.worker(self.f.user, self.key), 1)
        self.f.fill('old/new.bin', b'new bytes')
        with patch.object(self.f.w, 'unit_stopped', return_value=True):
            self.assertTrue(self.c.status(self.f.user, self.key)['retryable'])
        self.assertEqual(self.c.worker(self.f.user, self.key), 0)
        self.assertEqual((self.f.owner/'data/old/new.bin').read_bytes(), b'new bytes')

    def test_dead_worker_is_unknown_not_fake_running(self):
        self.remove()
        with patch.object(self.f.w, 'unit_stopped', return_value=True):
            state = self.c.status(self.f.user, self.key)
        self.assertEqual(state['state'], 'UNKNOWN');self.assertTrue(state['retryable'])
        self.assertTrue((self.f.owner/'data/old/data.bin').exists())

    def test_unknown_service_is_not_presented_as_active_or_retryable(self):
        self.remove()
        with patch.object(self.c, 'active', return_value=False):
            state = self.c.status(self.f.user, self.key)
        self.assertEqual(state['state'], 'UNKNOWN');self.assertFalse(state['retryable'])
        with patch.object(self.c, 'active', return_value=True):
            state = self.c.status(self.f.user, self.key)
        self.assertEqual(state['state'], 'QUEUED');self.assertFalse(state['retryable'])


if __name__ == '__main__':unittest.main()
