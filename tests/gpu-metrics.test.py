"""Reuse scheduler samples, retain per-attempt peaks, never invent zeroes."""
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

loader = importlib.util.spec_from_file_location('metrics_scheduler', Path(__file__).with_name('gpuq-priority.test.py'))
F = importlib.util.module_from_spec(loader)
loader.loader.exec_module(F)


class GpuMetrics(unittest.TestCase):
    setUp = F.SchedulerPriorityTests.setUp
    submit = F.SchedulerPriorityTests.submit
    running = F.SchedulerPriorityTests.running
    snapshot = F.SchedulerPriorityTests.snapshot

    def metrics(self):
        from gpuq import gpu_metrics
        return gpu_metrics

    def sample(self, used, utilization=37):
        return [SimpleNamespace(index=0, uuid='GPU-0', memory_used_mib=used, utilization_percent=utilization)]

    def test_unknown_before_sample_real_zero_after_sample_and_peak_survives_new_reader(self):
        _, attempt = self.running()
        metrics = self.metrics()
        unknown = metrics.read_metrics(attempt, 100)
        self.assertIsNone(unknown['sampledAt'])
        self.assertIsNone(unknown['gpus'][0]['memoryUsedMiB'])
        self.assertIsNone(unknown['gpus'][0]['memoryPeakMiB'])
        for now, used in ((100, 700), (102, 300), (104, 0)):
            metrics.observe(attempt, self.sample(used, 0), now)
        current = metrics.read_metrics(attempt, 104)
        self.assertEqual(current['gpus'][0]['memoryPeakMiB'], 700)
        self.assertEqual(current['gpus'][0]['memoryUsedMiB'], 0)
        self.assertEqual(current['gpus'][0]['utilization'], 0)
        self.assertEqual(current['attemptId'], attempt['id'])
        self.assertEqual(json.loads((Path(attempt['control_dir']) / 'gpu-metrics.json').read_text()), current)

    def test_missing_device_stale_samples_and_finished_attempt_show_current_unknown(self):
        _, attempt = self.running()
        metrics = self.metrics()
        metrics.observe(attempt, self.sample(600), 100)
        for state, now, available in ((attempt, 140, True), ({**attempt, 'state': 'SUCCEEDED'}, 101, True), (attempt, 101, False)):
            with self.subTest(state=state['state'], now=now, available=available):
                gpu = metrics.read_metrics(state, now, available=available)['gpus'][0]
                self.assertIsNone(gpu['utilization'])
                self.assertIsNone(gpu['memoryUsedMiB'])
                self.assertEqual(gpu['memoryPeakMiB'], 600)
        metrics.observe(attempt, [], 102)
        missing = metrics.read_metrics(attempt, 102)['gpus'][0]
        self.assertIsNone(missing['memoryUsedMiB'])
        self.assertEqual(missing['memoryPeakMiB'], 600)

    def test_peak_resets_for_a_new_run_and_shared_cards_have_physical_card_samples(self):
        _, attempt = self.running()
        metrics = self.metrics()
        metrics.observe(attempt, self.sample(600), 100)
        other = {**attempt, 'id': 'Anew', 'control_dir': str(self.root / 'another-attempt')}
        Path(other['control_dir']).mkdir()
        metrics.observe(other, self.sample(200), 101)
        self.assertEqual(metrics.read_metrics(other, 101)['gpus'][0]['memoryPeakMiB'], 200)
        self.assertEqual(metrics.read_metrics(attempt, 101)['gpus'][0]['memoryPeakMiB'], 600)

    def test_unreadable_or_malformed_metrics_do_not_block_job_queries_or_scheduling(self):
        _, attempt = self.running()
        metrics = self.metrics()
        path = Path(attempt['control_dir']) / 'gpu-metrics.json'
        for value in ('{bad', '[]', '{"gpus": null}', '{"gpus": [{}]}'):
            path.write_text(value)
            self.assertIsNone(metrics.read_metrics(attempt, 100)['gpus'][0]['memoryPeakMiB'])
        with patch.object(metrics.os, 'replace', side_effect=OSError('disk full')):
            metrics.observe(attempt, self.sample(1), 100)

    def test_user_writable_control_file_cannot_follow_a_link_or_block_the_scheduler_on_a_fifo(self):
        _, attempt = self.running()
        metrics = self.metrics()
        path = Path(attempt['control_dir']) / 'gpu-metrics.json'
        outside = self.root / 'outside.json'
        outside.write_text(json.dumps({'sampledAt': 100, 'gpus': [{'uuid': 'GPU-0', 'memoryPeakMiB': 999}]}))
        path.symlink_to(outside)
        self.assertIsNone(metrics.read_metrics(attempt, 100)['gpus'][0]['memoryPeakMiB'])
        path.unlink(); os.mkfifo(path)
        self.assertIsNone(metrics.read_metrics(attempt, 100)['gpus'][0]['memoryPeakMiB'])

    def test_gpuq_show_node_diagnostics_and_sync_share_the_same_metrics(self):
        job, attempt = self.running()
        self.metrics().observe(attempt, self.sample(800), self.coordinator.clock())
        self.coordinator._gpu_samples_available = True
        shown = self.coordinator.handle_api('show', {'job_id': job['id']})
        self.assertEqual(shown['gpuMetrics']['gpus'][0]['memoryPeakMiB'], 800)
        loader = importlib.util.spec_from_file_location('node_diagnostics_metrics', Path(__file__).resolve().parents[1] / 'node/job-diagnostics.py')
        diagnostics = importlib.util.module_from_spec(loader); loader.loader.exec_module(diagnostics)
        # No cgroup/capture is needed to see existing scheduler GPU samples.
        with patch.object(diagnostics, '_folder', side_effect=FileNotFoundError):
            bundle = diagnostics.bundle(self.root, {'id': '00000000-0000-4000-8000-000000000001'}, shown)
        self.assertEqual(bundle['gpuMetrics'], shown['gpuMetrics'])

    def test_existing_hardware_poll_updates_peaks_without_another_query_and_failure_is_unknown(self):
        job, attempt = self.running()
        self.snapshot(memory={0: 900})
        self.coordinator.gpu_provider.snapshot.return_value = self.coordinator._snapshot
        self.systemd.status.return_value = SimpleNamespace(
            main_pid=0, invocation_id='a' * 32, is_cleanup_ready=False,
            control_group='/user.slice/gpuq-active.service')
        self.coordinator.tick(); self.coordinator.tick()
        self.assertEqual(self.coordinator.health_name, 'ok')
        self.assertEqual(self.coordinator.gpu_provider.snapshot.call_count, 2)
        shown = self.coordinator.handle_api('show', {'job_id': job['id']})
        self.assertEqual(shown['gpuMetrics']['gpus'][0]['memoryPeakMiB'], 900)
        from gpuq.backends import NvidiaSmiError
        self.coordinator.gpu_provider.snapshot.side_effect = NvidiaSmiError('sample unavailable')
        with self.assertLogs('gpuq.coordinator', level='ERROR'):
            self.coordinator.tick()
        shown = self.coordinator.handle_api('show', {'job_id': job['id']})
        self.assertIsNone(shown['gpuMetrics']['gpus'][0]['memoryUsedMiB'])
        self.assertEqual(shown['gpuMetrics']['gpus'][0]['memoryPeakMiB'], 900)


if __name__ == '__main__':
    unittest.main()
