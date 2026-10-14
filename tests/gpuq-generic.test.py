"""Portable fleet paths and sync safety; no network, daemon or GPU required."""
import json
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'gpuq'))
from gpuq import fleet, sync


class FleetPaths(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'fleet.json'
        self.host = {'ssh': 'research@gpu-1', 'binary': '/srv/research/bin/gpu',
                     'config': '/srv/research/scheduler/config.json'}

    def inventory(self, host):
        data = {'hosts': {'gpu-1': host}}
        self.path.write_text(json.dumps(data))
        return fleet.load_inventory(self.path)

    def test_existing_explicit_paths_are_preserved(self):
        legacy = {'ssh': 'platform-user@gpu-1', 'binary': '/home/platform-user/bin/gpu',
                  'config': '/data1/gpu-scheduler/config.json'}
        self.assertEqual(self.inventory(legacy), {'hosts': {'gpu-1': legacy}})
        command = fleet.ssh_command(legacy)
        self.assertEqual(command[-2], 'platform-user@gpu-1')
        self.assertEqual(command[-1], '/home/platform-user/bin/gpu --config /data1/gpu-scheduler/config.json _remote')

    def test_missing_paths_keep_existing_implicit_defaults(self):
        defaults = {'binary': '/home/platform-user/bin/gpu', 'config': '/data1/gpu-scheduler/config.json'}
        for key in ('binary', 'config'):
            host = {k: v for k, v in self.host.items() if k != key}
            with self.subTest(key=key):
                self.assertEqual(self.inventory(host), {'hosts': {'gpu-1': host}})
                expected = {**host, key: defaults[key]}
                self.assertEqual(shlex.split(fleet.ssh_command(host)[-1]),
                                 [expected['binary'], '--config', expected['config'], '_remote'])

    def test_relative_and_control_character_paths_are_rejected(self):
        for key in ('binary', 'config'):
            for value in ('gpu', '~/bin/gpu', '', None, 17, '/srv/gpu\nextra', '/srv/gpu\x7f'):
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, 'explicit absolute ' + key):
                    self.inventory({**self.host, key: value})

    def test_custom_paths_are_shell_quoted_without_expansion(self):
        host = {**self.host, 'binary': '/srv/research tools/gpu',
                'config': "/srv/research's scheduler/config.json"}
        self.inventory(host)
        command = fleet.ssh_command(host)
        self.assertEqual(shlex.split(command[-1]), [host['binary'], '--config', host['config'], '_remote'])

    def test_explicit_ssh_identity_options_are_unchanged(self):
        host = {**self.host, 'identity_file': '/keys/private key', 'known_hosts_file': '/keys/known hosts'}
        self.inventory(host)
        command = fleet.ssh_command(host)
        self.assertEqual(command[command.index('-i') + 1], host['identity_file'])
        self.assertIn('UserKnownHostsFile=' + host['known_hosts_file'], command)
        self.assertIn('StrictHostKeyChecking=yes', command)

    def test_rsync_uses_explicit_binary_and_same_ssh_transport(self):
        meta = {'phase': 'plan', 'exclude': []}
        host = {**self.host, 'binary': '/srv/service tools/gpu'}
        command = sync.rsync_command(Path('/srv/project'), '/srv/dataset', host, meta)
        remote = next(arg.split('=', 1)[1] for arg in command if arg.startswith('--rsync-path='))
        parts = shlex.split(remote)
        self.assertEqual(parts[:4], [host['binary'], '--config', host['config'], '_sync-rsync'])
        from gpuq.cli import build_parser
        parsed = build_parser().parse_args(parts[1:])
        self.assertEqual(parsed.config, host['config'])
        self.assertEqual(shlex.split(command[command.index('-e') + 1]), fleet.ssh_command(host)[:-2])
        self.assertEqual(command[-1], host['ssh'] + ':/srv/dataset/')
        defaults = {'binary': '/home/platform-user/bin/gpu', 'config': '/data1/gpu-scheduler/config.json'}
        for key in ('binary', 'config'):
            with self.subTest(key=key):
                missing = {k: v for k, v in host.items() if k != key}
                command = sync.rsync_command(Path('/srv/project'), '/srv/dataset', missing, meta)
                remote = next(arg.split('=', 1)[1] for arg in command if arg.startswith('--rsync-path='))
                expected = {**missing, key: defaults[key]}
                self.assertEqual(shlex.split(remote)[:4],
                                 [expected['binary'], '--config', expected['config'], '_sync-rsync'])
                self.assertEqual(shlex.split(command[command.index('-e') + 1]), fleet.ssh_command(missing)[:-2])


