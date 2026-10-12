import copy
import contextlib
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import tomllib
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

HERE = Path(__file__).resolve().parents[1]/'deploy'
spec = importlib.util.spec_from_file_location('oci_test', HERE/'personal-oci.py')
o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
USER = 'demo-user-3'
SHA = 'a'*64
GPU = 'GPU-12345678-1111-2222-3333-123456789012'


def config():
    return {'root': '/srv/gpuq', 'storageQuota': {'enabled': True}, 'personalOci': {
        'enabled': True, 'baseImage': 'docker.io/library/ubuntu@sha256:'+SHA,
        'podmanSHA256': SHA, 'runtimeSHA256': SHA, 'cdiSHA256': SHA}}


class OCITests(unittest.TestCase):
    def manager(self):
        manager = o.PersonalOCI.__new__(o.PersonalOCI)
        manager.config, manager.user, manager.policy = config(), USER, config()['personalOci']
        manager.owner = hashlib.sha256(USER.encode()).hexdigest()
        manager.folder = Path('/srv/gpuq/oci')/manager.owner
        manager.env = {'PATH': '/usr/bin:/bin', 'HOME': str(manager.folder/'home')}
        manager.s = o.module('project-store')
        return manager

    def test_default_disabled_and_no_silent_shared_fallback(self):
        with self.assertRaisesRegex(ValueError, 'not enabled'): o.policy({})

    def test_requires_kernel_quota(self):
        c = config(); c['storageQuota']['enabled'] = False
        with self.assertRaisesRegex(ValueError, 'hard quotas'): o.policy(c)

    def test_oci_cohort_requires_authenticated_included_owner(self):
        c = config(); c['storageQuota']['owners'] = [USER]
        self.assertEqual(o.policy(c, USER), c['personalOci'])
        with self.assertRaisesRegex(ValueError, 'Authenticated'): o.policy(c)
        with self.assertRaisesRegex(ValueError, 'hard quotas'): o.policy(c, 'demo-user-4')

    def test_excluded_oci_owner_is_rejected_before_any_workspace_write(self):
        c = config(); c['storageQuota']['owners'] = ['demo-user-4']
        with patch.object(o, 'protected_file', side_effect=AssertionError), \
             patch.object(o.os, 'open', side_effect=AssertionError), \
             patch.object(o.Path, 'mkdir', side_effect=AssertionError):
            with self.assertRaisesRegex(ValueError, 'hard quotas'):
                o.PersonalOCI(c, USER)

    def test_explicit_oci_cohort_is_independent_of_disabled_disk_quota(self):
        c = config(); c['storageQuota'] = {'enabled': False}; c['personalOci']['owners'] = [USER]
        self.assertEqual(o.policy(c, USER), c['personalOci'])
        self.assertFalse(o.module('storage-quota').ensure(c, USER, Path('/not-created'))['enabled'])
        for user in (None, 'demo-user-4', '*', 'all', 'demo-user-3\n'):
            with self.subTest(user=user), self.assertRaisesRegex(ValueError, 'Authenticated owner'):
                o.policy(c, user)

    def test_explicit_oci_cohort_rejects_invalid_keys_and_owner_lists(self):
        for owners in ([], '*', ['all'], ['*'], [USER, USER], [123], ['builtin-admin-extra']):
            c = config(); c['personalOci']['owners'] = owners
            with self.subTest(owners=owners), self.assertRaisesRegex(ValueError, 'owner cohort'):
                o.policy(c, USER)
        c = config(); c['personalOci'].update(owners=[USER], socket='/var/run/docker.sock')
        with self.assertRaisesRegex(ValueError, 'capability policy'): o.policy(c, USER)

    def test_foreign_explicit_oci_owner_is_rejected_before_any_write(self):
        c = config(); c['storageQuota'] = {'enabled': False}; c['personalOci']['owners'] = [USER]
        with patch.object(o.os, 'open', side_effect=AssertionError), \
             patch.object(o.Path, 'mkdir', side_effect=AssertionError):
            with self.assertRaisesRegex(ValueError, 'Authenticated owner'):
                o.PersonalOCI(c, 'demo-user-4')

    def test_config_rejects_rootful_socket_paths_tags_and_unknown_flags(self):
        for replacement in ('ubuntu:latest', '/tmp/image', 'docker.io/lib/foo@sha256:bad', '--privileged'):
            c = config(); c['personalOci']['baseImage'] = replacement
            with self.subTest(replacement=replacement), self.assertRaises(ValueError): o.policy(c)
        c = config(); c['personalOci']['socket'] = '/var/run/docker.sock'
        with self.assertRaises(ValueError): o.policy(c)

    def test_owned_graphroot_and_no_remote_socket(self):
        command = self.manager().command('version')
        self.assertEqual(command[0], '/usr/bin/podman')
        self.assertIn('--cgroup-manager=cgroupfs', command)
        self.assertTrue(command[command.index('--root')+1].endswith(self.manager().owner+'/graph'))
        self.assertFalse(any('socket' in v or '--remote' in v for v in command))

    def test_fixed_cdi_override_cannot_load_host_or_user_spec_directories(self):
        expected = '/etc/gpuq-console/cdi'
        self.assertEqual(str(o.CDI), expected+'/gpuq-nvidia.json')
        self.assertEqual(tomllib.loads(o.ENGINE_RAW.decode())['engine']['cdi_spec_dirs'], [expected])
        for operation in ('version', 'info', 'create', 'run', 'start'):
            command = self.manager().command(operation)
            self.assertEqual([arg for arg in command if arg.startswith('--cdi-spec-dir=')],
                             ['--cdi-spec-dir='+expected])
            self.assertNotIn('/etc/cdi', command); self.assertNotIn('/run/cdi', command)
        c = config(); c['personalOci']['cdiSpecDir'] = '/run/cdi'
        with self.assertRaisesRegex(ValueError, 'capability policy'): o.policy(c, USER)

    def anonymous_manager(self, root):
        manager = self.manager()
        manager.folder = Path(root).resolve()/'private-oci'
        manager.folder.mkdir(mode=0o700)
        for name in ('tmp', 'home', 'home/.config', 'home/.config/containers', 'home/.config/containers/registries.conf.d', 'home/containers'):
            (manager.folder/name).mkdir(mode=0o700)
        manager.env = {'PATH': '/usr/bin:/bin', 'HOME': str(manager.folder/'home'),
                       'REGISTRY_AUTH_FILE': str(manager.folder/'anonymous-registry-auth.json'),
                       'CONTAINERS_REGISTRIES_CONF': str(manager.folder/'anonymous-registries.conf')}
        # Preserve real private-HOME checks; do not depend on the test host's
        # administrator /etc ownership or its legitimate registry drop-ins.
        original = manager.registry_dropin_state
        manager.registry_dropin_state = lambda path, uid: ('safe-system',) if path == o.REGISTRY_DROPINS else original(path, uid)
        return manager

    def test_anonymous_registry_auth_is_valid_private_json_and_named_identity_bound(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            with manager.registry_auth() as (env, fd):
                self.assertEqual(env['REGISTRY_AUTH_FILE'], str(manager.folder/'anonymous-registry-auth.json'))
                self.assertEqual(json.loads(os.pread(fd, 1024, 0)), {'auths': {}})
                self.assertEqual(env['CONTAINERS_REGISTRIES_CONF'], str(manager.folder/'anonymous-registries.conf'))
                policy = tomllib.loads(Path(env['CONTAINERS_REGISTRIES_CONF']).read_text())
                self.assertEqual(policy['credential-helpers'], ['containers-auth.json'])
                self.assertEqual(policy['unqualified-search-registries'], [])
                self.assertEqual(os.fstat(fd).st_mode & 0o777, 0o600)
            with self.assertRaises(OSError): os.fstat(fd)
            with manager.registry_auth() as (_, fd):
                self.assertEqual(os.pread(fd, 1024, 0), o.ANONYMOUS_AUTH_RAW)

    def test_anonymous_registry_auth_rejects_links_and_untrusted_content(self):
        for kind in ('symlink', 'hardlink', 'empty', 'credentials', 'helpers', 'mode'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                manager = self.anonymous_manager(root); path = Path(manager.env['REGISTRY_AUTH_FILE'])
                other = Path(root)/'other'; other.write_bytes(o.ANONYMOUS_AUTH_RAW); other.chmod(0o600)
                if kind == 'symlink': path.symlink_to(other)
                elif kind == 'hardlink': os.link(other, path)
                else:
                    path.write_bytes(b'' if kind == 'empty' else b'{"auths":{"private":{}}}' if kind == 'credentials'
                                     else b'{"auths":{},"credHelpers":{}}' if kind == 'helpers' else o.ANONYMOUS_AUTH_RAW)
                    path.chmod(0o644 if kind == 'mode' else 0o600)
                with self.assertRaises((ValueError, OSError)):
                    with manager.registry_auth(): self.fail('Unsafe anonymous auth accepted')

    def test_anonymous_registry_auth_rejects_replacement_and_disappearance(self):
        for kind in ('replace', 'delete', 'content'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                manager = self.anonymous_manager(root)
                with manager.registry_auth(): pass
                path = Path(manager.env['REGISTRY_AUTH_FILE'])
                if kind == 'replace':
                    replacement = manager.folder/'replacement'; replacement.write_bytes(o.ANONYMOUS_AUTH_RAW)
                    replacement.chmod(0o600); os.replace(replacement, path)
                elif kind == 'delete': path.unlink()
                else: path.write_bytes(b'{"auths":{}} ')
                with self.assertRaises((ValueError, OSError)):
                    with manager.registry_auth(): self.fail('Changed anonymous auth accepted')

    def test_anonymous_registry_auth_detects_replace_during_operation(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            with self.assertRaisesRegex(ValueError, 'during operation'):
                with manager.registry_auth():
                    path = Path(manager.env['REGISTRY_AUTH_FILE']); replacement = manager.folder/'replacement'
                    replacement.write_bytes(o.ANONYMOUS_AUTH_RAW); replacement.chmod(0o600); os.replace(replacement, path)

    def test_managed_command_inherits_only_private_paths_and_no_host_credentials(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            def fake(*args, **kwargs):
                path = Path(kwargs['env']['REGISTRY_AUTH_FILE'])
                self.assertEqual(path, manager.folder/'anonymous-registry-auth.json')
                self.assertNotIn('pass_fds', kwargs)
                self.assertEqual(json.loads(path.read_bytes()), {'auths': {}})
                self.assertNotIn('HTTP_PROXY', kwargs['env'])
                self.assertNotIn('DOCKER_CONFIG', kwargs['env'])
                return SimpleNamespace(returncode=0, stdout='5.8.8\n', stderr='')
            with patch.dict(os.environ, {'HTTP_PROXY': 'http://secret.invalid', 'DOCKER_CONFIG': '/private/host'}), \
                 patch.object(o.subprocess, 'run', side_effect=fake):
                self.assertEqual(manager.run('version'), '5.8.8')

    def test_image_layer_temporary_bytes_use_private_disk_not_runtime_tmpfs(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            runtime = Path(root)/'short-runtime'; runtime.mkdir(mode=0o700)
            manager.runtime_tmp = runtime
            manager.runtime_temporary = Mock(return_value=runtime)
            manager.env['TMPDIR'] = str(runtime)
            def engine(*args, **kwargs):
                temporary = Path(kwargs['env']['TMPDIR'])
                self.assertEqual(temporary, manager.folder/'tmp')
                self.assertEqual(temporary.stat().st_mode & 0o777, 0o700)
                self.assertNotEqual(temporary, runtime)
                (temporary/'synthetic-layer').write_bytes(b'x' * 1024)
                self.assertEqual(manager.env['TMPDIR'], str(runtime))
                return SimpleNamespace(returncode=0, stdout='sha256:'+SHA, stderr='')
            with patch.object(o.subprocess, 'run', side_effect=engine) as call:
                manager.run('commit', '--pause=false', 'owned-container')
            call.assert_called_once()
            self.assertFalse((runtime/'synthetic-layer').exists())
            self.assertEqual((manager.folder/'tmp/synthetic-layer').stat().st_size, 1024)

    def test_image_temporary_directory_rejects_link_unsafe_mode_and_missing_directory(self):
        for kind in ('symlink', 'unsafe-mode', 'missing'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                manager = self.anonymous_manager(root)
                path = manager.folder/'tmp'
                path.rmdir()
                if kind == 'symlink': path.symlink_to(Path(root))
                elif kind == 'unsafe-mode': path.mkdir(mode=0o755);path.chmod(0o755)
                with patch.object(o.subprocess,'run') as engine, self.assertRaises((ValueError,OSError)):
                    manager.run('commit', '--pause=false', 'owned-container')
                engine.assert_not_called()

    def test_image_temporary_override_does_not_mutate_runtime_registry_environment(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            manager.env['TMPDIR'] = '/fixture-short-runtime'
            with patch.object(o.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout='',stderr='private failure')), self.assertRaisesRegex(ValueError,'Managed OCI operation failed'):
                manager.run('image','inspect','sha256:'+SHA)
            self.assertEqual(manager.env['TMPDIR'], '/fixture-short-runtime')
            with manager.registry_auth() as (runtime_env, _):
                self.assertEqual(runtime_env['TMPDIR'], '/fixture-short-runtime')

    def test_private_registry_paths_cannot_be_redirected(self):
        for key, value in (('REGISTRY_AUTH_FILE', '/dev/null'), ('REGISTRY_AUTH_FILE', '/private/host/auth.json'),
                           ('CONTAINERS_REGISTRIES_CONF', '/etc/containers/registries.conf')):
            with self.subTest(key=key, value=value), tempfile.TemporaryDirectory() as root:
                manager = self.anonymous_manager(root); manager.env[key] = value
                with patch.object(o.subprocess, 'run') as engine, self.assertRaisesRegex(ValueError, 'path changed'):
                    manager.run('info')
                engine.assert_not_called()

    def test_anonymous_registry_create_race_fails_closed_without_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); path = Path(manager.env['REGISTRY_AUTH_FILE'])
            real_open = os.open
            def race(name, flags, *args, **kwargs):
                if name == path.name:
                    if flags & os.O_CREAT: raise FileExistsError('another initializer won')
                    raise FileNotFoundError('not present at first open')
                return real_open(name, flags, *args, **kwargs)
            with patch.object(o.os, 'open', side_effect=race), self.assertRaises(FileExistsError):
                with manager.registry_auth(): self.fail('Race accepted')
            self.assertFalse(path.exists())

    def test_anonymous_registry_short_write_is_retained_and_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); path = Path(manager.env['REGISTRY_AUTH_FILE'])
            real_write = os.write
            with patch.object(o.os, 'write', side_effect=lambda fd, raw: real_write(fd, raw[:3])):
                with self.assertRaisesRegex(ValueError, 'incomplete'):
                    with manager.registry_auth(): self.fail('Short write accepted')
            self.assertEqual(path.read_bytes(), o.ANONYMOUS_AUTH_RAW[:3])
            with self.assertRaisesRegex(ValueError, 'unsafe'):
                with manager.registry_auth(): self.fail('Partial JSON silently repaired')

    def test_anonymous_registry_policy_rejects_external_credential_helper(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            path = Path(manager.env['CONTAINERS_REGISTRIES_CONF'])
            path.write_bytes(b'credential-helpers = ["private-helper"]\n'); path.chmod(0o600)
            with self.assertRaises(ValueError):
                with manager.registry_auth(): self.fail('External credential helper accepted')

    def test_registry_dropins_reject_nonempty_links_modes_and_foreign_owner(self):
        for kind in ('nonempty', 'symlink', 'mode', 'foreign-owner'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                manager = self.manager(); base = Path(root).resolve()/'private'; base.mkdir(mode=0o700)
                path = base/'registries.conf.d'
                if kind == 'symlink': path.symlink_to(base, target_is_directory=True)
                else:
                    path.mkdir(mode=0o700)
                    if kind == 'nonempty': (path/'override.conf').write_text('credential-helpers=["private-helper"]')
                    if kind == 'mode': path.chmod(0o777)
                uid = os.geteuid()+1 if kind == 'foreign-owner' else os.geteuid()
                with self.assertRaises((ValueError, OSError)):
                    manager.registry_dropin_state(path, uid)

    def test_registry_dropins_safe_absence_empty_and_created_path_are_distinct(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.manager(); base = Path(root).resolve()/'private'; base.mkdir(mode=0o700)
            path = base/'containers/registries.conf.d'
            absent = manager.registry_dropin_state(path, os.geteuid())
            self.assertEqual(absent[0], 'absent')
            (base/'containers').mkdir(mode=0o700); path.mkdir(mode=0o700)
            present = manager.registry_dropin_state(path, os.geteuid())
            self.assertEqual(present[0], 'empty'); self.assertNotEqual(absent, present)

    def test_absent_dropin_ignores_unrelated_ancestor_entries_and_timestamps(self):
        for relative in ('registries.conf.d', 'containers/registries.conf.d',
                         'config/containers/registries.conf.d'):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as root:
                manager = self.manager(); base = Path(root).resolve()
                path = base/relative
                before = manager.registry_dropin_state(path, os.geteuid())
                original = base.stat()
                sibling = base/'unrelated-cache'; sibling.mkdir(mode=0o700)
                (base/'unrelated.conf').write_text('not a registry configuration')
                advanced = original.st_mtime_ns + 1_000_000_000
                os.utime(base, ns=(advanced, advanced))
                self.assertFalse(path.exists())
                self.assertEqual(manager.registry_dropin_state(path, os.geteuid()), before)
                sibling.rmdir(); (base/'unrelated.conf').unlink()
                self.assertEqual(manager.registry_dropin_state(path, os.geteuid()), before)

    def test_absent_dropin_detects_lookup_anchor_replacement_or_permission_change(self):
        for change in ('replacement', 'permissions', 'unsafe-permissions'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as root:
                manager = self.manager(); base = Path(root).resolve()/'anchor'
                base.mkdir(mode=0o700); path = base/'containers/registries.conf.d'
                before = manager.registry_dropin_state(path, os.geteuid())
                if change == 'replacement':
                    base.rename(base.with_name('original-anchor')); base.mkdir(mode=0o700)
                else:
                    base.chmod(0o750 if change == 'permissions' else 0o777)
                if change == 'unsafe-permissions':
                    with self.assertRaisesRegex(ValueError, 'unsafe'):
                        manager.registry_dropin_state(path, os.geteuid())
                else:
                    self.assertNotEqual(manager.registry_dropin_state(path, os.geteuid()), before)

    def test_absent_dropin_detects_new_components_and_rejects_files_or_links(self):
        for change in ('ancestor', 'empty', 'nonempty', 'file', 'symlink'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as root:
                manager = self.manager(); base = Path(root).resolve()
                parent = base/'containers'; path = parent/'registries.conf.d'
                before = manager.registry_dropin_state(path, os.geteuid())
                if change == 'file': parent.write_text('not a directory')
                elif change == 'symlink': parent.symlink_to(base, target_is_directory=True)
                else:
                    parent.mkdir(mode=0o700)
                    if change != 'ancestor': path.mkdir(mode=0o700)
                    if change == 'nonempty': (path/'override.conf').write_text('configuration')
                if change in ('file', 'symlink', 'nonempty'):
                    with self.assertRaises((ValueError, OSError)):
                        manager.registry_dropin_state(path, os.geteuid())
                else:
                    self.assertNotEqual(manager.registry_dropin_state(path, os.geteuid()), before)

    def test_registry_auth_keeps_engine_result_after_unrelated_system_ancestor_write(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            base = Path(root).resolve()/'operator-config'; base.mkdir(mode=0o700)
            dropin = base/'containers/registries.conf.d'
            # Only represent the temporary operator directory's root ownership;
            # exercise the real before/after checks, not a constant safe result.
            manager.registry_dropin_state = lambda path, uid: o.PersonalOCI.registry_dropin_state(
                manager, path, os.geteuid() if path == dropin else uid)
            def engine(*args, **kwargs):
                (base/'unrelated-host-config').mkdir(mode=0o700)
                original = base.stat().st_mtime_ns
                os.utime(base, ns=(original + 1_000_000_000, original + 1_000_000_000))
                return SimpleNamespace(returncode=0, stdout='verified engine result', stderr='')
            with patch.object(o, 'REGISTRY_DROPINS', dropin), \
                 patch.object(o.subprocess, 'run', side_effect=engine) as invoked:
                self.assertEqual(manager.run('image', 'inspect'), 'verified engine result')
                invoked.assert_called_once()
            self.assertFalse(dropin.exists())

    def test_existing_empty_dropin_ignores_sibling_changes_but_not_added_then_removed_override(self):
        with tempfile.TemporaryDirectory() as root:
            manager=self.manager();base=Path(root).resolve();path=base/'registries.conf.d';path.mkdir(mode=0o700)
            before=manager.registry_dropin_state(path,os.geteuid())
            (base/'unrelated').mkdir()
            self.assertEqual(manager.registry_dropin_state(path,os.geteuid()),before)
            override=path/'override.conf';override.write_text('configuration')
            with self.assertRaisesRegex(ValueError,'administrator review'):manager.registry_dropin_state(path,os.geteuid())
            override.unlink()
            # Some filesystems coalesce rapid changes into the same timestamp.
            # Exercise an observable directory change without a flaky sleep.
            advanced=before[1][-2]+1_000_000_000;os.utime(path,ns=(advanced,advanced))
            self.assertNotEqual(path.stat().st_mtime_ns,before[1][-2])
            self.assertNotEqual(manager.registry_dropin_state(path,os.geteuid()),before)

    def test_prepare_stderr_survives_post_execution_integrity_error_and_timeout(self):
        manager=self.manager();captured=[];manager.stderr_sink=lambda raw,**kw:captured.append((raw,kw))
        @contextlib.contextmanager
        def registry():
            yield {},1
            raise ValueError('OCI registry drop-in directories changed during operation')
        manager.registry_auth=registry
        manager.s.private_dir=lambda path:path
        with patch.object(o.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='ok',stderr='engine evidence')), \
             self.assertRaisesRegex(ValueError,'changed during operation'):manager.run('image','inspect')
        self.assertEqual(captured[-1][0],b'engine evidence')
        error=subprocess.TimeoutExpired(['private-command'],1,stderr=b'evidence')
        with patch.object(o.subprocess,'run',side_effect=error),self.assertRaises(subprocess.TimeoutExpired) as caught:manager.run('version')
        self.assertIs(caught.exception,error);self.assertEqual(captured[-1][0],b'evidence')

    def test_streaming_stderr_is_bounded_and_does_not_change_exit_or_main_log(self):
        manager=self.manager();captured=[];manager.stderr_sink=lambda raw,**kw:captured.append((raw,kw))
        command=[sys.executable,'-c','import os,sys;os.write(2,b"x"*200000+b"END");sys.exit(42)']
        forwarded=[]
        with patch.object(o.os,'write',side_effect=lambda fd,raw:(forwarded.append((fd,raw)),len(raw))[1]):
            code=manager.call(command,env={'PATH':'/usr/bin:/bin'},pass_fds=())
        self.assertEqual(code,42);self.assertEqual(sum(len(raw) for _,raw in forwarded),200003)
        self.assertTrue(all(fd==2 for fd,_ in forwarded));self.assertEqual(len(captured[-1][0]),o.STDERR_LIMIT)
        self.assertTrue(captured[-1][0].endswith(b'END'));self.assertTrue(captured[-1][1]['truncated'])
        manager.stderr_sink=lambda *a,**kw:(_ for _ in ()).throw(OSError('capture unavailable'))
        with patch.object(o.os,'write',side_effect=lambda fd,raw:len(raw)):
            self.assertEqual(manager.call([sys.executable,'-c','import os,sys;os.write(2,b"stderr");sys.exit(125)'],env={},pass_fds=()),125)

    def test_streaming_exception_keeps_original_exact_engine_child_cleanup(self):
        manager=self.manager();manager.stderr_sink=Mock()
        for error in (OSError('pipe read unavailable'),KeyboardInterrupt()):
            process=SimpleNamespace(stderr=Mock(),poll=Mock(return_value=None),kill=Mock(),wait=Mock(return_value=-9))
            with self.subTest(error=type(error).__name__),patch.object(o.subprocess,'Popen',return_value=process), \
                 patch.object(o.select,'select',side_effect=error),self.assertRaises(type(error)) as caught:
                manager.call(['fixed-engine'],env={},pass_fds=())
            self.assertIs(caught.exception,error);process.kill.assert_called_once_with();process.wait.assert_called_once_with()
            process.stderr.close.assert_called_once_with()

    def test_external_system_dropin_is_checked_before_engine_invocation(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); manager.registry_dropin_state = Mock(side_effect=ValueError('administrator review'))
            with patch.object(o.subprocess, 'run') as engine, self.assertRaisesRegex(ValueError, 'administrator review'):
                manager.run('version')
            engine.assert_not_called()
            self.assertEqual(manager.registry_dropin_state.call_args.args, (o.REGISTRY_DROPINS, 0))

    def test_commit_default_policy_is_private_exact_scope_and_checked_each_command(self):
        with tempfile.TemporaryDirectory() as root:
            manager=self.anonymous_manager(root)
            with manager.registry_auth():pass
            path=manager.folder/'home/containers/policy.json'
            self.assertEqual(path.read_bytes(),o.signature_policy_raw(manager.policy['baseImage']))
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            policy=json.loads(path.read_bytes());self.assertEqual(policy['default'],[{'type':'reject'}])
            self.assertEqual(set(policy['transports']['docker']),{manager.policy['baseImage']})
            path.write_bytes(b'{"default":[{"type":"insecureAcceptAnything"}]}')
            with patch.object(o.subprocess,'run') as engine,self.assertRaises(ValueError):manager.run('commit','own-container')
            engine.assert_not_called()

    def test_commit_private_policy_rejects_link_mode_and_replacement(self):
        for kind in ('symlink','hardlink','mode','replace'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as root:
                manager=self.anonymous_manager(root)
                with manager.registry_auth():pass
                path=manager.folder/'home/containers/policy.json';old=path.parent/'saved';path.rename(old)
                if kind=='symlink':path.symlink_to(old)
                elif kind=='hardlink':os.link(old,path)
                else:path.write_bytes(old.read_bytes());path.chmod(0o644 if kind=='mode' else 0o600)
                with patch.object(o.subprocess,'run') as engine,self.assertRaises((ValueError,OSError)):manager.run('commit','own-container')
                engine.assert_not_called()

    def test_save_home_policy_matches_xdg_policy_without_host_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            manager=self.anonymous_manager(root)
            with manager.registry_auth():pass
            xdg=manager.folder/'home/containers/policy.json'
            home=manager.folder/'home/.config/containers/policy.json'
            self.assertEqual(home.read_bytes(),xdg.read_bytes())
            self.assertEqual(home.stat().st_mode&0o777,0o600)
            value=json.loads(home.read_bytes())
            self.assertEqual(value['default'],[{'type':'reject'}])
            self.assertEqual(set(value['transports']['docker']),{manager.policy['baseImage']})
            with patch.object(o.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='')) as engine:
                manager.run('save','--format=oci-archive','sha256:'+SHA)
            self.assertEqual(engine.call_args.kwargs['env']['HOME'],str(manager.folder/'home'))

    def test_save_home_policy_rejects_tamper_and_mid_call_replacement(self):
        with tempfile.TemporaryDirectory() as root:
            manager=self.anonymous_manager(root)
            with manager.registry_auth():pass
            path=manager.folder/'home/.config/containers/policy.json'
            original=path.read_bytes();path.write_bytes(b'{"default":[{"type":"insecureAcceptAnything"}]}')
            with patch.object(o.subprocess,'run') as engine,self.assertRaises(ValueError):manager.run('save','pinned-image')
            engine.assert_not_called();path.write_bytes(original)
            with self.assertRaises(ValueError):
                with manager.registry_auth():
                    replacement=path.with_name('replacement');replacement.write_bytes(original);replacement.chmod(0o600);os.replace(replacement,path)

    def test_private_home_dropin_and_mid_operation_changes_are_refused(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            path = manager.folder/'home/.config/containers/registries.conf.d'
            (path/'override.conf').write_text('credential-helpers=["private-helper"]')
            with self.assertRaisesRegex(ValueError, 'administrator review'):
                with manager.registry_auth(): self.fail('Private helper override accepted')
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            with self.assertRaisesRegex(ValueError, 'changed during operation'):
                with manager.registry_auth():
                    path = manager.folder/'home/.config/containers/registries.conf.d'
                    path.rmdir(); path.mkdir(mode=0o700)

    def test_anonymous_registry_home_cannot_be_redirected(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); manager.env['HOME'] = '/private/host'
            with self.assertRaisesRegex(ValueError, 'path changed'):
                with manager.registry_auth(): self.fail('Foreign registry HOME accepted')

    def test_base_pull_is_one_attempt_with_verified_tls(self):
        manager = self.manager()
        manager.load = Mock(return_value={'schema': 1, 'owner': manager.owner, 'project': 'vision',
                                         'image': manager.policy['baseImage'], 'container': None})
        manager.run = Mock(side_effect=['', 'sha256:'+SHA])
        with patch.object(manager.s, 'atomic_json'):
            result = manager.checkpoint('vision')
        self.assertEqual(result['image'], 'sha256:'+SHA)
        self.assertEqual(manager.run.call_args_list[0].args,
                         ('pull', '--signature-policy', str(o.SIGNATURE_POLICY), '--quiet', '--policy=missing',
                          '--retry=0', '--tls-verify=true', manager.policy['baseImage']))
        self.assertEqual(manager.run.call_args_list[1].args,
                         ('image', 'inspect', '--format={{.Id}}', manager.policy['baseImage']))

    @contextlib.contextmanager
    def offline_fixture(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); manager = self.anonymous_manager(root)
            seeds = root/'seeds'; seeds.mkdir(mode=0o755)
            digest = manager.policy['baseImage'].split('@sha256:')[1]
            document, archive = seeds/(digest+'.json'), seeds/(digest+'.oci.tar')
            raw = b'deterministic public offline image fixture'
            archive.write_bytes(raw); archive.chmod(0o444)
            value = {'schema':1, 'baseImage':manager.policy['baseImage'], 'archiveBytes':len(raw),
                     'archiveSHA256':hashlib.sha256(raw).hexdigest(), 'imageId':'sha256:'+SHA,
                     'diffIds':['sha256:'+'b'*64]}
            document.write_text(json.dumps(value)); document.chmod(0o444)
            image = {'Id':SHA, 'RepoDigests':[value['baseImage']], 'Digest':'sha256:'+digest,
                     'RootFS':{'Layers':value['diffIds']}}
            # The Mac test account cannot chown fixtures to host root. Model
            # only administrator-owned seed assets/ancestors, not private HOME.
            real_fstat, real_stat = os.fstat, os.stat
            identities = {(p.stat().st_dev,p.stat().st_ino) for p in (seeds,*seeds.parents,document,archive)}
            def root_info(info):
                if (info.st_dev,info.st_ino) not in identities:return info
                fields = {key:getattr(info,key) for key in ('st_dev','st_ino','st_mode','st_uid','st_gid',
                          'st_nlink','st_size','st_mtime_ns','st_ctime_ns')}
                fields['st_uid']=0
                if __import__('stat').S_ISDIR(info.st_mode):fields['st_mode'] &= ~0o022
                return SimpleNamespace(**fields)
            with patch.object(o,'BASE_SEEDS',seeds), \
                 patch.object(o.os,'fstat',side_effect=lambda fd:root_info(real_fstat(fd))), \
                 patch.object(o.os,'stat',side_effect=lambda *a,**k:root_info(real_stat(*a,**k))):
                yield manager, document, archive, value, image

    def test_offline_base_cold_loads_only_fixed_archive_into_private_graph(self):
        with self.offline_fixture() as (manager,document,archive,value,image):
            manager.run=Mock(side_effect=['',json.dumps([image])])
            with patch.object(o.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout=b'',stderr=b'')) as exists:
                self.assertEqual(manager.offline_base(),value['imageId'])
            self.assertEqual(exists.call_args.args[0][-3:],['image','exists',value['baseImage']])
            self.assertIn(str(manager.folder/'graph'),exists.call_args.args[0])
            self.assertEqual(manager.run.call_args_list[0].args,
                ('load','--signature-policy',str(manager.folder/'offline-base-policy.json'),
                 '--quiet','--input',str(archive)))
            policy=json.loads((manager.folder/'offline-base-policy.json').read_text())
            self.assertEqual(policy,{'default':[{'type':'reject'}],'transports':{
                'oci-archive':{str(archive):[{'type':'insecureAcceptAnything'}]}}})
            self.assertNotIn('HTTP_PROXY',exists.call_args.kwargs['env'])
            self.assertFalse(any(call.args[0]=='pull' for call in manager.run.call_args_list))

    def test_offline_base_warm_still_checks_full_identity_without_reload(self):
        with self.offline_fixture() as (manager,document,archive,value,image):
            manager.run=Mock(return_value=json.dumps([image]))
            with patch.object(o.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'',stderr=b'')):
                self.assertEqual(manager.offline_base(),value['imageId'])
            manager.run.assert_called_once_with('image','inspect',value['baseImage'])

    def test_offline_base_unconfigured_remains_optional_without_engine_access(self):
        with tempfile.TemporaryDirectory() as root,patch.object(o,'BASE_SEEDS',Path(root)/'absent'), \
             patch.object(o.subprocess,'run') as engine:
            self.assertIsNone(self.manager().offline_base())
            engine.assert_not_called()

    def test_offline_base_unreadable_seed_is_not_treated_as_unconfigured(self):
        manager=self.manager();manager.run=Mock()
        manager.load=Mock(return_value={'schema':1,'owner':manager.owner,'project':'vision',
                                       'image':manager.policy['baseImage'],'container':None})
        with patch.object(Path,'lstat',side_effect=PermissionError('unreadable administrator seed')), \
             patch.object(o.subprocess,'run') as engine,self.assertRaises(PermissionError):
            manager.checkpoint('vision')
        engine.assert_not_called();manager.run.assert_not_called()

    def test_offline_base_material_changed_during_inspection_is_rejected(self):
        for target in ('metadata','archive'):
            with self.subTest(target=target),self.offline_fixture() as (manager,document,archive,value,image):
                def inspect(*args,**kwargs):
                    path=document if target=='metadata' else archive
                    path.chmod(0o644);path.write_bytes(path.read_bytes()+b' ');path.chmod(0o444)
                    return json.dumps([image])
                manager.run=Mock(side_effect=inspect)
                with patch.object(o.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'',stderr=b'')), \
                     self.assertRaisesRegex(ValueError,'seed changed during operation'):
                    manager.offline_base()

    def test_offline_base_corrupt_archive_or_metadata_never_calls_engine(self):
        for kind in ('checksum','size','foreign-base','unknown-key','mode','hardlink','symlink','missing'):
            with self.subTest(kind=kind),self.offline_fixture() as (manager,document,archive,value,image):
                if kind=='checksum':value['archiveSHA256']='c'*64
                elif kind=='size':value['archiveBytes']+=1
                elif kind=='foreign-base':value['baseImage']='docker.io/library/other@sha256:'+SHA
                elif kind=='unknown-key':value['archivePath']='/private/host/graph'
                elif kind=='mode':archive.chmod(0o644)
                elif kind=='hardlink':os.link(archive,archive.with_suffix('.linked'))
                elif kind=='symlink':archive.unlink();archive.symlink_to(document)
                elif kind=='missing':archive.unlink()
                document.chmod(0o644);document.write_text(json.dumps(value));document.chmod(0o444)
                with patch.object(o.subprocess,'run') as engine,self.assertRaises((ValueError,OSError)):
                    manager.offline_base()
                engine.assert_not_called()

    def test_offline_base_identity_requires_repo_manifest_config_and_every_layer(self):
        for kind in ('repo','digest','id','layer','extra-layer'):
            with self.subTest(kind=kind),self.offline_fixture() as (manager,document,archive,value,image):
                if kind=='repo':image['RepoDigests']=[]
                elif kind=='digest':image['Digest']='sha256:'+'c'*64
                elif kind=='id':image['Id']='c'*64
                elif kind=='layer':image['RootFS']['Layers']=['sha256:'+'c'*64]
                else:image['RootFS']['Layers']+=['sha256:'+'c'*64]
                manager.run=Mock(return_value=json.dumps([image]))
                with patch.object(o.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'',stderr=b'')),self.assertRaisesRegex(ValueError,'identity mismatch'):
                    manager.offline_base()
                manager.run.assert_called_once_with('image','inspect',value['baseImage'])

    def test_offline_base_load_failure_never_pulls_or_acknowledges_project(self):
        with self.offline_fixture() as (manager,document,archive,value,image):
            manager.load=Mock(return_value={'schema':1,'owner':manager.owner,'project':'vision',
                                           'image':value['baseImage'],'container':None})
            manager.run=Mock(side_effect=ValueError('Managed OCI operation failed'))
            with patch.object(o.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout=b'',stderr=b'')), \
                 patch.object(manager.s,'atomic_json') as write,self.assertRaises(ValueError):
                manager.checkpoint('vision')
            write.assert_not_called();self.assertEqual(manager.run.call_count,1)
            self.assertEqual(manager.run.call_args.args[0],'load')

    def test_offline_base_lookup_timeout_and_invalid_exit_never_load_or_retry(self):
        for result in (SimpleNamespace(returncode=125,stdout=b'',stderr=b'error'),
                       o.subprocess.TimeoutExpired('fixed-local-lookup',30)):
            with self.subTest(result=result),self.offline_fixture() as (manager,*_):
                manager.run=Mock()
                with patch.object(o.subprocess,'run',side_effect=result if isinstance(result,Exception) else None,
                                  return_value=result) as exists,self.assertRaises((ValueError,o.subprocess.TimeoutExpired)):
                    manager.offline_base()
                self.assertEqual(exists.call_count,1);manager.run.assert_not_called()

    def test_offline_base_published_image_does_not_load_or_pull(self):
        manager=self.manager();manager.load=Mock(return_value={'schema':1,'owner':manager.owner,
            'project':'vision','image':'sha256:'+SHA,'container':None})
        manager.offline_base=Mock(side_effect=AssertionError);manager.run=Mock(side_effect=AssertionError)
        self.assertEqual(manager.checkpoint('vision')['image'],'sha256:'+SHA)

    def test_signature_policy_allows_only_exact_approved_base_digest(self):
        value = json.loads(o.signature_policy_raw(config()['personalOci']['baseImage']))
        self.assertEqual(value['default'], [{'type':'reject'}])
        self.assertEqual(value['transports'], {'docker':{config()['personalOci']['baseImage']:[{'type':'insecureAcceptAnything'}]}})
        for image in ('ubuntu:latest', 'docker.io/library/ubuntu', 'sha256:'+SHA):
            with self.assertRaises(ValueError): o.signature_policy_raw(image)

    def test_short_runtime_owner_is_private_stable_and_not_a_database_migration(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as root:
            manager = self.manager(); base = Path(root).resolve(); user = base/str(os.getuid()); user.mkdir(mode=0o700)
            with patch.object(o, 'RUNTIME', base):
                path = manager.runtime_temporary(); self.assertEqual(path, manager.runtime_temporary())
                self.assertLess(len(os.fsencode(path))+len('/conmon-term.XXXXXX'),108)
                self.assertEqual((path/'.owner').read_text(),manager.owner+'\n')
                self.assertEqual(path.stat().st_mode&0o777,0o700)
                self.assertIn(str(manager.folder/'tmp'),manager.command('version'))
                (path/'.owner').write_text('f'*64+'\n')
                with self.assertRaisesRegex(ValueError,'runtime owner'):manager.runtime_temporary()

    def test_runtime_owner_symlink_and_mode_changes_are_rejected(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as root:
            manager=self.manager();base=Path(root).resolve();(base/str(os.getuid())).mkdir(mode=0o700)
            with patch.object(o,'RUNTIME',base):
                path=manager.runtime_temporary();owner=path/'.owner';owner.chmod(0o644)
                with self.assertRaises(ValueError):manager.runtime_temporary()
                owner.unlink();owner.symlink_to('/etc/passwd')
                with self.assertRaises(OSError):manager.runtime_temporary()

    def test_immutable_image_id_accepts_only_full_sha256(self):
        for value in (SHA, 'sha256:'+SHA):
            self.assertEqual(o.immutable_image_id(value), 'sha256:'+SHA)
        for value in ('ubuntu:latest', 'sha256:'+SHA[:12], SHA[:12], 'sha512:'+SHA,
                      SHA.upper(), ' '+SHA, SHA+'\n', None, 123):
            with self.subTest(value=value), self.assertRaises(ValueError):
                o.immutable_image_id(value)

    def test_base_and_published_image_accept_podman_bare_full_id(self):
        manager = self.manager()
        manager.load = Mock(return_value={'schema':1,'owner':manager.owner,'project':'vision',
                                         'image':manager.policy['baseImage'],'container':None})
        manager.run = Mock(side_effect=['', SHA])
        with patch.object(manager.s, 'atomic_json'):
            self.assertEqual(manager.checkpoint('vision')['image'], 'sha256:'+SHA)
        manager.run = Mock(return_value=SHA)
        self.assertEqual(manager.verify_image('vision', {'schema':1,'owner':manager.owner,
                         'project':'vision','image':'sha256:'+SHA}), 'sha256:'+SHA)

    def test_commit_canonicalizes_full_id_before_durable_head(self):
        manager = self.manager()
        manager.load = Mock(return_value={'schema':1,'owner':manager.owner,'project':'vision',
                         'image':'sha256:'+SHA,'container':'gpuq-dev-'+'c'*32})
        metadata={'Config':{'Labels':{'io.gpuq.owner':manager.owner,'io.gpuq.project':'vision'}},
                  'State':{'Running':False,'Pid':0,'Status':'exited'}}
        manager.run = Mock(side_effect=[json.dumps([metadata]), SHA, ''])
        with patch.object(manager.s, 'atomic_json') as durable:
            self.assertEqual(manager.checkpoint('vision')['image'], 'sha256:'+SHA)
            self.assertEqual(durable.call_args.args[1]['image'], 'sha256:'+SHA)

    def verify_capability(self, host, *, cdi_names=None, wrong_cdi=False):
        manager = self.manager()
        manager.s = SimpleNamespace(directory=MagicMock())
        manager.run = Mock(side_effect=['5.8.8', json.dumps({'host': host})])
        def verify_file(path, expected, **kwargs):
            if path == o.CDI:
                self.assertEqual(expected, SHA)
                if wrong_cdi: raise ValueError('OCI host dependency differs from accepted version')
        with patch.object(o, 'protected_file', side_effect=verify_file) as protected, \
             patch.object(o.os, 'geteuid', return_value=1000), \
             patch.object(o.os, 'fstat', return_value=SimpleNamespace(st_uid=0, st_mode=0o40755)), \
             patch.object(o.os, 'listdir', side_effect=[[], cdi_names if cdi_names is not None else ['gpuq-nvidia.json']]), \
             patch.object(o.Path, 'exists', lambda p: str(p) in ('/etc/cdi', '/run/cdi')), \
             patch.object(o.Path, 'is_symlink', return_value=False):
            result = manager.verify_host()
            protected.assert_any_call('/usr/bin/crun', SHA, executable=True)
        self.assertEqual([call.args[0] for call in manager.s.directory.call_args_list], [o.HOOKS, o.CDI.parent])
        self.assertEqual(manager.run.call_args_list[-1].args, ('info', '--format=json'))
        return result

    def test_dedicated_cdi_rejects_extra_spec_and_wrong_digest(self):
        host = {'security': {'rootless': True}, 'cgroupVersion': 'v2',
                'ociRuntime': {'name': 'crun', 'path': '/usr/bin/crun'}}
        for names in ([], ['gpuq-nvidia.json', 'host.yaml']):
            with self.subTest(names=names), self.assertRaisesRegex(ValueError, 'Unpinned CDI'):
                self.verify_capability(host, cdi_names=names)
        with self.assertRaisesRegex(ValueError, 'differs from accepted version'):
            self.verify_capability(host, wrong_cdi=True)

    def test_host_cdi_directories_are_not_inspected_or_loaded(self):
        # Both host defaults exist, potentially with automatic NVIDIA specs.
        # The only inspected CDI directory and command option are dedicated.
        self.verify_capability({'security': {'rootless': True}, 'cgroupVersion': 'v2',
                                'ociRuntime': {'name': 'crun', 'path': '/usr/bin/crun'}})

    def test_runtime_capability_accepts_pinned_absolute_name(self):
        for name in ('crun', '/usr/bin/crun'):
            with self.subTest(name=name):
                result = self.verify_capability({'security': {'rootless': True}, 'cgroupVersion': 'v2',
                    'ociRuntime': {'name': name, 'path': '/usr/bin/crun'}})
                self.assertEqual(result['podman'], '5.8.8')
                self.assertIs(result['rootless'], True)
                self.assertIs(result['gpuDevelopment'], False)

    def test_runtime_capability_rejects_unpinned_alias_and_unsafe_host(self):
        safe = {'security': {'rootless': True}, 'cgroupVersion': 'v2',
                'ociRuntime': {'name': '/usr/bin/crun', 'path': '/usr/bin/crun'}}
        wrong = [
            {**safe, 'ociRuntime': {'name': 'crun', 'path': '/tmp/crun'}},
            {**safe, 'ociRuntime': {'name': 'crun', 'path': '/usr/local/bin/crun'}},
            {**safe, 'ociRuntime': {'name': 'crun'}},
            {**safe, 'ociRuntime': {'name': 'crun-alias', 'path': '/usr/bin/crun'}},
            {**safe, 'ociRuntime': {'name': '/tmp/crun', 'path': '/usr/bin/crun'}},
            {**safe, 'security': {'rootless': False}},
            {**safe, 'security': {'rootless': 1}},
            {**safe, 'security': {}},
            {**safe, 'cgroupVersion': 'v1'},
            {**safe, 'cgroupVersion': 2},
        ]
        for host in wrong:
            with self.subTest(host=host), self.assertRaisesRegex(ValueError, 'Rootless cgroup-v2/crun'):
                self.verify_capability(host)

    def test_development_has_no_devices_no_host_network_or_privilege(self):
        args = self.manager().arguments({'project': 'vision', 'argv': ['/bin/bash']}, {'environmentMode': 'oci'}, True, [], [(8, '/workspace', False)])
        self.assertNotIn('--device', args)
        self.assertNotIn('--privileged', args)
        self.assertIn('--cgroups=split', args)
        self.assertIn('--image-volume=ignore', args)
        self.assertIn('--network=slirp4netns:allow_host_loopback=false', args)
        self.assertIn('--env=NVIDIA_VISIBLE_DEVICES=void', args)

    def test_execute_reads_existing_delegate_and_enforced_kernel_budget_only(self):
        manager = self.manager(); manager.verify_host = Mock(); manager.arguments = Mock(return_value=[])
        group = '/user.slice/amax-term-unit-test.service'
        state = 'Delegate=yes\nKillMode=control-group\nMemoryMax=8589934592\nTasksMax=2048\nControlGroup='+group+'\n'
        resources = SimpleNamespace(read_budget=Mock(side_effect=ValueError('budget verified sentinel')))
        with patch.object(o.os, 'getuid', return_value=1000), \
             patch.object(o.Path, 'read_text', return_value='0::'+group+'\n'), \
             patch.object(o.subprocess, 'run', return_value=SimpleNamespace(stdout=state)) as systemctl, \
             patch.object(o, 'module', return_value=resources), \
             self.assertRaisesRegex(ValueError, 'budget verified sentinel'):
            manager._execute({'project':'vision','id':'test'}, {'environmentMode':'oci'}, True, [], [], registry_env={})
        self.assertEqual(systemctl.call_count, 1)
        self.assertEqual(systemctl.call_args.args[0][:3], ['/usr/bin/systemctl','--user','show'])
        resources.read_budget.assert_called_once_with({'project':'vision','id':'test'}, group, [], True, config=manager.config)

    def test_named_mounts_use_only_open_descriptor_sources_including_controls(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); source = manager.folder/'workspace'; source.mkdir(mode=0o700)
            sdk = manager.folder/'sdk.pyz'; sdk.write_bytes(b'fixed sdk'); sdk.chmod(0o600)
            directory = os.open(source, os.O_RDONLY|os.O_DIRECTORY); archive = os.open(sdk, os.O_RDONLY)
            try:
                sources = {directory:str(source), archive:str(sdk)}
                with patch.object(o.os, 'readlink', side_effect=lambda name:sources[int(name.rsplit('/',1)[-1])]), \
                     manager.named_mounts([(directory,'/workspace',False)], ['--ro-bind-data',str(archive),'/opt/gpuq/sdk.pyz']):
                    args = manager.arguments({'project':'vision','argv':['/bin/bash']}, {'environmentMode':'oci'}, True, [], [(directory,'/workspace',False)])
                    self.assertIn(str(source)+':/workspace:rw', args)
                    control = o.translate_control(['--ro-bind-data',str(archive),'/opt/gpuq/sdk.pyz'], manager._mount_sources)
                    self.assertIn(str(sdk)+':/opt/gpuq/sdk.pyz:ro', control)
                    self.assertFalse(any('/proc/' in arg for arg in args+control))
                self.assertEqual(manager._mount_sources, {})
            finally: os.close(directory); os.close(archive)

    def test_named_mounts_reject_path_replacement_and_writable_ancestors(self):
        for replace in (False, True):
            with self.subTest(replace=replace), tempfile.TemporaryDirectory() as root:
                manager = self.anonymous_manager(root); source = manager.folder/'workspace'; source.mkdir(mode=0o700)
                descriptor = os.open(source, os.O_RDONLY|os.O_DIRECTORY)
                try:
                    if not replace: manager.folder.chmod(0o777)
                    with patch.object(o.os, 'readlink', return_value=str(source)), self.assertRaises(ValueError):
                        with manager.named_mounts([(descriptor,'/workspace',False)], []):
                            source.rename(manager.folder/'old-workspace'); source.mkdir(mode=0o700)
                finally: os.close(descriptor)

    def test_named_mounts_reject_symlink_and_deleted_or_client_path(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root); source = manager.folder/'workspace'; source.mkdir(mode=0o700)
            linked = manager.folder/'linked'; linked.symlink_to(source, target_is_directory=True)
            descriptor = os.open(source, os.O_RDONLY|os.O_DIRECTORY)
            try:
                for name in (str(linked), str(source)+' (deleted)', '../host', '/tmp:rw'):
                    with self.subTest(name=name), patch.object(o.os,'readlink',return_value=name), self.assertRaises((ValueError,OSError)):
                        with manager.named_mounts([(descriptor,'/workspace',False)], []): self.fail('Unsafe named source accepted')
            finally: os.close(descriptor)

    def test_only_small_valid_resource_memfd_is_privately_snapshotted_and_cleaned(self):
        with tempfile.TemporaryDirectory() as root:
            manager = self.anonymous_manager(root)
            path = manager.folder/'synthetic-resources'; raw = json.dumps({'schemaVersion':1,'cpuLimit':2,
                'memoryLimitBytes':8*1024**3,'pidsLimit':2048,'gpuCount':0}).encode(); path.write_bytes(raw)
            descriptor = os.open(path, os.O_RDONLY)
            try:
                with patch.object(o.os,'readlink',return_value='/memfd:gpuq-resources (deleted)'):
                    with manager.named_mounts([(descriptor,'/run/gpuq/resources.json',True)], []):
                        snapshot = Path(manager._mount_sources[descriptor]); self.assertEqual(snapshot.read_bytes(),raw)
                        self.assertEqual(snapshot.stat().st_mode & 0o777,0o600)
                    self.assertFalse(snapshot.exists())
                    for target, readonly in (('/etc/shadow',True),('/run/gpuq/resources.json',False)):
                        with self.assertRaises(ValueError):
                            with manager.named_mounts([(descriptor,target,readonly)], []): self.fail('Unsupported memfd accepted')
            finally: os.close(descriptor)

    def test_development_rejects_scheduler_gpu_injection(self):
        with self.assertRaisesRegex(ValueError, 'cannot have GPUs'):
            self.manager().arguments({'project': 'vision', 'argv': ['/bin/bash']}, {'environmentMode': 'oci'}, True, [GPU], [])

    def test_development_accepts_resource_environment_but_no_attempt_mount(self):
        args = self.manager().arguments({'project': 'vision', 'argv': ['/bin/bash']}, {'environmentMode': 'oci'}, True, [], [],
                                       ['--setenv', 'GPUQ_CPU_LIMIT', '2', '--setenv', 'PATH', '/opt/gpuq/bin:/usr/bin'])
        self.assertIn('GPUQ_CPU_LIMIT=2', args)
        self.assertIn('PATH=/opt/gpuq/bin:/usr/bin', args)
        with self.assertRaisesRegex(ValueError, 'scheduler controls'):
            self.manager().arguments({'project': 'vision', 'argv': ['/bin/bash']}, {'environmentMode': 'oci'}, True, [], [],
                                     ['--bind-fd', '8', '/run/gpuq/control'])

    def test_scheduler_cdi_exact_uuid_never_all_index_or_duplicate(self):
        raw = json.dumps({'kind': 'nvidia.com/gpu', 'devices': [{'name': 'all'}, {'name': GPU}]}).encode()
        self.assertEqual(o.cdi_devices(raw, [GPU]), ['nvidia.com/gpu='+GPU])
        for values in ([], ['all'], ['0'], [GPU, GPU], ['GPU-'+('f'*36)]):
            with self.subTest(values=values), self.assertRaises(ValueError): o.cdi_devices(raw, values)

    def test_cdi_missing_uuid_or_duplicate_spec_rejected(self):
        for devices in ([{'name': 'all'}], [{'name': GPU}, {'name': GPU}]):
            with self.assertRaises(ValueError): o.cdi_devices(json.dumps({'kind': 'nvidia.com/gpu', 'devices': devices}), [GPU])

    def test_mount_injection_not_a_supported_command(self):
        for target in ('/workspace/../etc', '/tmp:ro', 'relative'):
            with self.assertRaises(ValueError):
                self.manager().arguments({'project': 'vision', 'argv': ['/bin/bash']}, {'environmentMode': 'oci'}, True, [], [(8, target, False)])

    def test_control_translation_only_attempt_sdk_and_hami(self):
        result = o.translate_control(['--dir','/run/gpuq','--bind-fd','12','/run/gpuq/control','--setenv','GPUQ_ATTEMPT_ID','A123'])
        self.assertIn('/proc/'+str(os.getpid())+'/fd/12:/run/gpuq/control:rw', result)
        for args in (['--bind-fd','12','/etc'], ['--dev-bind','/dev/nvidia0','/dev/nvidia0'], ['--setenv','bad;command','x']):
            with self.assertRaises(ValueError): o.translate_control(args)

    def test_real_training_control_combination_accepts_exact_ray_spilling_key(self):
        owner=Mock();owner.run.return_value=json.dumps(['PATH=/usr/local/bin:/usr/bin'])
        owner.execute.side_effect=lambda *a,**kw:o.translate_control(kw['control'])
        training=SimpleNamespace(prepare=lambda *a:(['--dir','/run/gpuq','--bind-fd','99','/run/gpuq/control',
                      '--setenv','GPUQ_ATTEMPT_ID','A123'],[]))
        project={'code':Path('/private/code'),'meta':{'oci':{'image':'sha256:'+SHA}}}
        with patch.object(o,'PersonalOCI',return_value=owner),patch.object(o,'module',return_value=training), \
             patch.object(o.Path,'exists',return_value=False):
            result=o.run_project(config(),{'id':'job','userId':USER,'project':'vision'},project,
                                 False,[GPU],1,{'home':2,'output':3},[],runtimefd=4)
        self.assertIn('RAY_object_spilling_directory=/tmp/gpuq-ray-spill',result)
        self.assertIn('GPUQ_ATTEMPT_ID=A123',result)
        self.assertIn('RAY_TMPDIR=/run/gpuq/runtime',result)
        self.assertEqual(owner.execute.call_args.args[3],[GPU])

    def test_mixed_case_environment_exception_is_exact_and_bounded(self):
        for key,value in [('ray_object_spilling_directory','x'),('RAY_other','x'),('normalKey','x'),
                          ('RAY_object_spilling_directory','x\x00y'),('X',123),
                          ('X','x'*65537),('X'*257,'x')]:
            with self.subTest(key=key),self.assertRaises(ValueError):o.translate_control(['--setenv',key,value])

    def test_release_cannot_select_another_owner_or_tag(self):
        m = self.manager(); m.run = Mock(return_value='sha256:'+SHA)
        receipt = {'schema': 1, 'owner': m.owner, 'project': 'vision', 'image': 'sha256:'+SHA}
        self.assertEqual(m.verify_image('vision', receipt), 'sha256:'+SHA)
        for key, value in (('owner', 'f'*64), ('project', 'other'), ('image', 'ubuntu:latest')):
            bad = {**receipt, key: value}
            with self.assertRaises(ValueError): m.verify_image('vision', bad)

    def test_missing_published_image_does_not_pull_or_fallback(self):
        m = self.manager(); m.run = Mock(return_value='sha256:'+'b'*64)
        with self.assertRaisesRegex(ValueError, 'no tag fallback'):
            m.verify_image('vision', {'schema': 1, 'owner': m.owner, 'project': 'vision', 'image': 'sha256:'+SHA})
        self.assertEqual(m.run.call_count, 1)

    def test_portable_image_reports_fixed_digest_platform_and_layers_only(self):
        m=self.manager();m.verify_host=Mock();m.verify_image=Mock(return_value='sha256:'+SHA)
        image={'Id':'sha256:'+SHA,'Os':'linux','Architecture':'amd64','Size':123,
               'RootFS':{'Layers':['sha256:'+'b'*64]}}
        m.run=Mock(return_value=json.dumps([image]));receipt={'schema':1,'owner':m.owner,'project':'vision','image':'sha256:'+SHA}
        with patch.object(o.platform,'machine',return_value='x86_64'):
            value=m.portable_image('vision',receipt)
            self.assertEqual(value['architecture'],'amd64');self.assertEqual(value['unpackedBytes'],123)
            m.run.return_value=json.dumps([{**image,'Size':101*1024**3}])
            self.assertEqual(m.portable_image('vision',receipt)['unpackedBytes'],101*1024**3)
            for key,bad in [('Architecture','arm64'),('Os','windows'),('Id','sha256:'+'c'*64),('Size',True),('Size',-1),('Size',2**53)]:
                m.run.return_value=json.dumps([{**image,key:bad}])
                with self.assertRaises(ValueError):m.portable_image('vision',receipt)
        self.assertTrue(all(call.args[0]=='image' for call in m.run.call_args_list))

    def test_portable_load_checks_checksum_reserve_and_exact_local_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            m=self.manager();m.root=Path(directory).resolve();m.folder=m.root/'oci';m.folder.mkdir(mode=0o700)
            owner=m.root/'projects-v2'/m.owner;owner.mkdir(parents=True,mode=0o700)
            archive=owner/'image.tar';archive.write_bytes(b'fixed image');archive.chmod(0o600)
            receipt={'schema':1,'owner':m.owner,'project':'vision','image':'sha256:'+SHA}
            base={'schema':1,'image':receipt['image'],'os':'linux','architecture':'amd64','diffIds':['sha256:'+'b'*64],'unpackedBytes':456}
            identity={**base,'archiveBytes':11,'archiveSha256':hashlib.sha256(b'fixed image').hexdigest()}
            m.verify_host=Mock();m.portable_image=Mock(return_value=base);m.run=Mock()
            with patch.object(o.platform,'machine',return_value='x86_64'),patch.object(m.s,'require_workspace_space') as reserve:
                self.assertEqual(m.import_image('vision',receipt,archive,identity),base)
                self.assertGreater(reserve.call_args_list[0].args[2],base['unpackedBytes'])
                args=m.run.call_args.args;self.assertEqual(args[0],'load');self.assertEqual(args[args.index('--input')+1],str(archive))
                policy=json.loads(Path(args[args.index('--signature-policy')+1]).read_text())
                self.assertEqual(policy,{'default':[{'type':'reject'}],'transports':{'oci-archive':{str(archive):[{'type':'insecureAcceptAnything'}]}}})
                # Real Podman 5.8 save/load produced the same image/layers
                # with a 76-byte local Size accounting difference.
                m.portable_image.return_value={**base,'unpackedBytes':base['unpackedBytes']+76}
                self.assertEqual(m.import_image('vision',receipt,archive,identity),m.portable_image.return_value)
                for key,bad in [('image','sha256:'+'c'*64),('diffIds',['sha256:'+'c'*64]),('architecture','arm64')]:
                    m.portable_image.return_value={**base,key:bad}
                    with self.assertRaisesRegex(ValueError,'identity differs'):m.import_image('vision',receipt,archive,identity)
                m.portable_image.return_value=base
                m.run.reset_mock()
                with self.assertRaisesRegex(ValueError,'checksum'):m.import_image('vision',receipt,archive,{**identity,'archiveSha256':'f'*64})
                m.run.assert_not_called()
                with self.assertRaises(ValueError):m.import_image('vision',{**receipt,'owner':'f'*64},archive,identity)
                m.run.assert_not_called()

    def test_portable_save_never_commits_live_container_and_checks_free_space(self):
        with tempfile.TemporaryDirectory() as directory:
            m=self.manager();m.root=Path(directory).resolve();m.folder=m.root/'oci';m.folder.mkdir(mode=0o700)
            owner=m.root/'projects-v2'/m.owner;owner.mkdir(parents=True,mode=0o700);archive=owner/'image.tar'
            base={'schema':1,'image':'sha256:'+SHA,'os':'linux','architecture':'amd64','diffIds':['sha256:'+'b'*64],'unpackedBytes':456}
            m.portable_image=Mock(return_value=base)
            def save(*args,**kwargs):archive.write_bytes(b'fixed image');archive.chmod(0o600)
            m.run=Mock(side_effect=save)
            with patch.object(m.s,'require_workspace_space') as reserve:
                result=m.export_image('vision',{},archive)
                self.assertEqual(result['archiveSha256'],hashlib.sha256(b'fixed image').hexdigest())
                self.assertGreater(reserve.call_args_list[0].args[2],456)
                policy=m.folder/('portable-export-'+SHA+'.json')
                self.assertEqual(m.run.call_args.args,('save','--signature-policy',str(policy),'--format=oci-archive','--output',str(archive),'sha256:'+SHA))
                self.assertEqual(json.loads(policy.read_bytes()),{'default':[{'type':'reject'}],
                    'transports':{'containers-storage':{'[overlay@'+str(m.folder/'graph')+']@'+SHA:[{'type':'insecureAcceptAnything'}]}}})
                self.assertEqual(reserve.call_count,2)

    def test_running_or_foreign_dev_container_is_not_committed(self):
        for running, owner in ((True, None), (False, 'f'*64)):
            m = self.manager()
            m.load = Mock(return_value={'schema': 1, 'owner': m.owner, 'project': 'vision', 'image': 'sha256:'+SHA, 'container': 'gpuq-dev-'+'c'*32})
            m.run = Mock(return_value=json.dumps([{'Config': {'Labels': {'io.gpuq.owner': owner or m.owner, 'io.gpuq.project': 'vision'}}, 'State': {'Running': running, 'Pid': 0, 'Status': 'exited'}}]))
            with self.assertRaises(ValueError): m.checkpoint('vision')
            self.assertEqual(m.run.call_count, 1)

    def test_podman_stopped_checkpoint_is_safe_but_live_pid_or_pause_is_not(self):
        for state in ({'Status':'stopped','Running':False,'Paused':False,'Pid':0},
                      {'Status':'stopped','Running':False,'Paused':True,'Pid':0},
                      {'Status':'stopped','Running':False,'Paused':False,'Pid':123}):
            with self.subTest(state=state):
                m = self.manager(); m.load = Mock(return_value={'schema':1,'owner':m.owner,
                    'project':'vision','container':'gpuq-dev-'+'a'*32,'image':'sha256:'+SHA})
                entry={'Config':{'Labels':{'io.gpuq.owner':m.owner,'io.gpuq.project':'vision'}},'State':state}
                m.run = Mock(side_effect=[json.dumps([entry]), SHA, ''])
                with patch.object(m.s,'atomic_json') as write:
                    if state['Paused'] or state['Pid']:
                        with self.assertRaises(ValueError):m.checkpoint('vision')
                        write.assert_not_called();self.assertEqual(m.run.call_count,1)
                    else:
                        self.assertEqual(m.checkpoint('vision')['image'],'sha256:'+SHA)
                        self.assertEqual(m.run.call_args.args[0],'rm');write.assert_called_once()

    def test_dead_conmon_native_stop_preserves_overlay_before_checkpoint(self):
        m=self.manager();identifier='c'*64
        m.load=Mock(return_value={'schema':1,'owner':m.owner,'project':'vision',
                    'container':'gpuq-dev-'+'a'*32,'image':'sha256:'+SHA})
        stale={'Id':identifier,'Config':{'Labels':{'io.gpuq.owner':m.owner,'io.gpuq.project':'vision'}},
               'State':{'Running':True,'Paused':False,'Pid':99999998,'ConmonPid':99999999}}
        stopped={**stale,'State':{'Running':False,'Paused':False,'Pid':0,'Status':'stopped'}}
        for code in (0,125):
            m.load=Mock(return_value={'schema':1,'owner':m.owner,'project':'vision',
                        'container':'gpuq-dev-'+'a'*32,'image':'sha256:'+SHA})
            m.run=Mock(side_effect=[json.dumps([stale]),json.dumps([stopped]),SHA,''])
            auth=MagicMock();auth.__enter__.return_value=(m.env,-1)
            with patch.object(o.Path,'exists',return_value=False),patch.object(m.s,'atomic_json') as write, \
                 patch.object(m,'registry_auth',return_value=auth), \
                 patch.object(o.subprocess,'run',return_value=SimpleNamespace(returncode=code,stdout=b'',stderr=b'conmon exited')) as stop:
                self.assertEqual(m.checkpoint('vision')['image'],'sha256:'+SHA)
            self.assertEqual(stop.call_args.args[0][-4:],['stop','--time','1',identifier])
            self.assertEqual(stop.call_args.kwargs['env'],m.env);self.assertEqual(stop.call_args.kwargs['timeout'],30)
            self.assertEqual(m.run.call_args_list[2].args[0],'commit');write.assert_called_once()

    def test_dead_runtime_refresh_keeps_running_changed_paused_and_foreign_state_refused(self):
        identifier='c'*64
        stale={'Id':identifier,'Config':{'Labels':{'io.gpuq.owner':self.manager().owner,'io.gpuq.project':'vision'}},
               'State':{'Running':True,'Paused':False,'Pid':99999998,'ConmonPid':99999999}}
        variants=[stale,{**stale,'Id':'d'*64},
                  {**stale,'State':{'Running':False,'Paused':True,'Pid':0,'Status':'stopped'}},
                  {**stale,'Config':{'Labels':{'io.gpuq.owner':'f'*64,'io.gpuq.project':'vision'}}}]
        for refreshed in variants:
            with self.subTest(refreshed=refreshed):
                m=self.manager();m.load=Mock(return_value={'schema':1,'owner':m.owner,'project':'vision',
                    'container':'gpuq-dev-'+'a'*32,'image':'sha256:'+SHA})
                m.run=Mock(side_effect=[json.dumps([stale]),json.dumps([refreshed])])
                auth=MagicMock();auth.__enter__.return_value=(m.env,-1)
                with patch.object(o.Path,'exists',return_value=False),patch.object(m.s,'atomic_json') as write, \
                     patch.object(m,'registry_auth',return_value=auth), \
                     patch.object(o.subprocess,'run',return_value=SimpleNamespace(returncode=125,stdout=b'',stderr=b'conmon exited')):
                    with self.assertRaises(ValueError):m.checkpoint('vision')
                    write.assert_not_called();self.assertEqual(m.run.call_count,2)

    def test_live_kernel_pid_never_syncs_or_commits_development_container(self):
        m=self.manager();m.load=Mock(return_value={'schema':1,'owner':m.owner,'project':'vision',
                    'container':'gpuq-dev-'+'a'*32,'image':'sha256:'+SHA})
        entry={'Id':'c'*64,'Config':{'Labels':{'io.gpuq.owner':m.owner,'io.gpuq.project':'vision'}},
               'State':{'Running':True,'Paused':False,'Pid':123,'ConmonPid':124}}
        m.run=Mock(return_value=json.dumps([entry]))
        with patch.object(o.Path,'exists',return_value=True),patch.object(m.s,'atomic_json') as write:
            with self.assertRaises(ValueError):m.checkpoint('vision')
            write.assert_not_called();self.assertEqual(m.run.call_count,1)

    def test_dead_native_stop_timeout_or_oversize_cannot_commit(self):
        import subprocess
        for failure in (subprocess.TimeoutExpired('podman',30),
                        SimpleNamespace(returncode=0,stdout=b'x'*(2*1024**2),stderr=b'')):
            m=self.manager();m.load=Mock(return_value={'schema':1,'owner':m.owner,'project':'vision',
                       'container':'gpuq-dev-'+'a'*32,'image':'sha256:'+SHA})
            entry={'Id':'c'*64,'Config':{'Labels':{'io.gpuq.owner':m.owner,'io.gpuq.project':'vision'}},
                   'State':{'Running':True,'Paused':False,'Pid':99999998,'ConmonPid':99999999}}
            m.run=Mock(return_value=json.dumps([entry]));auth=MagicMock();auth.__enter__.return_value=(m.env,-1)
            with patch.object(o.Path,'exists',return_value=False),patch.object(m.s,'atomic_json') as write, \
                 patch.object(m,'registry_auth',return_value=auth),patch.object(o.subprocess,'run') as stop:
                if isinstance(failure,Exception):stop.side_effect=failure
                else:stop.return_value=failure
                with self.assertRaises((ValueError,subprocess.TimeoutExpired)):m.checkpoint('vision')
                self.assertEqual(m.run.call_count,1);write.assert_not_called()
    def test_commit_head_is_durable_before_deleting_writable_layer(self):
        m = self.manager()
        value = {'schema': 1, 'owner': m.owner, 'project': 'vision', 'image': 'sha256:'+SHA, 'container': 'gpuq-dev-'+'c'*32}
        m.load = Mock(return_value=value)
        m.run = Mock(side_effect=[json.dumps([{'Config': {'Labels': {'io.gpuq.owner': m.owner, 'io.gpuq.project': 'vision'}}, 'State': {'Running': False, 'Pid': 0, 'Status': 'exited'}}]), 'sha256:'+SHA])
        with patch.object(m.s, 'atomic_json', side_effect=OSError('full')):
            with self.assertRaises(OSError): m.checkpoint('vision')
        self.assertEqual(m.run.call_count, 2)  # No rm after a failed durable head.

    def test_project_oci_publish_hash_and_owner_binding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); (root/'base').mkdir()
            s = o.module('project-store')
            backend = Mock(); backend.publish.return_value = {'schema': 1, 'owner': hashlib.sha256(USER.encode()).hexdigest(), 'project': 'vision', 'image': 'sha256:'+SHA}
            # This is an immutable-publication unit fixture in a temporary
            # tree, not the node's real platform root. Keep the production
            # guard unchanged; scope its mock to only these fixture objects.
            with patch.object(s, 'check_platform_root'), patch.object(s.ProjectStore, '_oci', return_value=backend):
                store = s.ProjectStore(root, root/'base', reserve_bytes=0)
                store.create(USER, 'vision', 'oci')
                (store.dev_paths(USER, 'vision')['code']/'train.py').write_text('print(1)')
                published = store.publish(USER, 'vision')
                release = store.release(USER, 'vision', published['release'])
                self.assertEqual(release['meta']['environmentMode'], 'oci')
                self.assertEqual(release['meta']['oci']['image'], 'sha256:'+SHA)
                self.assertNotIn('env', release['meta']['content'])
                backend.verify_image.assert_called_once()


if __name__ == '__main__': unittest.main()
