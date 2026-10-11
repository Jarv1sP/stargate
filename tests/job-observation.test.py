"""Disposable SQLite/native boundary only; no real GPU, SSH or systemd."""
from contextlib import closing
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'
spec = importlib.util.spec_from_file_location('observation_test_module', DEPLOY / 'job-observation.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Observation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'root'
        (self.root / 'jobs').mkdir(parents=True)
        self.db = self.base / 'gpuq.sqlite'
        self.id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        self.native = 'J0123456789ab'
        self.job = {'id': self.id, 'userId': 'demo-user-1', 'username': 'alice',
                    'cards': 1, 'argv': ['python', 'train.py'], 'name': 'fixture', 'minVramGiB': 0}
        self.file = self.root / 'jobs' / (self.id + '.json')
        self.file.write_text(json.dumps(self.job))
        self.data = {'job': {'id': self.native, 'submit_key': self.id, 'state': 'PENDING', 'version': 7},
                     'attempts': [{'id': 'Aold', 'job_id': self.native, 'ordinal': 1, 'state': 'CANCELED', 'finished_at': 100}],
                     'progress': None}
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('CREATE TABLE jobs(id TEXT PRIMARY KEY, submit_key TEXT, state TEXT, version INTEGER)')
            db.execute('CREATE TABLE events(id INTEGER PRIMARY KEY, job_id TEXT, event_type TEXT, created_at REAL)')
            db.execute('INSERT INTO jobs VALUES(?,?,?,?)', (self.native, self.id, 'PENDING', 7))
            db.executemany('INSERT INTO events VALUES(?,?,?,?)', [(3, self.native, 'JOB_RETRIED', 150),
                (9, self.native, 'JOB_RETRIED', 200), (10, 'Jffffffffffff', 'JOB_RETRIED', 201),
                (11, self.native, 'OTHER_EVENT', 202)])
            db.commit()

    def observe(self, data=None, job=None, expected=None):
        return module.observe(self.root, self.db, self.job if job is None else job,
                              self.data if data is None else data, self.native if expected is None else expected)

    def test_latest_retry_is_exact_job_scoped_and_reads_never_change_files(self):
        before = {p: p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        value = self.observe()
        self.assertEqual(value['status'], 'CONFIRMED')
        self.assertEqual(value['latestRetry'], {'eventId': 9, 'createdAt': 200})
        self.assertTrue(value['specVerified'])
        self.assertEqual(value['latestAttempt']['ordinal'], 1)
        self.assertEqual(before, {p: p.read_bytes() for p in self.base.rglob('*') if p.is_file()})
        self.assertNotIn('argv', json.dumps(value))

    def test_native_revision_or_state_changed_after_show_is_unknown(self):
        for fields in ({'version': 8}, {'state': 'RUNNING'}, {'id': 'Jffffffffffff'}, {'submit_key': 'other'}):
            data = copy.deepcopy(self.data); data['job'].update(fields)
            self.assertEqual(self.observe(data)['status'], 'UNKNOWN')

    def test_spec_owner_command_and_expected_node_are_immutable(self):
        for fields in ({'userId': 'demo-user-2'}, {'argv': ['other']}):
            self.assertEqual(self.observe(job={**self.job, **fields})['status'], 'UNKNOWN')
        self.assertEqual(self.observe(expected='Jffffffffffff')['status'], 'UNKNOWN')
        self.assertEqual(self.observe(expected='../bad')['status'], 'UNKNOWN')

    def test_missing_oversize_and_symlink_spec_are_unknown(self):
        self.file.unlink()
        self.assertEqual(self.observe()['status'], 'UNKNOWN')
        self.file.write_bytes(b' ' * 65537)
        self.assertEqual(self.observe()['status'], 'UNKNOWN')
        self.file.unlink(); source = self.base / 'elsewhere'; source.write_text(json.dumps(self.job)); self.file.symlink_to(source)
        self.assertEqual(self.observe()['status'], 'UNKNOWN')

    def test_missing_event_is_explicit_and_schema_version_zero_is_valid(self):
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('DELETE FROM events'); db.execute('UPDATE jobs SET version=0'); db.commit()
        self.data['job']['version'] = 0
        value = self.observe()
        self.assertEqual(value['status'], 'CONFIRMED'); self.assertIsNone(value['latestRetry'])

    def test_attempt_cross_job_and_corrupt_event_fail_closed(self):
        data = copy.deepcopy(self.data); data['attempts'][0]['job_id'] = 'Jffffffffffff'
        self.assertEqual(self.observe(data)['status'], 'UNKNOWN')
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('UPDATE events SET created_at=1e100 WHERE id=9'); db.commit()
        self.assertEqual(self.observe()['status'], 'UNKNOWN')

    def test_database_unavailable_never_creates_a_new_database(self):
        missing = self.base / 'missing.sqlite'
        value = module.observe(self.root, missing, self.job, self.data, self.native)
        self.assertEqual(value['status'], 'UNKNOWN'); self.assertFalse(missing.exists())

    def load_node(self):
        for name in ('node-executor.py', 'scheduling-policy.py', 'job-observation.py'):
            shutil.copy2(DEPLOY / name, self.base / name)
        (self.base / 'node-config.json').write_text(json.dumps({'root': str(self.root), 'database': str(self.db), 'cards': 1}))
        spec = importlib.util.spec_from_file_location('observation_test_executor', self.base / 'node-executor.py')
        node = importlib.util.module_from_spec(spec); spec.loader.exec_module(node)
        return node

    def test_watch_and_diagnostics_only_show_existing_native_job(self):
        node = self.load_node()
        with patch.object(node, 'platform_root_check'), patch.object(node, 'gpu', return_value=self.data) as gpu, \
                patch.object(node, 'release_datasets', side_effect=AssertionError('no release')), \
                patch.object(node, 'acquire_datasets', side_effect=AssertionError('no acquire')), \
                patch.object(node, 'job_diagnostics', return_value={'state': 'PARTIAL'}):
            for operation in ('watch', 'diagnostics'):
                value = node.process(operation, {'job': self.job, 'expectedNodeJobId': self.native})
                self.assertEqual(value['nativeObservation']['status'], 'CONFIRMED')
                self.assertEqual(gpu.call_args.args, ('show', self.native))
            with self.assertRaises(ValueError):
                node.process('watch', {'job': self.job, 'expectedNodeJobId': self.native, 'retry': True})
            self.assertEqual(gpu.call_count, 2)

    def test_missing_native_row_never_submits(self):
        node = self.load_node()
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('DELETE FROM jobs'); db.commit()
        with patch.object(node, 'platform_root_check'), patch.object(node, 'gpu', side_effect=AssertionError('no GPU call')):
            value = node.process('watch', {'job': self.job, 'expectedNodeJobId': self.native})
            self.assertIsNone(value['nodeJobId']); self.assertEqual(value['nativeObservation']['status'], 'UNKNOWN')
            self.assertEqual(value['dispatchObservation']['state'], 'NOT_SUBMITTED')
            self.assertTrue(value['dispatchObservation']['requestFinished'])
            self.assertEqual(value['dispatchObservation']['submitKey'], self.job['id'])
            self.assertEqual(value['dispatchObservation']['userId'], self.job['userId'])


if __name__ == '__main__':
    unittest.main()
