"""Dataset/executor boundary regression tests; no GPU, SSH or systemd writes."""
import importlib.util
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from storage_test_helpers import local_data_mounts
from dataset_retention_helpers import protected_executor_original


DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'


class NodeDatasets(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.data_mount = local_data_mounts(self.base)
        self.data_mount.start()
        self.addCleanup(self.data_mount.stop)
        for name in ('platform-root-guard.py','node-executor.py', 'scheduling-policy.py', 'dataset-cache.py', 'dataset-upload.py','dataset-archive-intake.py', 'dataset-files.py', 'storage-observation.py', 'sandbox-runner.py', 'storage-quota.py'):
            shutil.copy2(DEPLOY / name, self.base / name)
        self.source = self.base / 'source'
        self.source.mkdir()
        (self.source / 'train.txt').write_text('small immutable training sample\n')
        config = dict(root=str(self.base / 'state'), cards=4, gpu='/not/a/gpu',
                      database=str(self.base / 'gpuq.sqlite'), datasets=dict(
                          root=str(self.base / 'cache'), mountPoint=str(self.base),
                          sources={'approved': str(self.source)}, reserveBytes=0))
        (self.base / 'node-config.json').write_text(json.dumps(config))
        spec = importlib.util.spec_from_file_location('node_dataset_test', self.base / 'node-executor.py')
        self.node = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.node)
        self.node.workspace('demo-user-1')
        (self.node.ROOT / 'jobs').mkdir()
        with closing(sqlite3.connect(config['database'])) as db:
            db.execute('CREATE TABLE jobs (id TEXT, submit_key TEXT)')
            db.commit()
        self.mount_patch = patch.object(self.node, 'dataset_mount_check')
        self.mount_patch.start()
        self.module, self.cache = self.node.dataset_cache()
        self.admin = self.module.Principal('builtin-admin', True)
        self.user = self.module.Principal('demo-user-1')
        record = self.cache.register_source(self.admin, 'example', 'approved', ['demo-user-1'])
        self.version = record['version']
        self.retention = protected_executor_original(self.node, self.base/'retention-original')
        self.retention.bind_cache(self.cache)
        self.job = dict(id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', userId='demo-user-1',
                        username='alice', cards=1, argv=['python', 'train.py'],
                        name='dataset-test', minVramGiB=0,
                        datasets=[dict(dataset='example', version=self.version)])

    def test_dataset_quota_cohort_is_bound_to_registered_billing_owner(self):
        self.node.CONFIG['storageQuota'] = {'enabled': True, 'owners': ['demo-user-1']}
        _, cache = self.node.dataset_cache()
        target = self.base/'stage'
        with patch.object(self.node, 'storage_quota') as quota:
            cache.quota_guard(self.admin, 'example', target)
            quota.assert_called_once_with('demo-user-1', target)
            cache.set_owners(self.admin, 'example', ['demo-user-1', 'demo-user-2'])
            with self.assertRaisesRegex(ValueError, 'Shared dataset'):
                cache.quota_guard(self.user, 'example', target)
            self.assertEqual(quota.call_count, 1)

    def test_all_legacy_dataset_owners_keep_existing_cohort_behavior(self):
        self.node.CONFIG['storageQuota'] = {'enabled': True, 'owners': ['demo-user-3']}
        _, cache = self.node.dataset_cache()
        cache.set_owners(self.admin, 'example', ['demo-user-1', 'demo-user-2'])
        with patch.object(self.node, 'storage_quota', side_effect=AssertionError):
            cache.quota_guard(self.user, 'example', self.base/'stage')

    def tearDown(self):
        self.mount_patch.stop()
        # Published cache trees are intentionally read-only, including on macOS.
        for directory, dirs, files in os.walk(self.base):
            os.chmod(directory, 0o700)
            for name in files:
                path = Path(directory) / name
                if not path.is_symlink():
                    os.chmod(path, 0o600)
        self.temp.cleanup()

    def call(self, action, **args):
        return self.node.dataset_op('datasets.' + action, {'userId': 'demo-user-1', **args})

    def ready(self):
        return self.cache.materialize(self.user, 'example', self.version)

    def start_prepare(self):
        with patch.object(self.node, 'dataset_background_active', return_value=False), \
                patch.object(self.node, 'run', return_value='') as run:
            response = self.call('prepare', dataset='example', version=self.version)
        return response, run.call_args

    def test_old_job_spec_remains_valid(self):
        old = {key: value for key, value in self.job.items() if key != 'datasets'}
        self.node.validate_job(old)
        self.node.validate_job(self.job)
        with self.assertRaises(ValueError):
            self.node.validate_job(dict(old, sourcePath='/tmp'))

    def test_personal_upload_node_routing_never_inherits_administrator(self):
        import hashlib
        manifest = b'{"schema":1,"directories":[],"files":[]}'
        args = dict(userId='demo-user-1',hostAdmin=False,name='mine',
            key='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',manifestBytes=len(manifest),
            manifestSha256=hashlib.sha256(manifest).hexdigest(),totalBytes=0,entries=0)
        with patch.object(self.node, 'gpu') as gpu:
            result = self.node.process('datasets.upload.begin', args)
            self.assertEqual(result['state'], 'RECEIVING_MANIFEST')
            gpu.assert_not_called()
        for value in (True, 0, 1, 'false'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.node.process('datasets.upload.begin', dict(args,hostAdmin=value))
        with patch.object(self.node, 'dataset_mount_check', side_effect=ValueError('missing mount')):
            with self.assertRaisesRegex(ValueError, 'missing mount'):
                self.node.process('datasets.upload.status', dict(userId='demo-user-1',uploadId=args['key']))

    def test_dataset_references_are_strict(self):
        invalid = [None, {}, [dict(dataset='../data', version=self.version)],
                   [dict(dataset='example', version='latest')],
                   [dict(dataset='example', version=self.version, path='/secret')],
                   self.job['datasets'] * 2, self.job['datasets'] * 17]
        for refs in invalid:
            with self.subTest(refs=refs), self.assertRaises(ValueError):
                self.node.dataset_refs(dict(self.job, datasets=refs))

    def test_listing_is_authorized_and_has_no_source_paths(self):
        result = self.call('list')
        self.assertEqual(result['datasets'][0]['dataset'], 'example')
        self.assertNotIn(str(self.source), json.dumps(result))
        other = self.call('list', userId='demo-user-2')
        self.assertEqual(other, {'datasets': []})

    def test_prepare_worker_and_status_have_bounded_contention_scopes(self):
        task,_=self.start_prepare();self.cache.lock_timeout=.01
        with patch.object(self.node,'dataset_cache',return_value=(self.module,self.cache)),ThreadPoolExecutor() as pool:
            with self.cache._locked():
                future=pool.submit(self.node.dataset_worker,task['operationId'])
                time.sleep(.08);self.assertFalse(future.done())
            self.assertEqual(future.result(2),0)
            with self.cache._locked():
                future=pool.submit(self.call,'status',dataset='example',version=self.version)
                time.sleep(.08);self.assertFalse(future.done())
            self.assertEqual(future.result(2)['state'],'READY')
        self.assertIsNone(self.module._LOCK_WAIT.get())

    def test_worker_mount_failure_still_records_failure_without_lock_retry(self):
        task,_=self.start_prepare()
        with patch.object(self.node,'dataset_mount_check',side_effect=ValueError('missing mount')) as check:
            self.assertEqual(self.node.dataset_worker(task['operationId']),1)
        self.assertEqual(check.call_count,1)
        result=json.loads((self.node.ROOT/'dataset-ops'/(task['operationId']+'.result.json')).read_text())
        self.assertEqual(result['state'],'FAILED');self.assertEqual(result['error'],'missing mount')

    def test_internal_mount_alias_changes_name_not_ownership_or_lease(self):
        self.ready()
        job=dict(self.job,datasets=[dict(dataset='example',version=self.version,mountAs='logical-data')])
        self.node.validate_job(job)
        opened=self.node.dataset_open_mounts(job)
        try:
            self.assertEqual(opened[0][1],'/data2/logical-data')
            fd=os.open('train.txt',os.O_RDONLY,dir_fd=opened[0][0])
            try:self.assertEqual(os.read(fd,100),b'small immutable training sample\n')
            finally:os.close(fd)
        finally:
            for fd,_ in opened:os.close(fd)
        with self.assertRaises(PermissionError):self.node.acquire_datasets(dict(job,userId='demo-user-2'))
        for alias in ('../secret','/etc','',None):
            with self.subTest(alias=alias),self.assertRaises(ValueError):
                self.node.dataset_refs(dict(job,datasets=[dict(dataset='example',version=self.version,mountAs=alias)]))
        with self.assertRaises(ValueError):
            self.node.dataset_refs(dict(job,datasets=[dict(dataset='example',version=self.version,mountAs='same'),dict(dataset='other',version=self.version,mountAs='same')]))

    def test_raw_actor_admin_and_paths_are_rejected(self):
        for extra in ({'actor': {'is_admin': True}}, {'admin': True}, {'path': '/data2'}, {'hostAdmin': 1}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.call('list', **extra)

    def test_unready_job_never_calls_gpu(self):
        with patch.object(self.node, 'gpu') as gpu:
            result = self.node.process('sync', {'job': self.job})
        gpu.assert_not_called()
        self.assertEqual(result['state'], 'FAILED')
        self.assertTrue(result['notSubmitted'])
        self.assertEqual(result['failureCode'], 'DATASET_NOT_READY')
        self.assertFalse((self.node.ROOT / 'jobs' / (self.job['id'] + '.dataset-dispatch-attempted')).exists())

    def test_evicted_after_preparation_is_terminal_and_cannot_submit_on_retry(self):
        self.ready()
        self.cache.evict(self.admin, 'example', self.version)
        with patch.object(self.node, 'gpu') as gpu:
            first = self.node.process('sync', {'job': self.job})
            self.ready()
            self.assertEqual(self.node.process('sync', {'job': self.job}), first)
            self.assertEqual(self.node.process('cancel', {'job': self.job}), first)
        gpu.assert_not_called()
        self.assertTrue(first['notSubmitted'])
        # Recovery requires a new immutable job identity, not reuse of the
        # rejected key after the cache happens to become READY again.
        new_job = dict(self.job, id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
        with patch.object(self.node, 'gpu', side_effect=[{'job_id': 'new-job'}, {'job': {'state': 'QUEUED'}, 'attempts': []}]) as gpu:
            self.assertEqual(self.node.process('sync', {'job': new_job})['state'], 'QUEUED')
        self.assertEqual(gpu.call_args_list[0].args[0], 'submit')

    def test_concurrent_same_job_rejection_is_serialized_by_real_job_flock(self):
        entered = threading.Event()
        proceed = threading.Event()
        original = self.node.acquire_datasets

        def paused(job):
            entered.set()
            if not proceed.wait(5):
                raise AssertionError('test did not release acquisition')
            return original(job)

        with patch.object(self.node, 'acquire_datasets', side_effect=paused) as acquire, patch.object(self.node, 'gpu') as gpu, ThreadPoolExecutor(max_workers=2) as workers:
            first = workers.submit(self.node.process, 'sync', {'job': self.job})
            self.assertTrue(entered.wait(5))
            second = workers.submit(self.node.process, 'sync', {'job': self.job})
            proceed.set()
            first_result = first.result(timeout=5)
            self.assertEqual(second.result(timeout=5), first_result)
        self.assertTrue(first_result['notSubmitted'])
        self.assertEqual(acquire.call_count, 1)
        gpu.assert_not_called()

    def test_native_database_failure_does_not_issue_unsubmitted_proof(self):
        with patch.object(self.node.sqlite3, 'connect', side_effect=sqlite3.OperationalError('unavailable')), patch.object(self.node, 'gpu') as gpu:
            with self.assertRaisesRegex(sqlite3.OperationalError, 'unavailable'):
                self.node.process('sync', {'job': self.job})
        self.assertFalse((self.node.ROOT / 'jobs' / (self.job['id'] + '.dataset-not-submitted.json')).exists())
        gpu.assert_not_called()

    def test_eviction_between_check_and_lease_cleans_only_this_jobs_partial_leases(self):
        self.ready()
        self.cache.register_source(self.admin, 'second', 'approved', ['demo-user-1'])
        self.cache.materialize(self.user, 'second', self.version)
        self.cache.set_owners(self.admin, 'example', ['demo-user-1', 'demo-user-2'])
        other = self.cache.acquire_lease(self.module.Principal('demo-user-2'), 'example', self.version, self.job['id'])
        other_job = self.cache.acquire_lease(self.user, 'example', self.version, 'different-job')
        job = dict(self.job, datasets=self.job['datasets'] + [dict(dataset='second', version=self.version)])
        original = self.module.DatasetCache.acquire_lease

        def acquire(cache, actor, dataset, version, job_id):
            if dataset == 'second':
                self.cache.evict(self.admin, dataset, version)
            return original(cache, actor, dataset, version, job_id)

        with patch.object(self.module.DatasetCache, 'acquire_lease', new=acquire), patch.object(self.node, 'gpu') as gpu:
            result = self.node.process('sync', {'job': job})
        gpu.assert_not_called()
        self.assertEqual(result['state'], 'FAILED')
        leases = self.cache._leases('example', self.version)
        self.assertEqual({lease['id'] for lease in leases}, {other['leaseId'], other_job['leaseId']})
        self.assertFalse((self.node.ROOT / 'jobs' / (job['id'] + '.datasets.json')).exists())

    def test_unsubmitted_rejection_recovers_unrecorded_lease_and_retries_cleanup(self):
        self.ready()
        self.cache.acquire_lease(self.user, 'example', self.version, self.job['id'])
        self.cache.register_source(self.admin, 'second', 'approved', ['demo-user-1'])
        job = dict(self.job, datasets=self.job['datasets'] + [dict(dataset='second', version=self.version)])
        receipt = self.node.ROOT / 'jobs' / (job['id'] + '.dataset-not-submitted.json')
        with patch.object(self.module.DatasetCache, 'release_lease', side_effect=OSError('cleanup unavailable')), patch.object(self.node, 'gpu') as gpu:
            with self.assertRaisesRegex(OSError, 'cleanup unavailable'):
                self.node.process('sync', {'job': job})
        self.assertTrue(receipt.exists())
        self.assertEqual(len(self.cache._leases('example', self.version)), 1)
        gpu.assert_not_called()
        self.cache.materialize(self.user, 'second', self.version)
        with patch.object(self.node, 'gpu') as gpu:
            result = self.node.process('sync', {'job': job})
        self.assertTrue(result['notSubmitted'])
        self.assertEqual(self.cache._leases('example', self.version), [])
        gpu.assert_not_called()

    def test_rejection_receipt_write_failure_does_not_release_leases_or_claim_terminal(self):
        self.ready()
        self.cache.acquire_lease(self.user, 'example', self.version, self.job['id'])
        self.cache.register_source(self.admin, 'second', 'approved', ['demo-user-1'])
        job = dict(self.job, datasets=self.job['datasets'] + [dict(dataset='second', version=self.version)])
        with patch.object(self.node, 'atomic_json', side_effect=OSError('read only')), patch.object(self.node, 'gpu') as gpu:
            with self.assertRaisesRegex(OSError, 'read only'):
                self.node.process('sync', {'job': job})
        self.assertEqual(len(self.cache._leases('example', self.version)), 1)
        gpu.assert_not_called()

    def test_dispatch_timeout_is_unknown_and_never_resubmits_or_releases(self):
        self.ready()
        with patch.object(self.node, 'gpu', side_effect=subprocess.TimeoutExpired('gpuq submit', 18)) as gpu:
            with self.assertRaises(subprocess.TimeoutExpired):
                self.node.process('sync', {'job': self.job})
        self.assertEqual(gpu.call_count, 1)
        with patch.object(self.node, 'gpu') as gpu:
            result = self.node.process('sync', {'job': self.job})
            canceled = self.node.process('cancel', {'job': self.job})
        self.assertEqual(result['state'], 'UNKNOWN')
        self.assertEqual(canceled['state'], 'UNKNOWN')
        self.assertNotIn('notSubmitted', result)
        self.assertEqual(len(self.cache._leases('example', self.version)), 1)
        gpu.assert_not_called()

    def test_even_broken_dispatch_marker_blocks_terminal_claim_and_new_submission(self):
        marker = self.node.ROOT / 'jobs' / (self.job['id'] + '.dataset-dispatch-attempted')
        marker.symlink_to(self.base / 'absent-marker-target')
        with patch.object(self.node, 'gpu') as gpu:
            result = self.node.process('sync', {'job': self.job})
        self.assertEqual(result['state'], 'UNKNOWN')
        self.assertNotIn('notSubmitted', result)
        gpu.assert_not_called()

    def test_existing_native_submission_overrides_unready_cache(self):
        with closing(sqlite3.connect(self.node.CONFIG['database'])) as db:
            db.execute('INSERT INTO jobs VALUES (?, ?)', ('native-job', self.job['id']))
            db.commit()
        with patch.object(self.node, 'acquire_datasets', side_effect=AssertionError('already submitted')), patch.object(self.node, 'gpu', return_value={'job': {'state': 'RUNNING'}, 'attempts': []}) as gpu:
            result = self.node.process('sync', {'job': self.job})
        self.assertEqual(result['state'], 'RUNNING')
        self.assertNotIn('notSubmitted', result)
        gpu.assert_called_once_with('show', 'native-job')

    def test_native_row_or_marker_appearing_during_preflight_stays_unknown(self):
        for evidence in ('row', 'marker'):
            with self.subTest(evidence=evidence):
                def interrupted(job):
                    if evidence == 'row':
                        with closing(sqlite3.connect(self.node.CONFIG['database'])) as db:
                            db.execute('INSERT INTO jobs VALUES (?, ?)', ('native-job', job['id']))
                            db.commit()
                    else:
                        (self.node.ROOT / 'jobs' / (job['id'] + '.dataset-dispatch-attempted')).touch()
                    raise self.node.DatasetNotReady('not READY')
                with patch.object(self.node, 'acquire_datasets', side_effect=interrupted), patch.object(self.node, 'gpu') as gpu:
                    result = self.node.process('sync', {'job': self.job})
                self.assertEqual(result['state'], 'UNKNOWN')
                self.assertNotIn('notSubmitted', result)
                gpu.assert_not_called()
                with closing(sqlite3.connect(self.node.CONFIG['database'])) as db:
                    db.execute('DELETE FROM jobs');db.commit()

    def test_unrelated_storage_errors_and_corrupt_receipts_fail_closed(self):
        self.ready()
        with patch.object(self.module.DatasetCache, 'acquire_lease', side_effect=self.module.CacheError('I/O failed')), patch.object(self.node, 'gpu') as gpu:
            with self.assertRaisesRegex(self.module.CacheError, 'I/O failed'):
                self.node.process('sync', {'job': self.job})
        gpu.assert_not_called()
        with patch.object(self.node, 'dataset_mount_check', side_effect=OSError('missing mount')), patch.object(self.node, 'gpu') as gpu:
            with self.assertRaisesRegex(OSError, 'missing mount'):
                self.node.process('sync', {'job': self.job})
        gpu.assert_not_called()
        receipt = self.node.ROOT / 'jobs' / (self.job['id'] + '.dataset-not-submitted.json')
        receipt.write_text(json.dumps({'schema': 1, 'jobId': 'other', 'failureCode': 'DATASET_NOT_READY'}))
        with patch.object(self.node, 'gpu') as gpu, self.assertRaisesRegex(ValueError, 'Invalid dataset rejection receipt'):
            self.node.process('sync', {'job': self.job})
        gpu.assert_not_called()

    def test_administrator_training_still_requires_explicit_dataset_ownership(self):
        self.ready()
        # Management visibility is broader than personal training access. The
        # trusted job specification never inherits a client/admin override.
        self.assertEqual(self.cache.status(self.admin, 'example', self.version)['state'], 'READY')
        admin_job = dict(self.job, userId='builtin-admin', username='admin')
        with patch.object(self.node, 'gpu') as gpu, self.assertRaisesRegex(PermissionError, 'dataset owner authorization required'):
            self.node.process('sync', {'job': admin_job})
        gpu.assert_not_called()
        self.cache.set_owners(self.admin, 'example', ['demo-user-1', 'builtin-admin'])
        self.assertTrue(self.node.acquire_datasets(admin_job)[0]['readOnly'])

    def test_prepare_runs_in_independent_fixed_background_unit(self):
        response, called = self.start_prepare()
        self.assertEqual(response['state'], 'PREPARING')
        self.assertEqual(self.cache.status(self.user, 'example', self.version)['state'], 'REGISTERED')
        argv = called.args[0]
        self.assertEqual(argv[:3], ['/usr/bin/systemd-run', '--user', '--collect'])
        self.assertIn('--property=KillMode=control-group', argv)
        self.assertIn('--property=RuntimeMaxSec=86400', argv)
        self.assertEqual(argv[-2:], ['--dataset-worker', response['operationId']])
        self.assertEqual(called.kwargs['timeout'], 8)
        self.assertNotIn(str(self.source), argv)

    def test_background_prepare_completes_and_status_is_current(self):
        response, _ = self.start_prepare()
        self.assertEqual(self.node.dataset_worker(response['operationId']), 0)
        result = self.call('status', operationId=response['operationId'])
        self.assertEqual(result['state'], 'READY')
        self.assertNotIn(str(self.source), json.dumps(result))
        self.assertNotIn('token', result)
        self.assertEqual(self.call('status', dataset='example', version=self.version)['state'], 'READY')

    def test_completed_receipt_does_not_resurrect_evicted_cache(self):
        response, _ = self.start_prepare()
        self.node.dataset_worker(response['operationId'])
        self.cache.evict(self.admin, 'example', self.version)
        self.assertEqual(self.call('status', operationId=response['operationId'])['state'], 'REGISTERED')
        self.assertEqual(self.call('status', dataset='example', version=self.version)['state'], 'REGISTERED')

    def test_interrupted_worker_is_not_permanently_preparing(self):
        response, _ = self.start_prepare()
        with patch.object(self.node, 'dataset_background_active', return_value=False):
            self.assertEqual(self.call('status', operationId=response['operationId'])['state'], 'FAILED')
        with patch.object(self.node, 'dataset_background_active', return_value=True):
            self.assertEqual(self.call('status', operationId=response['operationId'])['state'], 'PREPARING')

    def test_list_exposes_preparing_and_retryable_failed_states(self):
        self.start_prepare()
        with patch.object(self.node, 'dataset_background_active', return_value=True):
            self.assertEqual(self.call('list')['datasets'][0]['versions'][0]['state'], 'PREPARING')
        with patch.object(self.node, 'dataset_background_active', return_value=False):
            version = self.call('list')['datasets'][0]['versions'][0]
            self.assertEqual(version['state'], 'FAILED')
            self.assertNotIn(str(self.source), json.dumps(version))
        self.ready()
        self.assertEqual(self.call('list')['datasets'][0]['versions'][0]['state'], 'READY')

    def test_list_pending_overlay_reuses_one_full_manifest_validation(self):
        self.start_prepare()
        record = self.module.DatasetCache._record
        with patch.object(self.module.DatasetCache, '_record', autospec=True, side_effect=record) as read, \
                patch.object(self.node, 'dataset_background_active', return_value=True):
            result = self.call('list')
        self.assertEqual(result['datasets'][0]['versions'][0]['state'], 'PREPARING')
        self.assertEqual(read.call_count, 1)

    def test_list_pending_display_does_not_reenter_real_global_writer_lock(self):
        response, _ = self.start_prepare()
        with self.cache._locked(), \
                patch.object(self.module.DatasetCache, '_locked', side_effect=AssertionError('display reentered writer lock')), \
                patch.object(self.node, 'dataset_background_active', return_value=True):
            result = self.call('list')
        self.assertEqual(result['datasets'][0]['versions'][0]['state'], 'PREPARING')
        self.assertEqual(result['datasets'][0]['versions'][0]['operationId'], response['operationId'])

    def test_list_pending_overlay_rechecks_revoked_acl_after_catalog(self):
        self.start_prepare()
        snapshot = self.module.DatasetCache._list_datasets_snapshot
        def revoke(cache, actor):
            result = snapshot(cache, actor)
            self.cache.set_owners(self.admin, 'example', ['demo-user-2'])
            return result
        with patch.object(self.module.DatasetCache, '_list_datasets_snapshot', autospec=True, side_effect=revoke), \
                patch.object(self.node, 'dataset_background_active', return_value=True):
            with self.assertRaises(PermissionError): self.call('list')

    def test_list_pending_overlay_rejects_new_ready_identity_not_stale_state(self):
        self.start_prepare()
        snapshot = self.module.DatasetCache._list_datasets_snapshot
        def publish(cache, actor):
            result = snapshot(cache, actor)
            self.ready()
            return result
        with patch.object(self.module.DatasetCache, '_list_datasets_snapshot', autospec=True, side_effect=publish), \
                patch.object(self.node, 'dataset_background_active', return_value=True):
            with self.assertRaisesRegex(self.module.CacheError, 'metadata changed'): self.call('list')

    def test_shared_owner_reuses_one_active_prepare_without_initiator_identity(self):
        self.cache.register_source(self.admin, 'shared', 'approved', ['demo-user-1', 'demo-user-2'])
        with patch.object(self.node, 'dataset_background_active', return_value=False), patch.object(self.node, 'run'):
            first = self.call('prepare', dataset='shared', version=self.version)
        with patch.object(self.node, 'dataset_background_active', return_value=True), patch.object(self.node, 'run') as run:
            second = self.call('prepare', dataset='shared', version=self.version, userId='demo-user-2')
            result = self.call('list', userId='demo-user-2')
        run.assert_not_called()
        self.assertEqual(first['operationId'], second['operationId'])
        self.assertEqual(result['datasets'][0]['versions'][0]['state'], 'PREPARING')
        # Authorized ACL owner IDs are now deliberate node-to-portal metadata;
        # they still do not identify which co-owner started the shared worker.
        self.assertEqual(result['datasets'][0]['ownerIds'], ['demo-user-1', 'demo-user-2'])
        self.assertNotIn('demo-user-1', json.dumps(result['datasets'][0]['versions']))
        self.assertNotIn('userId', json.dumps(result))

    def test_operation_status_cannot_read_another_users_request(self):
        response, _ = self.start_prepare()
        with self.assertRaisesRegex(ValueError, 'not owned'):
            self.call('status', operationId=response['operationId'], userId='demo-user-2')
        with self.assertRaises(ValueError):
            self.call('status', operationId=response['operationId'], dataset='example')

    def test_register_requires_admin_approved_source_and_explicit_owners(self):
        args = dict(dataset='other', sourceId='approved', owners=['demo-user-1'])
        with self.assertRaisesRegex(ValueError, 'Administrator'):
            self.call('register', **args)
        for update in ({'sourceId': '/tmp/arbitrary'}, {'owners': []}, {'owners': ['root']}, {'path': '/tmp'}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                self.call('register', hostAdmin=True, **{**args, **update})
        with patch.object(self.node, 'dataset_background_active', return_value=False), patch.object(self.node, 'run'):
            response = self.call('register', hostAdmin=True, **args)
        self.assertEqual(response['state'], 'REGISTERING')
        self.assertEqual(self.node.dataset_worker(response['operationId']), 0)
        self.assertEqual(self.call('status', operationId=response['operationId'])['state'], 'REGISTERED')

    def test_worker_request_tampering_fails_before_execution(self):
        response, _ = self.start_prepare()
        path = self.node.ROOT / 'dataset-ops' / (response['operationId'] + '.json')
        task = json.loads(path.read_text())
        task['hostAdmin'] = True
        path.write_text(json.dumps(task))
        with self.assertRaisesRegex(ValueError, 'modified'):
            self.node.dataset_worker(response['operationId'])

    def test_mount_failure_blocks_before_cache_creation(self):
        with patch.object(self.node, 'dataset_mount_check', side_effect=ValueError('missing mount')), \
                patch.object(self.module, 'DatasetCache') as constructor:
            with self.assertRaisesRegex(ValueError, 'missing mount'):
                self.call('list')
            constructor.assert_not_called()

    def test_missing_source_worker_fails_without_private_path_leak(self):
        response, _ = self.start_prepare()
        shutil.rmtree(self.source)
        self.assertEqual(self.node.dataset_worker(response['operationId']), 1)
        result = self.call('status', operationId=response['operationId'])
        self.assertEqual(result['state'], 'FAILED')
        self.assertNotIn(str(self.source), json.dumps(result))

    def test_lease_is_idempotent_and_prevents_eviction(self):
        self.ready()
        first = self.node.acquire_datasets(self.job)
        self.assertEqual(first, self.node.acquire_datasets(self.job))
        self.assertTrue(first[0]['readOnly'])
        with self.assertRaisesRegex(self.module.CacheError, 'leases'):
            self.cache.evict(self.admin, 'example', self.version)

    def test_sandbox_mount_is_pinned_specific_dataset_directory(self):
        self.ready()
        mounts = self.node.dataset_open_mounts(self.job)
        try:
            self.assertEqual(len(mounts), 1)
            fd, target = mounts[0]
            self.assertEqual(target, '/data2/example')
            self.assertEqual(os.listdir(fd), ['train.txt'])
            self.assertTrue(os.fstat(fd).st_ino)
        finally:
            for fd, _ in mounts:
                os.close(fd)
        code = (DEPLOY / 'sandbox-runner.py').read_text()
        self.assertIn("dataset_fds=open_input_mounts(cfg,spec,terminal)", code)
        self.assertIn("mounts=[] if terminal else open_dataset_mounts(spec)", code)
        self.assertIn("local_module('gpuq_shared_data','shared-data.py').open_mounts(cfg)", code)
        self.assertIn("['--ro-bind-fd',str(descriptor),target]", code)
        self.assertNotIn("'--bind','/data2'", code)

    def test_running_unknown_and_incomplete_termination_retain_leases(self):
        self.ready()
        self.node.acquire_datasets(self.job)
        for data in ({'job': {'state': 'RUNNING'}, 'attempts': []},
                     {'job': {'state': 'LOST'}, 'attempts': []},
                     {'job': {'state': 'SUCCEEDED'}},
                     {'job': {'state': 'SUCCEEDED'}, 'attempts': [dict(state='DRAINING', unit_name='gpuq-a123')]}):
            self.assertFalse(self.node.release_datasets(self.job, data))
        with self.assertRaises(self.module.CacheError):
            self.cache.evict(self.admin, 'example', self.version)

    def test_confirmed_terminated_job_releases_lease(self):
        self.ready()
        self.node.acquire_datasets(self.job)
        stopped = SimpleNamespace(returncode=0, stdout='LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=\n')
        data = {'job': {'state': 'SUCCEEDED'}, 'attempts': [dict(state='EXITED_SUCCESS', unit_name='gpuq-a123')], 'leases': [], 'scale_up_reservations': []}
        with patch.object(self.node.subprocess, 'run', return_value=stopped):
            self.assertTrue(self.node.release_datasets(self.job, data))
        self.assertTrue(self.cache.evict(self.admin, 'example', self.version)['evicted'])

    def test_missing_legacy_receipt_recovers_only_exact_stopped_job_holds(self):
        self.ready()
        self.node.acquire_datasets(self.job)
        (self.node.ROOT/'jobs'/(self.job['id']+'.datasets.json')).unlink()
        self.cache.set_owners(self.admin,'example',['demo-user-1','demo-user-2'])
        other_job=self.cache.acquire_lease(self.user,'example',self.version,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
        other_owner=self.cache.acquire_lease(self.module.Principal('demo-user-2'),'example',self.version,self.job['id'])
        stopped=SimpleNamespace(returncode=0,stdout='LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=\n')
        data={'job':{'state':'FAILED'},'attempts':[dict(state='EXITED_FAILURE',unit_name='gpuq-a123')],'leases':[],'scale_up_reservations':[]}
        with patch.object(self.node.subprocess,'run',return_value=stopped):
            self.assertTrue(self.node.release_datasets(self.job,data))
            self.assertTrue(self.node.release_datasets(self.job,data))
        self.assertEqual({x['id'] for x in self.cache._leases('example',self.version)},
                         {other_job['leaseId'],other_owner['leaseId']})

    def test_missing_receipt_never_implies_worker_stopped(self):
        self.ready();self.node.acquire_datasets(self.job)
        (self.node.ROOT/'jobs'/(self.job['id']+'.datasets.json')).unlink()
        before=self.cache._leases('example',self.version)
        data={'job':{'state':'FAILED'},'attempts':[dict(state='EXITED_FAILURE',unit_name='gpuq-a123')],'leases':[],'scale_up_reservations':[]}
        with patch.object(self.node,'dataset_unit_stopped',return_value=False):
            self.assertFalse(self.node.release_datasets(self.job,data))
        self.assertEqual(self.cache._leases('example',self.version),before)

    def test_missing_receipt_cleanup_failure_is_retryable_not_success(self):
        self.ready();self.node.acquire_datasets(self.job)
        (self.node.ROOT/'jobs'/(self.job['id']+'.datasets.json')).unlink()
        data={'job':{'state':'FAILED'},'attempts':[],'leases':[],'scale_up_reservations':[]}
        with patch.object(self.module.DatasetCache,'release_lease',side_effect=OSError('disk temporarily unavailable')):
            with self.assertRaises(OSError):self.node.release_datasets(self.job,data)
        self.assertEqual(len(self.cache._leases('example',self.version)),1)
        self.assertTrue(self.node.release_datasets(self.job,data))
        self.assertEqual(self.cache._leases('example',self.version),[])

    def test_unit_must_be_terminal_and_have_no_processes(self):
        for state in ('RUNNING', 'LOST', 'KILL_REQUESTED', 'DRAINING', 'STUCK'):
            self.assertFalse(self.node.dataset_unit_stopped(dict(state=state, unit_name='gpuq-a123')))
        self.assertFalse(self.node.dataset_unit_stopped(dict(state='EXITED_SUCCESS', unit_name='ssh.service')))
        for stdout in ('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\nControlGroup=\n',
                       'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=/../../etc\n'):
            with patch.object(self.node.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=stdout)):
                self.assertFalse(self.node.dataset_unit_stopped(dict(state='EXITED_SUCCESS', unit_name='gpuq-a123')))

    def test_populated_cgroup_retains_lease(self):
        result = SimpleNamespace(returncode=0, stdout='LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=/user.slice/gpuq-a123.service\n')
        with patch.object(self.node.subprocess, 'run', return_value=result), patch.object(Path, 'read_text', return_value='populated 1\nfrozen 0\n'):
            self.assertFalse(self.node.dataset_unit_stopped(dict(state='EXITED_SUCCESS', unit_name='gpuq-a123')))

    def test_remain_after_exit_and_collected_units_are_confirmed_stopped(self):
        for result in (SimpleNamespace(returncode=0, stdout='LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\nControlGroup=\n'),
                       SimpleNamespace(returncode=1, stdout='LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=\n')):
            with patch.object(self.node.subprocess, 'run', return_value=result):
                self.assertTrue(self.node.dataset_unit_stopped(dict(state='EXITED_SUCCESS', unit_name='gpuq-a123')))

    def test_exact_mount_guard_rejects_root_same_device_readonly_and_network(self):
        self.mount_patch.stop()
        config = self.node.CONFIG['datasets']
        base = '1 0 8:1 / / rw - ext4 /dev/root rw\n'
        good = f'2 1 8:2 / {self.base} rw - ext4 /dev/data rw\n'
        try:
            with patch.object(Path, 'read_text', return_value=base + good):
                self.node.dataset_mount_check(config)
            for mount in ('', good.replace('8:2', '8:1'), good.replace(' rw ', ' ro '), good.replace('ext4', 'nfs4')):
                with patch.object(Path, 'read_text', return_value=base + mount), self.assertRaises(ValueError):
                    self.node.dataset_mount_check(config)
        finally:
            self.mount_patch.start()

    def test_ambiguous_submission_cancel_retains_lease_and_quota(self):
        self.ready()
        self.node.acquire_datasets(self.job)
        (self.node.ROOT / 'jobs' / (self.job['id'] + '.dataset-dispatch-attempted')).touch()
        with patch.object(self.node, 'gpu') as gpu:
            result = self.node.process('cancel', {'job': self.job})
        self.assertEqual(result['state'], 'UNKNOWN')
        gpu.assert_not_called()
        with self.assertRaises(self.module.CacheError):
            self.cache.evict(self.admin, 'example', self.version)

    def test_cancel_before_dispatch_safely_releases_lease(self):
        self.ready()
        self.node.acquire_datasets(self.job)
        with patch.object(self.node, 'gpu') as gpu:
            self.assertEqual(self.node.process('cancel', {'job': self.job})['state'], 'CANCELED')
        gpu.assert_not_called()
        self.assertTrue(self.cache.evict(self.admin, 'example', self.version)['evicted'])

    def test_no_datasets_preserves_legacy_execution(self):
        old = {key: value for key, value in self.job.items() if key != 'datasets'}
        with patch.object(self.node, 'dataset_cache', side_effect=AssertionError('must not load datasets')), \
                patch.object(self.node, 'gpu', side_effect=[{'job_id': 'legacy'}, {'job': {'state': 'QUEUED'}, 'attempts': []}]):
            self.assertEqual(self.node.process('sync', {'job': old})['state'], 'QUEUED')


if __name__ == '__main__':
    unittest.main()
