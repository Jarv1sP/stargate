"""OCI lifecycle/argv contract on real temporary handles and a fake Podman.

No engine, systemd unit, image, GPU or production storage is modified here.
"""
from contextlib import contextmanager
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


E = load('oci_engine_test', 'src/infrastructure/oci-training-engine.py')
F = load('oci_engine_inputs', 'tests/v2-training-command.test.py')


class OciEngineTests(unittest.TestCase):
    def setUp(self):
        self.fixture = f = F.TrainingCommandTests('runTest')
        self.addCleanup(f.doCleanups)
        f.setUp()
        f.identity.process = SimpleNamespace(control_group='/user.slice/gpuq-' + f.identity.attempt_id.lower() + '.service')
        f.identity.invocation_id = '1' * 32
        self.cid, self.image = 'a' * 64, 'sha256:' + 'b' * 64
        self.events, self.host_envs, self.created = [], [], None
        self.state = {'Status': 'created', 'Running': False, 'Pid': 0, 'ExitCode': 0}
        self.exists_code, self.create_stdout, self.attach_error, self.remove_error = 1, self.cid, None, False
        self.inspection_changes = {}
        self.owner = SimpleNamespace(owner='c' * 64, command=lambda *args: ['/fixture/podman', *args],
            prepare_runtime_directory=Mock(), run=Mock(return_value=json.dumps(['PATH=/image/bin', 'PYTHONPATH=/image/modules'])))
        self.owner.registry_auth = self.registry_auth
        self.owner.named_mounts = self.named_mounts
        self.owners = Mock(return_value=self.owner)
        self.devices = Mock(return_value=['nvidia.com/gpu=GPU-test-0', 'nvidia.com/gpu=GPU-test-1'])
        self.systemd = Mock(return_value=SimpleNamespace(stdout='Delegate=yes\nKillMode=control-group\nControlGroup=' +
            f.identity.process.control_group + '\nInvocationID=' + f.identity.invocation_id + '\n'))
        self.engine = E.OciTrainingEngine(owners=self.owners, devices=self.devices, systemd=self.systemd)
        self.authorize = Mock()

    @contextmanager
    def registry_auth(self):
        yield {'PATH': '/host/engine/bin', 'HOST_ONLY': 'host-scope'}, 999

    @contextmanager
    def named_mounts(self, mounts, control):
        self.assertEqual(control, [])
        self.mounts = mounts
        for fd, _, _ in mounts:
            self.assertGreaterEqual(os.fstat(fd).st_size, 0)
        yield {fd: '/fixture/mount-' + str(fd) for fd, _, _ in mounts}

    def request(self, argv, *, env, **kwargs):
        self.assertEqual(argv[0], '/fixture/podman')
        operation, *args = argv[1:]
        self.events.append((operation, args))
        self.host_envs.append(env)
        code, stdout = 0, ''
        if operation == 'container':
            self.assertEqual(args[0], 'exists'); code = self.exists_code
        elif operation == 'create':
            self.created = args
            self.name = args[args.index('--name') + 1]
            self.labels = dict(args[index+1].split('=', 1) for index, item in enumerate(args) if item == '--label')
            stdout = self.create_stdout
        elif operation == 'inspect':
            self.assertEqual(args, ['--type=container', '--format=json', self.cid])
            stdout = json.dumps([{'Id': self.cid, 'Name': self.name, 'Image': self.image.removeprefix('sha256:'),
                'Config': {'Labels': self.labels}, 'State': self.state, **self.inspection_changes}])
        elif operation == 'rm':
            self.assertIn(args, ([self.cid], ['--force', '--time=0', self.cid]))
            code = 125 if self.remove_error else 0
        else:
            self.fail('unexpected operation ' + operation)
        return subprocess.CompletedProcess(argv, code, stdout, '')

    def start(self, argv, *, env, **kwargs):
        self.assertEqual(argv, ['/fixture/podman', 'start', '--attach', self.cid])
        self.authorize.assert_called_once()
        self.events.append(('start', [self.cid])); self.host_envs.append(env)
        self.state = {'Status': 'running', 'Running': True, 'Pid': 321, 'ExitCode': 0}
        process = Mock()
        if self.attach_error:
            process.wait.side_effect = [self.attach_error, -9]
            process.poll.return_value = None
        else:
            def finish():
                self.state = {'Status': 'exited', 'Running': False, 'Pid': 0, 'ExitCode': 75}
                return 125  # The container exit receipt, not this CLI failure, is authoritative.
            process.wait.side_effect = finish
            process.poll.return_value = 125
        return process

    def execute(self, env=None, cwd='experiments/run', argv=None):
        with self.fixture.runtime().open() as resources, self.fixture.command().open(resources, sharing=None) as command:
            # Only the engine's input type changes; real FDs retain their roles.
            resources = {**resources, 'runtime': {'kind': 'oci', 'identity': self.image}}
            command = {**command, 'environment': {**command['environment'], **(env or {})}, 'workingDirectory': '/workspace/' + cwd,
                'argv': argv or ['/image/bin/python', 'train.py', '$(literal)', '参数']}
            budget = {'metadataFd': os.memfd_create('gpuq-resources'), 'cgroupFd': resources['descriptors']['output'],
                'environment': {'GPUQ_GPU_COUNT': '2', 'GPUQ_CPU_LIMIT': '8'}}
            try:
                with patch.object(E.subprocess, 'run', side_effect=self.request), patch.object(E.subprocess, 'Popen', side_effect=self.start):
                    return self.engine.run(resources=resources, command=command, budget=budget, authorize_start=self.authorize)
            finally:
                os.close(budget['metadataFd'])

    def test_exact_image_command_environment_mounts_and_exit_are_preserved(self):
        self.assertEqual(self.execute({'lowercase': 'one\ntwo', 'LD_PRELOAD': '/inside/user.so'}), 75)
        self.owner.prepare_runtime_directory.assert_called_once()
        self.assertEqual(self.created[self.created.index('--entrypoint')+1], json.dumps(['/image/bin/python']))
        self.assertEqual(self.created[-4:], [self.image, 'train.py', '$(literal)', '参数'])
        env = dict(self.created[index+1].split('=', 1) for index, item in enumerate(self.created) if item == '--env')
        self.assertEqual(env['lowercase'], 'one\ntwo')
        self.assertEqual(env['PATH'], '/opt/gpuq/bin:/image/bin')
        self.assertEqual(env['PYTHONPATH'], '/opt/gpuq/sdk.pyz:/workspace')
        self.assertEqual(env['GPUQ_CONSOLE_JOB_ID'], self.fixture.fixture.job)
        self.assertNotIn('HOST_ONLY', env)
        self.assertTrue(all(value == {'PATH': '/host/engine/bin', 'HOST_ONLY': 'host-scope'} for value in self.host_envs))
        self.assertEqual(self.created[self.created.index('--workdir')+1], '/workspace/experiments/run')
        self.assertIn('--pull=never', self.created); self.assertIn('--cgroups=split', self.created)
        self.assertNotIn('--replace', self.created); self.assertNotIn('--privileged', self.created)
        self.assertEqual({target: ro for _, target, ro in self.mounts}['/workspace'], True)
        self.assertEqual({target: ro for _, target, ro in self.mounts}['/outputs'], False)
        self.assertEqual(self.events[-1], ('rm', [self.cid]))
        self.devices.assert_called_once_with(self.owner, ['GPU-test-0', 'GPU-test-1'])

    def test_explicit_user_path_is_not_replaced_with_image_defaults(self):
        self.assertEqual(self.execute({'PATH': '/chosen/bin'}), 75)
        self.assertIn('PATH=/chosen/bin', self.created)

    def test_image_pythonpath_is_preserved_when_the_user_did_not_override_it(self):
        self.fixture.plan['submission']['execution']['env'].pop('PYTHONPATH')
        self.assertEqual(self.execute(), 75)
        self.assertIn('PYTHONPATH=/opt/gpuq/sdk.pyz:/image/modules', self.created)

    def test_existing_or_unobserved_name_is_never_replaced_or_started(self):
        for code in (0, 125):
            self.exists_code = code; self.events.clear()
            with self.subTest(code=code), self.assertRaises(E.OciExecutionError):
                self.execute()
            self.assertEqual([name for name, _ in self.events], ['container'])
        self.authorize.assert_not_called()

    def test_lost_create_receipt_keeps_name_without_starting_or_removing_any_container(self):
        self.create_stdout = ''
        with self.assertRaisesRegex(E.OciExecutionError, 'create receipt'):
            self.execute()
        self.assertEqual([op for op, _ in self.events], ['container', 'create'])
        self.authorize.assert_not_called()

    def test_foreign_inspect_receipt_is_not_started_stopped_or_removed(self):
        self.inspection_changes = {'Config': {'Labels': {'io.gpuq.owner': 'other'}}}
        with self.assertRaisesRegex(E.OciExecutionError, 'original attempt'):
            self.execute()
        self.assertFalse(any(op in {'start', 'kill', 'rm'} for op, _ in self.events))

    def test_revocation_after_create_removes_only_its_unstarted_container(self):
        self.authorize.side_effect = PermissionError('revoked')
        with self.assertRaisesRegex(PermissionError, 'revoked'):
            self.execute()
        self.assertFalse(any(op in {'start', 'kill'} for op, _ in self.events))
        self.assertEqual(self.events[-1], ('rm', [self.cid]))

    def test_attach_interruption_stops_the_original_container_and_keeps_the_primary_error(self):
        self.attach_error = RuntimeError('original attach failure')
        with self.assertRaisesRegex(RuntimeError, 'original attach failure'):
            self.execute()
        self.assertIn(('rm', ['--force', '--time=0', self.cid]), self.events)
        self.assertEqual(self.events[-1], ('container', ['exists', self.cid]))

    def test_live_initialized_state_after_lost_start_receipt_is_removed_by_exact_id(self):
        original = self.start
        def interrupted(*args, **kwargs):
            process = original(*args, **kwargs)
            process.wait.side_effect = lambda: -9
            process.poll.return_value = -9
            self.state = {'Status': 'initialized', 'Running': False, 'Pid': 321, 'ExitCode': 0}
            return process
        self.start = interrupted
        with self.assertRaisesRegex(E.OciExecutionError, 'completed execution'):
            self.execute()
        self.assertIn(('rm', ['--force', '--time=0', self.cid]), self.events)
        self.assertFalse(any(op in {'kill', 'wait'} for op, _ in self.events))

    def test_failed_removal_does_not_replace_the_confirmed_workload_exit(self):
        self.remove_error = True
        with patch('sys.stderr', new_callable=io.StringIO) as messages:
            self.assertEqual(self.execute(), 75)
        self.assertIn('retained ' + self.cid, messages.getvalue())

    def test_wrong_parent_unit_is_rejected_before_owner_or_podman_access(self):
        self.systemd.return_value.stdout = 'Delegate=no\n'
        with self.assertRaisesRegex(E.OciExecutionError, 'delegated task unit'):
            self.execute()
        self.owners.assert_not_called()
        self.assertEqual(self.events, [])


if __name__ == '__main__':
    unittest.main()
