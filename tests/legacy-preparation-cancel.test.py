"""Retired preparation cancellation through existing node lease cleanup.

Real temporary cache and SQLite, no remote host, systemd launch or training.
"""
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
definition = importlib.util.spec_from_file_location('legacy_preparation_fixture', HERE / 'node-datasets.test.py')
fixture = importlib.util.module_from_spec(definition)
definition.loader.exec_module(fixture)


class LegacyPreparationCancel(unittest.TestCase):
    def setUp(self):
        fixture.NodeDatasets.setUp(self)
        for name in ('storage-leases.py', 'project-store.py', 'project-ops.py', 'project-lifecycle.py', 'local-data.py'):
            shutil.copy2(fixture.DEPLOY / name, self.base / name)
        conda = self.base / 'conda'
        for name in ('bin', 'lib', 'conda-meta'):
            (conda / name).mkdir(parents=True)
        (conda / 'bin/python').write_text('fixture only, never executed')
        self.node.CONFIG['conda'] = str(conda)
        self.node.CONFIG['workspaceReserveBytes'] = 0
        self.node.process('projects.create', {'userId': self.job['userId'], 'project': 'legacy'})
        fixture.NodeDatasets.ready(self)
        self.held = {**self.job, 'project': 'legacy', 'release': 'a' * 64,
                     'datasets': [{**self.job['datasets'][0], 'mountAs': 'logical-data'}]}
        self.logical = {**self.held, 'datasets': [{'dataset': 'logical-data', 'version': self.version}]}
        self.node.storage_leases().prepare(self.held)
        self.spec = self.node.ROOT / 'jobs' / (self.job['id'] + '.json')
        self.marker = self.node.ROOT / 'jobs' / (self.job['id'] + '.canceled')

    tearDown = fixture.NodeDatasets.tearDown

    def leases(self):
        return self.cache._leases('example', self.version)

    def test_original_physical_hold_cancels_without_persisting_the_logical_spec(self):
        data = self.cache._paths('example', self.version)['ready'] / 'data' / 'train.txt'
        contents, inode = data.read_bytes(), data.stat().st_ino
        with patch.object(self.node, 'gpu', side_effect=AssertionError('never submit or cancel native training')):
            result = self.node.process('storage.lease.cancel', {'job': self.held})
            repeated = self.node.process('storage.lease.cancel', {'job': self.held})
        self.assertEqual(result, {'jobId': self.job['id'], 'state': 'CANCELED', 'released': True})
        self.assertEqual(repeated, result)
        self.assertEqual(self.leases(), [])
        self.assertFalse(self.spec.exists())
        self.assertTrue(self.marker.exists())
        self.assertEqual(self.cache.status(self.user, 'example', self.version)['state'], 'READY')
        self.assertEqual(data.read_bytes(), contents)
        self.assertEqual(data.stat().st_ino, inode)
        with self.assertRaises(ValueError):
            self.node.process('storage.lease.prepare', {'job': self.held})

    def test_logical_spec_cannot_release_a_different_physical_hold_or_poison_saved_spec(self):
        before = self.leases()
        with patch.object(self.node, 'gpu', side_effect=AssertionError('no native write')):
            with self.assertRaisesRegex(ValueError, 'identity or journal changed'):
                self.node.process('storage.lease.cancel', {'job': self.logical})
            self.assertEqual(self.leases(), before)
            self.assertFalse(self.spec.exists())
            # Exact original hold remains recoverable after the wrong tuple.
            result = self.node.process('storage.lease.cancel', {'job': self.held})
        self.assertTrue(result['released'])
        self.assertEqual(self.leases(), [])

    def test_running_native_job_is_observed_but_not_canceled_or_released(self):
        with closing(sqlite3.connect(self.node.CONFIG['database'])) as database:
            database.execute('INSERT INTO jobs VALUES (?, ?)', ('J' + '1' * 12, self.job['id']))
            database.commit()
        self.spec.write_text(json.dumps(self.held))
        before, contents = self.leases(), self.spec.read_bytes()
        with patch.object(self.node, 'gpu', return_value={'job': {'state': 'RUNNING'}, 'attempts': []}) as gpu:
            with self.assertRaisesRegex(ValueError, 'termination is unconfirmed'):
                self.node.process('storage.lease.cancel', {'job': self.held})
            gpu.assert_called_once_with('show', 'J' + '1' * 12)
        self.assertEqual(self.leases(), before)
        self.assertEqual(self.spec.read_bytes(), contents)
        self.assertFalse(self.marker.exists())

    def test_unconfirmed_dispatch_keeps_original_hold(self):
        attempted = self.node.ROOT / 'jobs' / (self.job['id'] + '.dataset-dispatch-attempted')
        attempted.write_text('{}')
        before = self.leases()
        with patch.object(self.node, 'gpu', side_effect=AssertionError('no native write')):
            with self.assertRaisesRegex(ValueError, 'dispatch is unknown'):
                self.node.process('storage.lease.cancel', {'job': self.held})
        self.assertEqual(self.leases(), before)
        self.assertFalse(self.spec.exists())
        self.assertFalse(self.marker.exists())


if __name__ == '__main__':
    unittest.main()
