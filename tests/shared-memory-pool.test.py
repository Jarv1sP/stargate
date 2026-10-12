"""Shared RAM is an enforced aggregate ceiling, not a per-GPU reservation."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('resources', Path(__file__).resolve().parents[1] / 'deploy/job-resources.py')
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)


class SharedMemory(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.pool = '/user.slice/gpuq-workloads.slice'
        self.group = self.pool + '/gpuq-test.service'
        self.parent = self.root / self.pool.lstrip('/')
        self.leaf = self.root / self.group.lstrip('/')
        self.leaf.mkdir(parents=True)
        self.config = {'memoryPool': {'cgroup': self.pool, 'maxBytes': 900 * R.GIB}}
        (self.parent / 'memory.max').write_text(str(900 * R.GIB))
        (self.parent / 'memory.oom.group').write_text('0')
        for name, value in [('cpu.max', '400000 100000'), ('memory.max', str(900 * R.GIB)), ('pids.max', '2048')]:
            (self.leaf / name).write_text(value)

    def test_one_or_many_gpus_and_cpu_terminal_can_borrow_entire_pool(self):
        for cards in (1, 2, 8):
            self.assertEqual(R.requested_limits({'cards': cards}, config=self.config)['memory'], 900 * R.GIB)
        self.assertEqual(R.requested_limits({}, terminal=True, config=self.config)['memory'], 900 * R.GIB)

    def test_explicit_limit_caps_only_this_task(self):
        self.assertEqual(R.requested_limits({'cards': 1, 'memoryLimitGiB': 60}, config=self.config)['memory'], 60 * R.GIB)
        self.assertEqual(R.requested_limits({'cards': 1, 'memoryLimitGiB': 1000}, config=self.config)['memory'], 900 * R.GIB)
        for value in (None, True, 0, -1, '60', 1.5):
            with self.subTest(value=value), self.assertRaises(ValueError):
                R.requested_limits({'cards': 1, 'memoryLimitGiB': value}, config=self.config)

    def test_budget_marks_shared_ceiling_not_reserved_or_free_memory(self):
        budget = R.read_budget({'id': 'job', 'cards': 1}, self.group, ['GPU-0'],
                               config=self.config, root=self.root, affinity_count=8,
                               physical_memory=1024 * R.GIB)
        self.assertTrue(budget['memoryShared'])
        self.assertEqual(budget['memoryLimitBytes'], 900 * R.GIB)
        self.assertEqual(budget['cpuLimit'], 4)

    def test_no_pool_or_wrong_pool_never_silently_removes_limit(self):
        for value in ('max', str(950 * R.GIB)):
            (self.parent / 'memory.max').write_text(value)
            with self.assertRaisesRegex(ValueError, 'not enforced'):
                R.verify_memory_pool(self.group, self.config, self.root)
        (self.parent / 'memory.max').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing enforced'):
            R.verify_memory_pool(self.group, self.config, self.root)
        with self.assertRaisesRegex(ValueError, 'outside'):
            R.verify_memory_pool('/app.slice/gpuq-test.service', self.config, self.root)
        with self.assertRaisesRegex(ValueError, 'outside'):
            R.verify_memory_pool(self.pool, self.config, self.root)

    def test_legacy_nodes_remain_bounded_until_pool_is_deployed(self):
        self.assertEqual(R.requested_limits({'cards': 1})['memory'], 32 * R.GIB)
        self.assertEqual(R.requested_limits({}, terminal=True)['memory'], 8 * R.GIB)
        R.verify_memory_pool('/app.slice/gpuq-test.service', {}, self.root)

    def test_pool_must_not_treat_all_users_as_one_oom_victim(self):
        (self.parent / 'memory.oom.group').write_text('1')
        with self.assertRaisesRegex(ValueError, 'all jobs'):
            R.verify_memory_pool(self.group, self.config, self.root)

    def test_rolling_pool_can_be_tighter_without_permanently_shrinking_each_job(self):
        (self.parent / 'memory.max').write_text(str(600 * R.GIB))
        budget = R.read_budget({'id': 'job', 'cards': 1}, self.group, ['GPU-0'],
                               config=self.config, root=self.root, affinity_count=8,
                               physical_memory=1024 * R.GIB)
        self.assertEqual(budget['memoryLimitBytes'], 600 * R.GIB)
        self.assertEqual(budget['requested']['memory'], 900 * R.GIB)
        (self.parent / 'memory.max').write_text(str(900 * R.GIB))
        R.verify_memory_pool(self.group, self.config, self.root)


if __name__ == '__main__':
    unittest.main()
