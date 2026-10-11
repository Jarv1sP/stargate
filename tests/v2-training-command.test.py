"""Real project/data/IPC and CPU namespaces; native allocation is a fixture.

No GPU, OCI engine, production task or project interpreter is executed. The
namespace runs test code with the installed system Python and the real SDK.
"""
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace
import time
import unittest
from unittest.mock import patch
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


F = load('command_input_fixture', 'tests/v2-training-runtime-inputs.test.py')
R = load('command_runtime', 'src/infrastructure/training-runtime.py')
C = load('command_control', 'deploy/training-control.py')
T = load('training_command', 'src/infrastructure/training-command.py')
sys.path.insert(0, str(ROOT / 'gpuq'))
from gpuq.constants import SCHEMA_VERSION, CHECKPOINT_EXIT_CODE


class TrainingCommandTests(unittest.TestCase):
    def setUp(self):
        self.fixture = f = F.RuntimeInputsTests('runTest')
        f.setUp()
        self.addCleanup(f.doCleanups)
        self.archive = f.path / 'sdk.pyz'
        with zipfile.ZipFile(self.archive, 'w') as archive:
            for path in (ROOT / 'gpuq').rglob('*.py'):
                archive.write(path, str(path.relative_to(ROOT / 'gpuq')))
        self.config = {'controlRoot': str(f.path / 'control'), 'gpuqArchive': str(self.archive)}
        self.identity = SimpleNamespace(dispatch_id=str(uuid.uuid4()), job_id=f.job, account_id=f.user,
            native_job_id='Jabcdef012345', attempt_id='A' + uuid.uuid4().hex)
        self.environment = {'PRIVATE_TOKEN': 'host-only', 'PATH': '/host/private', 'PYTHONPATH': '/host/private'}
        self.new_attempt(2, previous=0)
        observed = f.store.inspect_release_runtime(f.user, f.slug, f.version)
        self.plan = {'schema': 1, 'identity': {'dispatchId': self.identity.dispatch_id, 'jobId': f.job, 'accountId': f.user},
            'project': {**f.reference, 'runtime': observed['runtime']}, 'inputs': f.inputs,
            'submission': {'execution': {'argv': ['/usr/bin/python3', '-c', 'pass'], 'workingDirectory': '.',
                'env': {'PYTHONPATH': '/workspace', 'EXPERIMENT': '中文试验'}}}}

    def new_attempt(self, count, *, previous, resume=None):
        self.identity.attempt_id = 'A' + uuid.uuid4().hex
        self.control = Path(self.config['controlRoot']) / self.identity.attempt_id
        self.control.mkdir(parents=True)
        self.identity.control_dir = str(self.control)
        self.identity.assignments = tuple((f'GPU-test-{i}', i) for i in range(count))
        self.environment.update(GPUQ_JOB_ID=self.identity.native_job_id, GPUQ_ATTEMPT_ID=self.identity.attempt_id,
            GPUQ_CONTROL_DIR=str(self.control), GPUQ_ASSIGNED_GPU_COUNT=str(count), GPUQ_ACTUAL_GPU_COUNT=str(count),
            GPUQ_WORLD_SIZE=str(count), GPUQ_PREVIOUS_GPU_COUNT=str(previous), GPUQ_PREVIOUS_WORLD_SIZE=str(previous),
            GPUQ_MIN_GPU_COUNT='1', GPUQ_MAX_GPU_COUNT='3', GPUQ_MIN_WORLD_SIZE='1', GPUQ_MAX_WORLD_SIZE='3',
            GPUQ_TARGET_GLOBAL_BATCH_SIZE='12', GPUQ_PER_DEVICE_MICRO_BATCH_SIZE='2', GPUQ_ALLOWED_GPU_COUNTS='1,2,3')
        if resume is not None:
            self.environment['GPUQ_RESUME_CHECKPOINT'] = resume

    def runtime(self):
        return R.TrainingRuntime(authority=SimpleNamespace(require_current=lambda: self.identity),
            inputs=self.fixture.runtime, plan=self.plan)

    def command(self, **changes):
        return T.TrainingCommand(C, config=self.config, environment={**self.environment, **changes})

    def test_container_command_keeps_three_identities_separate_and_does_not_forward_host_environment(self):
        self.plan['submission']['execution']['workingDirectory'] = 'experiments/demo'
        original = deepcopy(self.plan)
        with self.runtime().open() as resources:
            with self.command().open(resources, sharing=None) as prepared:
                self.assertEqual(prepared['argv'], original['submission']['execution']['argv'])
                self.assertEqual(prepared['workingDirectory'], '/workspace/experiments/demo')
                env = prepared['environment']
                self.assertEqual(env['GPUQ_JOB_ID'], self.identity.native_job_id)
                self.assertEqual(env['GPUQ_CONSOLE_JOB_ID'], self.fixture.job)
                self.assertEqual(env['GPUQ_CONSOLE_DISPATCH_ID'], self.identity.dispatch_id)
                self.assertEqual(env['GPUQ_ATTEMPT_ID'], self.identity.attempt_id)
                self.assertNotEqual(self.fixture.job, self.identity.dispatch_id)
                self.assertEqual(env['PYTHONPATH'], '/opt/gpuq/sdk.pyz:/workspace')
                self.assertEqual(env['EXPERIMENT'], '中文试验')
                self.assertNotIn('PRIVATE_TOKEN', env)
                self.assertNotIn('PATH', env)
                self.assertEqual([(target, readonly) for _, target, readonly in prepared['mounts']],
                                 [('/run/gpuq/control', False), ('/opt/gpuq/sdk.pyz', True)])
                descriptors = [fd for fd, _, _ in prepared['mounts']]
                self.assertEqual(os.fstat(descriptors[0]).st_ino, self.control.stat().st_ino)
            self.fixture.assert_closed(descriptors)
            # The inner scope must not close project/data handles owned by runtime.
            self.assertTrue(os.fstat(resources['descriptors']['output']))
        self.assertEqual(self.plan, original)

    def test_native_allowed_counts_are_not_truncated_to_the_old_64_entry_limit(self):
        allowed = ','.join(map(str, range(1, 4097)))
        with self.runtime().open() as resources:
            with self.command(GPUQ_ALLOWED_GPU_COUNTS=allowed).open(resources, sharing=None) as prepared:
                self.assertEqual(prepared['environment']['GPUQ_ALLOWED_GPU_COUNTS'], allowed)
            for invalid in (allowed + ',4097', '1,,2', '1,0', '1,-2', 'one', '1,2\n'):
                with self.subTest(value=invalid[:30]), self.assertRaises(ValueError):
                    with self.command(GPUQ_ALLOWED_GPU_COUNTS=invalid).open(resources, sharing=None):
                        self.fail('invalid native counts exposed')

    def test_resume_uses_job_owned_open_mounts_and_missing_checkpoint_is_not_a_fresh_start(self):
        with self.runtime().open() as resources:
            output = resources['project']['output'] / 'saved.json'
            output.write_text('{}')
            for path in ('/outputs/saved.json', str(output)):
                with self.command(GPUQ_RESUME_CHECKPOINT=path).open(resources, sharing=None) as prepared:
                    self.assertEqual(prepared['environment']['GPUQ_RESUME_CHECKPOINT'], '/outputs/saved.json')
            (resources['project']['home'] / 'state.json').write_text('{}')
            with self.command(GPUQ_RESUME_CHECKPOINT='/home/gpuq/state.json').open(resources, sharing=None) as prepared:
                self.assertEqual(prepared['environment']['GPUQ_RESUME_CHECKPOINT'], '/home/gpuq/state.json')
            (resources['project']['output'] / 'escape').symlink_to(self.archive)
            for path in ('/outputs/missing', '/etc/passwd', '/outputs/escape', '/outputs/../saved.json'):
                with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                    with self.command(GPUQ_RESUME_CHECKPOINT=path).open(resources, sharing=None):
                        self.fail('resume failure treated as a fresh run')

    def test_wrong_control_configuration_and_missing_attempt_do_not_create_or_mount_another_scope(self):
        with self.runtime().open() as resources:
            wrong = T.TrainingCommand(C, config={**self.config, 'controlRoot': str(self.fixture.path / 'other')})
            with self.assertRaisesRegex(RuntimeError, 'authorized attempt'):
                with wrong.open(resources, sharing=None):
                    self.fail('wrong control root accepted')
            self.control.rmdir()
            with self.assertRaises(FileNotFoundError):
                with self.command().open(resources, sharing=None):
                    self.fail('missing control directory repaired')
            self.assertFalse(self.control.exists())

    def test_hami_reuses_the_existing_release_library_and_runtime_environment(self):
        folder = self.archive.parent / 'hami'
        folder.mkdir()
        library = folder / 'libvgpu.so'
        library.write_bytes(b'\x7fELFtest-only-not-executed')
        sha = hashlib.sha256(library.read_bytes()).hexdigest()
        (folder / 'manifest.json').write_text(json.dumps({'sha256': sha, 'sm_supported': True}))
        self.environment.update(LD_PRELOAD=str(library), GPUQ_HAMI_LIBRARY_SHA256=sha,
            CUDA_DEVICE_MEMORY_SHARED_CACHE=str(self.control / 'hami/usage.cache'), ACTIVE_OOM_KILLER='false')
        sharing = {'vramMiB': 2048, 'hami': {'smPercent': 40}}
        with self.runtime().open() as resources:
            with self.command().open(resources, sharing=sharing) as prepared:
                self.assertEqual(prepared['environment']['LD_PRELOAD'], '/opt/gpuq/libvgpu.so')
                self.assertEqual(prepared['environment']['CUDA_DEVICE_MEMORY_LIMIT'], '2048m')
                self.assertEqual(prepared['environment']['CUDA_DEVICE_SM_LIMIT'], '40')
                self.assertEqual(prepared['mounts'][-1][1:], ('/opt/gpuq/libvgpu.so', True))
                descriptors = [fd for fd, _, _ in prepared['mounts']]
            self.fixture.assert_closed(descriptors)

    def test_consumer_failure_closes_control_handles_but_preserves_checkpoint_and_durable_inputs(self):
        with self.assertRaisesRegex(RuntimeError, 'consumer failed'):
            with self.runtime().open() as resources, self.command().open(resources, sharing=None) as prepared:
                descriptors = [fd for fd, _, _ in prepared['mounts']]
                (resources['project']['output'] / 'keep.pt').write_bytes(b'checkpoint')
                raise RuntimeError('consumer failed')
        self.fixture.assert_closed(descriptors)
        self.assertEqual((resources['project']['output'] / 'keep.pt').read_bytes(), b'checkpoint')
        self.assertEqual(len(self.fixture.cache._leases('images', self.fixture.source['version'])), 1)
        self.assertTrue((self.fixture.store.path / '.run-claims' / (self.fixture.job + '.json')).exists())

    def test_failed_control_preparation_closes_only_its_opened_descriptors(self):
        original_open, opened = os.open, []
        def record(*args, **kwargs):
            descriptor = original_open(*args, **kwargs)
            opened.append(descriptor)
            return descriptor
        with self.runtime().open() as resources:
            with patch.object(C.os, 'open', side_effect=record), \
                    patch.object(C, 'hami_environment', side_effect=ValueError('library unavailable')):
                with self.assertRaisesRegex(ValueError, 'library unavailable'):
                    with self.command().open(resources, sharing=None):
                        self.fail('failed control preparation entered command scope')
            self.assertEqual(len(opened), 3)
            self.fixture.assert_closed(set(opened))
            self.assertTrue(os.fstat(resources['descriptors']['output']))

    def execute_namespace(self, script):
        bwrap = shutil.which('bwrap')
        if not bwrap:
            self.skipTest('bubblewrap unavailable; CPU namespace was not tested')
        self.plan['submission']['execution']['argv'] = ['/usr/bin/python3', '-c', script]
        with self.runtime().open() as resources, self.command().open(resources, sharing=None) as prepared:
            args = [bwrap, '--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr',
                '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
                '--tmpfs', '/tmp', '--tmpfs', '/run', '--dir', '/opt/gpuq', '--dir', '/datasets', '--dir', '/data2',
                '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/home/gpuq']
            descriptors = []
            for name, target in [('code', '/workspace'), ('env', '/opt/project-env'), ('home', '/home/gpuq'), ('output', '/outputs')]:
                fd = resources['descriptors'][name]
                descriptors.append(fd)
                args += ['--ro-bind-fd' if name in ('code', 'env') else '--bind-fd', str(fd), target]
            for fd, target in resources['dataMounts']:
                descriptors.append(fd)
                args += ['--ro-bind-fd', str(fd), target]
            for fd, target, readonly in prepared['mounts']:
                descriptors.append(fd)
                args += ['--ro-bind-data' if readonly else '--bind-fd', str(fd), target]
            for key, value in prepared['environment'].items():
                args += ['--setenv', key, value]
            result = subprocess.run(args + ['--chdir', prepared['workingDirectory'], '--', *prepared['argv']],
                pass_fds=descriptors, capture_output=True, text=True, timeout=15)
        if result.returncode and any(message in result.stderr for message in
                ('No permissions to create', 'Creating new namespace failed', 'Operation not permitted')):
            self.skipTest('local kernel denies namespaces; checkpoint execution was not tested')
        return result

    def test_real_namespace_progress_checkpoint_and_resume_keep_task_identity_and_exact_batch(self):
        request = {'version': SCHEMA_VERSION, 'nonce': 'checkpoint-test', 'attempt_id': self.identity.attempt_id,
                   'requested_by_job_id': 'Jhigher', 'created_at': time.time()}
        (self.control / 'request.json').write_text(json.dumps(request))
        script = '''import json,os
from pathlib import Path
from gpuq.checkpoint import checkpoint_at_epoch_end, resume_checkpoint_path
from gpuq.elastic import plan_elastic_batch
from gpuq.progress import ProgressReporter
from gpuq.util import atomic_write_json
assert os.getcwd() == '/workspace'
assert 'PRIVATE_TOKEN' not in os.environ
assert os.environ['EXPERIMENT'] == '中文试验'
assert Path('/datasets/raw/sample.txt').read_text() == Path('/data2/images/sample.txt').read_text()
batch = plan_elastic_batch()
if resume_checkpoint_path():
    state=json.load(open(resume_checkpoint_path()))
    assert state=={'epoch':2,'model':3,'optimizer':7,'scheduler':2,'rng':11,'task':os.environ['GPUQ_CONSOLE_JOB_ID']}
    assert os.environ['GPUQ_PREVIOUS_WORLD_SIZE']=='2'
    assert batch.gradient_accumulation_steps==2 and batch.lr_linear_scale==1
    print('RESUMED_SAME_TASK')
    raise SystemExit(0)
assert batch.gradient_accumulation_steps == 3 and batch.lr_linear_scale == 1
assert ProgressReporter(report_interval_seconds=0).update(phase='train',epochs_completed=2,epochs_total=4)
def save():
    state = {'epoch':2,'model':3,'optimizer':7,'scheduler':2,'rng':11,'task':os.environ['GPUQ_CONSOLE_JOB_ID']}
    atomic_write_json(Path('/outputs/model.json'), state)
    return {'checkpoint_path':'/outputs/model.json','resume_epoch':2}
checkpoint_at_epoch_end(save)
raise AssertionError('checkpoint did not stop the attempt')
'''
        result = self.execute_namespace(script)
        original_plan = deepcopy(self.plan)
        self.assertEqual(result.returncode, CHECKPOINT_EXIT_CODE, result.stderr)
        ack = json.loads((self.control / 'ack.json').read_text())
        progress = json.loads((self.control / 'progress.json').read_text())
        self.assertEqual(ack['nonce'], request['nonce'])
        self.assertEqual(ack['attempt_id'], self.identity.attempt_id)
        self.assertEqual(progress['job_id'], self.identity.native_job_id)
        self.assertEqual(progress['attempt_id'], self.identity.attempt_id)
        self.new_attempt(3, previous=2, resume=ack['checkpoint_path'])
        result = self.execute_namespace(script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'RESUMED_SAME_TASK')
        self.assertEqual(self.plan, original_plan)
        self.assertFalse((self.control / 'ack.json').exists())


if __name__ == '__main__':
    unittest.main()
