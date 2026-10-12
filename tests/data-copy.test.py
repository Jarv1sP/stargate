"""Independent transfers: real rsync, synthetic SSH transport, no live nodes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('data_copy', Path(__file__).parents[1]/'deploy/data-copy.py')
copy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(copy)


class DataCopyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.peer = {'host': 'source.invalid', 'port': 22, 'user': 'transfer',
                     'identityFile': '/private/key', 'knownHostsFile': '/private/known-hosts'}
        self.config = {'root': str(self.root/'state'),
                       'dataTransferPeers': {'source': {'hdd': self.peer, 'mine': {'demo-user-1': self.peer}}}}
        self.args = {'userId': 'demo-user-1', 'key': str(uuid.uuid4()),
                     'from': 'source', 'scope': 'hdd', 'path': 'imagenet', 'destination': 'datasets/imagenet'}

    def test_start_retry_keeps_identity_without_launching_second_worker(self):
        with patch.object(copy.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as launch, \
             patch.object(copy, 'running', return_value=True):
            first = copy.dispatch(self.config, 'data.copy.start', self.args)
            again = copy.dispatch(self.config, 'data.copy.start', self.args)
        self.assertEqual(first, again)
        self.assertEqual(launch.call_count, 1)
        self.assertNotIn('peer', first)
        self.assertNotIn('userId', first)
        with self.assertRaises(ValueError):
            copy.dispatch(self.config, 'data.copy.start', {**self.args, 'path': 'different'})

    def test_missing_status_and_cross_account_read_do_not_rebind_copy(self):
        with patch.object(copy.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
            copy.dispatch(self.config, 'data.copy.start', self.args)
        self.assertEqual(copy.dispatch(self.config, 'data.copy.status',
            {'userId': 'demo-user-2', 'key': self.args['key']}), {'key': self.args['key'], 'state': 'ABSENT'})
        self.assertFalse(copy.record_path(self.config, 'demo-user-2', self.args['key']).parent.exists())
        with self.assertRaises(KeyError):
            copy.peer(self.config, 'source', 'mine', 'demo-user-2')

    def test_active_worker_cannot_resume_and_stopped_unknown_keeps_original_key(self):
        with patch.object(copy.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
            copy.dispatch(self.config, 'data.copy.start', self.args)
        request = {key: self.args[key] for key in ('userId', 'key')}
        with patch.object(copy, 'running', return_value=True), self.assertRaises(ValueError):
            copy.dispatch(self.config, 'data.copy.resume', request)
        with patch.object(copy, 'running', return_value=False), \
             patch.object(copy.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as launch:
            self.assertEqual(copy.dispatch(self.config, 'data.copy.status', request)['state'], 'UNKNOWN')
            resumed = copy.dispatch(self.config, 'data.copy.resume', request)
        self.assertEqual(resumed['key'], request['key'])
        self.assertEqual(launch.call_count, 1)

    def test_command_cannot_delete_source_or_extras_and_uses_restricted_ssh(self):
        command = copy.copy_command({**self.args, 'peer': self.peer}, 9, self.root/'partial')
        self.assertIn('--checksum', command)
        for forbidden in ('--delete', '--inplace', '--remove-source-files', '--protect-args'):
            self.assertNotIn(forbidden, command)
        ssh = shlex.split(command[command.index('-e')+1])
        self.assertIn('-oStrictHostKeyChecking=yes', ssh)
        self.assertIn('-oForwardAgent=no', ssh)
        self.assertEqual(command[-1], '/proc/self/fd/9/')
        self.assertEqual(command[-2], 'transfer@source.invalid:imagenet/')

    def test_paths_and_client_credentials_are_not_accepted(self):
        for path in ('../other', '/etc', 'a/../b', 'a//b', 'a\nb'):
            with self.assertRaises(ValueError):
                copy.dispatch(self.config, 'data.copy.start', {**self.args, 'path': path})
        with self.assertRaises(ValueError):
            copy.dispatch(self.config, 'data.copy.start', {**self.args, 'identityFile': '/key'})

    @unittest.skipUnless(shutil.which('rsync') and shutil.which('rrsync'), 'rsync/rrsync required')
    def test_real_rsync_restricted_sender_resumes_partial_and_preserves_extra_files(self):
        source = self.root/'source'
        (source/'imagenet').mkdir(parents=True)
        payload = os.urandom(4*1024*1024)
        (source/'imagenet'/'image data.bin').write_bytes(payload)
        target = self.root/'target'; target.mkdir()
        (target/'keep').write_text('must remain')
        partial = self.root/'partial'; partial.mkdir()
        # Local replacement for the SSH transport: still exercise the actual
        # forced rrsync command and rsync protocol, including path escaping.
        transport = self.root/'transport.py'
        transport.write_text('import os,sys\n'
            'os.environ["SSH_ORIGINAL_COMMAND"]=" ".join(sys.argv[sys.argv.index("rsync"):])\n'
            'os.execv("/usr/bin/rrsync",["rrsync","-ro",sys.argv[1]])\n')
        fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, fd)
        command = copy.copy_command({**self.args, 'peer': self.peer}, fd, partial)
        command[command.index('-e')+1] = shlex.join([sys.executable, str(transport), str(source)])
        limited = [command[0], '--bwlimit=512', *command[1:]]
        process = subprocess.Popen(limited, pass_fds=(fd,), start_new_session=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        time.sleep(.6)
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        _, error = process.communicate(timeout=10)
        self.assertNotEqual(process.returncode, 0)
        self.assertTrue(any(partial.rglob('*')), error.decode())
        finished = subprocess.run(command, pass_fds=(fd,), capture_output=True, text=True, timeout=20)
        self.assertEqual(finished.returncode, 0, finished.stderr)
        self.assertEqual(hashlib.sha256((target/'image data.bin').read_bytes()).digest(), hashlib.sha256(payload).digest())
        self.assertEqual((target/'keep').read_text(), 'must remain')
        self.assertEqual((source/'imagenet'/'image data.bin').read_bytes(), payload)


if __name__ == '__main__':
    unittest.main()
