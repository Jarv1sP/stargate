"""Kernel UUID/device-minor identity, using private files and fake device stats."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


D = load('gpu_devices_test', 'gpu-devices.py')
P = load('gpu_devices_policy_test', 'scheduling-policy.py')
UUIDS = ['GPU-00000000-0000-0000-0000-' + str(i).zfill(12) for i in range(1, 4)]
JID = '11111111-1111-4111-8111-111111111111'


@unittest.skipUnless(os.name == 'posix', 'Linux device/proc contract; POSIX fixture')
class GPUDevices(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.proc = self.root / 'proc'; self.proc.mkdir()
        self.dev = self.root / 'dev'; self.dev.mkdir()
        self.nodes = {}
        original = Path.lstat

        def device_stat(path):
            if path.parent == self.dev:
                if path.name not in self.nodes:
                    raise FileNotFoundError(str(path))
                return self.nodes[path.name]
            return original(path)

        hook = patch.object(Path, 'lstat', device_stat)
        hook.start(); self.addCleanup(hook.stop)

    def entry(self, slot, identity, minor):
        directory = self.proc / f'0000:{slot:02x}:00.0'
        directory.mkdir()
        info = directory / 'information'
        info.write_text(f'Model: NVIDIA fixture\nGPU UUID: {identity}\nDevice Minor: {minor}\n')
        if isinstance(minor, int):
            self.nodes['nvidia' + str(minor)] = SimpleNamespace(st_mode=stat.S_IFCHR | 0o666, st_uid=0, st_rdev=os.makedev(195, minor))
        return info

    def paths(self, identities):
        return D.device_paths(identities, proc_root=self.proc, dev_root=self.dev)

    def test_inventory_index_two_is_device_minor_one_not_nvidia_two(self):
        for slot, (identity, minor) in enumerate(zip(UUIDS, [3, 2, 1])):
            self.entry(slot, identity, minor)
        self.assertEqual(self.paths([UUIDS[2]]), [str(self.dev / 'nvidia1')])
        self.assertEqual(self.paths([UUIDS[2], UUIDS[0]]), [str(self.dev / 'nvidia1'), str(self.dev / 'nvidia3')])

    def test_mounts_include_driver_controls_and_only_resolved_assigned_devices(self):
        with patch.object(D, 'device_paths', return_value=['/dev/nvidia7']) as resolve:
            self.assertEqual(D.mount_paths([UUIDS[0]]),
                             ['/dev/nvidiactl', '/dev/nvidia-uvm', '/dev/nvidia-uvm-tools', '/dev/nvidia7'])
        resolve.assert_called_once_with([UUIDS[0]])

    def test_bad_or_duplicate_allocated_uuid_rejects_before_filesystem_read(self):
        with patch.object(D.os, 'open') as opened:
            for value in [None, (), [], ['GPU-2'], ['../nvidia2'], [True], UUIDS * 22, [UUIDS[0], UUIDS[0]]]:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    self.paths(value)
            opened.assert_not_called()

    def test_missing_assigned_uuid_has_no_index_fallback(self):
        self.entry(0, UUIDS[0], 2)
        with self.assertRaisesRegex(ValueError, 'missing'):
            self.paths([UUIDS[2]])

    def test_duplicate_inventory_uuid_or_minor_is_ambiguous(self):
        self.entry(0, UUIDS[0], 1)
        second = self.entry(1, UUIDS[0], 2)
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.paths([UUIDS[0]])
        second.write_text(f'GPU UUID: {UUIDS[1]}\nDevice Minor: 1\n')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.paths([UUIDS[0]])

    def test_driver_records_are_strict_and_bounded(self):
        info = self.entry(0, UUIDS[0], 1)
        for content in [f'GPU UUID: {UUIDS[0]}\nDevice Minor: 1\nDevice Minor: 2\n',
                        f'GPU UUID: {UUIDS[0]}\n', 'GPU UUID: GPU-invalid\nDevice Minor: 1\n',
                        *[f'GPU UUID: {UUIDS[0]}\nDevice Minor: {minor}\n' for minor in ['-1', '255', '999', '1.0', '01']],
                        'x' * (D.MAX_INFORMATION_BYTES + 1)]:
            info.write_text(content)
            with self.subTest(content=content[:80]), self.assertRaises(ValueError):
                self.paths([UUIDS[0]])
        info.write_bytes(b'GPU UUID: \xff\nDevice Minor: 1\n')
        with self.assertRaises(ValueError):
            self.paths([UUIDS[0]])

    def test_inventory_card_count_is_bounded_and_no_unexpected_entries(self):
        with self.assertRaisesRegex(ValueError, 'empty'):
            self.paths([UUIDS[0]])
        self.entry(0, UUIDS[0], 1); self.entry(1, UUIDS[1], 2)
        with patch.object(D, 'MAX_GPUS', 1), self.assertRaisesRegex(ValueError, 'oversized'):
            self.paths([UUIDS[0]])
        (self.proc / 'unexpected').touch()
        with self.assertRaisesRegex(ValueError, 'Invalid.*entry'):
            self.paths([UUIDS[0]])

    def test_no_symlink_proc_directory_or_information(self):
        info = self.entry(0, UUIDS[0], 1)
        backing = self.root / 'record'; info.rename(backing); info.symlink_to(backing)
        with self.assertRaises(ValueError):
            self.paths([UUIDS[0]])
        info.unlink(); backing.rename(info)
        directory = info.parent; replacement = self.root / 'other'; directory.rename(replacement); directory.symlink_to(replacement)
        with self.assertRaises(ValueError):
            self.paths([UUIDS[0]])

    def test_device_node_must_be_root_owned_character_correct_major_and_minor(self):
        self.entry(0, UUIDS[0], 1)
        for mode, uid, major, minor in [(stat.S_IFREG, 0, 195, 1), (stat.S_IFLNK, 0, 195, 1),
                                       (stat.S_IFCHR, 1000, 195, 1), (stat.S_IFCHR, 0, 1, 1), (stat.S_IFCHR, 0, 195, 2)]:
            self.nodes['nvidia1'] = SimpleNamespace(st_mode=mode, st_uid=uid, st_rdev=os.makedev(major, minor))
            with self.subTest(mode=mode, uid=uid, major=major, minor=minor), self.assertRaisesRegex(ValueError, 'mismatch'):
                self.paths([UUIDS[0]])
        self.nodes.clear()
        with self.assertRaises(ValueError):
            self.paths([UUIDS[0]])

    def test_both_runners_resolve_uuid_before_smi_or_budget_mutation_or_child_start(self):
        for filename in ('sandbox-runner.py', 'sandbox-runner-common-p0.py'):
            with self.subTest(filename=filename):
                runner = load('device_runner_' + filename.replace('-', '_'), filename)
                jobs = self.root / 'jobs'; jobs.mkdir(exist_ok=True)
                (jobs / (JID + '.json')).write_text(json.dumps({'id': JID, 'userId': 'demo-user-1', 'username': 'demo', 'cards': 1, 'argv': ['/usr/bin/true']}))
                (self.root / 'node-config.json').write_text(json.dumps({'root': str(self.root), 'conda': '/opt/conda'}))
                resolve = Mock(side_effect=ValueError('missing device UUID'))
                guard = SimpleNamespace(check=Mock())
                modules = {'platform-root-guard.py': guard, 'scheduling-policy.py': P, 'gpu-devices.py': SimpleNamespace(device_paths=resolve)}
                with contextlib.ExitStack() as identity:
                    if hasattr(runner,'JobCapture'):
                        read=Path.read_text
                        identity.enter_context(patch.object(Path,'read_text',lambda path,*a,**kw:'0::/some/gpuq-test.service\n' if path==Path('/proc/self/cgroup') else read(path,*a,**kw)))
                        identity.enter_context(patch.object(runner,'start_job_capture',return_value=(None,None,None)))
                    with patch.object(runner, 'HERE', self.root), patch.object(runner, 'local_module', side_effect=lambda name, file: modules[file]), \
                        patch.object(runner.sys, 'argv', ['sandbox-runner.py', JID]), \
                        patch.dict(runner.os.environ, {'GPUQ_ASSIGNED_GPU_INDICES': '2', 'GPUQ_ASSIGNED_GPU_UUIDS': UUIDS[2]}), \
                        patch.object(runner.subprocess, 'check_output') as smi, patch.object(runner.subprocess, 'run') as run, patch.object(runner.subprocess, 'Popen') as spawn:
                        with self.assertRaisesRegex(ValueError, 'missing device UUID'):
                            runner.main()
                        resolve.assert_called_once_with([UUIDS[2]])
                        guard.check.assert_called_once_with(self.root)
                        smi.assert_not_called(); run.assert_not_called(); spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
