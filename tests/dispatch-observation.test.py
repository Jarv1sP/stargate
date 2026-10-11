import fcntl
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('dispatch_observation', Path(__file__).resolve().parents[1] / 'deploy' / 'job-observation.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DispatchObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root / 'jobs'
        self.folder.mkdir()
        self.database = self.root / 'gpuq.sqlite'
        with sqlite3.connect(self.database) as db:
            db.execute('CREATE TABLE jobs(id TEXT,submit_key TEXT UNIQUE)')
        self.job = {'id': '11111111-1111-4111-8111-111111111111', 'userId': 'owner', 'argv': ['true']}

    def observe(self):
        return module.observe_dispatch(self.root, self.database, self.job)

    def path(self, suffix):
        return self.folder / (self.job['id'] + suffix)

    def test_absent_original_is_owner_bound_and_read_does_not_create_records(self):
        before = list(self.folder.iterdir())
        value = self.observe()
        self.assertEqual(value['state'], 'NOT_SUBMITTED')
        self.assertTrue(value['requestFinished'])
        self.assertEqual(value['jobId'], self.job['id'])
        self.assertEqual(value['submitKey'], self.job['id'])
        self.assertEqual(value['userId'], self.job['userId'])
        self.assertEqual(list(self.folder.iterdir()), before)

    def test_active_original_dispatch_never_allows_retry(self):
        with self.path('.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertFalse(self.observe()['requestFinished'])
        self.assertTrue(self.observe()['requestFinished'])

    def test_native_record_never_produces_absence(self):
        with sqlite3.connect(self.database) as db:
            db.execute('INSERT INTO jobs VALUES(?,?)', ('J0123456789ab', self.job['id']))
        self.assertEqual(self.observe()['state'], 'UNKNOWN')

    def test_ambiguous_or_canceled_dispatch_retains_original_identity(self):
        for suffix in ('.dataset-dispatch-attempted', '.dataset-not-submitted.json', '.canceled'):
            with self.subTest(suffix=suffix):
                self.path(suffix).touch()
                self.assertFalse(self.observe()['requestFinished'])
                self.path(suffix).unlink()

    def test_changed_or_corrupt_original_spec_is_not_absence(self):
        for value in (json.dumps({**self.job, 'userId': 'other'}), '{'):
            self.path('.json').write_text(value)
            self.assertFalse(self.observe()['requestFinished'])

    def test_fixed_rejection_is_terminal_only_after_lease_cleanup(self):
        self.path('.json').write_text(json.dumps(self.job))
        self.path('.dataset-not-submitted.json').write_text(json.dumps({'schema': 1, 'jobId': self.job['id'], 'failureCode': 'DATASET_NOT_READY'}))
        self.path('.datasets.json').write_text('{}')
        self.assertEqual(self.observe()['state'], 'UNKNOWN')
        self.path('.datasets.json').unlink()
        value = self.observe()
        self.assertEqual(value['state'], 'REJECTED')
        self.assertTrue(value['requestFinished'])
        self.assertEqual(value['jobId'], self.job['id'])
        self.assertEqual(json.loads(self.path('.json').read_text()), self.job)

    def test_other_jobs_rejection_does_not_release_or_authorize_retry(self):
        self.path('.dataset-not-submitted.json').write_text(json.dumps({'schema': 1, 'jobId': 'other', 'failureCode': 'DATASET_NOT_READY'}))
        self.assertEqual(self.observe()['state'], 'UNKNOWN')
        self.assertFalse(self.observe()['requestFinished'])

    def test_database_failure_is_not_absence(self):
        self.database.unlink()
        self.assertEqual(self.observe()['state'], 'UNKNOWN')
        self.assertFalse(self.database.exists())


if __name__ == '__main__':
    unittest.main()
