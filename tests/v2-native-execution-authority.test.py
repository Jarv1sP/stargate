"""Real native DB/RPC and systemd parser; unit/process observations are fixtures.

Only current_process's separate test reads actual local /proc. No GPU, systemd
service, or untrusted training program is started.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


F = load('native_authority_fixture', 'tests/gpuq-priority.test.py')
A = load('native_authority', 'src/infrastructure/native-execution-authority.py')
R = load('authorized_training_runtime', 'src/infrastructure/training-runtime.py')
RF = load('authorized_runtime_fixture', 'tests/v2-training-runtime-inputs.test.py')
from gpuq.backends import BackendError, UnitNotFoundError, UserSystemdBackend
from gpuq.protocol import Client
from gpuq.rpc import _ThreadingUnixServer


class NativeAuthorityTests(unittest.TestCase):
    snapshot = F.SchedulerPriorityTests.snapshot

    def setUp(self):
        F.SchedulerPriorityTests.setUp(self)
        self.dispatch, self.platform_job = str(uuid.uuid4()), str(uuid.uuid4())
        raw = {'submit_key': self.dispatch, 'name': 'trusted-wrapper', 'owner': 'native-owner', 'priority': 2,
            'dispatch_mode': 'queue', 'yield_policy': 'never', 'checkpoint_capability': 'none', 'restart_policy': 'never',
            'gpu_count': 2, 'placement': 'any', 'requested_gpu_uuids': [],
            'argv': [sys.executable, '-c', 'never executed'], 'cwd': str(self.root), 'env': {}}
        accepted = self.coordinator.handle_api('submit_managed', {'submission': raw, 'grant_id': self.dispatch, 'max_gpu_count': 2})
        self.job = self.store.get_job(accepted['job_id'])
        self.attempt_id = 'A' + uuid.uuid4().hex
        self.unit = 'gpuq-' + self.attempt_id.lower() + '.service'
        self.group = '/user.slice/test.slice/' + self.unit
        self.proc = A.ProcessIdentity(4321, 'test-boot', 12345, self.group)
        control, log = self.coordinator._create_attempt_paths(self.job['id'], self.attempt_id)
        self.attempt = self.store.create_attempt(self.job['id'], attempt_id=self.attempt_id, state='RUNNING',
            gpu_uuids=['GPU-0', 'GPU-1'], gpu_indices=[0, 1], unit_name=self.unit, unit_token='attempt:' + self.attempt_id,
            boot_id=self.proc.boot_id, invocation_id='a' * 32, main_pid=self.proc.pid, start_ticks=self.proc.start_ticks,
            control_dir=str(control), log_path=str(log))
        self.store.acquire_leases(self.job['id'], self.attempt_id, {'GPU-0': 0, 'GPU-1': 1})
        self.store.update_job(self.job['id'], state='RUNNING')
        self.binding = {'dispatchId': self.dispatch, 'jobId': self.platform_job, 'accountId': 'alice', 'machineId': 'node-1',
            'nativeDigest': self.store.get_submission_receipt(self.dispatch)['submit_digest'],
            'nativeOwner': 'native-owner', 'nativeName': 'trusted-wrapper', 'nativeMaxGpus': 2}
        self.environment = {'GPUQ_JOB_ID': self.job['id'], 'GPUQ_ATTEMPT_ID': self.attempt_id,
            'GPUQ_CONTROL_DIR': str(control), 'GPUQ_ASSIGNED_GPU_UUIDS': 'GPU-0,GPU-1',
            'GPUQ_ASSIGNED_GPU_INDICES': '0,1', 'GPUQ_ASSIGNED_GPU_COUNT': '2'}
        self.properties = {'Id': self.unit, 'Description': '',
            'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running', 'Result': 'success',
            'ExecMainCode': '0', 'ExecMainStatus': '0', 'InvocationID': 'a' * 32, 'ControlGroup': self.group, 'MainPID': str(self.proc.pid)}
        self.commands, self.calls = [], []
        def systemctl(argv, **kwargs):
            self.commands.append(argv)
            self.assertEqual(argv[:4], ['/fixture/systemctl', '--user', 'show', '--no-pager'])
            self.assertEqual(argv[-2:], ['--', self.unit])
            self.assertFalse(kwargs['shell'])
            return subprocess.CompletedProcess(argv, 0, '\n'.join(f'{key}={value}' for key, value in self.properties.items()), '')
        self.backend = UserSystemdBackend(runner=systemctl, systemctl_binary='/fixture/systemctl')
        self.properties['Description'] = self.backend.description_for(self.attempt['unit_token'])
        def call(operation, arguments):
            self.assertEqual(operation, 'execution_snapshot')
            self.calls.append(deepcopy(arguments))
            return self.coordinator.handle_api(operation, arguments)
        self.native = SimpleNamespace(call=call)

    def authority(self, **overrides):
        return A.NativeExecutionAuthority(**{'native': self.native, 'systemd': self.backend, 'binding': self.binding,
            'machine_id': 'node-1', 'control_root': self.config.control_dir, 'environment': self.environment,
            'process': lambda: self.proc, **overrides})

    def inputs_fixture(self):
        fixture = RF.RuntimeInputsTests()
        self.addCleanup(fixture.doCleanups)
        fixture.setUp()
        binding = {**self.binding, 'jobId': fixture.job, 'accountId': fixture.user}
        return fixture, self.authority(binding=binding)

    def test_current_attempt_matches_native_binding_kernel_process_and_real_systemd_parser_without_writes(self):
        before = '\n'.join(self.store._get_connection().iterdump())
        identity = self.authority().require_current()
        self.assertEqual(identity, A.ExecutionIdentity(self.dispatch, self.platform_job, 'alice', self.job['id'], self.attempt_id,
            self.proc, 'a' * 32, self.environment['GPUQ_CONTROL_DIR'], (('GPU-0', 0), ('GPU-1', 1))))
        self.assertEqual(self.calls, [{'submit_key': self.dispatch, 'attempt_id': self.attempt_id}])
        self.assertEqual(len(self.commands), 1)
        self.assertEqual('\n'.join(self.store._get_connection().iterdump()), before)
        self.systemd.start.assert_not_called()

    def test_default_backend_uses_current_service_user_bus_not_training_environment(self):
        output = '\n'.join(f'{key}={value}' for key, value in self.properties.items())
        with (patch.dict(os.environ, {'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/unrelated', 'LD_PRELOAD': '/not-inherited'}),
              patch.object(A.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, '')) as run):
            identity = self.authority(systemd=None).require_current()
        self.assertEqual(identity.attempt_id, self.attempt_id)
        self.assertEqual(run.call_args.args[0][:4], ['/usr/bin/systemctl', '--user', 'show', '--no-pager'])
        self.assertFalse(run.call_args.kwargs['shell'])
        self.assertEqual(run.call_args.kwargs['timeout'], 5)
        environment = run.call_args.kwargs['env']
        self.assertEqual(environment['XDG_RUNTIME_DIR'], f'/run/user/{os.getuid()}')
        self.assertEqual(environment['DBUS_SESSION_BUS_ADDRESS'], f'unix:path=/run/user/{os.getuid()}/bus')
        self.assertEqual(environment['HOME'], A.pwd.getpwuid(os.getuid()).pw_dir)
        self.assertNotIn('LD_PRELOAD', environment)

    def test_binding_is_copied_and_wrong_native_identity_or_machine_cannot_authorize(self):
        binding = dict(self.binding)
        authority = self.authority(binding=binding)
        binding['accountId'] = 'changed-after-construction'
        self.assertEqual(authority.require_current().account_id, 'alice')
        for change in [{'nativeDigest': 'f' * 64}, {'dispatchId': str(uuid.uuid4())}, {'nativeOwner': 'other'},
                       {'nativeName': 'other'}, {'nativeMaxGpus': 1}, {'machineId': 'other'}, {'nativeDigest': None}]:
            with self.subTest(change=change), self.assertRaises(A.NativeExecutionError):
                self.authority(binding={**self.binding, **change}).require_current()

    def test_wrong_reserved_environment_never_opens_a_different_attempt_or_control_directory(self):
        for change in [{'GPUQ_JOB_ID': 'J' + 'f' * 12}, {'GPUQ_ATTEMPT_ID': 'A' + 'f' * 32},
                       {'GPUQ_CONTROL_DIR': '/unrelated'}, {'GPUQ_ASSIGNED_GPU_UUIDS': 'GPU-2,GPU-3'},
                       {'GPUQ_ASSIGNED_GPU_INDICES': '1,0'}, {'GPUQ_ASSIGNED_GPU_COUNT': '1'}, {'GPUQ_ATTEMPT_ID': ''}]:
            with self.subTest(change=change), self.assertRaises(A.NativeExecutionError):
                self.authority(environment={**self.environment, **change}).require_current()

    def test_noncurrent_states_native_jobs_missing_or_insufficient_grants_and_partial_leases_are_denied(self):
        base = self.store.get_execution_snapshot(self.dispatch, self.attempt_id)
        variants = [None, {}, {**base, 'latest_attempt_id': 'A' + 'f' * 32}, {**base, 'grant': None},
                    {**base, 'leases': base['leases'][:1]}, {**base, 'leases': [{'gpu_uuid': 'GPU-0', 'gpu_index': False}, base['leases'][1]]}]
        variants += [{**base, 'grant': {**base['grant'], **change}} for change in
                     [{'grant_id': 'different'}, {'max_gpu_count': 0}, {'max_gpu_count': 1}, {'max_gpu_count': 3}, {'revision': True}]]
        variants += [{**base, 'job': {**base['job'], **change}} for change in
                     [{'state': 'CANCELED'}, {'state': 'PENDING'}, {'allocation_authority': None}]]
        variants += [{**base, 'attempt': {**base['attempt'], **change}} for change in
                     [{'state': 'DRAINING'}, {'state': 'SAVE_REQUESTED'}, {'boot_id': 'previous-boot'},
                      {'main_pid': self.proc.pid + 1}, {'start_ticks': self.proc.start_ticks + 1},
                      {'gpu_uuids': ['GPU-0', 'GPU-0']}, {'gpu_indices': [False, 1]}]]
        for value in variants:
            native = SimpleNamespace(call=lambda *args: deepcopy(value))
            with self.subTest(value=value), self.assertRaises(A.NativeExecutionError):
                self.authority(native=native).require_current()

    def test_wrong_unit_invocation_main_pid_cgroup_or_finished_service_cannot_authorize(self):
        for change in [{'Description': 'not-gpuq'}, {'InvocationID': 'b' * 32}, {'MainPID': str(self.proc.pid + 1)},
                       {'ControlGroup': '/unrelated/' + self.unit}, {'Id': 'different.service'},
                       {'ActiveState': 'inactive'}, {'SubState': 'exited'}, {'LoadState': 'not-found'}]:
            original = dict(self.properties)
            with self.subTest(change=change):
                try:
                    self.properties.update(change)
                    with self.assertRaises((A.NativeExecutionError, BackendError)):
                        self.authority().require_current()
                finally:
                    self.properties = original

    def test_process_identity_change_during_systemd_read_is_not_accepted(self):
        observations = iter([self.proc, replace(self.proc, control_group='/moved')])
        with self.assertRaisesRegex(A.NativeExecutionError, 'changed during observation'):
            self.authority(process=lambda: next(observations)).require_current()

    def test_initial_start_uses_verified_live_unit_without_fabricating_persisted_process_metadata(self):
        self.store.update_attempt(self.attempt_id, state='STARTING', main_pid=None, start_ticks=None, invocation_id=None)
        self.store.update_job(self.job['id'], state='STARTING')
        self.assertEqual(self.authority().require_current().invocation_id, 'a' * 32)
        attempt = self.store.get_attempt(self.attempt_id)
        self.assertIsNone(attempt['invocation_id'])
        self.assertIsNone(attempt['main_pid'])
        self.assertIsNone(attempt['start_ticks'])

    def test_runner_authenticates_over_real_socket_before_systemd_start_receipt_is_committed(self):
        self.store.update_attempt(self.attempt_id, state='PLANNED', main_pid=None, start_ticks=None, invocation_id=None)
        self.store.update_job(self.job['id'], state='STARTING')
        job, attempt = self.store.get_job(self.job['id']), self.store.get_attempt(self.attempt_id)
        action = {'id': str(uuid.uuid4()), 'job_id': job['id'], 'attempt_id': attempt['id'],
                  'payload': self.coordinator._start_payload(job, attempt)}
        path = self.root / 'initial-runner.sock'
        server = _ThreadingUnixServer(path, self.coordinator.handle_api, os.getuid(), 262144)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        observed = []
        authority = self.authority(native=Client(path, timeout=3))
        def starting(**kwargs):
            pending = self.store.get_attempt(self.attempt_id)
            self.assertEqual(pending['state'], 'STARTING')
            self.assertIsNone(pending['invocation_id'])
            self.assertIsNone(pending['main_pid'])
            self.assertIsNone(pending['start_ticks'])
            self.assertEqual(self.store.get_job(job['id'])['state'], 'STARTING')
            self.assertEqual(kwargs['unit_name'], self.unit)
            observed.append(authority.require_current())
            return self.backend.status(unit_name=self.unit, description_token=attempt['unit_token'])
        self.systemd.status.side_effect = UnitNotFoundError('unit not created yet')
        self.systemd.start.side_effect = starting
        try:
            with self.assertRaisesRegex(A.NativeExecutionError, 'not current and runnable'):
                authority.require_current()
            with (patch.object(self.coordinator, '_fresh_devices_for_start'),
                  patch('gpuq.coordinator.process_start_ticks', return_value=self.proc.start_ticks)):
                # The native action really holds this lock during start. The
                # separate socket handler must not wait for the action to end.
                with self.coordinator._lock:
                    self.coordinator._execute_start(action)
            self.assertEqual(len(observed), 1)
            self.assertEqual(self.store.get_attempt(self.attempt_id)['state'], 'RUNNING')
            self.assertEqual(self.store.get_job(job['id'])['state'], 'RUNNING')
            self.assertEqual(authority.require_current(), observed[0])
            self.assertEqual(len(self.store.list_attempts(job_id=job['id'])), 1)
            self.assertEqual(len(self.store.list_leases(job_id=job['id'])), 2)
        finally:
            server.shutdown(); server.server_close(); thread.join(5)
        self.assertFalse(thread.is_alive())

    def test_actual_linux_process_observation_is_not_a_managed_unit_proof(self):
        if not Path('/proc/self/stat').exists():
            self.skipTest('Linux procfs is required')
        observed = A.current_process()
        self.assertEqual(observed.pid, os.getpid())
        self.assertEqual(observed.start_ticks, A.process_start_ticks(os.getpid()))
        self.assertEqual(observed.boot_id, A.read_boot_id())
        with self.assertRaises(A.NativeExecutionError):
            self.authority(process=A.current_process).require_current()

    def test_real_native_socket_can_supply_snapshot_but_systemd_identity_is_still_required(self):
        path = self.root / 'runner-identity.sock'
        server = _ThreadingUnixServer(path, self.coordinator.handle_api, os.getuid(), 262144)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            authority = self.authority(native=Client(path, timeout=3))
            self.assertEqual(authority.require_current().attempt_id, self.attempt_id)
            self.properties['MainPID'] = '99999'
            with self.assertRaises(A.NativeExecutionError):
                authority.require_current()
        finally:
            server.shutdown(); server.server_close(); thread.join(5)
        self.assertFalse(thread.is_alive())

    def test_runtime_uses_bound_task_and_rechecks_authority_around_real_input_handles(self):
        fixture, authority = self.inputs_fixture()
        project, data = deepcopy(fixture.reference), deepcopy(fixture.inputs)
        runtime = R.TrainingRuntime(authority=authority, inputs=fixture.runtime, project=project, data=data)
        project['release'] = 'f' * 64
        data[0]['source']['sourceId'] = 'changed'
        with runtime.open() as resources:
            self.assertEqual(resources['execution'].job_id, fixture.job)
            self.assertEqual(resources['execution'].account_id, fixture.user)
            self.assertEqual(resources['project']['meta']['release'], fixture.version)
            handles = [*resources['descriptors'].values(), *(fd for fd, _ in resources['dataMounts'])]
        self.assertEqual(len(self.calls), 2)
        fixture.assert_closed(handles)
        self.assertEqual(len(fixture.cache._leases('images', fixture.source['version'])), 1)

    def test_initial_denial_makes_no_input_call_and_late_cancellation_closes_all_handles_without_releasing(self):
        fixture, authority = self.inputs_fixture()
        denied = SimpleNamespace(require_current=Mock(side_effect=A.NativeExecutionError('denied')))
        resources = SimpleNamespace(open=Mock(side_effect=AssertionError('must not open')))
        runtime = R.TrainingRuntime(authority=denied, inputs=resources, project=fixture.reference, data=fixture.inputs)
        with self.assertRaises(A.NativeExecutionError):
            with runtime.open():
                self.fail('unauthorized payload')
        resources.open.assert_not_called()
        handles = []
        @contextmanager
        def revoke_after_open(**kwargs):
            with fixture.runtime.open(**kwargs) as opened:
                handles.extend([*opened['descriptors'].values(), *(fd for fd, _ in opened['dataMounts'])])
                self.store.update_job(self.job['id'], state='CANCELED')
                yield opened
        runtime = R.TrainingRuntime(authority=authority, inputs=SimpleNamespace(open=revoke_after_open), project=fixture.reference, data=fixture.inputs)
        with self.assertRaises(A.NativeExecutionError):
            with runtime.open():
                self.fail('canceled attempt reached payload')
        self.assertTrue(handles)
        fixture.assert_closed(handles)
        self.assertEqual(len(fixture.cache._leases('images', fixture.source['version'])), 1)
        self.assertTrue((fixture.store.path / '.run-claims' / (fixture.job + '.json')).exists())

    def test_input_scope_rejects_changed_execution_identity_but_not_harmless_grant_revision(self):
        fixture, authority = self.inputs_fixture()
        initial = authority.require_current()
        for next_identity, allowed in [(replace(initial, invocation_id='b' * 32), False), (initial, True)]:
            source = SimpleNamespace(require_current=Mock(side_effect=[initial, next_identity]))
            runtime = R.TrainingRuntime(authority=source, inputs=fixture.runtime, project=fixture.reference, data=fixture.inputs)
            with self.subTest(allowed=allowed):
                if allowed:
                    with runtime.open() as result:
                        self.assertEqual(result['execution'], initial)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                        with runtime.open():
                            self.fail('replacement invocation accepted')
        baseline = self.native.call
        def newer_grant(*args):
            result = baseline(*args)
            result['grant']['revision'] += 1
            return result
        self.assertEqual(self.authority(native=SimpleNamespace(call=newer_grant),
            binding={**self.binding, 'jobId': fixture.job, 'accountId': fixture.user}).require_current(), initial)


if __name__ == '__main__':
    unittest.main()
