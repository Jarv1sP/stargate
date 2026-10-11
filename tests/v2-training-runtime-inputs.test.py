"""Prepared project/data scopes on real temporary storage, not a GPU launch."""
from contextlib import contextmanager
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


F = load('runtime_project_fixture', 'tests/project-store.test.py')
P = F.module
D = load('runtime_input_cache', 'deploy/dataset-cache.py')
S = load('runtime_input_shared', 'deploy/shared-data.py')
M = load('runtime_data_mounts', 'src/infrastructure/training-data-mounts.py')
R = load('runtime_input_scope', 'src/infrastructure/training-runtime-inputs.py')


class RuntimeInputsTests(unittest.TestCase):
    initialize_env = F.ProjectStoreTests.initialize_env
    cleanup = F.ProjectStoreTests.cleanup

    def setUp(self):
        F.ProjectStoreTests.setUp(self)
        self.version = self.store.publish(self.user, self.slug)['release']
        self.job = str(uuid.uuid4())
        self.reference = {'project': self.slug, 'release': self.version,
            'projectUUID': self.store.project_uuid(self.user, self.slug), 'generation': self.store.generation(self.user, self.slug)}
        self.store.prepare_run(self.user, self.slug, self.version, self.job,
            project_uuid=self.reference['projectUUID'], generation=self.reference['generation'])
        self.reader = P.ProjectStore(self.root, self.base, initialize=False)
        self.original = self.path / 'existing-data'
        self.original.mkdir()
        (self.original / 'sample.txt').write_text('original input')
        self.cache = D.DatasetCache(self.path / 'cache', sources={'original': self.original}, reserve_bytes=0)
        version = self.cache.register_source(D.Principal('operator', True), 'images', 'original', [self.user])['version']
        self.cache.materialize(D.Principal(self.user), 'images', version)
        lease = self.cache.acquire_lease(D.Principal(self.user), 'images', version, self.job)
        self.source = {'kind': 'cache', 'datasetId': 'images', 'version': version}
        self.inputs = [{'source': {'kind': 'directory', 'sourceId': 'raw'}}, {'source': self.source, 'leaseId': lease['leaseId']}]
        self.data = M.TrainingDataMounts(D, S, directories={'raw': str(self.original)}, roots=[{'kind': 'cache', 'root': str(self.path / 'cache')}])
        self.runtime = R.TrainingRuntimeInputs(projects=self.reader, data=self.data)

    def open(self, **changes):
        return self.runtime.open(**{'user_id': self.user, 'job_id': self.job, 'project': self.reference, 'inputs': self.inputs, **changes})

    def assert_closed(self, descriptors):
        for descriptor in descriptors:
            with self.assertRaises(OSError):
                os.fstat(descriptor)

    def test_existing_project_and_inputs_open_without_initialization_or_metadata_writes(self):
        claim = self.store.path / '.run-claims' / (self.job + '.json')
        before = claim.read_bytes(), claim.stat().st_mtime_ns
        with (patch.object(P, 'atomic_json', side_effect=AssertionError('no project write')),
              patch.object(P.ProjectStore, '_claim_run_paths', side_effect=AssertionError('no run creation')),
              patch.object(P.ProjectStore, '_quota', side_effect=AssertionError('no quota setup')),
              patch.object(D, '_write_json', side_effect=AssertionError('no lease write'))):
            with self.open() as opened:
                self.assertEqual(opened['runtime']['kind'], 'base')
                self.assertTrue(opened['project']['readonly'])
                self.assertEqual(opened['project']['meta']['release'], self.version)
                self.assertEqual(set(opened['descriptors']), {'code', 'env', 'home', 'output'})
                for name, descriptor in opened['descriptors'].items():
                    self.assertEqual(os.fstat(descriptor).st_ino, opened['project'][name].stat().st_ino)
                descriptors = [*opened['descriptors'].values(), *(fd for fd, _ in opened['dataMounts'])]
        self.assert_closed(descriptors)
        self.assertEqual((claim.read_bytes(), claim.stat().st_mtime_ns), before)
        self.assertEqual(len(self.cache._leases('images', self.source['version'])), 1)

    def test_missing_run_claim_or_directories_are_not_recreated(self):
        before = sorted(path.name for path in (self.store.path / '.run-claims').iterdir())
        with self.assertRaises(P.ProjectError) as error:
            with self.open(job_id=str(uuid.uuid4())):
                self.fail('unprepared run opened')
        self.assertEqual(error.exception.code, 'not_found')
        self.assertEqual(sorted(path.name for path in (self.store.path / '.run-claims').iterdir()), before)
        output = self.store.existing_run_paths(self.user, self.slug, self.version, self.job)['output']
        output.rmdir()
        with self.assertRaises(P.ProjectError):
            with self.open():
                self.fail('missing output directory repaired')
        self.assertFalse(output.exists())

    def test_wrong_instance_owner_release_and_runtime_never_reach_data_open(self):
        variants = [
            {'project': {**self.reference, 'projectUUID': str(uuid.uuid4())}},
            {'project': {**self.reference, 'generation': 'f' * 64}},
            {'project': {**self.reference, 'release': 'f' * 64}},
            {'user_id': 'different-owner'},
            {'project': {**self.reference, 'hostPath': str(self.original)}},
        ]
        with patch.object(self.data, 'open', side_effect=AssertionError('invalid project cannot open data')):
            for changes in variants:
                with self.subTest(changes=changes), self.assertRaises((P.ProjectError, FileNotFoundError, ValueError)):
                    with self.open(**changes):
                        self.fail('changed reference accepted')
            (self.base / 'bin/python3.12').write_bytes(b'changed synthetic interpreter')
            with self.assertRaises(P.ProjectError) as error:
                with self.open():
                    self.fail('changed runtime accepted')
            self.assertEqual(error.exception.code, 'base_changed')

    def test_failed_data_open_closes_project_handles_and_unlocks_only_after_unwind(self):
        descriptors = []
        original_open = self.reader.open_run
        @contextmanager
        def record(*args, **kwargs):
            with original_open(*args, **kwargs) as opened:
                descriptors.extend(opened['descriptors'].values())
                yield opened
        self.original.rename(self.original.with_name('unavailable-data'))
        with patch.object(self.reader, 'open_run', record), self.assertRaises(FileNotFoundError):
            with self.open():
                self.fail('missing data accepted')
        self.assertEqual(len(descriptors), 4)
        self.assert_closed(descriptors)
        with self.store.lifetime(self.user, self.slug, exclusive=True):
            self.assertEqual(len(self.cache._leases('images', self.source['version'])), 1)

    def test_consumer_failure_preserves_output_and_claim_but_closes_all_handles(self):
        with self.assertRaisesRegex(RuntimeError, 'payload error'):
            with self.open() as opened:
                descriptors = [*opened['descriptors'].values(), *(fd for fd, _ in opened['dataMounts'])]
                output = os.open('checkpoint.txt', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=opened['descriptors']['output'])
                try:
                    os.write(output, b'keep checkpoint')
                finally:
                    os.close(output)
                raise RuntimeError('payload error')
        self.assert_closed(descriptors)
        self.assertEqual((opened['project']['output'] / 'checkpoint.txt').read_bytes(), b'keep checkpoint')
        self.assertTrue((self.store.path / '.run-claims' / (self.job + '.json')).exists())
        self.assertEqual(len(self.cache._leases('images', self.source['version'])), 1)

    def test_project_lifetime_prevents_retirement_while_consumer_owns_handles(self):
        other = P.ProjectStore(self.root, self.base, initialize=False)
        with patch.object(P, 'PROJECT_LOCK_WAIT_SECONDS', 0.02):
            with self.open():
                with self.assertRaises(P.ProjectError) as error:
                    with other.lifetime(self.user, self.slug, exclusive=True):
                        self.fail('exclusive lifecycle operation entered during execution')
                self.assertEqual(error.exception.code, 'project_busy')
            with other.lifetime(self.user, self.slug, exclusive=True):
                pass

    def test_kernel_mount_roles_keep_inputs_readonly_and_outputs_persistent(self):
        bwrap = shutil.which('bwrap')
        if not bwrap:
            self.skipTest('bubblewrap is not installed; mount roles not verified')
        # The fixture project interpreter is never executed. A trusted test
        # interpreter verifies mount roles, not OCI or user training execution.
        script = "import errno\nfor path in ['/workspace/train.py','/datasets/raw/sample.txt','/data2/images/sample.txt']:\n assert open(path,'rb').read()\n try: open(path,'w')\n except OSError as e: assert e.errno==errno.EROFS,e\n else: raise AssertionError('input is writable')\nopen('/outputs/result.txt','w').write('test result')\nopen('/home/gpuq/state.txt','w').write('test home')\nprint('MOUNT_ROLES_CONFIRMED')"
        with self.open() as opened:
            args = [bwrap, '--unshare-user', '--unshare-net', '--tmpfs', '/', '--ro-bind', '/usr', '/usr',
                '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--ro-bind', sys.prefix, sys.prefix,
                '--dir', '/home', '--dir', '/opt', '--dir', '/data2', '--dir', '/datasets', '--chdir', '/']
            for name, target in [('code', '/workspace'), ('env', '/opt/project-env'), ('home', '/home/gpuq'), ('output', '/outputs')]:
                args += ['--ro-bind-fd' if name in ('code', 'env') else '--bind-fd', str(opened['descriptors'][name]), target]
            for descriptor, target in opened['dataMounts']:
                args += ['--ro-bind-fd', str(descriptor), target]
            descriptors = [*opened['descriptors'].values(), *(fd for fd, _ in opened['dataMounts'])]
            result = subprocess.run(args + ['--', sys.executable, '-c', script], pass_fds=descriptors,
                text=True, capture_output=True, timeout=15)
        if result.returncode and any(reason in result.stderr for reason in ('No permissions to create', 'Creating new namespace failed', 'Operation not permitted')):
            self.skipTest('local kernel denies namespaces; mount roles not verified')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'MOUNT_ROLES_CONFIRMED')
        self.assertEqual((opened['project']['output'] / 'result.txt').read_text(), 'test result')
        self.assertEqual((opened['project']['home'] / 'state.txt').read_text(), 'test home')


if __name__ == '__main__':
    unittest.main()
