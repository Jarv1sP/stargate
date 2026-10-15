"""Streaming node release receiver; real subprocesses, no SSH or host services."""
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('node_receive', ROOT/'deploy/node/receive.py')
RECEIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECEIVER)

INSTALLER = '''import json,sys
from pathlib import Path
package=Path(sys.argv[1]); config=Path(sys.argv[3])
value=json.loads(config.read_text())
assert sys.argv[2]=='--config'
assert (package/'node/helper').stat().st_mode & 0o111
result=dict(state='INSTALLED',node=value['node'],data=(package/'node/data').read_text(),
            extra={'kept':True},args=sys.argv[1:])
config.with_suffix('.called').write_text(json.dumps(result))
print(json.dumps(result))
'''


class Pipe(io.BytesIO):
    def seek(self, *args):
        raise io.UnsupportedOperation('stdin is not seekable')


def archive(entries):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as stream:
        for name, raw, kind, mode in entries:
            entry = tarfile.TarInfo(name)
            entry.type, entry.mode = kind, mode
            if kind in (tarfile.LNKTYPE, tarfile.SYMTYPE):
                entry.linkname = '../outside'
            data = raw.encode() if isinstance(raw, str) else raw
            if kind == tarfile.REGTYPE:
                entry.size = len(data)
            stream.addfile(entry, io.BytesIO(data) if entry.isfile() else None)
    return buffer.getvalue()


def payload(installer=INSTALLER):
    return [('install.py', installer, tarfile.REGTYPE, 0o644),
            ('package', b'', tarfile.DIRTYPE, 0o755),
            ('package/node/helper', '#!/bin/sh\n', tarfile.REGTYPE, 0o555),
            ('package/node/data', 'node payload', tarfile.REGTYPE, 0o444)]


class NodeReceiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.inbox = self.root/'inbox'
        self.inbox.mkdir()
        self.config = self.root/'private-node.json'
        self.config.write_text(json.dumps({'node': 'test-node'}))

    def run_receiver(self, data):
        with redirect_stderr(io.StringIO()):
            return RECEIVER.install_stream(Pipe(data), self.config, temp_root=self.inbox)

    def test_stream_runs_bundled_installer_with_local_config_and_preserves_extra_result_fields(self):
        value, code = self.run_receiver(archive(payload()))
        self.assertEqual(code, 0)
        self.assertEqual(value['state'], 'INSTALLED')
        self.assertEqual(value['node'], 'test-node')
        self.assertEqual(value['data'], 'node payload')
        self.assertEqual(value['extra'], {'kept': True})
        package, flag, config = value['args']
        self.assertEqual(flag, '--config')
        self.assertEqual(config, str(self.config))
        self.assertEqual(Path(package).name, 'package')
        self.assertEqual(json.loads(self.config.with_suffix('.called').read_text()), value)
        self.assertEqual(list(self.inbox.iterdir()), [])

    def test_cli_uses_fixed_private_config_and_does_not_interpret_ssh_command(self):
        out, err = io.StringIO(), io.StringIO()
        mask = os.umask(0o077)
        try:
            with patch.object(sys, 'argv', ['receive.py']), patch.object(sys, 'stdin', SimpleNamespace(buffer=Pipe(archive(payload())))), \
                    patch.object(RECEIVER, 'CONFIG', self.config), patch.object(RECEIVER, 'TEMP_ROOT', self.inbox), \
                    patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': 'sh -c "do-not-run" --config /wrong'}), \
                    redirect_stdout(out), redirect_stderr(err):
                code = RECEIVER.main()
        finally:
            os.umask(mask)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())['args'][-1], str(self.config))
        self.assertEqual(err.getvalue(), '')
        self.assertEqual(list(self.inbox.iterdir()), [])

    def test_installer_failure_returns_nonzero_json_and_keeps_diagnostics_and_cleans_temp(self):
        stderr = io.StringIO()
        script = 'import sys\nprint("installer failed",file=sys.stderr)\nraise SystemExit(7)\n'
        with redirect_stderr(stderr):
            value, code = RECEIVER.install_stream(Pipe(archive(payload(script))), self.config, temp_root=self.inbox)
        self.assertEqual(code, 7)
        self.assertEqual(value['state'], 'FAILED')
        self.assertIn('installer failed', stderr.getvalue())
        self.assertEqual(list(self.inbox.iterdir()), [])

    def test_missing_installer_or_malformed_tar_fails_without_invoking_an_installer(self):
        for data in (b'not a tar archive', archive(payload()[1:])):
            with self.subTest(data=data[:20]):
                value, code = self.run_receiver(data)
                self.assertNotEqual(code, 0)
                self.assertEqual(value['state'], 'FAILED')
                self.assertFalse(self.config.with_suffix('.called').exists())
                self.assertEqual(list(self.inbox.iterdir()), [])

    def test_path_escape_links_and_special_files_never_start_installer(self):
        absolute = str(self.root/'escaped')
        entries = [(absolute, tarfile.REGTYPE), ('../escaped', tarfile.REGTYPE),
                   ('package/../../escaped', tarfile.REGTYPE), ('link', tarfile.SYMTYPE),
                   ('hardlink', tarfile.LNKTYPE), ('fifo', tarfile.FIFOTYPE),
                   ('device', tarfile.CHRTYPE), ('block', tarfile.BLKTYPE)]
        for name, kind in entries:
            with self.subTest(name=name):
                data = archive([*payload(), (name, b'x', kind, 0o644)])
                value, code = self.run_receiver(data)
                self.assertEqual(code, 1)
                self.assertEqual(value['state'], 'FAILED')
                self.assertFalse((self.root/'escaped').exists())
                self.assertFalse(self.config.with_suffix('.called').exists())
                self.assertEqual(list(self.inbox.iterdir()), [])

    def test_truncated_stream_is_failure_and_never_starts_installer(self):
        data = archive([('package/incomplete', b'x'*4096, tarfile.REGTYPE, 0o444), *payload()])
        value, code = self.run_receiver(data[:1500])
        self.assertEqual(code, 1)
        self.assertEqual(value['state'], 'FAILED')
        self.assertFalse(self.config.with_suffix('.called').exists())
        self.assertEqual(list(self.inbox.iterdir()), [])

    def test_success_without_json_is_unknown_and_not_reported_as_success(self):
        value, code = self.run_receiver(archive(payload('print("not-json")\n')))
        self.assertEqual(code, 1)
        self.assertEqual(value['state'], 'UNKNOWN')
        self.assertIn('不要自动重放', value['error'])
        self.assertEqual(list(self.inbox.iterdir()), [])

    def test_archive_owner_and_setuid_bits_are_not_installed(self):
        folder = self.inbox/'extracted'
        folder.mkdir()
        data = archive([('helper', b'helper', tarfile.REGTYPE, 0o4755)])
        RECEIVER.receive(Pipe(data), folder)
        self.assertEqual(stat.S_IMODE((folder/'helper').stat().st_mode), 0o755)
        self.assertEqual((folder/'helper').stat().st_uid, os.geteuid())


if __name__ == '__main__':
    unittest.main()
