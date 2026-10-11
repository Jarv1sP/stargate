"""Budget application with temporary cgroup files and a fake systemd setter.

The optional namespace test checks mount visibility, not kernel enforcement.
No real unit, GPU allocation, system configuration or production data changes.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load('allocated_budget_resources', 'deploy/job-resources.py')
B = load('allocated_budget_runner', 'src/infrastructure/training-budget.py')


class TrainingBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.attempt = 'A' + uuid.uuid4().hex
        self.unit = 'gpuq-' + self.attempt.lower() + '.service'
        self.group = '/user.slice/' + self.unit
        self.leaf = self.root / self.group.lstrip('/')
        self.leaf.mkdir(parents=True)
        self.identity = SimpleNamespace(job_id=str(uuid.uuid4()), attempt_id=self.attempt,
            process=SimpleNamespace(control_group=self.group), assignments=(('GPU-a', 2), ('GPU-b', 7)))
        self.systemd = Mock(side_effect=self.apply_limits)
        self.runtime = B.TrainingBudget(R, systemd=self.systemd, cgroup_root=self.root)
        for target, value in [('sched_getaffinity', lambda _: set(range(128))),
                              ('sysconf', lambda key: 1024 * R.GIB if key == 'SC_PHYS_PAGES' else 1)]:
            patcher = patch.object(R.os, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def apply_limits(self, argv, **kwargs):
        properties = dict(value.split('=', 1) for value in argv[6:])
        cpu = int(properties['CPUQuota'].removesuffix('%')) * 1000
        self.write_limits(self.leaf, f'{cpu} 100000', properties['MemoryMax'], properties['TasksMax'])
        return subprocess.CompletedProcess(argv, 0)

    def write_limits(self, path, cpu, memory, pids):
        for name, value in [('cpu.max', cpu), ('memory.max', memory), ('pids.max', pids)]:
            (path / name).write_text(str(value) + '\n')

    def assert_closed(self, *descriptors):
        for descriptor in descriptors:
            with self.assertRaises(OSError):
                os.fstat(descriptor)

    def test_actual_two_card_allocation_sets_only_original_unit_and_exposes_matching_readonly_view(self):
        with self.runtime.open(self.identity) as resources:
            self.systemd.assert_called_once_with(['/usr/bin/systemctl', '--user', 'set-property', '--runtime', '--', self.unit,
                'MemoryMax=' + str(64 * R.GIB), 'CPUQuota=800%', 'TasksMax=2048'],
                check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            budget = resources['budget']
            self.assertEqual((budget['jobId'], budget['gpuCount'], budget['gpuUuids']),
                             (self.identity.job_id, 2, ['GPU-a', 'GPU-b']))
            self.assertEqual(budget['requested'], {'cpu': 8, 'memory': 64 * R.GIB, 'pids': 2048})
            self.assertEqual((budget['cpuLimit'], budget['memoryLimitBytes'], budget['pidsLimit']), (8, 64 * R.GIB, 2048))
            self.assertEqual(json.loads(os.pread(resources['metadataFd'], 65536, 0)), budget)
            self.assertEqual(os.fstat(resources['cgroupFd']).st_ino, self.leaf.stat().st_ino)
            self.assertNotIn(str(self.root), json.dumps(budget))
            self.assertEqual(resources['environment']['GPUQ_GPU_COUNT'], '2')
            handles = resources['metadataFd'], resources['cgroupFd']
        self.assert_closed(*handles)
        # Scope cleanup does not undo the still-existing job unit's limits.
        self.assertEqual((self.leaf / 'memory.max').read_text().strip(), str(64 * R.GIB))
        self.assertEqual(self.systemd.call_count, 1)

    def test_parent_limits_and_affinity_are_reported_without_raising_requested_caps(self):
        self.write_limits(self.leaf.parent, '200000 100000', 6 * R.GIB, 512)
        with self.runtime.open(self.identity) as resources:
            budget = resources['budget']
            self.assertEqual((budget['cpuLimit'], budget['memoryLimitBytes'], budget['pidsLimit']), (2, 6 * R.GIB, 512))
            self.assertEqual(resources['environment']['GPUQ_MEMORY_LIMIT_BYTES'], str(6 * R.GIB))
            self.assertEqual(budget['requested']['memory'], 64 * R.GIB)

    def test_setter_failure_or_missing_kernel_limits_never_yields_a_container_budget(self):
        self.systemd.side_effect = subprocess.CalledProcessError(1, 'fixture-systemctl')
        with patch.object(B.os, 'memfd_create', side_effect=AssertionError('no resource view before limits')):
            with self.assertRaises(subprocess.CalledProcessError):
                with self.runtime.open(self.identity):
                    self.fail('failed setter admitted a container')
        self.systemd.side_effect = None
        with self.assertRaisesRegex(ValueError, 'Missing enforced'):
            with self.runtime.open(self.identity):
                self.fail('successful setter reply replaced kernel observation')

    def test_unlimited_or_larger_leaf_limits_are_not_treated_as_requested_limits(self):
        for field, value in [('cpu.max', 'max 100000'), ('memory.max', str(65 * R.GIB)), ('pids.max', '2049')]:
            def apply(argv, field=field, value=value, **kwargs):
                self.apply_limits(argv, **kwargs)
                (self.leaf / field).write_text(value)
            self.systemd.side_effect = apply
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'not enforced'):
                with self.runtime.open(self.identity):
                    self.fail('unenforced budget exposed')

    def test_large_allocations_use_shared_policy_while_legacy_submit_validation_is_unchanged(self):
        for count in (65, 4096):
            self.identity.assignments = tuple((f'GPU-test-{i}', i) for i in range(count))
            with self.runtime.open(self.identity) as resources:
                self.assertEqual(resources['budget']['gpuCount'], count)
                self.assertEqual(resources['budget']['requested'], {'cpu': 4 * count, 'memory': 32 * count * R.GIB, 'pids': 2048})
                self.assertEqual(resources['environment']['GPUQ_GPU_COUNT'], str(count))
                self.assertEqual(resources['budget']['cpuLimit'], 128)
        for invalid in (0, True, '2', 4097):
            with self.subTest(count=invalid), self.assertRaises(ValueError):
                R.allocation_limits(invalid)
        with self.assertRaises(ValueError):
            R.requested_limits({'cards': 65})
        self.identity.assignments = ()
        self.systemd.reset_mock()
        with self.assertRaises(ValueError):
            with self.runtime.open(self.identity):
                self.fail('zero-card training applied limits')
        self.systemd.assert_not_called()

    def test_consumer_exception_closes_view_handles_without_changing_unit_limits(self):
        with self.assertRaisesRegex(RuntimeError, 'consumer failed'):
            with self.runtime.open(self.identity) as resources:
                handles = resources['metadataFd'], resources['cgroupFd']
                raise RuntimeError('consumer failed')
        self.assert_closed(*handles)
        self.assertEqual((self.leaf / 'pids.max').read_text().strip(), '2048')
        self.assertEqual(self.systemd.call_count, 1)

    def test_failed_metadata_creation_closes_the_already_open_cgroup_handle(self):
        original_open, descriptors = os.open, []
        def record(*args, **kwargs):
            fd = original_open(*args, **kwargs)
            descriptors.append(fd)
            return fd
        with patch.object(B.os, 'open', side_effect=record), patch.object(B.os, 'memfd_create', side_effect=OSError('fixture failure')):
            with self.assertRaisesRegex(OSError, 'fixture failure'):
                with self.runtime.open(self.identity):
                    self.fail('metadata failure ignored')
        self.assertEqual(len(descriptors), 1)
        self.assert_closed(*descriptors)

    def test_real_namespace_sees_only_this_readonly_cgroup_view_and_budget(self):
        bwrap = shutil.which('bwrap')
        if not bwrap:
            self.skipTest('bubblewrap unavailable; namespace view not tested')
        with self.runtime.open(self.identity) as resources:
            args = [bwrap, '--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr',
                '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
                '--tmpfs', '/tmp', '--tmpfs', '/run', '--ro-bind-fd', str(resources['cgroupFd']), '/sys/fs/cgroup',
                '--ro-bind-data', str(resources['metadataFd']), R.RESOURCE_FILE, '--clearenv']
            for key, value in resources['environment'].items():
                args += ['--setenv', key, value]
            script = """import errno,json,os
from pathlib import Path
budget=json.load(open('/run/gpuq/resources.json'))
assert budget['gpuCount']==2 and budget['cpuLimit']==8
assert os.environ['GPUQ_MEMORY_LIMIT_BYTES']==str(64*1024**3)
assert Path('/sys/fs/cgroup/cpu.max').read_text().strip()=='800000 100000'
assert sorted(p.name for p in Path('/sys/fs/cgroup').iterdir())==['cpu.max','memory.max','pids.max']
for path in ['/sys/fs/cgroup/memory.max','/run/gpuq/resources.json']:
    try: open(path,'w')
    except OSError as error: assert error.errno==errno.EROFS,error
    else: raise AssertionError('resource view is writable')
print('READONLY_JOB_VIEW')
"""
            result = subprocess.run(args + ['--', '/usr/bin/python3', '-c', script],
                pass_fds=(resources['cgroupFd'], resources['metadataFd']), text=True, capture_output=True, timeout=15)
        if result.returncode and any(reason in result.stderr for reason in
                ('No permissions to create', 'Creating new namespace failed', 'Operation not permitted')):
            self.skipTest('local kernel denies namespaces; resource view not tested')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'READONLY_JOB_VIEW')


if __name__ == '__main__':
    unittest.main()
