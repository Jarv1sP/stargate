"""Common P0 runner: trusted orchestration only, no bwrap/systemd/GPU/network."""
import ast
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
S = load('common_p0_runner', 'sandbox-runner-common-p0.py')
P = load('common_p0_allocation', 'scheduling-policy.py')
R = load('common_p0_memory', 'job-resources.py')
D = load('common_p0_diagnostics', 'job-diagnostics.py')
JID = '11111111-1111-4111-8111-111111111111'
CAPTURE = 'a' * 32


class CommonRunner(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def orchestrate(self, terminal=False, available=True, missing=False, broken=False, indices='0,1', devices=None, fragmented_info=False, invalid_info=False):
        job = {'id': JID, 'userId': 'demo-user-1', 'username': 'demo', 'cards': 2, 'argv': ['python', 'train.py']}
        if terminal: del job['id']; job['cards'] = 0
        spec_dir = self.root / ('terminals' if terminal else 'jobs'); spec_dir.mkdir()
        spec_file = spec_dir / (JID + '.json'); spec_file.write_text(json.dumps(job))
        config={'root':str(self.root),'conda':'/opt/conda'}
        if terminal:config.update(controlRoot=str(self.root/'not-for-terminals'),gpuqArchive=str(self.root/'must-not-mount-sdk.pyz'),trainingControlProtocol=1)
        (self.root / 'node-config.json').write_text(json.dumps(config))
        runtime = self.root / 'diagnostics' / JID / CAPTURE / 'runtime'
        if not missing: (self.root / 'job-diagnostics.py').touch()
        def start(*args):
            self.assertEqual(args[1], job); runtime.mkdir(parents=True)
            return {'captureId': CAPTURE, 'runtimePath': str(runtime), 'available': available}
        diagnostic = SimpleNamespace(start_capture=Mock(side_effect=start), finish_capture=Mock())
        guard = SimpleNamespace(check=Mock())
        mapping = SimpleNamespace(device_paths=Mock(return_value=devices or ['/dev/nvidia3', '/dev/nvidia2']))
        if broken: diagnostic.start_capture.side_effect = RuntimeError('observer unavailable')
        captured, properties, kept, memfds, writers, stopped = [], [], [], [], [], []
        path_exists, path_read = Path.exists, Path.read_text
        group = '/user.slice/' + ('amax-term-test.service' if terminal else 'gpuq-test.service')
        def exists(path):
            return str(path).startswith('/dev/nvidia') or str(path) == '/run/systemd/resolve/resolv.conf' or path_exists(path)
        def read(path, *args, **kwargs):
            if str(path) == '/proc/self/cgroup': return '0::' + group + '\n'
            if str(path) == '/run/systemd/resolve/resolv.conf': return 'nameserver 192.0.2.53\n'
            if str(path).startswith('/sys/fs/cgroup'): raise AssertionError('Common runner must not require cgroup budget files')
            return path_read(path, *args, **kwargs)
        def memfd(name):
            memfds.append(name)
            return os.open(self.root / ('memfd-' + name), os.O_CREAT | os.O_RDWR, 0o600)
        def spawn(command, **kwargs):
            captured.append((command, kwargs))
            if command[0] == '/usr/bin/bwrap':
                info = int(command[command.index('--info-fd') + 1])
                block = int(command[command.index('--block-fd') + 1]); kept.append(os.dup(block))
                if fragmented_info:
                    writer=os.dup(info)
                    os.write(writer,b'{\n  "child-pid": 12345,\n  "mnt-namespace": 4026')
                    def finish_info():
                        try:time.sleep(.03);os.write(writer,b'5355\n}\n')
                        except BrokenPipeError:pass
                        finally:os.close(writer)
                    thread=threading.Thread(target=finish_info);writers.append(thread);thread.start()
                else:os.write(info, json.dumps({'child-pid': 0 if invalid_info else 12345}).encode())
                if '/run/gpuq/runtime' in command:
                    descriptor = int(command[command.index('/run/gpuq/runtime') - 1])
                    self.assertEqual(os.fstat(descriptor).st_ino, runtime.stat().st_ino)
                    self.assertIn(descriptor, kwargs['pass_fds'])
            else: os.write(int(command[command.index('--ready-fd') + 1]), b'1')
            def stop():
                gate=Path(command[command.index('/run/.ready')-1])
                self.assertEqual(gate.read_bytes(),b'0','failed admission never opens or deletes readiness gate before stop')
                stopped.append(True)
            return SimpleNamespace(wait=lambda *args, **kwargs: 42, poll=lambda: None if invalid_info else 42,kill=stop)
        try:
            with patch.object(S, 'HERE', self.root), patch.object(S, 'local_module', side_effect=lambda name, filename: guard if filename=='platform-root-guard.py' else P if filename=='scheduling-policy.py' else R if filename=='job-resources.py' else mapping if filename=='gpu-devices.py' else diagnostic) as imported, \
                    patch.object(S, 'start_job_capture', wraps=S.start_job_capture) as capture, \
                    patch.object(S, 'project_runtime', return_value=None), \
                    patch.object(S.sys, 'argv', ['sandbox-runner.py', JID] + (['terminal'] if terminal else [])), \
                    patch.dict(S.os.environ, {'GPUQ_ASSIGNED_GPU_INDICES': indices, 'GPUQ_ASSIGNED_GPU_UUIDS': 'GPU-a,GPU-b'}), \
                    patch.object(Path, 'exists', exists), patch.object(Path, 'read_text', read), \
                    patch.object(S.os, 'memfd_create', side_effect=memfd, create=True), \
                    patch.object(S.subprocess, 'check_output', return_value='24576\n24576\n') as gpu, \
                    patch.object(S.subprocess, 'run', side_effect=lambda cmd, **kwargs: properties.append(cmd)), \
                    patch.object(S.subprocess, 'Popen', side_effect=spawn), contextlib.redirect_stderr(io.StringIO()):
                if invalid_info:
                    with self.assertRaisesRegex(ValueError,'child PID'):S.main()
                    self.assertEqual(stopped,[True]);self.assertEqual(len(captured),1,'invalid info never starts networking')
                    self.assertFalse(list(self.root.glob('.gate-*')))
                    diagnostic.finish_capture.assert_not_called()
                    return
                self.assertEqual(S.main(), 42)
                guard.check.assert_called_once_with(self.root)
                if terminal:
                    capture.assert_not_called(); diagnostic.start_capture.assert_not_called()
                    diagnostic.finish_capture.assert_not_called()
                    self.assertEqual([call.args for call in imported.call_args_list],[('gpuq_platform_root_guard','platform-root-guard.py'),('gpuq_job_resources','job-resources.py')]); gpu.assert_not_called()
                elif not missing and not broken:
                    self.assertEqual([call.args for call in imported.call_args_list],[('gpuq_platform_root_guard','platform-root-guard.py'),('gpuq_allocation','scheduling-policy.py'),('gpuq_gpu_devices','gpu-devices.py'),('gpuq_job_resources','job-resources.py'),('gpuq_job_diagnostics','job-diagnostics.py')])
                    diagnostic.finish_capture.assert_called_once_with(self.root, job, CAPTURE, 42)
                else: diagnostic.finish_capture.assert_not_called()
                if not terminal:
                    mapping.device_paths.assert_called_once_with(['GPU-a','GPU-b'])
                    self.assertEqual(gpu.call_args.args[0][2], 'GPU-a,GPU-b')
        finally:
            for thread in writers:thread.join(timeout=1)
            for fd in kept: os.close(fd)
        self.assertEqual(json.loads(spec_file.read_text()), job)
        self.assertEqual(memfds, ['resolv', 'passwd', 'hosts'])
        args, options = captured[0]
        self.assertEqual(args[-2:], job['argv'])
        self.assertNotIn('/sys/fs/cgroup', args); self.assertIn('/sys', args)
        self.assertEqual(len(properties), 1)
        env = {args[i + 1]: args[i + 2] for i, value in enumerate(args) if value == '--setenv'}
        return args, env, properties[0]

    def test_terminal_is_head_style_without_diagnostic_or_resource_hooks(self):
        args, env, props = self.orchestrate(terminal=True)
        self.assertIn('MemoryMax='+str(8*1024**3), props); self.assertIn('CPUQuota=200%', props)
        self.assertIn('TasksMax=2048', props); self.assertNotIn('--new-session', args)
        self.assertEqual(env['PATH'], '/opt/gpuq/bin:/opt/conda/bin:/usr/bin:/bin')
        self.assertFalse(any(key.startswith(('RAY_', 'GPUQ_CPU', 'GPUQ_MEMORY')) for key in env))
        self.assertNotIn('/run/gpuq/runtime', args)
        self.assertNotIn('/run/gpuq/control',args);self.assertNotIn('/opt/gpuq/sdk.pyz',args)
        self.assertNotIn('GPUQ_CONTROL_DIR',env);self.assertNotIn('PYTHONPATH',env)

    def test_fragmented_bwrap_information_waits_for_complete_json(self):
        self.orchestrate(fragmented_info=True)

    def test_invalid_information_kills_child_with_gate_closed_before_unlinking(self):
        self.orchestrate(invalid_info=True)

    def test_training_records_exit_and_binds_only_managed_runtime_without_budget_files(self):
        args, env, props = self.orchestrate()
        self.assertIn('MemoryMax='+str(64*1024**3), props); self.assertIn('CPUQuota=800%', props)
        self.assertIn('TasksMax=2048', props); self.assertIn('--new-session', args)
        self.assertEqual(env['PATH'], '/opt/gpuq/bin:/opt/conda/bin:/usr/bin:/bin')
        self.assertEqual(env['RAY_TMPDIR'], '/run/gpuq/runtime')
        self.assertEqual(env['GPUQ_RAY_TEMP_DIR'], '/run/gpuq/runtime/ray')
        self.assertEqual(env['RAY_object_spilling_directory'], '/tmp/gpuq-ray-spill')
        self.assertNotIn('GPUQ_CPU_LIMIT', env)

    def test_inventory_indices_are_not_used_as_device_minors(self):
        args, _, _ = self.orchestrate(indices='2,0', devices=['/dev/nvidia1', '/dev/nvidia3'])
        bindings = [args[i + 1:i + 3] for i, value in enumerate(args) if value == '--dev-bind']
        self.assertIn(['/dev/nvidia1', '/dev/nvidia1'], bindings)
        self.assertIn(['/dev/nvidia3', '/dev/nvidia3'], bindings)
        self.assertNotIn(['/dev/nvidia2', '/dev/nvidia2'], bindings)
        self.assertNotIn(['/dev/nvidia0', '/dev/nvidia0'], bindings)

    def test_observer_unavailable_retains_owned_runtime_and_finish_receipt(self):
        args, _, _ = self.orchestrate(available=False)
        self.assertIn('/run/gpuq/runtime', args)

    def test_missing_helper_falls_back_without_changing_command_exit(self):
        args, env, _ = self.orchestrate(missing=True)
        self.assertNotIn('/run/gpuq/runtime', args); self.assertNotIn('RAY_TMPDIR', env)

    def test_broken_observer_falls_back_without_changing_command_exit(self):
        args, env, _ = self.orchestrate(broken=True)
        self.assertNotIn('/run/gpuq/runtime', args); self.assertNotIn('RAY_TMPDIR', env)

    def test_old_job_no_capture_is_unavailable_with_unknown_scheduler_not_success(self):
        result = D.bundle(self.root, {'id': JID, 'userId': 'demo-user-1'}, {})
        self.assertEqual(result['state'], 'UNAVAILABLE'); self.assertEqual(result['schedulerState'], 'UNKNOWN')
        self.assertEqual(result['captures'], []); self.assertFalse((self.root / 'diagnostics').exists())

    def test_ast_has_no_new_cpu_resource_or_wrapper_dependency(self):
        source = (DEPLOY / 'sandbox-runner-common-p0.py').read_text(); ast.parse(source)
        self.assertIn('resources.verify_memory_pool(group,cfg)', source)
        self.assertIn('resources.requested_limits', source)
        for forbidden in ('read_budget', 'cpu-delegation', "'gpuq-ray'", 'cgroupfd', 'resourcefd', 'GPUQ_RESOURCE'):
            self.assertNotIn(forbidden, source)
        self.assertIn("if terminal else start_job_capture", source)
        self.assertIn("if capture_module is not None:finish_job_capture", source)
        self.assertIn("'--system-site-packages'", source.replace('"', "'"))


if __name__ == '__main__': unittest.main()
