"""Local node installation/rollback with real files and simulated host commands."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


INSTALL = load('node_install', ROOT / 'deploy/node/install.py')
BUILDER = load('node_builder', ROOT / 'scripts/build-node-release.py')


class Host(INSTALL.Installer):
    """Only command boundaries are fake; publication and rollback use real IO."""
    health_attempts = 2
    health_delay = 0

    def __init__(self, config, base):
        super().__init__(config)
        self.policy = base / 'etc/containers/policy.json'
        self.system_units = base / 'etc/systemd/system'
        self.states, self.calls = {}, []
        self.fail_start = self.fail_stop = None
        self.gpu_only_release = None

    def run(self, argv, *, user=False, check=True, timeout=90):
        argv = list(map(str, argv))
        self.calls.append((user, argv))
        code, output = 0, ''
        if argv[0] == '/usr/bin/nvidia-smi':
            code = int(self.gpu_only_release is not None and self.current.resolve() != self.gpu_only_release)
            output = '' if code else 'GPU-fixture\n'
        elif argv[-1] == '_init':
            Path(self.config['gpuq']['db_path']).write_bytes(b'existing jobs, attempts and settings')
        result = subprocess.CompletedProcess(argv, code, output, '')
        if check:
            result.check_returncode()
        return result

    def systemctl(self, scope, *args, check=True):
        self.calls.append((scope, list(args)))
        action, name = args[0], args[-1]
        value = self.states.setdefault((scope, name), dict(active=False, enabled=False, loaded=False))
        code, output = 0, ''
        if action in ('is-active', 'is-enabled'):
            code = 0 if value['active' if action == 'is-active' else 'enabled'] else 3
        elif action == 'start':
            if name == self.fail_start:
                self.fail_start = None
                code = 1
            else:
                value['active'] = value['loaded'] = True
        elif action == 'stop':
            if name == self.fail_stop:
                self.fail_stop = None
                code = 1
            else:
                value['active'] = False
        elif action == 'enable':
            value['enabled'] = value['loaded'] = True
        elif action == 'disable':
            value['enabled'] = False
        elif action == 'show':
            output = 'loaded' if value['loaded'] else 'not-found'
        result = subprocess.CompletedProcess(args, code, output, '')
        if check:
            result.check_returncode()
        return result


class InstallationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.home = self.base / 'home'
        self.home.mkdir()
        account = SimpleNamespace(pw_name='nodeops', pw_uid=os.geteuid(), pw_gid=os.getegid(), pw_dir=str(self.home))
        for mock in (patch.object(INSTALL.pwd, 'getpwnam', return_value=account),
                     patch.object(INSTALL.os, 'chown'), patch.object(INSTALL.os, 'fchown'),
                     patch.object(INSTALL, 'data_path', side_effect=lambda path, mounts: Path(path).resolve())):
            mock.start()
            self.addCleanup(mock.stop)
        data = self.base / 'data'
        cfg = dict(machine='node-example', cards=1, root=str(data/'state'), workspacesRoot=str(data/'workspaces'),
                   datasetsRoot=str(data/'datasets'), dataMountPoints=[str(data)], personalOci=dict(baseImage='fixture'),
                   jobMemoryGiBPerCard=3, directUpload=dict(token='local-fixture'), futureNodeField=1)
        self.config = dict(account='nodeops', releaseRoot=str(data/'releases'),
                           environment={'HTTPS_PROXY': 'http://proxy.example.invalid:1234', 'PATH': '/usr/bin:/bin'},
                           gpuq=dict(root=str(data/'scheduler'), db_path=str(data/'scheduler/state/gpuq.db'),
                                     log_dir=str(data/'scheduler/logs'), control_dir=str(data/'control'),
                                     socket_path=f'/run/user/{account.pw_uid}/gpuq/gpuq.sock',
                                     managed_gpu_uuids=['GPU-fixture'], observe_only=False),
                           profiles={name: copy.deepcopy(cfg) for name in BUILDER.PROFILES},
                           authorizedKeys=[dict(publicKey='ssh-ed25519 AAAATEST executor', profile='7IM'),
                                           dict(publicKey='ssh-ed25519 AAAACOLLECT sampler', profile='7IM', collector=True)],
                           gpuqService=dict(dropin=str(self.home/'.config/systemd/user/gpuq.service.d/binding.conf')),
                           services=[dict(name='node-http.service', profile='FGK'),
                                     dict(name='node-peer.service', scope='system', profile='peer'),
                                     dict(name='storage-collect.service', profile='7IM', seconds=3600),
                                     dict(name='container-observer.service', profile='R6t', seconds=60)], futureInstallerField=2)
        self.host = Host(self.config, self.base)
        self.package = self.make_package('first')

    def make_package(self, label):
        package = self.base / label
        (package/'node').mkdir(parents=True)
        for name in ('core-entry.py', 'core-service.py', 'node-probe.py', 'runtime-profile.py'):
            (package/'node'/name).write_bytes((ROOT/'node'/name).read_bytes())
        with zipfile.ZipFile(package/'gpuq.pyz', 'w') as archive:
            archive.writestr('__main__.py', 'print("READY", flush=True)\ninput()\nimport late\nprint(late.VALUE)\n')
            archive.writestr('late.py', 'VALUE = ' + repr(label))
        manifest = dict(profiles={name: BUILDER.profile_manifest(name) for name in BUILDER.PROFILES},
                        nodeFiles={}, gpuq=dict(path='gpuq.pyz', bytes=(package/'gpuq.pyz').stat().st_size))
        (package/'manifest.json').write_text(json.dumps(manifest))
        return package

    def selected(self):
        return self.host.current.resolve(strict=True)

    def assert_running(self):
        for name in ('gpuq.service', 'node-http.service', 'storage-collect.timer', 'container-observer.timer'):
            self.assertTrue(self.host.states['user', name]['active'], name)
        self.assertTrue(self.host.states['system', 'node-peer.service']['active'])

    def test_install_writes_private_profiles_policy_keys_units_and_only_initializes_new_database(self):
        ssh = self.home/'.ssh'
        ssh.mkdir(mode=0o700)
        (ssh/'authorized_keys').write_text('ssh-ed25519 AAAAADMIN keep\nrestrict,command="old" ssh-ed25519 AAAATEST executor\n')
        hami = self.base/'libvgpu.so'
        hami.write_bytes(b'local hami library')
        self.config['hamiLibrary'] = str(hami)
        result = self.host.install(self.package)
        self.assertEqual(result['state'], 'INSTALLED')
        self.assertEqual(json.loads(self.host.policy.read_text()), {'default': [{'type': 'insecureAcceptAnything'}]})
        self.assertEqual(stat.S_IMODE(self.host.policy.parent.stat().st_mode), 0o755)
        self.assertEqual((self.selected()/'hami/libvgpu.so').read_bytes(), hami.read_bytes())
        self.assertFalse((self.selected()/'hami/manifest.json').exists())
        for name in BUILDER.PROFILES:
            path = self.selected()/'profiles'/name/'node-config.json'
            cfg = json.loads(path.read_text())
            self.assertEqual(cfg['gpuqArchive'], str(self.selected()/'gpuq.pyz'))
            self.assertEqual(cfg['gpu'], str(self.selected()/'gpu'))
            self.assertEqual(cfg['jobMemoryGiBPerCard'], 3)
            self.assertEqual(cfg['directUpload'], self.config['profiles'][name]['directUpload'])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        keys = (ssh/'authorized_keys').read_text()
        self.assertIn('AAAAADMIN keep', keys)
        self.assertEqual(keys.count('AAAATEST'), 1)
        self.assertIn('--profile 7IM', keys)
        self.assertIn('STARGATE_CORE_PROFILE=7IM', keys)
        self.assertIn('node-probe.py', keys)
        unit = (self.home/'.config/systemd/user/gpuq.service').read_text()
        self.assertIn(str(self.host.current/'gpu'), unit)
        self.assertIn('HTTPS_PROXY=', unit)
        self.assertIn('User=nodeops', (self.host.system_units/'node-peer.service').read_text())
        self.assert_running()
        self.assertEqual(sum(args[-1] == '_init' for _, args in self.host.calls), 1)
        self.host.install(self.make_package('second'))
        self.assertEqual(sum(args[-1] == '_init' for _, args in self.host.calls), 1)

    def test_atomic_selection_and_rollback_preserve_old_pyz_lazy_import_job_and_database(self):
        self.host.install(self.package)
        first = self.selected()
        database = Path(self.config['gpuq']['db_path'])
        database.write_bytes(b'live job J1 and its running attempt')
        worker = subprocess.Popen([sys.executable, '-B', str(first/'gpuq.pyz')], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: worker.poll() is None and worker.kill())
        self.assertEqual(worker.stdout.readline().strip(), 'READY')
        old_bytes = (first/'gpuq.pyz').read_bytes()
        self.host.states['user', 'gpuq-job-fixture.service'] = dict(active=True, enabled=False, loaded=True)
        with patch.object(INSTALL.os, 'replace', wraps=INSTALL.os.replace) as rename:
            self.host.install(self.make_package('second'))
            switches = [c for c in rename.call_args_list if c.args[1] == self.host.current]
            self.assertEqual(len(switches), 1)
        second = self.selected()
        self.assertNotEqual(first, second)
        output, error = worker.communicate('\n', timeout=10)
        self.assertEqual((worker.returncode, output.strip(), error), (0, 'first', ''))
        self.assertEqual((first/'gpuq.pyz').read_bytes(), old_bytes)
        self.host.rollback()
        self.assertEqual(self.selected(), first)
        self.assertTrue(second.exists())
        self.assertEqual(database.read_bytes(), b'live job J1 and its running attempt')
        self.assertTrue(self.host.states['user', 'gpuq-job-fixture.service']['active'])
        self.assertFalse(any('gpuq-job-fixture.service' in args for _, args in self.host.calls))
        self.assert_running()

    def test_health_failure_after_switch_restores_files_pointer_enable_state_and_old_services(self):
        self.host.install(self.package)
        first = self.selected()
        key_path = self.home/'.ssh/authorized_keys'
        original = key_path.read_bytes()
        self.host.gpu_only_release = first
        self.config['authorizedKeys'][0]['publicKey'] = 'ssh-ed25519 AAAACHANGED replacement'
        with self.assertRaisesRegex(RuntimeError, '读不到 GPU'):
            self.host.install(self.make_package('unhealthy'))
        self.assertEqual(self.selected(), first)
        self.assertEqual(key_path.read_bytes(), original)
        self.assert_running()

    def test_failure_before_switch_keeps_previous_release_and_restores_partial_binding_writes(self):
        self.host.install(self.package)
        first = self.selected()
        unit = self.home/'.config/systemd/user/gpuq.service'
        old_unit = unit.read_bytes()
        original = INSTALL.atomic
        failed = False
        def write(path, *args, **kwargs):
            nonlocal failed
            if str(path).endswith('authorized_keys') and not failed:
                failed = True
                raise OSError('fixture write failed')
            return original(path, *args, **kwargs)
        self.config['environment']['HTTPS_PROXY'] = 'http://different.example.invalid:1234'
        self.host.environment['HTTPS_PROXY'] = self.config['environment']['HTTPS_PROXY']
        with patch.object(INSTALL, 'atomic', side_effect=write), self.assertRaisesRegex(OSError, 'write failed'):
            self.host.install(self.make_package('partial'))
        self.assertEqual(self.selected(), first)
        self.assertEqual(unit.read_bytes(), old_unit)
        self.assert_running()

    def test_start_or_stop_failure_rolls_back_and_does_not_run_a_second_daemon(self):
        self.host.install(self.package)
        first = self.selected()
        for action in ('start', 'stop'):
            with self.subTest(action=action):
                setattr(self.host, 'fail_' + action, 'gpuq.service')
                with self.assertRaises((subprocess.CalledProcessError, RuntimeError)):
                    self.host.install(self.make_package('fail-' + action))
                self.assertEqual(self.selected(), first)
                self.assert_running()

    def test_failed_first_install_removes_new_bindings_and_leaves_no_current_version(self):
        self.host.fail_start = 'gpuq.service'
        with self.assertRaises(subprocess.CalledProcessError):
            self.host.install(self.package)
        self.assertFalse(self.host.current.exists())
        self.assertFalse((self.home/'bin/gpu').exists())
        self.assertFalse(self.host.policy.exists())

    def test_multiple_rollbacks_reach_each_previous_release_but_first_has_no_previous(self):
        selected = []
        for package in (self.package, self.make_package('second'), self.make_package('third')):
            self.host.install(package)
            selected.append(self.selected())
        self.host.rollback()
        self.assertEqual(self.selected(), selected[1])
        self.host.rollback()
        self.assertEqual(self.selected(), selected[0])
        with self.assertRaisesRegex(ValueError, '没有上一版'):
            self.host.rollback()
        self.assertEqual(self.selected(), selected[0])

    def test_archive_install_and_path_or_link_escape_never_replace_current(self):
        archive = self.base/'package.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(self.package, arcname='node-example')
        self.host.install(archive)
        first = self.selected()
        for name, kind in (('../outside', tarfile.REGTYPE), ('link', tarfile.SYMTYPE)):
            with self.subTest(name=name):
                with tarfile.open(archive, 'w:gz') as tar:
                    tar.add(self.package/'manifest.json', arcname='manifest.json')
                    info = tarfile.TarInfo(name)
                    info.type = kind
                    info.linkname = '/etc/passwd'
                    tar.addfile(info, io.BytesIO(b''))
                with self.assertRaises(ValueError):
                    self.host.install(archive)
                self.assertEqual(self.selected(), first)
        (self.package/'escape').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            self.host.install(self.package)
        self.assertEqual(self.selected(), first)

    def test_existing_container_policy_is_preserved(self):
        self.host.policy.parent.mkdir(parents=True)
        self.host.policy.write_text('{"default":[{"type":"reject"}]}')
        self.host.install(self.package)
        self.assertEqual(json.loads(self.host.policy.read_text())['default'][0]['type'], 'reject')

    def test_command_error_does_not_expose_private_environment_to_release_caller(self):
        result = subprocess.CompletedProcess([], 7, '', 'private diagnostic')
        with patch.object(INSTALL.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, '返回码 7') as error:
                INSTALL.Installer.run(self.host, ['false'], user=True)
        self.assertNotIn('proxy.example.invalid', str(error.exception))
        with patch.object(INSTALL.subprocess, 'run', side_effect=subprocess.TimeoutExpired('private argv', 5)):
            self.assertEqual(INSTALL.Installer.run(self.host, ['nvidia-smi'], user=True, check=False).returncode, 124)


class BoundaryTests(unittest.TestCase):
    def test_system_disk_is_refused(self):
        with self.assertRaisesRegex(ValueError, '系统盘'):
            INSTALL.data_path('/tmp/not-created-node-install', ['/'])

    def test_resource_floor_is_still_64_gib(self):
        with tempfile.TemporaryDirectory() as folder:
            original = Path.stat
            def stat_device(path, *args, **kwargs):
                info = list(original(path, *args, **kwargs))
                info[2] = 42 if str(path).startswith(folder) else 1
                return os.stat_result(info)
            mounts = f'42 1 0:42 / {folder} rw - ext4 fixture rw\n'
            with patch.object(Path, 'read_text', return_value=mounts), patch.object(Path, 'stat', stat_device), \
                    patch.object(INSTALL.shutil, 'disk_usage', return_value=SimpleNamespace(free=64*1024**3-1)):
                with self.assertRaisesRegex(ValueError, '64GiB'):
                    INSTALL.data_path(Path(folder)/'new', [folder])

    def test_gray_wires_the_same_installer_from_candidate_source(self):
        setup = (ROOT/'deploy/gray-local/node-setup.sh').read_text()
        self.assertIn('/opt/node-install.py /opt/gray-release --config', setup)
        self.assertNotIn('systemctl --user', setup)
        self.assertNotIn('cp /opt/gray-release/gpuq.pyz', setup)
        run = (ROOT/'scripts/gray-local/run.sh').read_text()
        self.assertIn('"$run/src/deploy/node/install.py"', run)
        self.assertIn('COPY node-install.py /opt/node-install.py', (ROOT/'deploy/gray-local/node.Dockerfile').read_text())


if __name__ == '__main__':
    unittest.main()
