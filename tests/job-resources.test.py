"""Isolated budget/Ray adapter tests: no Ray, systemd, GPU or network required."""
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


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / filename)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


R = module('resource_tests', 'job-resources.py')
S = module('resource_runner_tests', 'sandbox-runner.py')
P = module('resource_allocation_tests', 'scheduling-policy.py')
JOB = {'id': '11111111-1111-4111-8111-111111111111', 'cards': 8}
UUIDS = ['GPU-' + str(n) for n in range(8)]


class Resources(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.group = '/user.slice/gpuq-test.service'
        self.leaf = self.root / self.group.lstrip('/')
        self.leaf.mkdir(parents=True)
        self.write_limits(self.leaf, '3200000 100000', str(256 * R.GIB), '2048')

    def tearDown(self):
        self.temp.cleanup()

    def write_limits(self, path, cpu, memory, pids):
        for name, value in [('cpu.max', cpu), ('memory.max', memory), ('pids.max', pids)]:
            (path / name).write_text(value + '\n')

    def budget(self, **kwargs):
        return R.read_budget(JOB, self.group, UUIDS, root=self.root,
                             affinity_count=128, physical_memory=512 * R.GIB, **kwargs)

    def test_eight_cards_are_32_cpu_256_gib_2048_tasks_not_host_capacity(self):
        budget = self.budget()
        self.assertEqual(budget['cpuLimit'], 32)
        self.assertEqual(budget['memoryLimitBytes'], 256 * R.GIB)
        self.assertEqual(budget['pidsLimit'], 2048)
        self.assertEqual(budget['gpuCount'], 8)
        self.assertEqual(budget['gpuUuids'], UUIDS)
        self.assertEqual(budget['cgroupPath'], '/sys/fs/cgroup')
        self.assertNotIn(str(self.root), json.dumps(budget))

    def test_ancestor_caps_affinity_and_physical_memory_are_conservative(self):
        self.write_limits(self.leaf.parent, '1200000 100000', str(128 * R.GIB), '1024')
        self.write_limits(self.root, '600000 100000', str(64 * R.GIB), '800')
        budget = self.budget()
        self.assertEqual((budget['cpuLimit'], budget['memoryLimitBytes'], budget['pidsLimit']),
                         (6, 64 * R.GIB, 800))
        budget = R.read_budget(JOB, self.group, UUIDS, root=self.root,
                               affinity_count=4, physical_memory=32 * R.GIB)
        self.assertEqual((budget['cpuLimit'], budget['memoryLimitBytes']), (4, 32 * R.GIB))

    def test_missing_unlimited_or_excessive_leaf_limits_fail_closed(self):
        for field, values in [('cpu.max', ['max 100000', '6400000 100000', '0 100000', '1 0', 'broken']),
                              ('memory.max', ['max', str(512 * R.GIB), '-1', 'bad']),
                              ('pids.max', ['max', '2049', '0', 'NaN'])]:
            original = (self.leaf / field).read_text()
            for value in values:
                with self.subTest(field=field, value=value):
                    (self.leaf / field).write_text(value)
                    with self.assertRaises(ValueError):
                        self.budget()
            (self.leaf / field).unlink()
            with self.assertRaisesRegex(ValueError, 'Missing enforced'):
                self.budget()
            (self.leaf / field).write_text(original)

    def test_cgroup_paths_cannot_escape_or_follow_symlinks(self):
        for value in ('../outside', '/user.slice/../outside', '//user.slice', '/bad\x00'):
            with self.assertRaises(ValueError):
                R.cgroup_path(value, self.root)
        (self.root / 'alias').symlink_to(self.leaf.parent, target_is_directory=True)
        with self.assertRaises(ValueError):
            R.cgroup_path('/alias/gpuq-test.service', self.root)

    def test_allocations_and_terminal_budget(self):
        with self.assertRaises(ValueError):
            R.read_budget(JOB, self.group, UUIDS[:-1], root=self.root)
        with self.assertRaises(ValueError):
            R.read_budget(JOB, self.group, [UUIDS[0]] * 8, root=self.root)
        for cards in (None, 0, True, '8', 65):
            with self.assertRaises(ValueError):
                R.requested_limits({'cards': cards})
        self.write_limits(self.leaf, '200000 100000', str(8 * R.GIB), '2048')
        budget = R.read_budget({'id': JOB['id']}, self.group, [], terminal=True,
                               root=self.root, affinity_count=128, physical_memory=512 * R.GIB)
        self.assertEqual((budget['cpuLimit'], budget['memoryLimitBytes'], budget['gpuCount']),
                         (2, 8 * R.GIB, 0))

    def test_metadata_environment_is_complete_and_generic_not_ray_thread_tuning(self):
        env = R.resource_environment(self.budget())
        self.assertEqual(env, {'GPUQ_RESOURCES_FILE': '/run/gpuq/resources.json',
                              'GPUQ_CPU_LIMIT': '32', 'GPUQ_MEMORY_LIMIT_BYTES': str(256 * R.GIB),
                              'GPUQ_PIDS_LIMIT': '2048', 'GPUQ_GPU_COUNT': '8'})
        self.assertFalse(any(key.startswith('RAY_') for key in env))

    def test_ray_kwargs_and_start_include_exact_budget_with_memory_headroom(self):
        budget = self.budget()
        values = R.ray_init_kwargs(budget)
        self.assertEqual((values['num_cpus'], values['num_gpus']), (32, 8))
        self.assertIs(type(values['num_cpus']), int)
        self.assertEqual(values['object_store_memory'], 8 * R.GIB)
        self.assertEqual(values['object_spilling_directory'], '/tmp/gpuq-ray-spill')
        self.assertLessEqual(values['_memory'] + values['object_store_memory'],
                             budget['memoryLimitBytes'] - budget['memoryLimitBytes'] // 10)
        command = R.ray_start_command(budget, ['--block'], python='/opt/project-env/bin/python',
                                       temp_dir='/run/gpuq/runtime/ray')
        self.assertEqual(command[:5], ['/opt/project-env/bin/python', '-m', 'ray.scripts.scripts', 'start', '--head'])
        for value in ('--num-cpus=32', '--num-gpus=8', '--temp-dir=/run/gpuq/runtime/ray',
                      '--object-spilling-directory=/tmp/gpuq-ray-spill',
                      '--memory=' + str(values['_memory']), '--object-store-memory=' + str(8 * R.GIB)):
            self.assertIn(value, command)
        for arguments in (['--num-cpus=128'], ['--num', '128'], ['--address=auto'], ['--system-config={}'], ['--temp-dir=/tmp']):
            with self.assertRaises(ValueError):
                R.ray_start_command(budget, arguments)

    def test_ray_cpu_budget_is_integer_and_fractional_quota_is_never_rounded_up(self):
        for quota, logical in ((32.0, 32), (32.75, 32), (1.25, 1), (1, 1)):
            budget = {**self.budget(), 'cpuLimit': quota}
            with self.subTest(quota=quota):
                values = R.ray_init_kwargs(budget)
                self.assertIs(type(values['num_cpus']), int)
                self.assertEqual(values['num_cpus'], logical)
                self.assertLessEqual(values['num_cpus'], quota)
                self.assertIn('--num-cpus=' + str(logical), R.ray_start_command(budget, []))
                self.assertEqual(budget['cpuLimit'], quota)
        for quota in (.1, .99):
            budget = {**self.budget(), 'cpuLimit': quota}
            with self.subTest(quota=quota), self.assertRaisesRegex(ValueError, 'one whole CPU'):
                R.ray_init_kwargs(budget)
            with self.assertRaisesRegex(ValueError, 'one whole CPU'):
                R.ray_start_command(budget, [])

    def test_ray_profile_is_opt_in_keeps_gpu_visibility_and_limits_worker_fanout(self):
        original = {'PATH': '/opt/project-env/bin', 'CUDA_VISIBLE_DEVICES': '7',
                    'RAY_USE_MULTIPROCESSING_CPU_COUNT': '1', 'RAY_ADDRESS': 'outside:1234',
                    'RAY_OVERRIDE_RESOURCES': '{"CPU":128}', 'MKL_NUM_THREADS': '128',
                    'GPUQ_RAY_TEMP_DIR': '/run/gpuq/runtime/ray', 'RAY_TMPDIR': '/tmp/stale',
                    'RAY_object_spilling_directory': '/run/gpuq/runtime/large-spill'}
        result = R.ray_environment(self.budget(), original)
        self.assertEqual(original['MKL_NUM_THREADS'], '128')
        self.assertEqual(result['CUDA_VISIBLE_DEVICES'], '7')
        self.assertEqual(result['PATH'], original['PATH'])
        self.assertEqual(result['MKL_NUM_THREADS'], '1')
        self.assertEqual(result['RAY_worker_num_grpc_internal_threads'], '2')
        self.assertEqual(result['RAY_prestart_worker_first_driver'], 'false')
        self.assertEqual(result['RAY_TMPDIR'], '/run/gpuq/runtime')
        self.assertEqual(result['RAY_object_spilling_directory'], '/tmp/gpuq-ray-spill')
        self.assertNotIn('RAY_ADDRESS', result)
        self.assertNotIn('RAY_USE_MULTIPROCESSING_CPU_COUNT', result)
        self.assertNotIn('RAY_OVERRIDE_RESOURCES', result)

    def test_cli_json_and_exec_without_importing_ray(self):
        for action in ('resources', 'init-kwargs'):
            output = io.StringIO()
            with patch.object(R, 'load_budget', return_value=self.budget()), contextlib.redirect_stdout(output):
                self.assertEqual(R.main([action]), 0)
            data = json.loads(output.getvalue())
            self.assertEqual(data['gpuCount' if action == 'resources' else 'num_gpus'], 8)
        with patch.object(R, 'load_budget', return_value=self.budget()), patch.object(R.os, 'execvpe') as execute:
            R.main(['exec', 'python', 'train.py', '--flag'])
        self.assertEqual(execute.call_args.args[:2], ('python', ['python', 'train.py', '--flag']))
        self.assertEqual(execute.call_args.args[2]['OPENBLAS_NUM_THREADS'], '1')

    def test_invalid_metadata_and_tiny_ray_memory_fail(self):
        for update in ({'schemaVersion': 2}, {'cpuLimit': float('inf')}, {'cpuLimit': True},
                       {'memoryLimitBytes': '256G'}, {'pidsLimit': 0}, {'gpuCount': -1}):
            with self.assertRaises(ValueError):
                R.validate_budget({**self.budget(), **update})
        with self.assertRaises(ValueError):
            R.ray_init_kwargs({**self.budget(), 'memoryLimitBytes': 100 * 1024 ** 2})

    def test_diagnostic_hook_mounts_only_valid_attempt_runtime_and_is_best_effort(self):
        identifier = 'a' * 32
        runtime = self.root / 'diagnostics' / JOB['id'] / identifier / 'runtime'
        runtime.mkdir(parents=True)
        capture = {'available': True, 'captureId': identifier, 'runtimePath': str(runtime)}
        diagnostic = SimpleNamespace(start_capture=lambda *args: capture)
        with patch.object(S, 'HERE', self.root), patch.object(S, 'local_module', return_value=diagnostic):
            (self.root / 'job-diagnostics.py').touch()
            loaded, found, descriptor = S.start_job_capture(self.root, JOB, 'gpuq-test.service', self.group, {}, [], [])
            self.assertIs(loaded, diagnostic)
            self.assertEqual(found, identifier)
            self.assertEqual(os.fstat(descriptor).st_ino, runtime.stat().st_ino)
            os.close(descriptor)
            capture['available'] = False
            with contextlib.redirect_stderr(io.StringIO()):
                loaded, found, descriptor = S.start_job_capture(self.root, JOB, '', self.group, {}, [], [])
            self.assertIs(loaded, diagnostic)
            os.close(descriptor)
            capture['runtimePath'] = str(self.root)
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(S.start_job_capture(self.root, JOB, '', self.group, {}, [], []), (None, None, None))
        broken = SimpleNamespace(finish_capture=lambda *args: (_ for _ in ()).throw(RuntimeError('unavailable')))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(S.finish_job_capture(broken, self.root, JOB, identifier, 42))

    def runner_command(self, terminal=False, managed_runtime=False, data_workspace=False, training_control=False, allocated_cards=8, fragmented_info=False):
        """Execute trusted runner orchestration with fake children, never bwrap/GPU."""
        job = {**JOB, 'userId': 'demo-user-1', 'username': 'demo', 'argv': ['python', 'train.py']}
        if data_workspace:job['dataWorkspace']=True
        if allocated_cards!=8:
            job['elastic']={'minCards':1,'globalBatch':256,'microBatch':8,'autoExpand':False}
            self.write_limits(self.leaf,str(allocated_cards*400000)+' 100000',str(allocated_cards*32*R.GIB),'2048')
        if terminal:
            del job['id']
            job['cards'] = 0
            self.group = '/user.slice/amax-term-test.service'
            self.leaf = self.leaf.rename(self.leaf.with_name('amax-term-test.service'))
            self.write_limits(self.leaf, '200000 100000', str(8 * R.GIB), '2048')
        spec_dir = self.root / ('terminals' if terminal else 'jobs')
        spec_dir.mkdir()
        spec_file = spec_dir / (JOB['id'] + '.json')
        spec_file.write_text(json.dumps(job))
        config={'root':str(self.root),'conda':'/opt/conda'}
        if training_control:config.update(controlRoot=str(self.root/'not-for-terminals'),gpuqArchive=str(self.root/'must-not-mount-sdk.pyz'),trainingControlProtocol=1)
        (self.root / 'node-config.json').write_text(json.dumps(config))
        captured, properties, kept, writers = [], [], [], []
        path_exists, path_read = Path.exists, Path.read_text
        def exists(path):
            return str(path).startswith('/dev/nvidia') or str(path) == '/run/systemd/resolve/resolv.conf' or path_exists(path)
        def read(path, *args, **kwargs):
            if str(path) == '/proc/self/cgroup':
                return '0::' + self.group + '\n'
            if str(path) == '/run/systemd/resolve/resolv.conf':
                return 'nameserver 192.0.2.53\n'
            return path_read(path, *args, **kwargs)
        def memfd(name):
            return os.open(self.root / ('memfd-' + name), os.O_CREAT | os.O_RDWR, 0o600)
        def spawn(command, **kwargs):
            captured.append((command, kwargs))
            if command[0] == '/usr/bin/bwrap':
                info = int(command[command.index('--info-fd') + 1])
                block = int(command[command.index('--block-fd') + 1])
                kept.append(os.dup(block))
                if fragmented_info:
                    writer=os.dup(info)
                    os.write(writer,b'{\n  "child-pid": 12345,\n  "mnt-namespace": 4026')
                    def finish_info():
                        try:time.sleep(.03);os.write(writer,b'5355\n}\n')
                        except BrokenPipeError:pass
                        finally:os.close(writer)
                    thread=threading.Thread(target=finish_info);writers.append(thread);thread.start()
                else:os.write(info, json.dumps({'child-pid': 12345}).encode())
            else:
                ready = int(command[command.index('--ready-fd') + 1])
                os.write(ready, b'1')
            return SimpleNamespace(wait=lambda *args, **kwargs: 42, poll=lambda: 42)
        def read_budget(spec, group, uuids, terminal, config=None):
            return R.read_budget(spec, group, uuids, terminal, root=self.root,
                                 affinity_count=128, physical_memory=512 * R.GIB, config=config)
        resource = SimpleNamespace(requested_limits=R.requested_limits, read_budget=read_budget,
                                   verify_memory_pool=lambda group, config: R.verify_memory_pool(group, config, self.root),
                                   cgroup_path=lambda group: self.leaf, resource_environment=R.resource_environment,
                                   RESOURCE_FILE=R.RESOURCE_FILE, RAY_SPILL_DIR=R.RAY_SPILL_DIR)
        devices = ['/dev/nvidia' + str(i) for i in [3,2,1,0,7,6,5,4][:allocated_cards]]
        mapping = SimpleNamespace(device_paths=Mock(return_value=devices))
        guard = SimpleNamespace(check=Mock())
        runtime = self.root / 'diagnostic-runtime'; runtime.mkdir()
        runtimefd = os.open(runtime, os.O_RDONLY | os.O_DIRECTORY) if managed_runtime else None
        data = self.root/'personal-data';data.mkdir()
        datafd = os.open(data, os.O_RDONLY | os.O_DIRECTORY) if data_workspace else None
        datalock = os.open(self.root/'personal-data.lock', os.O_CREAT | os.O_RDWR, 0o600) if data_workspace else None
        self.data_descriptors = (datafd, datalock)
        try:
            with patch.object(S, 'HERE', self.root), patch.object(S, 'local_module', side_effect=lambda name, filename: guard if filename=='platform-root-guard.py' else P if filename=='scheduling-policy.py' else mapping if filename=='gpu-devices.py' else resource), \
                    patch.object(S, 'start_job_capture', return_value=(None, None, runtimefd)), \
                    patch.object(S, 'project_runtime', return_value=None), \
                    patch.object(S, 'open_data_workspace', return_value=(datafd,datalock)), \
                    patch.object(S.sys, 'argv', ['sandbox-runner.py', JOB['id']] + (['terminal'] if terminal else [])), \
                    patch.dict(S.os.environ, {'GPUQ_ASSIGNED_GPU_INDICES': ','.join(map(str, range(allocated_cards))),
                                              'GPUQ_ASSIGNED_GPU_UUIDS': ','.join(UUIDS[:allocated_cards])}), \
                    patch.object(Path, 'exists', exists), patch.object(Path, 'read_text', read), \
                    patch.object(S.os, 'memfd_create', side_effect=memfd, create=True), \
                    patch.object(S.subprocess, 'check_output', return_value='24576\n' * allocated_cards) as gpu_check, \
                    patch.object(S.subprocess, 'run', side_effect=lambda command, **kwargs: properties.append(command)), \
                    patch.object(S.subprocess, 'Popen', side_effect=spawn):
                self.assertEqual(S.main(), 42)
                guard.check.assert_called_once_with(self.root)
                if terminal: gpu_check.assert_not_called()
                else:
                    mapping.device_paths.assert_called_once_with(UUIDS[:allocated_cards])
                    self.assertEqual(gpu_check.call_args.args[0][2], ','.join(UUIDS[:allocated_cards]))
        finally:
            for thread in writers:thread.join(timeout=1)
            for descriptor in kept:
                os.close(descriptor)
        self.assertEqual(json.loads(spec_file.read_text()), job)
        return captured[0], properties

    def test_fragmented_bwrap_information_waits_for_complete_json(self):
        self.runner_command(fragmented_info=True)

    def test_runner_builds_readonly_leaf_cgroup_and_metadata_without_changing_user_command(self):
        (args, options), properties = self.runner_command()

        self.assertEqual(args[-2:], ['python', 'train.py'])
        mount = args.index('/sys/fs/cgroup')
        self.assertEqual(args[mount - 2], '--ro-bind-fd')
        self.assertIn(int(args[mount - 1]), options['pass_fds'])
        metadata = args.index('/run/gpuq/resources.json')
        self.assertEqual(args[metadata - 2], '--ro-bind-data')
        self.assertIn('--clearenv', args)
        self.assertIn('TasksMax=2048', properties[0])
        self.assertIn('CPUQuota=3200%', properties[0])
        self.assertIn('MemoryMax=' + str(256 * R.GIB), properties[0])
        env = {args[i + 1]: args[i + 2] for i, value in enumerate(args) if value == '--setenv'}
        self.assertEqual(env['GPUQ_CPU_LIMIT'], '32')
        self.assertEqual(env['GPUQ_GPU_COUNT'], '8')
        self.assertFalse(any(key.startswith('RAY_') for key in env))

    def test_runner_uses_two_card_budget_for_an_immutable_eight_card_elastic_request(self):
        (args,_),properties=self.runner_command(allocated_cards=2)
        self.assertIn('MemoryMax='+str(64*R.GIB),properties[0]);self.assertIn('CPUQuota=800%',properties[0])
        env={args[i+1]:args[i+2] for i,item in enumerate(args) if item=='--setenv'}
        self.assertEqual(env['GPUQ_GPU_COUNT'],'2');self.assertEqual(env['GPUQ_CPU_LIMIT'],'8')
        bindings=[args[i+1:i+3] for i,value in enumerate(args) if value=='--dev-bind']
        self.assertIn(['/dev/nvidia3','/dev/nvidia3'],bindings)
        self.assertIn(['/dev/nvidia2','/dev/nvidia2'],bindings)
        self.assertNotIn(['/dev/nvidia0','/dev/nvidia0'],bindings)
        self.assertNotIn(['/dev/nvidia1','/dev/nvidia1'],bindings)

    def test_legacy_terminal_without_id_gets_budget_without_rewriting_immutable_spec(self):
        (args, _), properties = self.runner_command(terminal=True)
        env = {args[i + 1]: args[i + 2] for i, value in enumerate(args) if value == '--setenv'}
        self.assertEqual((env['GPUQ_CPU_LIMIT'], env['GPUQ_MEMORY_LIMIT_BYTES'], env['GPUQ_GPU_COUNT']),
                         ('2', str(8 * R.GIB), '0'))
        self.assertIn('CPUQuota=200%', properties[0])
        budget = json.loads((self.root / 'memfd-gpuq-resources').read_text())
        self.assertEqual(budget['jobId'], JOB['id'])
        self.assertEqual(args[-2:], ['python', 'train.py'])

    def test_oci_terminal_runtime_uses_trusted_filename_without_mutating_legacy_spec(self):
        spec={'userId':'demo-user-1','project':'vision','cards':0,'argv':['bash']}
        runtime=S.oci_runtime_spec(spec,JOB['id'],True)
        self.assertEqual(runtime,{**spec,'id':JOB['id']})
        self.assertNotIn('id',spec)
        self.assertIsNot(runtime,spec)

    def test_oci_terminal_runtime_rejects_client_identity_by_using_validated_filename(self):
        spec={'id':'untrusted-client-id','userId':'demo-user-1','cards':0}
        runtime=S.oci_runtime_spec(spec,JOB['id'],True)
        self.assertEqual(runtime['id'],JOB['id'])
        self.assertEqual(spec['id'],'untrusted-client-id')

    def test_oci_training_runtime_preserves_immutable_original_spec(self):
        spec={**JOB,'userId':'demo-user-1'}
        self.assertIs(S.oci_runtime_spec(spec,'different-id',False),spec)

    def test_managed_runtime_moves_raw_ray_spill_back_to_job_private_tmpfs(self):
        (args, _), _ = self.runner_command(managed_runtime=True)
        env = {args[i + 1]: args[i + 2] for i, value in enumerate(args) if value == '--setenv'}
        self.assertEqual(env['RAY_TMPDIR'], '/run/gpuq/runtime')
        self.assertEqual(env['RAY_object_spilling_directory'], '/tmp/gpuq-ray-spill')
        self.assertIn('/run/gpuq/runtime', args)

    def data_mount_assertions(self,args,options):
        mount=args.index('/data2')
        self.assertEqual(args[mount-2],'--bind-fd')
        datafd,datalock=self.data_descriptors
        self.assertEqual(int(args[mount-1]),datafd)
        self.assertIn(datafd,options['pass_fds'])
        self.assertNotIn(datalock,options['pass_fds'])
        self.assertNotIn('--dev-bind',args)
        self.assertNotIn('/run/gpuq/control',args)
        self.assertNotIn('/opt/gpuq/sdk.pyz',args)
        env={args[i+1]:args[i+2] for i,value in enumerate(args) if value=='--setenv'}
        self.assertNotIn('GPUQ_CONTROL_DIR',env);self.assertNotIn('PYTHONPATH',env)
        self.assertIn(['--chdir','/data2'],[args[i:i+2] for i in range(len(args)-1)])
        for descriptor in self.data_descriptors:
            with self.assertRaises(OSError):os.fstat(descriptor)

    def test_data_terminal_mounts_only_private_fd_without_gpu_or_lock_escape(self):
        (args,options),_=self.runner_command(terminal=True,data_workspace=True,training_control=True)
        self.data_mount_assertions(args,options)

    def test_common_p0_data_terminal_has_identical_private_mount_boundary(self):
        global S
        original=S
        try:
            S=module('common_p0_data_runner_test','sandbox-runner-common-p0.py')
            (args,options),_=self.runner_command(terminal=True,data_workspace=True,training_control=True)
            self.data_mount_assertions(args,options)
        finally:S=original


if __name__ == '__main__':
    unittest.main()
