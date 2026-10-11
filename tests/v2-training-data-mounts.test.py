"""Real input FDs and native leases in temporary storage; no production jobs."""
import importlib.util
from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


D = load('v2_mount_cache', 'deploy/dataset-cache.py')
S = load('v2_mount_shared', 'deploy/shared-data.py')
M = load('v2_training_mounts', 'src/infrastructure/training-data-mounts.py')
OWNER, ADMIN = D.Principal('alice'), D.Principal('operator', True)


class TrainingDataMountsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / 'original'
        self.source.mkdir()
        (self.source / 'sample.txt').write_text('original sample')
        self.job = str(uuid.uuid4())
        self.roots, self.stores, self.inputs = [], {}, [{'source': {'kind': 'directory', 'sourceId': 'raw'}}]
        for kind in ('cache', 'warehouse'):
            root, dataset = self.base / kind, kind + '-images'
            store = D.DatasetCache(root, sources={'original': self.source}, reserve_bytes=0)
            version = store.register_source(ADMIN, dataset, 'original', ['alice', 'bob'])['version']
            store.materialize(OWNER, dataset, version)
            if kind == 'cache':
                with store._locked():
                    tier = store._tier(dataset, version)
                    tier['role'] = 'cache'
                    store._write_tier(dataset, version, tier)
            lease = store.acquire_lease(OWNER, dataset, version, self.job, require_protected=kind == 'warehouse')
            self.roots.append({'kind': kind, 'root': str(root)})
            self.stores[kind] = store
            self.inputs.append({'source': {'kind': kind, 'datasetId': dataset, 'version': version}, 'leaseId': lease['leaseId']})
        self.reader = M.TrainingDataMounts(D, S, directories={'raw': str(self.source)}, roots=self.roots)

    def tearDown(self):
        for root, _, files in os.walk(self.base, followlinks=False):
            os.chmod(root, 0o700)
            for name in files:
                path = Path(root) / name
                if not path.is_symlink():
                    os.chmod(path, 0o600)
        self.temp.cleanup()

    def open(self, inputs=None, **kwargs):
        return self.reader.open(user_id=kwargs.get('user_id', 'alice'), job_id=kwargs.get('job_id', self.job),
                                inputs=self.inputs if inputs is None else inputs)

    def test_all_sources_open_original_inodes_without_writes_or_copy_and_close_without_release(self):
        expected = [self.source] + [self.stores[value['source']['kind']]._paths(value['source']['datasetId'], value['source']['version'])['ready'] / 'data' for value in self.inputs[1:]]
        with (patch.object(D, '_write_json', side_effect=AssertionError('opening must not write')),
             patch.object(D.DatasetCache, '_touch_locked', side_effect=AssertionError('opening must not touch')),
             patch.object(D.DatasetCache, 'acquire_lease', side_effect=AssertionError('must use original lease')),
             patch.object(D.DatasetCache, 'materialize', side_effect=AssertionError('opening must not copy')),
             patch.object(os, 'fstatvfs', side_effect=AssertionError('no publication space admission'))):
            with self.open() as mounts:
                self.assertEqual([target for _, target in mounts], ['/datasets/raw', '/data2/cache-images', '/data2/warehouse-images'])
                descriptors = [fd for fd, _ in mounts]
                for descriptor, path in zip(descriptors, expected):
                    self.assertEqual(os.fstat(descriptor).st_ino, path.stat().st_ino)
                    fd = os.open('sample.txt', os.O_RDONLY, dir_fd=descriptor)
                    try:
                        self.assertEqual(os.read(fd, 100), b'original sample')
                        self.assertEqual(os.fstat(fd).st_ino, (path / 'sample.txt').stat().st_ino)
                    finally:
                        os.close(fd)
                # A consumer never holds the global cache lock for its runtime.
                for value in self.inputs[1:]:
                    source = value['source']
                    store = D.DatasetCache(self.base / source['kind'], initialize=False, lock_timeout=0.05)
                    self.assertEqual(store.lookup_lease(OWNER, source['datasetId'], source['version'], self.job)['leaseId'], value['leaseId'])
        for descriptor in descriptors:
            with self.assertRaises(OSError):
                os.fstat(descriptor)
        for value in self.inputs[1:]:
            source = value['source']
            self.assertEqual(len(self.stores[source['kind']]._leases(source['datasetId'], source['version'])), 1)

    def test_missing_or_different_lease_job_and_account_cannot_open_managed_data(self):
        value = self.inputs[1]
        for inputs, identity in [([{**value, 'leaseId': str(uuid.uuid4())}], {}),
                                 ([value], {'job_id': str(uuid.uuid4())}), ([value], {'user_id': 'bob'})]:
            with self.subTest(identity=identity), self.assertRaisesRegex(D.CacheError, 'lease does not match'):
                with self.open(inputs, **identity):
                    self.fail('wrong lease opened')
        source = value['source']
        self.stores['cache'].release_lease(ADMIN, source['datasetId'], source['version'], value['leaseId'])
        with self.assertRaisesRegex(D.CacheError, 'lease does not match'):
            with self.open([value]):
                self.fail('released lease reopened')
        self.assertEqual(self.stores['cache']._leases(source['datasetId'], source['version']), [])

    def test_later_input_failure_closes_earlier_handles_but_does_not_release_leases(self):
        opened = []
        original = S.open_directory
        def record(path):
            descriptor = original(path)
            opened.append(descriptor)
            return descriptor
        open_managed = M._adapter.LegacyDataLeaser.open_mount
        @contextmanager
        def record_managed(leaser, **kwargs):
            with open_managed(leaser, **kwargs) as descriptor:
                opened.append(descriptor)
                yield descriptor
        broken = {**self.inputs[2], 'leaseId': str(uuid.uuid4())}
        with (patch.object(S, 'open_directory', side_effect=record),
              patch.object(M._adapter.LegacyDataLeaser, 'open_mount', record_managed), self.assertRaises(D.CacheError)):
            with self.open([self.inputs[0], self.inputs[1], broken]):
                self.fail('incomplete input set')
        self.assertEqual(len(opened), 2)
        for descriptor in opened:
            with self.assertRaises(OSError):
                os.fstat(descriptor)
        source = self.inputs[1]['source']
        self.assertEqual(len(self.stores['cache']._leases(source['datasetId'], source['version'])), 1)

    def test_raw_directory_does_not_require_any_managed_store_or_available_write_space(self):
        reader = M.TrainingDataMounts(D, S, directories={'raw': str(self.source)}, roots=[])
        with (patch.object(D, 'DatasetCache', side_effect=AssertionError('raw read must not open cache')),
             patch.object(os, 'statvfs', side_effect=AssertionError('raw read has no write admission')),
             patch.object(os, 'fstatvfs', side_effect=AssertionError('raw read has no write admission'))):
            with reader.open(user_id='alice', job_id=self.job, inputs=[self.inputs[0]]) as mounts:
                self.assertEqual(os.fstat(mounts[0][0]).st_ino, self.source.stat().st_ino)

    def test_managed_storage_cannot_be_registered_as_a_raw_directory(self):
        with self.assertRaisesRegex(ValueError, 'normal dataset reader'):
            M.TrainingDataMounts(D, S, directories={'bypass': str(self.base / 'cache' / 'ready')}, roots=self.roots)

    def test_invalid_plans_and_conflicting_targets_are_rejected_before_any_directory_is_opened(self):
        raw, managed = self.inputs[:2]
        variants = [[raw, raw], [managed, managed], [{**raw, 'leaseId': str(uuid.uuid4())}],
                    [{'source': managed['source']}], [{**managed, 'hostPath': str(self.source)}],
                    [{'source': {'kind': 'directory', 'sourceId': 'unknown'}}],
                    [{'source': {**managed['source'], 'path': str(self.source)}, 'leaseId': managed['leaseId']}]]
        for inputs in variants:
            with (self.subTest(inputs=inputs), patch.object(S, 'open_directory', side_effect=AssertionError('plan must fail before opening')),
                  self.assertRaises(ValueError)):
                with self.open(inputs):
                    self.fail('invalid plan')

    def test_warehouse_role_is_rechecked_at_open(self):
        value = self.inputs[2]
        source = value['source']
        store = self.stores['warehouse']
        with store._locked():
            tier = store._tier(source['datasetId'], source['version'])
            tier['role'] = 'cache'
            store._write_tier(source['datasetId'], source['version'], tier)
        with self.assertRaisesRegex(D.CacheError, 'protected original'):
            with self.open([value]):
                self.fail('warehouse protection changed')

    def test_native_read_permission_is_checked_again_without_releasing_existing_protection(self):
        value = self.inputs[1]
        source = value['source']
        self.stores['cache'].set_owners(ADMIN, source['datasetId'], ['bob'])
        with self.assertRaises(PermissionError):
            with self.open([value]):
                self.fail('revoked owner opened the data')
        self.assertEqual(len(self.stores['cache']._leases(source['datasetId'], source['version'])), 1)

    def test_data_directory_replaced_after_ready_check_cannot_supply_the_runtime_handle(self):
        value = self.inputs[1]
        check = D.DatasetCache._check_ready_snapshot
        def replace(store, paths, identity):
            check(store, paths, identity)
            data = paths['ready'] / 'data'
            # Fault injection only: mutate our sealed temporary fixture after
            # its real READY check to verify the descriptor identity check.
            os.chmod(paths['ready'], 0o700)
            data.rename(paths['ready'] / 'original-data')
            data.mkdir()
        with patch.object(D.DatasetCache, '_check_ready_snapshot', replace), self.assertRaisesRegex(D.CacheError, 'opened dataset differs'):
            with self.open([value]):
                self.fail('replacement directory was adopted')

    def test_consumer_exception_closes_descriptors_without_releasing_durable_leases(self):
        with self.assertRaisesRegex(RuntimeError, 'training error'):
            with self.open() as mounts:
                descriptors = [fd for fd, _ in mounts]
                raise RuntimeError('training error')
        for descriptor in descriptors:
            with self.assertRaises(OSError):
                os.fstat(descriptor)
        for value in self.inputs[1:]:
            source = value['source']
            self.assertEqual(len(self.stores[source['kind']]._leases(source['datasetId'], source['version'])), 1)

    def test_open_delegated_lease_requires_explicit_version_configuration(self):
        source = self.inputs[1]['source']
        leaser = M._adapter.LegacyDataLeaser(D, root=self.base / 'cache', kind='cache',
            lease_version={'dataset': source['datasetId'], 'version': source['version']})
        lease = leaser.acquire(user_id='v2-reader', job_id=self.job, dataset=source['datasetId'], version=source['version'], kind='cache')
        inputs = [{'source': source, 'leaseId': lease['leaseId']}]
        with self.assertRaises(PermissionError):
            with self.open(inputs, user_id='v2-reader'):
                self.fail('no implicit delegation')
        delegated = M.TrainingDataMounts(D, S, directories={}, roots=self.roots, lease_versions=[source])
        with delegated.open(user_id='v2-reader', job_id=self.job, inputs=inputs) as mounts:
            self.assertEqual(mounts[0][1], '/data2/cache-images')
            self.assertEqual(os.fstat(mounts[0][0]).st_ino,
                (self.stores['cache']._paths(source['datasetId'], source['version'])['ready'] / 'data').stat().st_ino)

    def test_directory_symlink_replacement_is_not_followed_and_open_handle_keeps_original_inode(self):
        with self.open([self.inputs[0]]) as mounts:
            original = os.fstat(mounts[0][0]).st_ino
            moved = self.source.with_name('moved-original')
            self.source.rename(moved)
            self.source.symlink_to(moved, target_is_directory=True)
            self.assertEqual(os.fstat(mounts[0][0]).st_ino, original)
            with self.assertRaises(OSError):
                with self.open([self.inputs[0]]):
                    self.fail('symlink followed')

    def test_real_readonly_mounts_allow_reads_and_refuse_writes(self):
        bwrap = shutil.which('bwrap')
        if not bwrap:
            self.skipTest('bubblewrap is not installed; no kernel mount validation')
        script = "import errno\nfor root in ['/datasets/raw','/data2/cache-images','/data2/warehouse-images']:\n p=root+'/sample.txt'\n assert open(p).read()=='original sample'\n try: open(p,'w')\n except OSError as e: assert e.errno==errno.EROFS,e\n else: raise AssertionError('input is writable')\nprint('READ_ONLY_CONFIRMED')"
        with self.open() as mounts:
            args = [bwrap, '--unshare-user', '--unshare-net', '--tmpfs', '/', '--ro-bind', '/usr', '/usr',
                    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
                    '--ro-bind', sys.prefix, sys.prefix, '--dir', '/datasets', '--dir', '/data2', '--chdir', '/']
            for descriptor, target in mounts:
                args += ['--ro-bind-fd', str(descriptor), target]
            result = subprocess.run(args + ['--', sys.executable, '-c', script], pass_fds=tuple(fd for fd, _ in mounts),
                                    text=True, capture_output=True, timeout=15)
        if result.returncode and any(reason in result.stderr for reason in ('No permissions to create', 'Creating new namespace failed', 'Operation not permitted')):
            self.skipTest('local kernel denies unprivileged namespaces; no kernel mount validation')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'READ_ONLY_CONFIRMED')


if __name__ == '__main__':
    unittest.main()
