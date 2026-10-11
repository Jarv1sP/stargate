"""Stored-plan/runner integration on disposable stores and real CPU namespaces.

Native systemd/process identity, GPU devices and cgroup limits are fixtures.
No real service, scheduler allocation or project interpreter is executed.
"""
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


B = load('runner_bootstrap_test', 'src/bootstrap/training-runner.py')
F = load('runner_native_fixture', 'tests/v2-native-execution-authority.test.py')
from gpuq.store import normalized_submission_digest
from gpuq.rpc import _ThreadingUnixServer


class TrainingRunnerTests(unittest.TestCase):
    def setUp(self):
        n = self.native = F.NativeAuthorityTests('runTest')
        self.addCleanup(n.doCleanups)
        n.setUp()
        self.inputs, _ = n.inputs_fixture()
        f = self.inputs
        self.config_path = n.root / 'runner.json'
        self.database = n.root / 'v2-node.sqlite'
        self.socket = n.root / 'runner-native.sock'
        self.archive = n.root / 'sdk.pyz'
        with zipfile.ZipFile(self.archive, 'w') as archive:
            for path in (ROOT / 'gpuq').rglob('*.py'):
                archive.write(path, str(path.relative_to(ROOT / 'gpuq')))
        self.config = {'schema': 1, 'machineId': 'node-1', 'database': str(self.database), 'gpuqSocket': str(self.socket),
            'root': str(f.root), 'basePath': str(f.base), 'controlRoot': str(n.config.control_dir), 'gpuqArchive': str(self.archive),
            'directories': {'raw': str(f.original)}, 'managedRoots': [{'kind': 'cache', 'root': str(f.path / 'cache')}],
            'slirp': os.environ.get('V2_SLIRP') or '/usr/bin/slirp4netns', 'slirpLibraryPath': os.environ.get('V2_SLIRP_LIB')}
        self.config_path.write_text(json.dumps(self.config))
        self.plan = n.runtime_plan(f)
        self.plan['identity'].update(gpuCount=2, requestHash='a' * 64, machineId='node-1')
        self.plan['submission']['resources'] = {'sharing': None}
        self.plan['submission']['execution'] = {'argv': ['/usr/bin/python3', '-c', '''import json,os
from pathlib import Path
from gpuq.progress import ProgressReporter
assert Path('/datasets/raw/sample.txt').read_text()=='original input'
assert Path('/data2/images/sample.txt').read_text()=='original input'
assert os.environ['GPUQ_GPU_COUNT']=='2'
assert os.environ['USER_PARAMETER']=='容器内参数'
assert ProgressReporter(report_interval_seconds=0).update(phase='train',epochs_completed=1,epochs_total=1)
Path('/outputs/runner-result.json').write_text(json.dumps({'task':os.environ['GPUQ_CONSOLE_JOB_ID'],'native':os.environ['GPUQ_JOB_ID']}))
raise SystemExit(19)
'''], 'workingDirectory': '.', 'env': {'USER_PARAMETER': '容器内参数'}}
        # This is fixture setup of immutable records, not a production submission.
        self.plan_json = json.dumps(self.plan, ensure_ascii=False)
        self.digest = hashlib.sha256(self.plan_json.encode()).hexdigest()
        submission = {**n.store.get_job(n.job['id']), 'argv': B.runner_prefix(self.config_path) +
            ['--dispatch-id', n.dispatch, '--plan-digest', self.digest]}
        self.binding = {**n.binding, **self.plan['identity'], 'nativeDigest': normalized_submission_digest(submission)}
        native_db = n.store._get_connection()
        native_db.execute('UPDATE jobs SET argv_json=?,submit_digest=? WHERE id=?',
                         (json.dumps(submission['argv']), self.binding['nativeDigest'], n.job['id']))
        with closing(sqlite3.connect(self.database)) as db:
            db.executescript('''CREATE TABLE v2_node_dispatch_bindings(dispatch_id TEXT PRIMARY KEY,binding_json TEXT NOT NULL);
                CREATE TABLE v2_node_launch_specs(dispatch_id TEXT PRIMARY KEY,submission_json TEXT NOT NULL);
                CREATE TABLE v2_node_runtime_plans(dispatch_id TEXT PRIMARY KEY,plan_json TEXT NOT NULL,plan_digest TEXT NOT NULL);''')
            db.execute('INSERT INTO v2_node_dispatch_bindings VALUES(?,?)', (n.dispatch, json.dumps(self.binding)))
            db.execute('INSERT INTO v2_node_launch_specs VALUES(?,?)', (n.dispatch, json.dumps(submission)))
            db.execute('INSERT INTO v2_node_runtime_plans VALUES(?,?,?)', (n.dispatch, self.plan_json, self.digest))
            db.commit()
        self.output = f.store.existing_run_paths(f.user, f.slug, f.version, f.job)['output']

    def execute(self, **changes):
        return B.run(self.config_path, dispatch_id=changes.get('dispatch_id', self.native.dispatch),
                     plan_digest=changes.get('plan_digest', self.digest))

    def test_config_has_fixed_paths_and_only_explicit_operator_options(self):
        self.assertEqual(B.load_config(ROOT / 'deploy/v2-runner.example.json')['machineId'], 'gpu-1')
        config = B.load_config(self.config_path)
        self.assertEqual(config['bwrap'], '/usr/bin/bwrap')
        self.assertEqual(config['leaseVersions'], [])
        self.assertEqual(config['runtimeConfig'], {})
        self.assertEqual(B.runner_prefix(self.config_path), [sys.executable, '-I', '-B', str(B.ENTRYPOINT), '--config', str(self.config_path)])
        for change in [{'schema': True}, {'schema': 2}, {'database': 'relative.db'}, {'machineId': '../other'},
                       {'bypassIdentity': True}, {'argv': ['python']}, {'runtimeConfig': []}, {'directories': []}, {'leaseVersions': {}}]:
            self.config_path.write_text(json.dumps({**self.config, **change}))
            with self.subTest(change=change), self.assertRaises(B.RunnerConfigError):
                B.load_config(self.config_path)
        with self.assertRaises(B.RunnerConfigError):
            B.load_config(Path('relative.json'))

    def test_stored_plan_and_machine_mismatches_fail_before_runtime_construction(self):
        with patch.object(B.Authority, 'NativeExecutionAuthority', side_effect=AssertionError('no runtime before exact plan')) as authority:
            for changes in [{'plan_digest': 'b' * 64}, {'dispatch_id': 'invalid'}]:
                with self.subTest(changes=changes), self.assertRaises(B.Plans.RuntimePlanError):
                    self.execute(**changes)
            self.config_path.write_text(json.dumps({**self.config, 'machineId': 'other-node'}))
            with self.assertRaises(B.Plans.RuntimePlanError):
                self.execute()
            authority.assert_not_called()

    def test_missing_database_is_not_created_and_missing_plan_is_not_prepared(self):
        absent = self.native.root / 'absent.sqlite'
        self.config_path.write_text(json.dumps({**self.config, 'database': str(absent)}))
        with self.assertRaises(B.Plans.RuntimePlanError):
            self.execute()
        self.assertFalse(absent.exists())
        self.config_path.write_text(json.dumps(self.config))
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('DELETE FROM v2_node_runtime_plans'); db.commit()
        with self.assertRaises(B.Plans.RuntimePlanError):
            self.execute()
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM v2_node_runtime_plans').fetchone()[0], 0)

    def test_cli_help_and_host_command_flags_do_not_enter_runtime(self):
        help_result = subprocess.run([sys.executable, '-B', str(B.ENTRYPOINT), '--help'], text=True, capture_output=True)
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn('--dispatch-id', help_result.stdout)
        for extra in [['--argv', 'touch', '/never-created'], ['--root', '/other'], ['--dispatch', self.native.dispatch]]:
            result = subprocess.run(B.runner_prefix(self.config_path) +
                ['--dispatch-id', self.native.dispatch, '--plan-digest', self.digest, *extra], text=True, capture_output=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn('unrecognized arguments', result.stderr)

    def test_cli_outside_native_execution_refuses_without_mutating_plan_or_inputs(self):
        environment = {key: value for key, value in os.environ.items() if not key.startswith('GPUQ_')}
        hooks = self.native.root / 'user-hooks'
        hooks.mkdir()
        marker = hooks / 'host-hook-ran'
        (hooks / 'sitecustomize.py').write_text(f"open({str(marker)!r},'w').write('unexpected host code')")
        environment['PYTHONPATH'] = str(hooks)
        before = self.database.read_bytes()
        result = subprocess.run(B.runner_prefix(self.config_path) + ['--dispatch-id', self.native.dispatch, '--plan-digest', self.digest],
            text=True, capture_output=True, env=environment, timeout=10)
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertIn('NATIVE_EXECUTION_UNCONFIRMED', result.stderr)
        self.assertNotIn('容器内参数', result.stderr)
        self.assertEqual(self.database.read_bytes(), before)
        self.assertFalse(marker.exists())
        self.assertFalse((self.output / 'runner-result.json').exists())
        self.assertEqual(len(self.inputs.cache._leases('images', self.inputs.source['version'])), 1)

    def test_unsupported_engine_is_explicit_and_never_falls_back_to_base(self):
        launch = B.Plans.NodeRuntimePlans(database=self.database, machine_id='node-1', runner=B.runner_prefix(self.config_path)).load(
            dispatch_id=self.native.dispatch, plan_digest=self.digest)
        launch['plan']['project']['runtime'] = {'kind': 'oci', 'identity': 'sha256:' + 'a' * 64}
        with patch.object(B.Plans.NodeRuntimePlans, 'load', return_value=launch), \
                patch.object(B.Authority, 'NativeExecutionAuthority', side_effect=AssertionError('unsupported engine must not start')) as authority:
            with self.assertRaises(B.EngineUnavailable):
                self.execute()
            authority.assert_not_called()

    def test_bootstrap_runs_stored_plan_through_real_rpc_inputs_and_cpu_engine(self):
        if not shutil.which('bwrap') or not Path(self.config['slirp']).is_file():
            self.skipTest('bubblewrap/slirp unavailable; bootstrap execution not tested')
        n = self.native
        server = _ThreadingUnixServer(self.socket, n.coordinator.handle_api, os.getuid(), 262144)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def close_server():
            server.shutdown(); server.server_close(); thread.join(5)
        self.addCleanup(close_server)
        root = n.root / 'test-cgroup'
        leaf = root / n.group.lstrip('/')
        leaf.mkdir(parents=True)
        def set_limits(argv, **kwargs):
            self.assertEqual(argv[5], n.unit)
            values = dict(value.split('=', 1) for value in argv[6:])
            for name, value in [('cpu.max', str(int(values['CPUQuota'][:-1]) * 1000) + ' 100000'),
                                ('memory.max', values['MemoryMax']), ('pids.max', values['TasksMax'])]:
                (leaf / name).write_text(value)
            return subprocess.CompletedProcess(argv, 0)
        budget_type = B.Budget.TrainingBudget
        before_node, before_native = self.database.read_bytes(), '\n'.join(n.store._get_connection().iterdump())
        with patch.dict(os.environ, n.environment), \
                patch.object(B.Authority, 'NativeExecutionAuthority', side_effect=lambda **kwargs: n.authority(
                    native=kwargs['native'], binding=kwargs['binding'])), \
                patch.object(B.Budget, 'TrainingBudget', side_effect=lambda resources, **kwargs:
                    budget_type(resources, systemd=set_limits, cgroup_root=root)), \
                patch.object(B.Devices, 'mount_paths', return_value=[]) as devices:
            self.assertEqual(self.execute(), 19)
        self.assertEqual(json.loads((self.output / 'runner-result.json').read_text()), {'task': self.inputs.job, 'native': n.job['id']})
        devices.assert_called_once_with(['GPU-0', 'GPU-1'])
        self.assertEqual(self.database.read_bytes(), before_node)
        self.assertEqual('\n'.join(n.store._get_connection().iterdump()), before_native)
        self.assertEqual(len(self.inputs.cache._leases('images', self.inputs.source['version'])), 1)


if __name__ == '__main__':
    unittest.main()
