"""Original-key cancellation with real SQLite; no GPU or training processes."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import threading
import unittest
from unittest.mock import Mock, patch
import uuid

def fixture(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name+'.test.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

F = fixture('gpuq-priority')
N = fixture('project-security')
from gpuq import cli
from gpuq.rpc import ApiError
from gpuq.store import Store, StoreConflictError

class CancelSubmission(unittest.TestCase):
    setUp = F.SchedulerPriorityTests.setUp
    snapshot = F.SchedulerPriorityTests.snapshot
    submit = F.SchedulerPriorityTests.submit
    running = F.SchedulerPriorityTests.running

    def test_cancel_before_submit_is_durable_and_never_allocates(self):
        key = str(uuid.uuid4())
        result = self.coordinator.handle_api('cancel', {'submit_key': key})
        self.assertEqual(result, {'job_id': None, 'state': 'CANCELED', 'not_submitted': True})
        self.assertEqual(self.coordinator.handle_api('cancel', {'submit_key': key}), result)
        self.store.close(); self.store.open()
        with self.assertRaises(StoreConflictError): self.submit(submit_key=key)
        self.assertIsNone(self.store.get_job_by_submit_key(key))
        self.assertEqual(self.store.list_attempts(), [])
        self.assertEqual(self.store.list_leases(), [])

    def test_existing_job_uses_normal_cancel_and_keeps_other_training(self):
        target, attempt = self.running(indices=(0,))
        other, _ = self.running(indices=(1,))
        result = self.coordinator.handle_api('cancel', {'submit_key': target['submit_key']})
        self.assertEqual(result['job_id'], target['id'])
        self.assertEqual(result['state'], 'CANCELED')
        self.assertEqual(self.store.get_job(other['id'])['state'], 'RUNNING')
        self.assertEqual(len(self.store.list_leases(job_id=other['id'])), 1)
        self.assertEqual([a['attempt_id'] for a in self.store.list_actions()], [attempt['id']])

    def test_submit_and_cancel_serialize_across_database_connections(self):
        second = Store(self.config.db_path).open(); self.addCleanup(second.close)
        for _ in range(5):
            key = str(uuid.uuid4()); gate = threading.Barrier(2)
            def submit():
                gate.wait()
                try: return self.submit(submit_key=key)
                except StoreConflictError: return None
            def cancel():
                gate.wait(); return second.cancel_unsubmitted(key)
            with ThreadPoolExecutor(2) as pool:
                submitted, canceled = pool.submit(submit), pool.submit(cancel)
                job, found = submitted.result(5), canceled.result(5)
            if found is None:
                self.assertIsNone(job)
                with self.assertRaises(StoreConflictError): self.submit(submit_key=key)
            else:
                self.assertEqual(found['id'], job['id'])
                self.assertEqual(self.coordinator.handle_api('cancel', {'submit_key': key})['state'], 'CANCELED')

    def test_store_submit_key_length_remains_supported(self):
        key = 'k' * 256
        original = self.submit()
        self.store.cancel_unsubmitted(key)
        with self.assertRaises(StoreConflictError): self.store.submit_job({**original, 'id': 'Jlongkey', 'submit_key': key})

    def test_cancel_uses_the_same_uuid_normalization_as_submit(self):
        original = self.submit(); key = str(uuid.uuid4())
        self.coordinator.handle_api('cancel', {'submit_key': key.upper()})
        with self.assertRaises(ApiError) as error:
            self.coordinator.handle_api('submit', {**original, 'submit_key': key})
        self.assertEqual(error.exception.code, 'BAD_SUBMISSION')
        self.assertIsNone(self.store.get_job_by_submit_key(key))

    def test_cli_preserves_cancel_by_id_and_accepts_original_key(self):
        client = Mock(); client.call.return_value = {'state': 'CANCELED'}
        for argv, args in [(['cancel', 'Jexample'], {'job_id': 'Jexample'}),
                           (['cancel', '--submit-key', 'original'], {'submit_key': 'original'})]:
            with patch.object(cli, 'get_client', return_value=client), redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(['--json', *argv]), 0)
            client.call.assert_called_with('cancel', args)

class NodeCancellation(unittest.TestCase):
    setUp = N.ProjectContract.setUp
    key = N.ProjectContract.key
    node = N.ProjectContract.node

    def pending(self):
        node = self.node(); jid = self.key()
        job = {'id': jid, 'userId': 'alice', 'project': 'demo', 'cards': 1, 'argv': ['python', 'train.py']}
        folder = node.module('project-store').private_dir(node.ROOT/'jobs', create=True)
        node.atomic_json(folder/(jid+'.dispatch.json'), {'state': 'SUBMITTING'})
        node.atomic_json(folder/(jid+'.canceled.json'), {'state': 'CANCEL_REQUESTED'})
        return node, job, folder

    def test_old_dispatch_marker_converges_after_native_cancel_ack(self):
        node, job, folder = self.pending()
        node.gpu = Mock(return_value={'job_id': None, 'state': 'CANCELED', 'not_submitted': True})
        result = node.job_operation('cancel', {'job': job})
        self.assertEqual(result['state'], 'CANCELED'); self.assertTrue(result['notSubmitted'])
        node.gpu.assert_called_once_with('cancel', '--submit-key', job['id'])
        self.assertEqual(json.loads((folder/(job['id']+'.canceled.json')).read_text())['state'], 'CANCELED')
        for operation in ['sync', 'watch']:
            self.assertEqual(node.job_operation(operation, {'job': job})['state'], 'CANCELED')
        self.assertEqual(node.gpu.call_count, 1)
        node.gpu.side_effect=ValueError('offline')
        self.assertEqual(node.job_operation('cancel', {'job': job})['state'], 'CANCELED')
        self.assertEqual(node.gpu.call_count, 1)

    def test_failed_cancel_does_not_fake_completion(self):
        node, job, folder = self.pending(); node.gpu = Mock(side_effect=ValueError('offline'))
        with self.assertRaisesRegex(ValueError, 'offline'): node.job_operation('cancel', {'job': job})
        self.assertEqual(json.loads((folder/(job['id']+'.canceled.json')).read_text())['state'], 'CANCEL_REQUESTED')

    def test_submit_winning_the_lookup_race_still_cancels_the_real_job(self):
        node, job, _ = self.pending()
        def gpu(*args):
            if args[0] == 'cancel':
                with sqlite3.connect(node.CONFIG['database']) as db: db.execute('INSERT INTO jobs VALUES (?,?)', ('Jreal', job['id']))
                return {'job_id': 'Jreal', 'state': 'CANCELED'}
            self.assertEqual(args, ('show', 'Jreal'))
            return {'job': {'state': 'CANCELED'}, 'attempts': []}
        node.gpu = gpu
        result = node.job_operation('cancel', {'job': job})
        self.assertEqual(result['state'], 'CANCELED'); self.assertEqual(result['nodeJobId'], 'Jreal')

if __name__ == '__main__': unittest.main()
