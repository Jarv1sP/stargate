"""Actual allocation, unchanged quotas and user-controlled thread settings."""
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
        self.gpus = [{'index': i, 'uuid': 'GPU-' + str(i), 'pci': '0000:0%d:00.0' % (i + 1)} for i in range(4)]

    def numa(self, gpu, node, cpus):
        folder = self.sysfs / 'bus/pci/devices' / self.gpus[gpu]['pci']
        folder.mkdir(parents=True)
        (folder / 'numa_node').write_text(str(node))
        folder = self.sysfs / 'devices/system/node' / ('node' + str(node))
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'cpulist').write_text(cpus)

    def siblings(self, *cores):
        for core in cores:
            for cpu in core:
                folder = self.sysfs / 'devices/system/cpu' / ('cpu' + str(cpu)) / 'topology'
                folder.mkdir(parents=True)
                (folder / 'thread_siblings_list').write_text(','.join(map(str, core)))

    def test_numa_segments_are_disjoint_and_cover_available_cpus(self):
        self.numa(0, 1, '8-15'); self.numa(1, 0, '0-7')
        self.numa(2, 1, '8-15'); self.numa(3, 0, '0-7')
        layout = self.resources.gpu_cpu_layout(self.gpus, range(16), self.sysfs)
        self.assertEqual(layout, {'GPU-0': [8, 9, 10, 11], 'GPU-1': [0, 1, 2, 3],
                                  'GPU-2': [12, 13, 14, 15], 'GPU-3': [4, 5, 6, 7]})
        self.assertEqual(set().union(*map(set, layout.values())), set(range(16)))
        self.assertEqual(sum(map(len, layout.values())), 16)

    def test_unknown_numa_uses_stable_sequential_segments_and_parent_affinity(self):
        layout = self.resources.gpu_cpu_layout(self.gpus, [2, 4, 6, 8, 10, 12, 14, 16, 18], self.sysfs)
        self.assertEqual(layout, {'GPU-0': [2, 4, 6], 'GPU-1': [8, 10], 'GPU-2': [12, 14], 'GPU-3': [16, 18]})

    def test_unbalanced_six_two_numa_layout_uses_equal_segments_with_whole_physical_cores(self):
        self.gpus = [{'index': i, 'uuid': 'GPU-' + str(i), 'pci': '0000:%02x:00.0' % (i + 1)} for i in range(8)]
        self.siblings(*[(cpu, cpu + 64) for cpu in range(64)])
        for gpu in range(8):
            self.numa(gpu, 0 if gpu < 6 else 1, '0-31,64-95' if gpu < 6 else '32-63,96-127')
        layout = self.resources.gpu_cpu_layout(self.gpus, range(128), self.sysfs)
        self.assertEqual({len(cpus) for cpus in layout.values()}, {16})
        self.assertEqual(layout['GPU-0'], list(range(8)) + list(range(64, 72)))
        self.assertEqual(layout['GPU-7'], list(range(56, 64)) + list(range(120, 128)))
        self.assertEqual(set().union(*map(set, layout.values())), set(range(128)))
        for cpus in layout.values():
            self.assertEqual({cpu % 64 for cpu in cpus}, {cpu for cpu in cpus if cpu < 64})
        self.assertEqual(sum(map(len, layout.values())), 128)

    def test_uneven_split_never_cuts_hyperthreads_of_one_physical_core_between_jobs(self):
        self.siblings(*[(cpu, cpu + 5) for cpu in range(5)])
        layout = self.resources.gpu_cpu_layout(self.gpus, range(10), self.sysfs)
        self.assertEqual([len(cpus) for cpus in layout.values()], [4, 2, 2, 2])
        for cpus in layout.values():
            self.assertEqual({cpu % 5 for cpu in cpus}, {cpu for cpu in cpus if cpu < 5})
        self.assertEqual(set().union(*map(set, layout.values())), set(range(10)))
        self.assertEqual(sum(map(len, layout.values())), 10)

    def test_gpu_query_and_actual_shared_elastic_allocation_select_only_their_segments(self):
        rows = '\n'.join('%d, %s, %s' % (g['index'], g['uuid'], g['pci']) for g in self.gpus)
        layout = self.resources.gpu_cpu_layout
        with patch.object(self.resources.os, 'sched_getaffinity', return_value=set(range(16))), \
                patch.object(self.resources.subprocess, 'run', return_value=SimpleNamespace(stdout=rows)), \
                patch.object(self.resources, 'gpu_cpu_layout', side_effect=lambda gpus, cpus: layout(gpus, cpus, self.sysfs)):
            self.assertEqual(self.resources.allocated_cpus(['GPU-0', 'GPU-2'], {'cards': 4}), [0, 1, 2, 3, 8, 9, 10, 11])
            # A shared job on GPU 2 and an elastic job currently on GPU 2 use
            # that card's segment, never their requested maximum card count.
            self.assertEqual(self.resources.allocated_cpus(['GPU-2'], {'cards': 4}), [8, 9, 10, 11])
            self.assertEqual(self.resources.allocated_cpus(['GPU-1', 'GPU-3'], {'cards': 4}), [4, 5, 6, 7, 12, 13, 14, 15])

    def test_failed_or_timed_out_gpu_query_skips_binding_instead_of_inventing_a_different_layout(self):
        for error in (OSError('unavailable'), subprocess.CalledProcessError(1, 'nvidia-smi'),
                      subprocess.TimeoutExpired('nvidia-smi', 5)):
            with self.subTest(error=type(error).__name__), \
                    patch.object(self.resources.subprocess, 'run', side_effect=error), \
                    patch.dict(os.environ, {'GPUQ_ASSIGNED_GPU_INDICES': '2,3'}):
                self.assertEqual(self.resources.allocated_cpus(['GPU-2', 'GPU-3'], {'cards': 4}), [])

    def test_cpuset_availability_uses_the_current_process_cgroup_controllers(self):
        proc = self.sysfs / 'proc-cgroup'; proc.write_text('0::/user.slice/job.service\n')
        group = self.sysfs / 'cgroup/user.slice/job.service'; group.mkdir(parents=True)
        for controllers, available in (('cpu cpuset io memory pids', True), ('cpu io memory pids', False)):
            (group / 'cgroup.controllers').write_text(controllers)
            self.assertEqual(self.resources.cpuset_available(proc=proc, root=self.sysfs / 'cgroup'), available)
        (group / 'cgroup.controllers').unlink()
        self.assertFalse(self.resources.cpuset_available(proc=proc, root=self.sysfs / 'cgroup'))

    def test_oci_gpu_jobs_get_cpuset_including_interactive_jobs_but_dev_terminal_does_not(self):
        oci = module('personal-oci')
        engine = oci.PersonalOCI.__new__(oci.PersonalOCI)
        engine.config = {'cards': 4}; engine.owner = 'team'; engine._mount_sources = {}
        engine.cpu_set = [4, 5, 12, 13]
        with patch.object(oci, 'cdi_selection', return_value=['nvidia.com/gpu=GPU-1']):
            for interactive in (False, True):
                args = engine.arguments({'project': 'demo', 'cards': 8}, {}, interactive, ['GPU-1'], [])
                self.assertIn('--cpuset-cpus=4,5,12,13', args)
            args = engine.arguments({'project': 'demo'}, {}, True, [], [])
            self.assertFalse(any(arg.startswith('--cpuset-cpus') for arg in args))
            engine.cpu_set = []
            args = engine.arguments({'project': 'demo', 'cards': 1}, {}, False, ['GPU-1'], [])
            self.assertFalse(any(arg.startswith('--cpuset-cpus') for arg in args))

    def test_thread_defaults_follow_enforced_quota_floor_not_host_count(self):
        for quota, expected in ((16, '16'), (2, '2'), (2.75, '2'), (0.5, '1')):
            values = self.resources.thread_defaults({'cpuLimit': quota})
            self.assertEqual(len(values), 6)
            self.assertEqual(set(values.values()), {expected})
            self.assertIn('TORCHINDUCTOR_COMPILE_THREADS', values)

    def test_thread_defaults_are_capped_by_the_actual_cpu_segment(self):
        for quota, cpus, expected in ((16, [0, 1], '2'), (2.75, list(range(4)), '2'), (0.5, [0], '1'), (16, [], '16')):
            self.assertEqual(set(self.resources.thread_defaults({'cpuLimit': quota}, cpus).values()), {expected})

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
                   'execution': 'test', 'argv': ['python', 'train.py'],
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
        for terminal, quota, delegated, cpus, expected in ((False, 16, True, [4, 5], 2),
                (False, 16, False, [4, 5], 16), (False, 16, True, [], 16), (True, 2, True, [], 2)):
            uuids = [] if terminal else ['GPU-1']
            budget = {'cpuLimit': quota, 'memoryLimitBytes': 8 * 1024**3, 'pidsLimit': 2048, 'gpuCount': len(uuids)}
            descriptor = os.memfd_create('test-budget'); self.addCleanup(os.close, descriptor)
            os.write(descriptor, json.dumps(budget).encode())
            engine = SimpleNamespace(execute=lambda *args, **kwargs: kwargs['control'])
            with patch.object(oci, 'PersonalOCI', return_value=engine), patch.dict(os.environ, {'OMP_NUM_THREADS': '3'}, clear=True), \
                    patch.object(oci, 'module', side_effect=lambda name: self.resources if name == 'job-resources' else original(name)), \
                    patch.object(self.resources, 'cpuset_available', return_value=delegated), \
                    patch.object(self.resources, 'allocated_cpus', return_value=cpus) as allocate:
                control = oci.run_project({'root': str(self.sysfs)}, {'userId': 'team', 'project': 'demo'},
                    {'code': str(self.sysfs)}, terminal, uuids, directory,
                    {'home': directory, 'output': directory}, [], resourcefd=descriptor)
            self.assertEqual(set(engine.thread_defaults.values()), {str(expected)})
            self.assertEqual(engine.cpu_set, cpus if delegated and uuids else [])
            if delegated and uuids: allocate.assert_called_once_with(uuids, {'root': str(self.sysfs)})
            else: allocate.assert_not_called()
            environment = dict((control[i+1], control[i+2]) for i, value in enumerate(control) if value == '--setenv')
            self.assertEqual(environment['OMP_NUM_THREADS'], '3')
            self.assertEqual(environment['GPUQ_CPU_LIMIT'], str(quota))
            self.assertNotIn('OPENBLAS_NUM_THREADS', environment)

    def test_real_child_affinity_and_nproc_use_only_selected_cpus(self):
        selected = sorted(os.sched_getaffinity(0))[:2]
        code = 'import json,os,subprocess;print(json.dumps([sorted(os.sched_getaffinity(0)),int(subprocess.check_output(["nproc"]))]))'
        env = {k: v for k, v in os.environ.items() if k not in ('OMP_NUM_THREADS', 'OMP_THREAD_LIMIT')}
        child = subprocess.run(['taskset', '-c', ','.join(map(str, selected)), '/usr/bin/python3', '-c', code],
                               check=True, text=True, capture_output=True, env=env)
        self.assertEqual(json.loads(child.stdout), [selected, len(selected)])


if __name__ == '__main__':
    unittest.main()
