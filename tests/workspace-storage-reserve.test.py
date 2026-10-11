"""Workspace admission policy: disposable local fixtures, no service/GPU/SSH."""
import base64
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parent
DEPLOY = HERE.parent / 'deploy'


def load(path):
    spec = importlib.util.spec_from_file_location('reserve_' + uuid.uuid4().hex, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


store = load(DEPLOY / 'project-store.py')


def free(value):
    # Deliberately huge f_bfree: reserved/root-only blocks are not available.
    return SimpleNamespace(f_bavail=value, f_bfree=2**60, f_frsize=1)


class Policy(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'root'
        self.root.mkdir()

    def test_scalar_default_zero_and_exact_integer_range(self):
        self.assertEqual(store.workspace_reserve_bytes({}), 10 * 1024**3)
        for value in (0, 256 * 1024**3, 2**63 - 1):
            self.assertEqual(store.workspace_reserve_bytes({'workspaceReserveBytes': value}), value)
        for value in (None, True, False, -1, 1.2, '100', {}, 2**63):
            with self.subTest(value=value), self.assertRaises(ValueError):
                store.workspace_reserve_bytes({'workspaceReserveBytes': value})

    def test_fd_available_boundary_includes_known_write(self):
        with patch.object(store.os, 'fstatvfs', return_value=free(109)) as probe:
            with self.assertRaisesRegex(ValueError, 'reserve'):
                store.require_workspace_space(self.root, 100, 10)
            self.assertIsInstance(probe.call_args.args[0], int)
        with patch.object(store.os, 'fstatvfs', return_value=free(110)):
            store.require_workspace_space(self.root, 100, 10)

    def test_reserve_error_explains_byte_counts_without_host_paths(self):
        for available, reserve, needed in ((109, 100, 10), (99, 100, 0),
                                           (2**63 - 2, 2**63 - 1, 2**63 - 1)):
            with self.subTest(available=available), \
                    patch.object(store.os, 'fstatvfs', return_value=free(available)):
                with self.assertRaises(store.ProjectError) as caught:
                    store.require_workspace_space(self.root, reserve, needed)
                error = caught.exception
                self.assertEqual(error.code, 'insufficient_space')
                self.assertIn('Personal workspace', str(error))
                for key, value in [('availableBytes', available), ('reserveBytes', reserve),
                                   ('requestedBytes', needed)]:
                    self.assertIn(f'{key}={value}', str(error))
                self.assertNotIn(str(self.root), str(error))
                self.assertLessEqual(len(str(error)), 200)
        with patch.object(store.os, 'fstatvfs',
                          return_value=SimpleNamespace(f_bavail=54, f_bfree=2**60, f_frsize=2)):
            with self.assertRaisesRegex(store.ProjectError, 'availableBytes=108'):
                store.require_workspace_space(self.root, 100, 10)

    def test_never_mkdir_or_follow_root_or_ancestor_symlink(self):
        missing = self.root / 'absent'
        with self.assertRaises(FileNotFoundError):store.require_workspace_space(missing, 0)
        self.assertFalse(missing.exists())
        link = self.root.parent / 'link';link.symlink_to(self.root, target_is_directory=True)
        (self.root / 'child').mkdir()
        for path in (link, link / 'child'):
            with self.subTest(path=path), self.assertRaises(OSError):store.require_workspace_space(path, 0)

    def test_guard_failure_or_root_replacement_denies_before_space_check(self):
        with patch.object(store, 'check_platform_root', side_effect=ValueError('unmounted')), \
                patch.object(store.os, 'fstatvfs') as probe:
            with self.assertRaisesRegex(ValueError, 'unmounted'):store.require_workspace_space(self.root, 0)
            probe.assert_not_called()
        def replace(_):
            self.root.rename(self.root.parent / 'old');self.root.mkdir()
        with patch.object(store, 'check_platform_root', side_effect=replace), \
                patch.object(store.os, 'fstatvfs') as probe:
            with self.assertRaisesRegex(ValueError, 'changed'):store.require_workspace_space(self.root, 0)
            probe.assert_not_called()

    def test_other_filesystem_descriptor_denied(self):
        original = store.os.fstat
        with store.directory(self.root) as target:
            def info(fd):
                result = original(fd)
                return SimpleNamespace(st_dev=result.st_dev + 1) if fd == target else result
            with patch.object(store.os, 'fstat', side_effect=info):
                with self.assertRaisesRegex(ValueError, 'another filesystem'):
                    store.require_workspace_space(self.root, 0, target_fd=target)


class Integration(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
    def fixture(self, filename, classname):
        case = getattr(load(HERE / filename), classname)()
        case.setUp();self.addCleanup(case.tearDown)
        return case

    def test_files_put_policy_denies_before_creation_or_truncate_read_stays_available(self):
        case = self.fixture('node-files.test.py', 'Files')
        shutil.copy2(DEPLOY / 'project-store.py', Path(case.temp.name) / 'project-store.py')
        # This legacy fixture does not resolve macOS /var; production paths must
        # not have symbolic-link ancestors. Use its canonical local root here.
        case.node.ROOT = case.node.ROOT.resolve()
        case.node.CONFIG['workspaceReserveBytes'] = 100
        root = case.node.workspace('demo-user-1');(root / 'keep').write_bytes(b'old')
        with patch.object(os, 'fstatvfs', return_value=free(100)):
            for name in ('keep', 'nested/new'):
                with self.assertRaisesRegex(ValueError, 'reserve'):
                    case.call('put', name, data='eA==', truncate=True, workspaceReserveBytes=0)
            self.assertFalse((root / 'nested').exists())
            self.assertEqual(base64.b64decode(case.call('get', 'keep')['data']), b'old')
            self.assertEqual(len(case.call('list')['entries']), 1)
        case.node.CONFIG['workspaceReserveBytes'] = 0
        with patch.object(os, 'fstatvfs', return_value=free(1)):
            case.call('put', 'keep', data='eA==', truncate=True)
        self.assertEqual((root / 'keep').read_bytes(), b'x')

    def test_project_upload_and_publication_share_configured_reserve(self):
        case = self.fixture('node-projects.test.py', 'NodeProjects')
        case.n.PROJECT_OPS = None;case.n.CONFIG['workspaceReserveBytes'] = 100
        case.ops = case.n.projects()
        self.assertEqual(case.ops.store.reserve_bytes, 100)
        with patch.object(os, 'fstatvfs', return_value=free(104)):
            with self.assertRaisesRegex(ValueError, 'reserve'):case.upload(b'hello')
        with patch.object(os, 'fstatvfs', return_value=free(105)):
            case.upload(b'hello')
        with patch.object(os, 'fstatvfs', return_value=free(99)):
            with self.assertRaisesRegex(ValueError, 'reserve'):
                case.ops.store.publish(case.args['userId'], case.args['project'])
            self.assertEqual(base64.b64decode(case.call('files.get', path='train.py')['data']), b'hello')

    def test_snapshot_begin_manifest_seal_and_status_policy(self):
        case = self.fixture('snapshot-sync.test.py', 'SnapshotSyncTests')
        node = case.nodes[1];node.CONFIG['workspaceReserveBytes'] = 100
        node.projects().store.reserve_bytes = 100
        with patch.object(os, 'fstatvfs', return_value=free(100)):
            with self.assertRaisesRegex(ValueError, 'reserve'):case.call('begin', **case.begin)
        self.assertEqual(node.projects().store.list('demo-user-42'), [])
        case.call('begin', **case.begin)
        with patch.object(os, 'fstatvfs', return_value=free(100)):
            with self.assertRaisesRegex(ValueError, 'reserve'):
                case.call('manifest', offset=0, data=base64.b64encode(case.raw).decode())
            self.assertEqual(case.call('status')['manifestOffset'], 0)
        case.call('manifest', offset=0, data=base64.b64encode(case.raw).decode())
        with patch.object(os, 'fstatvfs', return_value=free(100)):
            with self.assertRaisesRegex(ValueError, 'reserve'):case.call('seal')
            self.assertEqual(case.call('status')['state'], 'RECEIVING_MANIFEST')
        self.assertEqual(case.call('seal')['state'], 'COPYING')

    def test_snapshot_existing_export_and_unconfigured_metadata_remain_readable(self):
        case = self.fixture('snapshot-sync.test.py', 'SnapshotSyncTests')
        node = case.nodes[0];user = 'demo-user-42'
        node.process('projects.create', {'userId': user, 'project': 'source'})
        paths = node.projects().store.dev_paths(user, 'source')
        (paths['code'] / 'train.py').write_bytes(b'fixed')
        (paths['env'] / 'bin').mkdir();(paths['env'] / 'bin/python').write_text('venv')
        (paths['env'] / 'pyvenv.cfg').write_text('home = /opt/conda/bin\n')
        release = node.projects().store.publish(user, 'source')['release']
        args = {'userId': user, 'project': 'source', 'release': release}
        node.CONFIG['workspaceReserveBytes'] = 100;node.projects().store.reserve_bytes = 100
        with patch.object(os, 'fstatvfs', return_value=free(0)):
            with self.assertRaisesRegex(ValueError, 'reserve'):node.process('projects.snapshot.info', args)
        self.assertEqual(list((node.ROOT / 'snapshot-sync').iterdir()), [])
        del node.CONFIG['workspaceReserveBytes']
        # With no config, introducing an index gate must not change reads.
        with patch.object(os, 'fstatvfs', return_value=free(0)):
            self.assertEqual(node.process('projects.snapshot.info', args)['totalBytes'], 5)
        node.CONFIG['workspaceReserveBytes'] = 100;node.projects().store.reserve_bytes = 100
        with patch.object(os, 'fstatvfs', return_value=free(0)):
            result = node.process('projects.snapshot.get', {**args, 'path': 'train.py', 'offset': 0})
            self.assertEqual(base64.b64decode(result['data']), b'fixed')

    def test_new_terminal_blocked_but_reconnect_exchange_close_and_host_admin_work(self):
        case = self.fixture('terminal-sessions.test.py', 'TerminalSessions')
        personal = {**case.context, 'hostAdmin': False}
        request, result = case.open(context=personal)
        connection = case.connection(request, result)
        case.n.CONFIG['workspaceReserveBytes'] = 100
        with patch.object(os, 'fstatvfs', return_value=free(0)):
            with self.assertRaisesRegex(ValueError, 'reserve'):case.open(context=personal)
            self.assertEqual(len(case.starts), 1)
            request, result = case.reconnect(connection)
            connection = case.connection(request, result)
            case.n.process('terminal.exchange', connection)
            case.n.process('terminal.close', connection)
            _, admin = case.open()
            self.assertTrue(admin['hostAdmin'])
        self.assertEqual(len(case.starts), 2)

    def test_new_submit_blocked_but_existing_sync_logs_priority_and_cancel_do_not_probe(self):
        case = self.fixture('node-priority.test.py', 'NodePriority')
        shutil.copy2(DEPLOY / 'project-store.py', case.base / 'project-store.py')
        case.node.CONFIG['workspaceReserveBytes'] = 100
        with patch.object(os, 'fstatvfs', return_value=free(0)):
            with self.assertRaisesRegex(ValueError, 'reserve'):case.call()
        self.assertEqual(case.commands, [])
        case.register()
        with patch.object(case.node, 'workspace_storage_check', side_effect=AssertionError('control probed reserve')):
            self.assertEqual(case.call()['state'], 'PENDING')
            case.call('logs')
            case.call('priority', priority='high', expected=case.policy())
            case.data['job']['state'] = 'CANCELED'
            # The original unit-stop confirmation gate still applies; low
            # space must not turn that independent UNKNOWN into a reserve error.
            self.assertEqual(case.call('cancel')['state'], 'UNKNOWN')

    def test_unregistered_cancel_and_logs_not_blocked_by_bad_config(self):
        case = self.fixture('node-priority.test.py', 'NodePriority')
        case.node.CONFIG['workspaceReserveBytes'] = 'bad'
        with patch.object(case.node, 'workspace_storage_check', side_effect=AssertionError('control probed reserve')):
            case.call('logs')
            self.assertEqual(case.call('cancel')['state'], 'CANCELED')

    def test_both_runners_check_only_configured_nodes_at_actual_start(self):
        for name in ('sandbox-runner.py', 'sandbox-runner-common-p0.py'):
            with self.subTest(name=name):
                runner = load(DEPLOY / name)
                with patch.object(runner, 'local_module', return_value=store) as imported:
                    runner.workspace_admission({}, Path('/nonexistent'))
                    imported.assert_not_called()
                    with tempfile.TemporaryDirectory() as temporary, patch.object(os, 'fstatvfs', return_value=free(0)):
                        root = Path(temporary).resolve()
                        with self.assertRaisesRegex(ValueError, 'reserve'):
                            runner.workspace_admission({'workspaceReserveBytes': 1}, root)
                        runner.workspace_admission({'workspaceReserveBytes': 0}, root)
                # Read-only original invocation binding precedes diagnostics;
                # reserve admission still precedes allocation and limit writes.
                source = (DEPLOY / name).read_text()
                self.assertLess(source.index('    workspace_admission(cfg,root,terminal=terminal)'), source.index("    else:runtime_spec="))

    def test_existing_terminal_can_open_below_bulk_reserve_but_not_without_metadata_space(self):
        case = self.fixture('terminal-sessions.test.py', 'TerminalSessions')
        case.n.CONFIG['workspaceReserveBytes'] = 256*1024**3
        personal = {**case.context, 'hostAdmin': False}
        with patch.object(os, 'fstatvfs', return_value=free(250*1024**3)):
            request, result = case.open(context=personal)
            self.assertEqual(len(case.starts), 1)
            case.n.process('terminal.close', case.connection(request, result))
        with patch.object(os, 'fstatvfs', return_value=free(0)):
            with self.assertRaisesRegex(ValueError, 'reserve'):case.open(context=personal)
        self.assertEqual(len(case.starts), 1)
        for name in ('sandbox-runner.py', 'sandbox-runner-common-p0.py'):
            runner = load(DEPLOY/name)
            with patch.object(runner, 'local_module', return_value=store), patch.object(os, 'fstatvfs', return_value=free(250*1024**3)):
                runner.workspace_admission(case.n.CONFIG, case.n.ROOT, terminal=True)
                with self.assertRaisesRegex(ValueError, 'reserve'):
                    runner.workspace_admission(case.n.CONFIG, case.n.ROOT)

    def test_real_runner_main_rejects_before_gpu_probe_budget_mutation_or_payload(self):
        for name in ('sandbox-runner.py', 'sandbox-runner-common-p0.py'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve();jid = str(uuid.uuid4())
                (root / 'jobs').mkdir();(root / 'jobs' / (jid + '.json')).write_text(json.dumps({'id':jid}))
                (root / 'node-config.json').write_text(json.dumps({'root':str(root), 'workspaceReserveBytes':1}))
                runner = load(DEPLOY / name);runner.HERE = root
                def module(_name, filename):
                    if filename == 'platform-root-guard.py':return SimpleNamespace(check=lambda _: None)
                    if filename == 'project-store.py':return store
                    self.fail('Runner proceeded past disk admission: ' + filename)
                with contextlib.ExitStack() as identity:
                    if hasattr(runner,'JobCapture'):
                        read=Path.read_text
                        identity.enter_context(patch.object(Path,'read_text',lambda path,*a,**kw:'0::/some/gpuq-test.service\n' if path==Path('/proc/self/cgroup') else read(path,*a,**kw)))
                        identity.enter_context(patch.object(runner,'start_job_capture',return_value=(None,None,None)))
                    with patch.object(runner, 'local_module', side_effect=module), \
                        patch.object(runner.sys, 'argv', [str(DEPLOY / name), jid]), \
                        patch.object(os, 'fstatvfs', return_value=free(0)), \
                        patch.object(runner.subprocess, 'run') as run, \
                        patch.object(runner.subprocess, 'check_output') as output:
                        with self.assertRaisesRegex(ValueError, 'reserve'):runner.main()
                        run.assert_not_called();output.assert_not_called()


if __name__ == '__main__':unittest.main()
