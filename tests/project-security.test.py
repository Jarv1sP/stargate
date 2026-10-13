"""Independent regression checks for project publication and identity barriers.

Only synthetic temporary directories and mocked service-manager responses are
used. These tests do not contact machines, start units, or execute user code.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'


class ProjectSecurity(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        for name in ('platform-root-guard.py','node-executor.py', 'scheduling-policy.py', 'project-ops.py', 'project-store.py', 'project-lifecycle.py', 'local-data.py'):
            shutil.copy2(DEPLOY / name, self.root / name)
        conda = self.root / 'base'
        for name in ('bin', 'conda-meta', 'lib'):
            (conda / name).mkdir(parents=True)
        (conda / 'bin/python').write_text('synthetic interpreter; never executed')
        (self.root / 'node-config.json').write_text(json.dumps({'root': str(self.root / 'state'), 'conda': str(conda)}))
        spec = importlib.util.spec_from_file_location('project_security_executor', self.root / 'node-executor.py')
        self.node = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.node
        spec.loader.exec_module(self.node)
        self.args = {'userId': 'demo-user-42', 'project': 'test'}
        self.node.workspace(self.args['userId'])
        self.ops = self.node.projects()
        self.node.process('projects.create', self.args)
        self.space = patch.object(self.node.os, 'statvfs', return_value=SimpleNamespace(f_bavail=100000000, f_frsize=4096))
        self.space.start()
        # Project admission uses a pinned descriptor; keep the same synthetic
        # capacity for that probe instead of depending on the host's disk.
        fd_space = patch.object(self.node.os, 'fstatvfs', return_value=SimpleNamespace(f_bavail=100000000, f_frsize=4096))
        fd_space.start()
        self.addCleanup(fd_space.stop)

    def tearDown(self):
        self.space.stop()
        self.temp.cleanup()

    def upload(self, data, **extra):
        return self.node.process('files.put', {**self.args, 'path': 'train.py',
            'uploadId': str(uuid.uuid4()), 'totalSize': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'offset': 0, 'final': True, 'data': base64.b64encode(data).decode(), **extra})

    def test_unknown_service_manager_state_must_not_confirm_terminal_stopped(self):
        unavailable = SimpleNamespace(returncode=1, stdout='', stderr='Failed to connect to bus: No medium found')
        with patch.object(self.node.subprocess, 'run', return_value=unavailable):
            self.assertFalse(self.ops.terminal_stopped(str(uuid.uuid4())))

    def test_unknown_stop_keeps_project_pointer_and_does_not_publish(self):
        jid = str(uuid.uuid4())
        pointer = self.node.terminal_pointer(self.args)
        pointer.parent.mkdir(exist_ok=True)
        pointer.write_text(jid)
        unavailable = SimpleNamespace(returncode=1, stdout='', stderr='Failed to connect to bus')
        with patch.object(self.node, 'terminal_alive', return_value=False), \
             patch.object(self.node.subprocess, 'run', return_value=unavailable), \
             patch.object(self.node, 'run', return_value='') as launch:
            with self.assertRaises((ValueError, RuntimeError)):
                self.node.process('projects.publish', self.args)
            launch.assert_not_called()
        self.assertEqual(pointer.read_text(), jid)

    def test_reopen_cannot_replace_unknown_old_terminal_pointer(self):
        jid = str(uuid.uuid4())
        pointer = self.node.terminal_pointer(self.args)
        pointer.parent.mkdir(exist_ok=True)
        pointer.write_text(jid)
        unavailable = SimpleNamespace(returncode=1, stdout='', stderr='Failed to connect to bus')
        with patch.object(self.node, 'terminal_alive', return_value=False), \
             patch.object(self.node.subprocess, 'run', return_value=unavailable), \
             patch.object(self.node.time, 'sleep'), \
             patch.object(self.node, 'run', return_value='') as launch:
            with self.assertRaises((ValueError, RuntimeError)):
                self.node.process('terminal.open', {**self.args, 'username': 'alice', 'key': str(uuid.uuid4())})
            launch.assert_not_called()
        self.assertEqual(pointer.read_text(), jid)

    def test_upload_identity_is_scoped_by_user_and_project(self):
        other = {**self.args, 'userId': 'demo-user-4'}
        self.node.process('projects.create', other)
        uid = str(uuid.uuid4())
        self.upload(b'first', uploadId=uid)
        request = {**other, 'path': 'train.py', 'uploadId': uid, 'offset': 0, 'totalSize': 6,
                   'sha256': hashlib.sha256(b'second').hexdigest(), 'final': True,
                   'data': base64.b64encode(b'second').decode()}
        self.node.process('files.put', request)
        own = self.node.process('files.get', {**self.args, 'path': 'train.py'})
        theirs = self.node.process('files.get', {**other, 'path': 'train.py'})
        self.assertEqual(base64.b64decode(own['data']), b'first')
        self.assertEqual(base64.b64decode(theirs['data']), b'second')

    def test_failing_final_digest_retains_old_complete_code_and_blocks_publish(self):
        self.upload(b'old complete code')
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            self.upload(b'new broken code', sha256='a' * 64)
        old = self.node.process('files.get', {**self.args, 'path': 'train.py'})
        self.assertEqual(base64.b64decode(old['data']), b'old complete code')
        with self.assertRaisesRegex(ValueError, 'Unfinished'):
            self.node.process('projects.publish', self.args)

    def test_final_target_symlink_is_replaced_without_touching_target(self):
        code = self.ops.store.dev_paths(self.args['userId'], self.args['project'])['code']
        elsewhere = self.root / 'unrelated'
        elsewhere.write_text('untouched')
        (code / 'train.py').symlink_to(elsewhere)
        self.upload(b'new safe code')
        self.assertEqual(elsewhere.read_text(), 'untouched')
        self.assertFalse((code / 'train.py').is_symlink())
        self.assertEqual((code / 'train.py').read_bytes(), b'new safe code')

    def test_code_symlink_parent_cannot_escape_to_other_project(self):
        other = {**self.args, 'project': 'second'}
        self.node.process('projects.create', other)
        code = self.ops.store.dev_paths(self.args['userId'], self.args['project'])['code']
        other_code = self.ops.store.dev_paths(other['userId'], other['project'])['code']
        (code / 'escape').symlink_to(other_code)
        with self.assertRaises(OSError):
            self.upload(b'blocked', path='escape/train.py')
        self.assertFalse((other_code / 'train.py').exists())


if __name__ == '__main__':
    unittest.main()
