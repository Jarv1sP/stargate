"""GPUQ queue sampling and GPU process attribution with real SQLite ordering."""
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.util.spec_from_file_location('probe_scheduler_fixture', Path(__file__).with_name('gpuq-priority.test.py'))
F = importlib.util.module_from_spec(loader)
loader.loader.exec_module(F)
loader = importlib.util.spec_from_file_location('node_probe', ROOT / 'node/node-probe.py')
probe = importlib.util.module_from_spec(loader)
loader.loader.exec_module(probe)


class Probe(unittest.TestCase):
    submit = F.SchedulerPriorityTests.submit
    running = F.SchedulerPriorityTests.running
    snapshot = F.SchedulerPriorityTests.snapshot

    def setUp(self):
        F.SchedulerPriorityTests.setUp(self)
        self.config = replace(self.config, managed_gpu_uuids=tuple(f'GPU-{i}' for i in range(8)))
        self.coordinator.config = self.config

    def sample(self, running):
        gpus, memberships = [], {}
        for index, (job, attempt) in enumerate(running):
            pid = 10000 + index
            memberships[pid] = {attempt['unit_name'] + '.service'}
            gpus.append({'index': index, 'processes': [{'pid': pid, 'owner': 'nobody'}]})

        def command(argv, timeout):
            self.assertEqual(argv[:-1], [str(self.root / 'gpu'), '--json', 'q', '--limit'])
            return json.dumps(self.coordinator.handle_api('status', {'limit': int(argv[-1])}))

        with patch.object(probe, 'command', side_effect=command), \
             patch.object(probe, 'probe_gpus', return_value={'gpus': gpus}), \
             patch.object(probe, 'process_cgroups', side_effect=memberships.get):
            return probe.probe({'gpu': str(self.root / 'gpu'), 'dataMountPoints': []})

    def test_running_jobs_and_process_owners_survive_a_large_higher_priority_queue(self):
        (self.root / 'gpu').touch()
        pending = [self.submit(priority=4, name=f'queued-{i}') for i in range(150)]
        running = [self.running((i,), priority=0, name=f'training-{i}', owner='team-member') for i in range(8)]
        # This is the ordering that previously hid every running job.
        self.assertTrue(all(row['state'] == 'PENDING' for row in self.store.list_jobs(limit=100)))
        result = self.sample(running)
        self.assertTrue(result['gpuq']['connected'])
        self.assertEqual([row['id'] for row in result['tasks'] if row['state'] == 'PENDING'],
                         [row['id'] for row in pending[:100]])
        self.assertEqual([row['id'] for row in result['tasks'] if row['state'] == 'RUNNING'],
                         [job['id'] for job, _ in running])
        self.assertEqual(result['gpuq']['limit'], 108)
        self.assertEqual(len(result['tasks']), 108)
        for gpu, (job, _) in zip(result['gpus'], running):
            process = gpu['processes'][0]
            self.assertEqual(process['scheduling']['jobId'], job['id'])
            self.assertEqual(process['task']['id'], job['id'])
            self.assertEqual(process['task']['name'], job['name'])
            self.assertEqual(process['task']['owner'], 'team-member')

    def test_starting_and_preempting_jobs_do_not_use_pending_slots(self):
        (self.root / 'gpu').touch()
        pending = [self.submit(priority=4) for _ in range(101)]
        running = [self.running((i,), priority=0) for i in range(3)]
        for (job, _), state in zip(running, ('STARTING', 'PREEMPTING', 'RUNNING')):
            self.store.update_job(job['id'], state=state)
        result = self.sample(running)
        self.assertEqual(len(result['tasks']), 103)
        self.assertEqual(result['gpuq']['limit'], 103)
        self.assertEqual([row['id'] for row in result['tasks'][:100]], [row['id'] for row in pending[:100]])
        self.assertEqual([gpu['processes'][0]['task']['id'] for gpu in result['gpus']],
                         [job['id'] for job, _ in running])


if __name__ == '__main__':
    unittest.main()
