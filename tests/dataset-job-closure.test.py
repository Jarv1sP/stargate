"""Task-scoped lease closure and late acquisition; isolated real cache only."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('job_closure_fixture', Path(__file__).with_name('dataset-cache.test.py'))
F = importlib.util.module_from_spec(spec); spec.loader.exec_module(F)
D, ADMIN, OWNER, OTHER = F.D, F.ADMIN, F.OWNER, F.OTHER


class JobClosure(unittest.TestCase):
    tearDown = F.DatasetCacheTests.tearDown

    def setUp(self):
        F.DatasetCacheTests.setUp(self)
        self.version = self.cache.register_source(ADMIN, 'images', 'sample-source', [OWNER.user_id, OTHER.user_id])['version']
        self.cache.materialize(OWNER, 'images', self.version)
        self.job = str(uuid.uuid4())
        self.refs = [{'dataset': 'images', 'version': self.version}]

    def acquire(self, owner=OWNER, job=None):
        return self.cache.acquire_lease(owner, 'images', self.version, job or self.job)

    def close(self, cache=None):
        return (cache or self.cache).close_job_leases(ADMIN, OWNER.user_id, self.job, self.refs)

    def test_closure_removes_only_this_owner_job_and_preserves_data_and_neighbours(self):
        own = self.acquire(); other_job = str(uuid.uuid4())
        neighbour = self.acquire(job=other_job); other_owner = self.acquire(owner=OTHER)
        data = self.cache._paths('images', self.version)['ready'] / 'data' / 'labels.txt'
        before = data.stat(); content = data.read_bytes()
        result = self.close()
        self.assertEqual(result, {'closed': True, 'released': True, 'removedLeases': 1})
        remaining = self.cache._leases('images', self.version)
        self.assertEqual({row['id'] for row in remaining}, {neighbour['leaseId'], other_owner['leaseId']})
        self.assertNotIn(own['leaseId'], {row['id'] for row in remaining})
        self.assertEqual(data.read_bytes(), content)
        after = data.stat(); self.assertEqual((after.st_ino, after.st_size, after.st_mtime_ns), (before.st_ino, before.st_size, before.st_mtime_ns))
        self.assertEqual(self.acquire(job=other_job), neighbour)
        self.assertEqual(self.acquire(owner=OTHER), other_owner)
        with self.assertRaisesRegex(D.CacheError, 'leases are closed'): self.acquire()

    def test_a_separate_process_that_observed_ready_before_closure_cannot_create_a_late_lease(self):
        script = '''import importlib.util, sys
spec=importlib.util.spec_from_file_location('cache',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
cache=m.DatasetCache(sys.argv[2],initialize=False)
original=cache._ready_snapshot
def delayed(*args,**kwargs):
    value=original(*args,**kwargs)
    print('ready',flush=True)
    sys.stdin.readline()
    return value
cache._ready_snapshot=delayed
try:
    cache.acquire_lease(m.Principal(sys.argv[4]),'images',sys.argv[3],sys.argv[5])
except m.CacheError as error:
    if 'leases are closed' not in str(error): raise
    print('closed',flush=True)
else: raise AssertionError('late lease was created')
'''
        child = subprocess.Popen([sys.executable, '-B', '-c', script, str(F.MODULE_PATH), str(self.root), self.version, OWNER.user_id, self.job],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            self.assertEqual(self.close()['removedLeases'], 0)
            output, errors = child.communicate('continue\n', timeout=5)
            self.assertEqual(child.returncode, 0, errors); self.assertEqual(output.strip(), 'closed')
            self.assertEqual(self.cache._leases('images', self.version), [])
        finally:
            if child.poll() is None: child.kill(); child.communicate()

    def test_marker_write_failure_leaves_all_leases_and_can_be_retried(self):
        lease = self.acquire(); original = D._write_json
        def fail(path, value, *args, **kwargs):
            if path.parent.name == '.job-lease-closures': raise OSError(errno.ENOSPC, 'fixture metadata full')
            return original(path, value, *args, **kwargs)
        with patch.object(D, '_write_json', side_effect=fail), self.assertRaises(OSError): self.close()
        self.assertEqual(self.acquire(), lease)
        self.assertEqual(self.close()['removedLeases'], 1)
        self.assertEqual(self.close()['removedLeases'], 0)

    def test_an_existing_job_fence_does_not_skip_other_declared_sources(self):
        other_version = self.cache.register_source(ADMIN, 'other', 'sample-source', [OWNER.user_id])['version']
        self.cache.materialize(OWNER, 'other', other_version)
        self.acquire()
        lease = self.cache.acquire_lease(OWNER, 'other', other_version, self.job)
        self.assertEqual(self.close()['removedLeases'], 1)
        self.assertEqual(self.cache.lookup_lease(OWNER, 'other', other_version, self.job), lease)
        with self.assertRaisesRegex(D.CacheError, 'leases are closed'):
            self.cache.acquire_lease(OWNER, 'other', other_version, self.job)
        result = self.cache.close_job_leases(ADMIN, OWNER.user_id, self.job, [{'dataset': 'other', 'version': other_version}])
        self.assertEqual(result['removedLeases'], 1)
        self.assertIsNone(self.cache.lookup_lease(OWNER, 'other', other_version, self.job))

    def test_failed_deletion_keeps_the_fence_and_a_fresh_instance_finishes_cleanup(self):
        lease = self.acquire(); unlink = os.unlink
        def fail(path, *args, **kwargs):
            if path == lease['leaseId'] + '.json': raise OSError(errno.EIO, 'fixture deletion failure')
            return unlink(path, *args, **kwargs)
        with patch.object(D.os, 'unlink', side_effect=fail), self.assertRaises(OSError): self.close()
        self.assertEqual(self.cache.lookup_lease(OWNER, 'images', self.version, self.job), lease)
        with self.assertRaisesRegex(D.CacheError, 'leases are closed'): self.acquire()
        with self.assertRaisesRegex(D.CacheError, 'leases are closed'):
            with self.cache.open_lease(OWNER, 'images', self.version, self.job, lease['leaseId']): pass
        reopened = D.DatasetCache(self.root, initialize=False)
        self.assertEqual(self.close(reopened)['removedLeases'], 1)
        self.assertIsNone(self.cache.lookup_lease(OWNER, 'images', self.version, self.job))

    def test_cleanup_after_acl_revocation_needs_no_ready_metadata_and_retains_the_fence_after_eviction(self):
        self.acquire(); self.cache.set_owners(ADMIN, 'images', [OTHER.user_id])
        with self.assertRaises(PermissionError): self.acquire()
        with (patch.object(D.DatasetCache, '_record_snapshot', side_effect=AssertionError('cleanup must not scan the manifest')),
              patch.object(D.DatasetCache, '_ready_snapshot', side_effect=AssertionError('cleanup must not inspect READY'))):
            self.assertEqual(self.close()['removedLeases'], 1)
        self.cache.evict(ADMIN, 'images', self.version)
        self.assertEqual(self.close()['removedLeases'], 0)
        self.cache.set_owners(ADMIN, 'images', [OWNER.user_id, OTHER.user_id])
        self.cache.materialize(OWNER, 'images', self.version)
        with self.assertRaisesRegex(D.CacheError, 'leases are closed'): self.acquire()
        self.assertTrue(self.acquire(job=str(uuid.uuid4()))['leaseId'])

    def test_unauthorized_or_invalid_closure_creates_no_marker(self):
        self.acquire()
        with self.assertRaises(PermissionError): self.cache.close_job_leases(OWNER, OWNER.user_id, self.job, self.refs)
        with self.assertRaises(D.CacheError): self.cache.close_job_leases(ADMIN, OWNER.user_id, self.job, [])
        with self.assertRaises(D.CacheError): self.cache.close_job_leases(ADMIN, OWNER.user_id, self.job, [{'dataset': '../bad', 'version': self.version}])
        self.assertFalse((self.root / '.job-lease-closures').exists())
        self.assertEqual(len(self.cache._leases('images', self.version)), 1)

    def test_corrupt_closure_does_not_become_permission_to_acquire_or_release(self):
        lease = self.acquire(); marker, record = self.cache._job_lease_marker(OWNER.user_id, self.job)
        D._mkdir(marker.parent); D._write_json(marker, {**record, 'owner': OTHER.user_id})
        with self.assertRaisesRegex(D.CacheError, 'closure identity differs'): self.acquire()
        with self.assertRaisesRegex(D.CacheError, 'closure identity differs'): self.close()
        self.assertEqual(self.cache.lookup_lease(OWNER, 'images', self.version, self.job), lease)


if __name__ == '__main__': unittest.main()
