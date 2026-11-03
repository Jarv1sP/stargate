"""Shared host CPU access and user-controlled thread settings."""
import importlib.util
from contextlib import nullcontext
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'node' / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class CpuAllocation(unittest.TestCase):
    def setUp(self):
        self.resources = module('job-resources')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sysfs = Path(self.tmp.name)

    def test_jobs_and_terminals_do_not_bind_cpus_to_gpu_indices(self):
        oci = module('personal-oci')
        engine = oci.PersonalOCI.__new__(oci.PersonalOCI)
        engine.config = {'cards': 4}; engine.owner = 'team'; engine._mount_sources = {}
        with patch.object(oci, 'cdi_selection', return_value=['nvidia.com/gpu=GPU-1']):
            for terminal, uuids in ((False, ['GPU-1']), (False, ['GPU-1', 'GPU-2']), (True, [])):
                args = engine.arguments({'project': 'demo'}, {}, terminal, uuids, [])
                self.assertFalse(any(arg.startswith('--cpuset-cpus') or arg.startswith('--cpus=') for arg in args))

    def test_thread_defaults_follow_enforced_quota_floor_not_host_count(self):
        for quota, expected in ((16, '16'), (2, '2'), (2.75, '2'), (0.5, '1')):
            values = self.resources.thread_defaults({'cpuLimit': quota})
            self.assertEqual(len(values), 6)
            self.assertEqual(set(values.values()), {expected})
            self.assertIn('TORCHINDUCTOR_COMPILE_THREADS', values)

    def test_opt_in_ray_workers_use_one_thread_even_when_the_container_default_was_sixteen(self):
        budget = {'cpuLimit': 16, 'memoryLimitBytes': 8 * 1024**3, 'pidsLimit': 2048, 'gpuCount': 1}
        environment = self.resources.ray_environment(budget, self.resources.thread_defaults(budget))
        for key in self.resources.THREAD_VARIABLES[:-1]:
            self.assertEqual(environment[key], '1')

    def test_image_and_explicit_user_values_win_over_defaults(self):
        rootfs = module('workspace-rootfs')
        defaults = self.resources.thread_defaults({'cpuLimit': 16})
        environment = rootfs.thread_environment(['OMP_NUM_THREADS=3', 'OPENBLAS_NUM_THREADS=5'], defaults)
        self.assertEqual(environment['OMP_NUM_THREADS'], '3')
        self.assertEqual(environment['OPENBLAS_NUM_THREADS'], '5')
        self.assertEqual(environment['TORCHINDUCTOR_COMPILE_THREADS'], '16')
        # Explicit flags are applied after image/default env by Podman.
        flags = module('personal-oci').translate_control(['--setenv', 'OMP_NUM_THREADS', '7'])
        self.assertEqual(flags, ['--env', 'OMP_NUM_THREADS=7'])

    def test_real_workspace_execution_command_keeps_image_and_explicit_overrides(self):
        rootfs = module('workspace-rootfs')
        graph = self.sysfs / 'graph'; graph.mkdir(); mounted = graph / 'rootfs'; mounted.mkdir()
        request = {'engine': ['/usr/bin/podman'], 'hostUid': 1000, 'container': 'workspace', 'graph': str(graph),
                   'execution': 'test', 'argv': ['python', 'train.py'], 'workspaceLock': str(graph/'use-demo.lock'),
                   'threadDefaults': self.resources.thread_defaults({'cpuLimit': 16}),
                   'flags': ['--env', 'MKL_NUM_THREADS=7']}
        def command(argv, **kwargs):
            if 'inspect' in argv: return SimpleNamespace(stdout=json.dumps([{'Config': {'Env': ['OMP_NUM_THREADS=3']}}]))
            return SimpleNamespace(stdout=str(mounted), returncode=0)
        read_text = Path.read_text
        def contents(path, *args, **kwargs):
            return '0 1000 1\n' if str(path) == '/proc/self/uid_map' else read_text(path, *args, **kwargs)
        with patch.object(rootfs.os, 'getuid', return_value=0), patch.object(Path, 'read_text', contents), \
                patch.object(rootfs.subprocess, 'run', side_effect=command), \
                patch.object(rootfs.subprocess, 'call', return_value=0) as call, \
                patch.object(rootfs, 'output_mount', side_effect=lambda flags, folder: nullcontext(flags)):
            self.assertEqual(rootfs.execute(request), 0)
        argv = call.call_args[0][0]
        environment = dict(argv[i+1].split('=', 1) for i, value in enumerate(argv) if value == '--env')
        self.assertEqual(environment['OMP_NUM_THREADS'], '3')
        self.assertEqual(environment['MKL_NUM_THREADS'], '7')
        self.assertEqual(environment['OPENBLAS_NUM_THREADS'], '16')
        self.assertEqual(environment['TORCHINDUCTOR_COMPILE_THREADS'], '16')

    def test_job_and_terminal_runner_pass_actual_budget_defaults_and_only_explicit_thread_values(self):
        oci = module('personal-oci')
        (self.sysfs / 'outputs').mkdir()
        directory = os.open(self.sysfs, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, directory)
        original = oci.module
        for terminal, quota, expected in ((False, 16, 16), (True, 128, 128)):
            uuids = [] if terminal else ['GPU-1']
            budget = {'cpuLimit': quota, 'memoryLimitBytes': 8 * 1024**3, 'pidsLimit': 2048, 'gpuCount': len(uuids)}
            descriptor = os.memfd_create('test-budget'); self.addCleanup(os.close, descriptor)
            os.write(descriptor, json.dumps(budget).encode())
            engine = SimpleNamespace(execute=lambda *args, **kwargs: kwargs['control'])
            with patch.object(oci, 'PersonalOCI', return_value=engine), patch.dict(os.environ, {'OMP_NUM_THREADS': '3'}, clear=True), \
                    patch.object(oci, 'module', side_effect=lambda name: self.resources if name == 'job-resources' else original(name)):
                control = oci.run_project({'root': str(self.sysfs)}, {'userId': 'team', 'project': 'demo'},
                    {'code': str(self.sysfs)}, terminal, uuids, directory,
                    {'home': directory, 'output': directory}, [], resourcefd=descriptor)
            self.assertEqual(set(engine.thread_defaults.values()), {str(expected)})
            environment = dict((control[i+1], control[i+2]) for i, value in enumerate(control) if value == '--setenv')
            self.assertEqual(environment['OMP_NUM_THREADS'], '3')
            self.assertEqual(environment['GPUQ_CPU_LIMIT'], str(quota))
            self.assertNotIn('OPENBLAS_NUM_THREADS', environment)



if __name__ == '__main__':
    unittest.main()