class ForcedSyncConfiguration(unittest.TestCase):
    def setUp(self):
        self.config = '/srv/research scheduler/config.json'
        self.server_args = ['--server', '-nOrce.iLsfxCIvu', '--log-format=%i', '.', '/srv/data/']

    def call(self, words):
        with patch.dict(sync.os.environ, {'SSH_ORIGINAL_COMMAND': shlex.join(words)}):
            return sync.forced_receiver(self.config)

    def test_legacy_command_uses_forced_server_config(self):
        with patch.object(sync, 'receiver', return_value=17) as receiver:
            self.assertEqual(self.call(['/home/platform-user/bin/gpu', '_sync-rsync', 'header', *self.server_args]), 17)
        receiver.assert_called_once_with('header', self.server_args, self.config)

    def test_explicit_matching_config_uses_server_value(self):
        with patch.object(sync, 'receiver', return_value=23) as receiver:
            self.assertEqual(self.call(['/srv/tools/gpu', '--config', self.config, '_sync-rsync', 'header', *self.server_args]), 23)
        receiver.assert_called_once_with('header', self.server_args, self.config)

    def test_config_override_is_rejected_before_receiver(self):
        for value in ('/srv/other/config.json', '../config.json', '/etc/config.json', self.config + '\n'):
            with self.subTest(value=value), patch.object(sync, 'receiver') as receiver, self.assertRaisesRegex(ValueError, 'does not match'):
                self.call(['/srv/tools/gpu', '--config', value, '_sync-rsync', 'header', *self.server_args])
            receiver.assert_not_called()

    def test_unsupported_option_layouts_fail_closed(self):
        for options in (['--config=/other', '_sync-rsync', 'header'],
                        ['--config', self.config, '--config', '/other', '_sync-rsync', 'header'],
                        ['--config', self.config, '_sync-rsync']):
            with self.subTest(options=options), patch.object(sync, 'receiver') as receiver, self.assertRaisesRegex(ValueError, 'unsupported'):
                self.call(['/srv/tools/gpu', *options])
            receiver.assert_not_called()

    def test_non_sync_command_still_uses_normal_remote_protocol(self):
        with patch.object(sync, 'receiver') as receiver:
            self.assertIsNone(self.call(['/srv/tools/gpu', '--config', self.config, '_remote']))
        receiver.assert_not_called()


class SyncBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_existing_and_generic_home_roots_are_rejected(self):
        for value in ('/', '/home', '/home/platform-user', '/home/gpuq', '/home/alice', '/Users', '/Users/alice',
                      '/root', '/data1', '/data2', '/tmp', '/var/tmp'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'broad'):
                sync.valid_path(value)
        custom_home = self.root / 'custom-home'
        with patch.object(Path, 'home', return_value=custom_home), self.assertRaisesRegex(ValueError, 'broad'):
            sync.valid_path(str(custom_home))

    def test_project_subdirectory_is_not_a_whole_home(self):
        # Pure path-policy checks, independent of the test host's /home symlinks.
        with patch.object(Path, 'is_symlink', return_value=False), patch.object(Path, 'exists', return_value=False):
            for value in ('/home/platform-user/project', '/home/gpuq/project', '/home/alice/project', '/Users/alice/project'):
                with self.subTest(value=value):
                    self.assertEqual(sync.valid_path(value), Path(value))

    def test_existing_system_credential_and_scheduler_guards_remain(self):
        for value in ('/etc/project', '/proc/project', '/var/lib/project', '/home/alice/.ssh',
                      '/home/alice/miniconda3', '/home/alice/../other'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                sync.valid_path(value)
        scheduler = self.root / 'scheduler'
        for target in (scheduler, scheduler / 'state', self.root):
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, 'scheduler'):
                sync.valid_path(str(target), scheduler)

    def test_real_project_allowed_and_symlink_rejected(self):
        project = self.root / 'project'
        project.mkdir()
        self.assertEqual(sync.valid_path(str(project)), project)
        link = self.root / 'link'
        link.symlink_to(project, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            sync.valid_path(str(link))


if __name__ == '__main__':
    unittest.main()
