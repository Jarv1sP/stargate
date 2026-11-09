"""Local node installation/rollback with real files and simulated host commands."""
import copy
import builtins
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import shlex
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
        self.libexec = base / 'usr/local/libexec/stargate'
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
        elif action in ('start', 'restart'):
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
                   datasetsRoot=str(data/'datasets'), personalOci=dict(baseImage='fixture'),
                   jobMemoryGiBPerCard=3, directUpload=dict(token='local-fixture'), futureNodeField=1)
        self.config = dict(account='nodeops', releaseRoot=str(data/'releases'), dataMountPoints=[str(data)],
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
        for name in ('core-entry.py', 'core-service.py', 'node-probe.py', 'runtime-profile.py', 'quota-sample.py', 'quota-ids.py', 'quota-limits.py'):
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

    def test_shared_pool_binding_and_live_refresh_are_installed_together(self):
        pool = dict(cgroup='/user.slice/gpuq-workloads.slice', maxBytes=90*1024**3)
        for cfg in self.config['profiles'].values():
            cfg['memoryPool'] = pool
        self.host.install(self.package)
        unit_dir = self.home/'.config/systemd/user'
        self.assertIn('MemoryMax='+str(pool['maxBytes']), (unit_dir/'gpuq-workloads.slice.d/60-stargate-resources.conf').read_text())
        self.assertNotIn('MemoryOOMGroup', (unit_dir/'gpuq-workloads.slice.d/60-stargate-resources.conf').read_text())
        self.assertIn('Slice=gpuq-workloads.slice', (unit_dir/'gpuq-.service.d/60-stargate-resources.conf').read_text())
        refresh = [argv for user, argv in self.host.calls if user is True and any(str(a).endswith('/refresh-resources.py') for a in argv)]
        self.assertEqual(len(refresh), 1)
        self.assertEqual(Path(refresh[0][-1]), self.selected()/'profiles/7IM/node-config.json')
        refresh_index = next(i for i, (_, argv) in enumerate(self.host.calls) if any(str(a).endswith('/refresh-resources.py') for a in argv))
        scheduler_start = self.host.calls.index(('user', ['start', 'gpuq.service']))
        self.assertLess(refresh_index, scheduler_start)

    def assert_running(self):
        for name in ('gpuq.service', 'node-http.service', 'storage-collect.timer', 'container-observer.timer'):
            self.assertTrue(self.host.states['user', name]['active'], name)
        self.assertTrue(self.host.states['system', 'node-peer.service']['active'])
        self.assertTrue(self.host.states['system', 'stargate-quota-sample.timer']['active'])

    def test_project_limits_are_off_by_default_and_only_admin_config_enables(self):
        self.host.install(self.package)
        service=(self.host.system_units/'stargate-quota-limits.service').read_text()
        self.assertNotIn('"--enabled"',service)
        self.assertIn('MemoryMax=512M',service)
        self.assertEqual((self.host.libexec/'quota-limits.py').read_bytes(),(ROOT/'node/quota-limits.py').read_bytes())
        self.host.config['quota']={'projectFilesEnabled':True,'projectFilesDefaultBytes':50_000_000_000}
        files,_=self.host.quota_limits();service=files[str(self.host.system_units/'stargate-quota-limits.service')][0].decode()
        self.assertIn('"--enabled"',service);self.assertIn('"50000000000"',service)

    def test_rollback_to_pre_limits_release_keeps_clear_but_restores_other_root_helpers(self):
        for name in ('quota-sample.py','quota-ids.py'):
            file=self.package/'node'/name;file.write_text('# old release\n'+file.read_text())
        sampler=self.package/'node/quota-sample.py'
        sampler.write_text(sampler.read_text().replace("def publish(root,value,owner,*,name='quota.json'):","def publish(root,value,owner):").replace("os.replace(tmp,name,","os.replace(tmp,'quota.json',"))
        bindings=self.host.bindings
        def before_limits(manifest,release=None):
            files,units=bindings(manifest,release)
            for path in (self.host.libexec/'quota-limits.py',self.host.system_units/'stargate-quota-limits.service',self.host.system_units/'stargate-quota-limits.timer'):files.pop(str(path),None)
            return files,[u for u in units if u['name']!='stargate-quota-limits.timer']
        with patch.object(self.host,'bindings',side_effect=before_limits):first=self.host.install(self.package)
        self.assertFalse((self.host.libexec/'quota-limits.py').exists())
        self.host.install(self.make_package('with-limits'));self.host.rollback()
        self.assertEqual(str(self.selected()),first['release'])
        self.assertEqual((self.host.libexec/'quota-limits.py').read_bytes(),(ROOT/'node/quota-limits.py').read_bytes())
        for name in ('quota-sample.py','quota-ids.py'):
            self.assertEqual((self.host.libexec/name).read_bytes(),(self.package/'node'/name).read_bytes())
        help=subprocess.run([sys.executable,'-I','-B',str(self.host.libexec/'quota-limits.py'),'--help'],capture_output=True,text=True,check=True)
        self.assertIn('--clear',help.stdout)
        self.assertFalse(self.host.states['system','stargate-quota-limits.timer']['active'])

    def test_rollback_restores_all_existing_root_programs_with_their_old_units(self):
        self.config['quota']={'projectFilesEnabled':True}
        for name in ('quota-sample.py','quota-ids.py','quota-limits.py'):
            file=self.package/'node'/name;source=file.read_text()
            file.write_text(source.replace('"""','"""fixture release A: ',1))
        first=self.host.install(self.package)
        names=('quota-sample.py','quota-ids.py','quota-limits.py')
        old={name:(self.host.libexec/name).read_bytes() for name in names}
        units={name:(self.host.system_units/name).read_bytes() for name in ('stargate-quota-sample.service','stargate-quota-limits.service')}
        for failed in (False,True):
            with self.subTest(failed_install=failed):
                package=self.make_package('bad' if failed else 'second')
                if failed:
                    self.host.fail_start='gpuq.service'
                    with self.assertRaises(subprocess.CalledProcessError):self.host.install(package)
                else:self.host.install(package);self.host.rollback()
                self.assertEqual(str(self.selected()),first['release'])
                for name in names:self.assertEqual((self.host.libexec/name).read_bytes(),old[name])
                for name,data in units.items():
                    self.assertEqual((self.host.system_units/name).read_bytes(),data)
                    command=shlex.split(next(line[10:] for line in data.decode().splitlines() if line.startswith('ExecStart=')))
                    help=subprocess.run([sys.executable,*command[1:],'--help'],capture_output=True,text=True,check=True)
                    self.assertIn('fixture release A',help.stdout)

    def test_shutdown_documentation_stops_timer_before_clear(self):
        guide=(ROOT/'docs/NODE_RELEASE_BUILD.md').read_text()
        shutdown=guide.split('关闭开关只停止后续修改',1)[1].split('64 GiB 资源底线',1)[0]
        self.assertLess(shutdown.index('sudo systemctl disable --now stargate-quota-limits.timer'),shutdown.index('quota-limits.py --clear'))
        self.assertLess(shutdown.index('sudo systemctl stop stargate-quota-limits.service'),shutdown.index('quota-limits.py --clear'))
        self.assertIn('projectFilesEnabled',shutdown)
        self.assertIn('回滚后仍可',shutdown)
        self.assertIn('若不为 0，再执行一次 --clear',shutdown)
        self.assertIn('旧版 root unit 只运行还原后的旧版代码',shutdown)

    def test_quota_sampler_is_a_root_owned_copy_on_a_minute_timer(self):
        self.host.install(self.package)
        service = (self.host.system_units/'stargate-quota-sample.service').read_text()
        timer = (self.host.system_units/'stargate-quota-sample.timer').read_text()
        sampler = self.host.libexec/'quota-sample.py'
        self.assertEqual(sampler.read_bytes(), (ROOT/'node/quota-sample.py').read_bytes())
        self.assertEqual((self.host.libexec/'quota-ids.py').read_bytes(), (ROOT/'node/quota-ids.py').read_bytes())
        self.assertIn('ExecStart="/usr/bin/python3" "-I" "-B" '+json.dumps(str(sampler)), service)
        self.assertNotIn(str(self.host.root), service.split('ExecStart=')[1].split('--account')[0])
        self.assertNotIn('User=', service)
        self.assertIn('"--account" "nodeops" "--root" '+json.dumps(self.config['profiles']['7IM']['root']), service)
        self.assertEqual(service.count('"--root"'), 1)
        self.assertTrue(service.rstrip().endswith(json.dumps(self.config['dataMountPoints'][0])))
        for line in ('Type=oneshot', 'Nice=19', 'IOSchedulingClass=idle'):
            self.assertIn(line, service)
        for line in ('OnBootSec=30', 'OnUnitActiveSec=60', 'Unit=stargate-quota-sample.service'):
            self.assertIn(line, timer)
        self.assertTrue(self.host.states['system', 'stargate-quota-sample.timer']['enabled'])

    def test_root_sampler_uses_bytes_captured_before_service_chown_and_replaces_links(self):
        original=INSTALL.os.chown;attacked=[]
        def handoff(path,*args,**kwargs):
            if Path(path).name.startswith('.stage-'):
                source=Path(path)/'node'/'quota-sample.py';source.write_bytes(b'print("service-controlled")')
                attacked.append(path)
            return original(path,*args,**kwargs)
        self.host.libexec.mkdir(parents=True);victim=self.base/'victim';victim.write_bytes(b'keep')
        (self.host.libexec/'quota-sample.py').symlink_to(victim)
        with patch.object(INSTALL.os,'chown',side_effect=handoff):self.host.install(self.package)
        self.assertTrue(attacked)
        self.assertEqual((self.host.libexec/'quota-sample.py').read_bytes(),(ROOT/'node/quota-sample.py').read_bytes())
        self.assertFalse((self.host.libexec/'quota-sample.py').is_symlink());self.assertEqual(victim.read_bytes(),b'keep')

    def test_root_programs_come_from_the_package_even_if_staging_is_swapped_during_unpack(self):
        original=INSTALL.atomic;swapped=[]
        def write(path,data,*args,**kwargs):
            original(path,data,*args,**kwargs)
            if Path(path).parent.name=='node' and Path(path).name in ('quota-sample.py','quota-ids.py'):
                Path(path).write_bytes(b'print("service-controlled")');swapped.append(Path(path).name)
        with patch.object(INSTALL,'atomic',side_effect=write):self.host.install(self.package)
        self.assertEqual(sorted(swapped),['quota-ids.py','quota-sample.py'])
        for name in ('quota-sample.py','quota-ids.py'):
            self.assertEqual((self.host.libexec/name).read_bytes(),(ROOT/'node'/name).read_bytes())

    def test_sampler_unit_resolves_a_symlinked_state_root(self):
        self.host.stage(self.package)
        real=Path(self.config['profiles']['7IM']['root']);alias=self.base/'state-alias';alias.symlink_to(real)
        for profile in self.config['profiles'].values():profile['root']=str(alias)
        files,_=self.host.quota_sampler(self.host.current)
        unit=files[str(self.host.system_units/'stargate-quota-sample.service')][0].decode()
        self.assertIn('"--root" '+json.dumps(str(real.resolve())),unit);self.assertNotIn(str(alias),unit)

    def test_rollback_to_a_release_without_the_sampler_removes_its_units(self):
        first = self.host.install(self.package)
        self.host.fail_start = 'stargate-quota-sample.timer'
        with self.assertRaises(Exception):
            self.host.install(self.make_package('second'))
        self.assertEqual(str(self.selected()), first['release'])
        self.assertTrue((self.host.system_units/'stargate-quota-sample.timer').exists())

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
            self.assertEqual(cfg['dataMountPoints'], self.config['dataMountPoints'])
            self.assertNotIn('jobMemoryGiBPerCard', cfg)
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

    def test_cli_install_uses_top_level_mounts_and_explicit_profile_without_7im(self):
        self.config['profiles'] = {'FGK': self.config['profiles']['FGK']}
        for key in self.config['authorizedKeys']:
            key['profile'] = 'FGK'
        self.config['services'] = [dict(name='node-http.service', profile='FGK')]
        private = self.base/'node-install.json'
        private.write_text(json.dumps(self.config))
        output = io.StringIO()
        mask = os.umask(0o077)
        try:
            with patch.object(sys, 'argv', ['install.py', str(self.package), '--config', str(private)]), \
                    patch.object(INSTALL, 'Installer', return_value=self.host), redirect_stdout(output):
                INSTALL.main()
        finally:
            os.umask(mask)
        self.assertEqual(json.loads(output.getvalue())['state'], 'INSTALLED')
        profile = json.loads((self.selected()/'profiles/FGK/node-config.json').read_text())
        self.assertEqual(profile['dataMountPoints'], self.config['dataMountPoints'])
        self.assertFalse((self.selected()/'profiles/7IM/node-config.json').exists())
        keys = (self.home/'.ssh/authorized_keys').read_text()
        self.assertIn('--profile FGK', keys)
        self.assertIn('STARGATE_CORE_PROFILE=FGK', keys)

    def test_installer_delegates_cpuset_only_to_its_account_without_restarting_user_manager(self):
        self.config['services'] = []
        self.host.install(self.package)
        delegation = self.host.system_units / f'user@{self.host.owner[0]}.service.d/50-stargate-cpuset.conf'
        self.assertEqual(delegation.read_text(), '[Service]\nDelegate=cpu cpuset io memory pids\n')
        self.assertEqual(stat.S_IMODE(delegation.stat().st_mode), 0o644)
        self.assertFalse((self.host.system_units / 'user@.service.d').exists())
        self.assertIn(('system', ['daemon-reload']), self.host.calls)
        manager = f'user@{self.host.owner[0]}.service'
        self.assertFalse(any(manager in args and any(action in args for action in ('stop', 'restart')) for _, args in self.host.calls))

    def test_install_failure_restores_previous_controller_delegation(self):
        delegation = self.host.system_units / f'user@{self.host.owner[0]}.service.d/50-stargate-cpuset.conf'
        delegation.parent.mkdir(parents=True)
        previous = '[Service]\nDelegate=cpu memory pids\n'
        delegation.write_text(previous)
        self.host.gpu_only_release = self.base / 'uninstalled'
        with self.assertRaises(RuntimeError):
            self.host.install(self.package)
        self.assertEqual(delegation.read_text(), previous)
        self.assertFalse(self.host.current.exists())

    def test_missing_key_profile_never_defaults_to_a_different_channel(self):
        self.host.install(self.package)
        first = self.selected()
        del self.config['authorizedKeys'][0]['profile']
        with self.assertRaises(KeyError):
            self.host.install(self.make_package('missing-profile'))
        self.assertEqual(self.selected(), first)
        self.assert_running()

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

    @unittest.skipUnless(shutil.which('systemd-analyze'), 'requires the systemd unit parser')
    def test_working_directory_accepts_spaces_and_percent_but_rejects_quoted_paths(self):
        root = self.base/'scheduler space %value'
        root.mkdir()
        self.config['gpuq']['root'] = str(root)
        _, manifest = self.host.stage(self.package)
        files, _ = self.host.bindings(manifest, self.package)
        body = files[str(self.home/'.config/systemd/user/gpuq.service')][0].decode()
        setting = next(line for line in body.splitlines() if line.startswith('WorkingDirectory='))
        unit = self.base/'working-directory.service'
        def verify(value):
            # Offline parser only: no daemon, service start or system changes.
            unit.write_text('[Unit]\nDefaultDependencies=no\n[Service]\nExecStart=/usr/bin/true\n'+value+'\n')
            return subprocess.run(['systemd-analyze', 'verify', '--man=no', '--generators=no', str(unit)],
                                  capture_output=True, text=True)
        quoted = verify('WorkingDirectory='+json.dumps(str(root)).replace('%', '%%'))
        self.assertNotEqual(quoted.returncode, 0)
        self.assertIn('WorkingDirectory=', quoted.stderr)
        accepted = verify(setting)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(setting, 'WorkingDirectory='+str(root).replace('%', '%%'))

    def test_restore_repairs_old_files_and_pointer_even_when_stopping_broken_units_fails(self):
        self.host.install(self.package)
        first = self.selected()
        unit = self.home/'.config/systemd/user/gpuq.service'
        original = unit.read_bytes()
        systemctl = self.host.systemctl
        for state in ('not-found', 'bad-setting', 'error', 'loaded', 'exception'):
            with self.subTest(load_state=state):
                self.host.install(self.make_package('broken-'+state))
                unit.write_text('[Service]\nWorkingDirectory="/invalid"\n')
                restarted = []
                def broken(scope, *args, check=True):
                    if args[-1] == 'gpuq.service':
                        if args[0] == 'stop':
                            if state == 'exception':
                                raise OSError('fixture stop unavailable')
                            return subprocess.CompletedProcess(args, 1, '', 'fixture broken unit')
                        if args[0] == 'show':
                            return subprocess.CompletedProcess(args, 0, state+'\n', '')
                        if args[0] == 'restart':
                            self.assertEqual(self.selected(), first)
                            self.assertEqual(unit.read_bytes(), original)
                            restarted.append(self.selected())
                    return systemctl(scope, *args, check=check)
                with patch.object(self.host, 'systemctl', side_effect=broken):
                    units = [dict(scope='user', name='gpuq.service')]
                    if state in ('not-found', 'bad-setting', 'error'):
                        self.host.stop(units)
                    else:
                        with self.assertRaises((RuntimeError, OSError)):
                            self.host.stop(units)
                    self.assertEqual(self.host.rollback()['state'], 'ROLLED_BACK')
                self.assertEqual(restarted, [first])
                self.assertEqual(self.selected(), first)
                self.assertEqual(unit.read_bytes(), original)
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

    def test_gray_cdi_is_readable_while_installer_config_stays_private(self):
        setup = (ROOT/'deploy/gray-local/node-setup.sh').read_text()
        program = next(part.split('\nPY', 1)[0] for part in setup.split("python3 - <<'PY'\n")[1:]
                       if 'node-install.json' in part.split('\nPY', 1)[0])
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            for name in ('etc/gray-sim', 'etc/gpuq-console/cdi', 'keys'):
                (base/name).mkdir(parents=True, exist_ok=True)
            (base/'etc/gray-sim/gpus.json').write_text(json.dumps([dict(uuid='GPU-fixture', minor=0)]))
            for role in ('executor', 'collector'):
                (base/'keys'/f'{role}.pub').write_text('ssh-ed25519 AAAAFIXTURE')
            def imports(name, *args, **kwargs):
                if name == 'pathlib':
                    return SimpleNamespace(Path=lambda *parts: base/str(Path(*parts)).lstrip('/'))
                if name == 'pwd':
                    return SimpleNamespace(getpwnam=lambda _: SimpleNamespace(pw_uid=os.getuid()))
                return builtins.__import__(name, *args, **kwargs)
            mask = os.umask(0o022)
            try:
                exec(program, {'__builtins__': {**vars(builtins), '__import__': imports}})
            finally:
                os.umask(mask)
            self.assertEqual(stat.S_IMODE((base/'etc/gpuq-console/node-install.json').stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((base/'etc/gpuq-console/cdi/gpuq-nvidia.json').stat().st_mode), 0o644)


if __name__ == '__main__':
    unittest.main()
