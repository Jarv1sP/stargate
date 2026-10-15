"""Local scheduler regressions with real files/SQLite and synthetic hardware."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.util.spec_from_file_location('gate1_scheduler', Path(__file__).with_name('gpuq-priority.test.py'))
F = importlib.util.module_from_spec(loader)
loader.loader.exec_module(F)
from gpuq import cluster_node, progress, sync
from gpuq.checkpoint import REQUEST_FILE_NAME


class Gate1(unittest.TestCase):
    setUp = F.SchedulerPriorityTests.setUp
    submit = F.SchedulerPriorityTests.submit
    running = F.SchedulerPriorityTests.running
    snapshot = F.SchedulerPriorityTests.snapshot

    def payload(self):
        return dict(job_id='job', attempt_id='attempt', sequence=1, phase='train',
                    epochs_completed=None, epochs_total=None, steps_completed=None, steps_total=None,
                    metrics={}, eta_seconds=None, stall_timeout_seconds=None,
                    severity='info', message=None)

    def write_progress(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def test_missing_and_invalid_progress_is_optional(self):
        path = self.root / progress.PROGRESS_FILE_NAME
        good = self.payload()
        invalid = [{}, [], None]
        for field in ('job_id', 'attempt_id', 'sequence', 'phase', 'metrics', 'severity'):
            invalid.append({k: v for k, v in good.items() if k != field})
        for field, value in (('sequence', '1'), ('phase', 2), ('metrics', []),
                             ('metrics', {'loss': []}), ('severity', {}),
                             ('epochs_completed', '1'), ('eta_seconds', 10**400),
                             ('phase', '\ud800')):
            invalid.append({**good, field: value})
        for value in invalid:
            with self.subTest(value=value):
                self.write_progress(path, value)
                self.assertIsNone(progress.load_progress_file(path))

    def test_bad_progress_does_not_stop_scheduling_other_jobs(self):
        running, attempt = self.running()
        pending = self.submit()
        self.write_progress(Path(attempt['control_dir']) / progress.PROGRESS_FILE_NAME, {})
        self.coordinator.gpu_provider.snapshot.return_value = self.coordinator._snapshot
        self.systemd.status.return_value = SimpleNamespace(
            main_pid=0, invocation_id='a' * 32, is_cleanup_ready=False,
            control_group='/user.slice/gpuq-active.service')
        self.coordinator.tick()
        self.coordinator.tick()
        self.assertEqual(self.coordinator.health_name, 'ok')
        self.assertEqual(self.store.get_job(running['id'])['state'], 'RUNNING')
        self.assertEqual(self.store.get_job(pending['id'])['state'], 'STARTING')
        self.assertIsNone(self.store.get_attempt_progress(attempt['id']))
        self.systemd.terminate.assert_not_called()
        self.systemd.kill.assert_not_called()

    def test_reporter_publishes_after_partial_progress_file(self):
        path = self.root / progress.PROGRESS_FILE_NAME
        self.write_progress(path, {})
        reporter = progress.ProgressReporter(environment={
            'GPUQ_CONTROL_DIR': str(self.root), 'GPUQ_JOB_ID': 'job', 'GPUQ_ATTEMPT_ID': 'attempt'})
        self.assertTrue(reporter.enabled)
        self.assertTrue(reporter.update(phase='train', metrics={'loss': 1.25}, force=True))
        snapshot = progress.load_progress_file(path)
        self.assertEqual((snapshot.phase, snapshot.sequence, snapshot.metrics['loss']), ('train', 1, 1.25))

    def test_existing_admission_token_returns_its_original_result(self):
        self.coordinator._set_health('ok')
        token = str(uuid.uuid4())
        submission = dict(submit_key=str(uuid.uuid4()), name='fleet', owner='team', priority=2,
                          dispatch_mode='queue', checkpoint_capability='none', restart_policy='never',
                          gpu_count=1, placement='any', requested_gpu_uuids=[],
                          argv=['/bin/true'], cwd=str(self.root), env={})
        first = cluster_node.node_api(self.coordinator, 'fleet_admit', {'token': token, 'submission': submission})
        before = self.store.list_jobs()
        for retry in ({'token': token}, {'token': token, 'submission': None},
                      {'token': token, 'submission': {**submission, 'argv': ['/bin/echo', 'other']}}):
            self.assertEqual(cluster_node.node_api(self.coordinator, 'fleet_admit', retry), first)
        self.assertEqual(self.store.list_jobs(), before)
        self.assertTrue(first['accepted'])

    def test_checkpoint_request_can_be_withdrawn_under_its_lock(self):
        victim, attempt = self.running((0,), priority=0, yield_policy='save', checkpoint_capability='epoch-v1')
        self.submit(priority=4, placement='pinned', requested_gpu_uuids=['GPU-0'])
        self.coordinator._schedule()
        attempt = self.store.get_attempt(attempt['id'])
        self.assertEqual(attempt['state'], 'SAVE_REQUESTED')
        path = Path(attempt['control_dir']) / REQUEST_FILE_NAME
        path.write_text(json.dumps({'nonce': 'stale', 'attempt_id': 'old', 'extra': True}))
        self.assertTrue(self.coordinator._try_withdraw_save_request(attempt, 'request canceled'))
        self.assertFalse(path.exists())
        self.assertEqual(self.store.get_job(victim['id'])['state'], 'RUNNING')
        self.assertEqual(len(self.store.list_leases()), 1)

    def test_container_hami_uses_the_installed_library(self):
        loader = importlib.util.spec_from_file_location('gate1_training_control', ROOT / 'node/training-control.py')
        control = importlib.util.module_from_spec(loader)
        loader.loader.exec_module(control)
        archive = self.root / 'gpuq.pyz'
        archive.touch()
        directory = self.root / 'hami'
        directory.mkdir()
        library = directory / 'libvgpu.so'
        library.write_bytes(b'local-library-fixture')
        fd = control.hami_library({'gpuqArchive': str(archive)}, 25)
        try:
            self.assertEqual(os.read(fd, 64), b'local-library-fixture')
        finally:
            os.close(fd)
        with self.assertRaises(ValueError):
            control.hami_library({'gpuqArchive': str(archive)}, 0)

    def copy_with_space(self, remaining):
        source, dest = self.root / 'source', self.root / 'target'
        source.mkdir(); dest.mkdir()
        (source / 'done').write_bytes(b'olddata8')
        (source / 'pending').write_bytes(b'hi')
        shutil.copy2(source / 'done', dest / 'done')
        (dest / 'unrelated').write_bytes(b'x' * 4096)
        actual_run = subprocess.run
        copy_metadata = []

        def command(source, dest, host, meta):
            if meta['phase'] == 'plan':
                flags = ['-rn', '--itemize-changes', '--out-format=%i|%l|%n']
            else:
                copy_metadata.append(meta)
                flags = ['-rt', '--ignore-existing', '--partial-dir=' + sync.PARTIAL]
            return ['rsync', *flags, '--', str(source) + '/', dest + '/']

        def copy(argv, **kwargs):
            meta = copy_metadata[-1]
            header = base64.urlsafe_b64encode(json.dumps(meta).encode()).decode()
            args = ['--server', '-Otre.iLsfxCIvu', '--partial-dir', sync.PARTIAL,
                    '--ignore-existing', '.', str(dest) + '/']
            with patch.object(sync.subprocess, 'Popen') as process:
                process.return_value.wait.return_value = 0
                self.assertEqual(sync.receiver(header, args, 'private-fixture'), 0)
            return actual_run(argv, capture_output=True)

        with patch.object(sync, 'rsync_command', side_effect=command), \
             patch.object(sync.subprocess, 'run', side_effect=copy), \
             patch.object(sync.Config, 'from_json', return_value=SimpleNamespace(root=self.root / 'scheduler')), \
             patch.object(sync.shutil, 'disk_usage', return_value=SimpleNamespace(free=64 * 1024**3 + remaining)):
            result = sync.transfer(source, str(dest), {'ssh': 'local-fixture'}, [], dry_run=False, as_json=True)
        self.assertTrue(result['ready'])
        self.assertEqual((dest / 'pending').read_bytes(), b'hi')
        self.assertEqual((dest / 'done').read_bytes(), b'olddata8')
        self.assertEqual((dest / 'unrelated').stat().st_size, 4096)
        self.assertEqual(len(copy_metadata), 1)

    @unittest.skipUnless(shutil.which('rsync'), 'rsync is not installed')
    def test_resume_only_needs_space_for_pending_files(self):
        self.copy_with_space(remaining=2)

    @unittest.skipUnless(shutil.which('rsync'), 'rsync is not installed')
    def test_unrelated_target_files_do_not_reduce_required_space(self):
        with self.assertRaisesRegex(ValueError, '64 GiB'):
            self.copy_with_space(remaining=1)
        self.assertFalse((self.root / 'target' / 'pending').exists())


if __name__ == '__main__':
    unittest.main()
