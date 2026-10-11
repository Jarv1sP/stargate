"""Real bubblewrap/slirp execution; GPU allocation and systemd limits are fixtures.

Only temporary projects and local test endpoints are used. The test invokes
system Python, never the synthetic project's interpreter or a GPU workload.
"""
from contextlib import contextmanager
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import select
import socket
import subprocess
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


F = load('engine_command_fixture', 'tests/v2-training-command.test.py')
N = load('engine_network', 'src/infrastructure/sandbox-network.py')
E = load('training_engine', 'src/infrastructure/bwrap-training-engine.py')
B = load('engine_budget', 'src/infrastructure/training-budget.py')
L = load('engine_resource_policy', 'deploy/job-resources.py')


class BwrapEngineTests(unittest.TestCase):
    def setUp(self):
        self.bwrap = shutil.which('bwrap')
        self.slirp = os.environ.get('V2_SLIRP') or shutil.which('slirp4netns')
        if not self.bwrap or not self.slirp:
            self.skipTest('bubblewrap/slirp4netns unavailable; engine not tested')
        f = self.fixture = F.TrainingCommandTests('runTest')
        f.setUp()
        self.addCleanup(f.doCleanups)
        f.plan['submission']['resources'] = {'sharing': None}
        group = '/user.slice/gpuq-' + f.identity.attempt_id.lower() + '.service'
        f.identity.process = SimpleNamespace(control_group=group)
        self.root = f.fixture.path / 'cgroups'
        self.leaf = self.root / group.lstrip('/')
        self.leaf.mkdir(parents=True)
        self.setter = Mock(side_effect=self.set_limits)
        self.budget = B.TrainingBudget(L, systemd=self.setter, cgroup_root=self.root)
        self.network = N.SlirpNetwork(binary=self.slirp, library_path=os.environ.get('V2_SLIRP_LIB'))
        self.devices = Mock(return_value=[])  # No NVIDIA devices are present in this CPU test.
        self.engine = E.BwrapTrainingEngine(network=self.network, devices=self.devices, bwrap=self.bwrap)
        self.output = f.fixture.store.existing_run_paths(f.fixture.user, f.fixture.slug, f.fixture.version, f.fixture.job)['output']

    def set_limits(self, argv, **kwargs):
        values = dict(value.split('=', 1) for value in argv[6:])
        for name, value in [('cpu.max', str(int(values['CPUQuota'][:-1]) * 1000) + ' 100000'),
                            ('memory.max', values['MemoryMax']), ('pids.max', values['TasksMax'])]:
            (self.leaf / name).write_text(value)
        return subprocess.CompletedProcess(argv, 0)

    def run_script(self, script, *, engine=None):
        self.fixture.plan['submission']['execution']['argv'] = ['/usr/bin/python3', '-c', script]
        return self.fixture.runtime().run(budget=self.budget, command=self.fixture.command(), engine=engine or self.engine)

    def test_real_runtime_executes_after_network_setup_with_persistent_outputs_and_readonly_inputs(self):
        processes, original = [], subprocess.Popen
        def spawn(*args, **kwargs):
            process = original(*args, **kwargs)
            processes.append(process)
            return process
        script = '''import errno,json,os
from pathlib import Path
assert os.getcwd()=='/workspace'
assert os.environ['EXPERIMENT']=='中文试验'
assert os.environ['GPUQ_CONSOLE_JOB_ID']!=os.environ['GPUQ_CONSOLE_DISPATCH_ID']
assert 'PRIVATE_HOST_MARKER' not in os.environ
assert Path('/etc/resolv.conf').read_text()=='nameserver 10.0.2.3\\n'
assert 'tap0' in Path('/proc/net/dev').read_text()
assert json.load(open('/run/gpuq/resources.json'))['gpuCount']==2
for path in ['/workspace/train.py','/datasets/raw/sample.txt','/data2/images/sample.txt','/sys/fs/cgroup/memory.max']:
    assert Path(path).read_bytes()
    try: open(path,'w')
    except OSError as error: assert error.errno==errno.EROFS,error
    else: raise AssertionError('read-only input is writable')
assert Path('/opt/gpuq/bin/gpuq-ray').exists()
assert Path('/opt/gpuq/bin/gpuq-network').exists()
assert not Path('/host-secret-marker').exists()
Path('/outputs/result.json').write_text(json.dumps({'task':os.environ['GPUQ_CONSOLE_JOB_ID'],'count':os.environ['GPUQ_GPU_COUNT']}))
Path('/home/gpuq/persistent.txt').write_text('saved')
raise SystemExit(17)
'''
        with patch.dict(os.environ, {'PRIVATE_HOST_MARKER': 'not-inherited'}), patch.object(E.subprocess, 'Popen', side_effect=spawn):
            self.assertEqual(self.run_script(script), 17)
        self.assertEqual(json.loads((self.output / 'result.json').read_text()), {'task': self.fixture.fixture.job, 'count': '2'})
        self.devices.assert_called_once_with(['GPU-test-0', 'GPU-test-1'])
        self.assertEqual(len(processes), 2)
        self.assertTrue(all(process.poll() is not None for process in processes))
        self.assertFalse(list(self.fixture.control.glob('.launch-*')))
        self.assertEqual(len(self.fixture.fixture.cache._leases('images', self.fixture.fixture.source['version'])), 1)

    def test_network_start_failure_never_runs_user_command_or_user_python_hooks(self):
        namespaces = []
        @contextmanager
        def fail(pid):
            descriptor = os.pidfd_open(pid)
            self.addCleanup(os.close, descriptor)
            namespaces.append(descriptor)
            raise RuntimeError('fixture network failure')
            yield
        network = SimpleNamespace(resolv_conf=self.network.resolv_conf, open=fail)
        engine = E.BwrapTrainingEngine(network=network, devices=self.devices, bwrap=self.bwrap)
        (self.output / 'sitecustomize.py').write_text("open('/outputs/hook-ran','w').write('bad')")
        self.fixture.plan['submission']['execution']['env']['PYTHONPATH'] = '/outputs'
        with self.assertRaisesRegex(RuntimeError, 'fixture network failure'):
            self.run_script("open('/outputs/payload-ran','w').write('bad')", engine=engine)
        self.assertFalse((self.output / 'hook-ran').exists())
        self.assertFalse((self.output / 'payload-ran').exists())
        self.assertEqual(select.select(namespaces, [], [], 0)[0], namespaces)
        self.assertFalse(list(self.fixture.control.glob('.launch-*')))
        # Once ready, the same requested PYTHONPATH takes effect in the payload.
        self.assertEqual(self.run_script("open('/outputs/payload-ran','w').write('ok')"), 0)
        self.assertEqual((self.output / 'hook-ran').read_text(), 'bad')

    def test_helper_spawn_and_early_exit_failures_do_not_execute_payload(self):
        for binary, expected in [('/nonexistent-v2-helper', FileNotFoundError), ('/bin/false', RuntimeError)]:
            network = N.SlirpNetwork(binary=binary, timeout=.5)
            engine = E.BwrapTrainingEngine(network=network, devices=self.devices, bwrap=self.bwrap)
            with self.subTest(binary=binary), self.assertRaises(expected):
                self.run_script("open('/outputs/unexpected','w').write('bad')", engine=engine)
            self.assertFalse((self.output / 'unexpected').exists())
            self.assertFalse(list(self.fixture.control.glob('.launch-*')))

    def test_cancellation_while_network_is_prepared_stops_before_user_code(self):
        alive, real_open = True, self.network.open
        def current():
            if not alive:
                raise RuntimeError('canceled during network setup')
            return self.fixture.identity
        @contextmanager
        def cancel_after_ready(pid):
            nonlocal alive
            with real_open(pid) as process:
                alive = False
                yield process
        self.network.open = cancel_after_ready
        self.fixture.plan['submission']['execution']['argv'] = ['/usr/bin/python3', '-c', "open('/outputs/canceled-ran','w').write('bad')"]
        runtime = F.R.TrainingRuntime(authority=SimpleNamespace(require_current=current),
            inputs=self.fixture.fixture.runtime, plan=self.fixture.plan)
        with self.assertRaisesRegex(RuntimeError, 'canceled during network setup'):
            runtime.run(budget=self.budget, command=self.fixture.command(), engine=self.engine)
        self.assertFalse((self.output / 'canceled-ran').exists())
        self.assertFalse(list(self.fixture.control.glob('.launch-*')))

    def test_payload_exit_stops_its_orphaned_child_namespace(self):
        namespaces, real_open = [], self.network.open
        @contextmanager
        def track(pid):
            descriptor = os.pidfd_open(pid)
            self.addCleanup(os.close, descriptor)
            namespaces.append(descriptor)
            with real_open(pid) as process:
                yield process
        self.network.open = track
        script = '''import subprocess,time
from pathlib import Path
subprocess.Popen(['/usr/bin/python3','-c',"from pathlib import Path; import time; Path('/outputs/child-started').write_text('yes'); time.sleep(30)"])
deadline=time.monotonic()+5
while not Path('/outputs/child-started').exists() and time.monotonic()<deadline: time.sleep(.01)
assert Path('/outputs/child-started').exists()
raise SystemExit(23)
'''
        self.assertEqual(self.run_script(script), 23)
        self.assertEqual(len(namespaces), 1)
        self.assertEqual(select.select(namespaces, [], [], 0)[0], namespaces)

    def test_direct_host_loopback_gateway_is_disabled(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0)); server.listen(1)
            port = server.getsockname()[1]
            script = f'''import socket
try: connection=socket.create_connection(('10.0.2.2',{port}),timeout=.5)
except OSError: pass
else:
    connection.close()
    raise AssertionError('host loopback gateway is accessible')
'''
            self.assertEqual(self.run_script(script), 0)

    def test_same_command_checkpoint_and_resume_through_the_real_engine(self):
        f = self.fixture
        request = {'version': F.SCHEMA_VERSION, 'nonce': 'engine-checkpoint', 'attempt_id': f.identity.attempt_id,
                   'requested_by_job_id': 'Jhigher', 'created_at': time.time()}
        (f.control / 'request.json').write_text(json.dumps(request))
        script = '''import os,json
from pathlib import Path
from gpuq.checkpoint import checkpoint_at_epoch_end,resume_checkpoint_path
from gpuq.elastic import plan_elastic_batch
from gpuq.progress import ProgressReporter
from gpuq.util import atomic_write_json
batch=plan_elastic_batch()
if resume_checkpoint_path():
    state=json.load(open(resume_checkpoint_path()))
    assert state=={'epoch':1,'task':os.environ['GPUQ_CONSOLE_JOB_ID'],'state':[3,7,11]}
    assert batch.gradient_accumulation_steps==2 and batch.lr_linear_scale==1
    Path('/outputs/resumed').write_text('yes')
    raise SystemExit(0)
assert batch.gradient_accumulation_steps==3 and batch.lr_linear_scale==1
assert ProgressReporter(report_interval_seconds=0).update(phase='train',epochs_completed=1,epochs_total=2)
def save():
    atomic_write_json(Path('/outputs/checkpoint.json'),{'epoch':1,'task':os.environ['GPUQ_CONSOLE_JOB_ID'],'state':[3,7,11]})
    return {'checkpoint_path':'/outputs/checkpoint.json','resume_epoch':1}
checkpoint_at_epoch_end(save)
raise AssertionError('checkpoint request did not exit')
'''
        self.assertEqual(self.run_script(script), F.CHECKPOINT_EXIT_CODE)
        original = deepcopy(f.plan)
        ack = json.loads((f.control / 'ack.json').read_text())
        self.assertEqual((ack['nonce'], ack['attempt_id']), (request['nonce'], request['attempt_id']))
        self.assertEqual(json.loads((f.control / 'progress.json').read_text())['job_id'], f.identity.native_job_id)
        f.new_attempt(3, previous=2, resume=ack['checkpoint_path'])
        f.identity.process = SimpleNamespace(control_group='/user.slice/gpuq-' + f.identity.attempt_id.lower() + '.service')
        self.leaf = self.root / f.identity.process.control_group.lstrip('/')
        self.leaf.mkdir(parents=True)
        self.assertEqual(self.run_script(script), 0)
        self.assertEqual(f.plan, original)
        self.assertEqual((self.output / 'resumed').read_text(), 'yes')
        self.assertFalse((f.control / 'ack.json').exists())

    def test_network_helper_failure_during_training_stops_and_reaps_the_container(self):
        children, failure = [], []
        real_open = self.network.open
        @contextmanager
        def track(pid):
            with real_open(pid) as process:
                children.append(process)
                yield process
        self.network.open = track
        def run():
            try:
                self.run_script("from pathlib import Path; import time; Path('/outputs/running').write_text('ready'); time.sleep(30)")
            except BaseException as error:
                failure.append(error)
        thread = threading.Thread(target=run)
        thread.start()
        try:
            deadline = time.monotonic() + 10
            while not (self.output / 'running').exists() and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue((self.output / 'running').exists(), failure)
            self.assertEqual(len(children), 1)
            children[0].terminate()  # This test's exact helper, not any shared daemon.
            thread.join(10)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(failure), 1)
            self.assertIn('network helper exited', str(failure[0]))
            self.assertIsNotNone(children[0].poll())
        finally:
            for process in children:
                N.stop_process(process)
            thread.join(10)
        self.assertFalse(list(self.fixture.control.glob('.launch-*')))

    def test_real_private_network_reaches_a_local_nonloopback_fixture(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
            route.connect(('192.0.2.1', 9))  # Route selection only; no packet is sent.
            address = route.getsockname()[0]
        if address.startswith('127.'):
            self.skipTest('no non-loopback local address for the network fixture')
        listener = socket.socket()
        self.addCleanup(listener.close)
        listener.bind((address, 0)); listener.listen(1); listener.settimeout(10)
        port = listener.getsockname()[1]
        served = []
        def serve():
            with listener.accept()[0] as connection:
                served.append(connection.recv(32))
                connection.sendall(b'fixture-reply')
        server = threading.Thread(target=serve)
        server.start()
        script = f"import socket; from pathlib import Path; s=socket.create_connection(({address!r},{port}),timeout=5); s.sendall(b'fixture-request'); Path('/outputs/network.txt').write_bytes(s.recv(32)); s.close()"
        try:
            self.assertEqual(self.run_script(script), 0)
        finally:
            server.join(11)
        self.assertFalse(server.is_alive())
        self.assertEqual(served, [b'fixture-request'])
        self.assertEqual((self.output / 'network.txt').read_bytes(), b'fixture-reply')

    def test_wrong_engine_or_device_mapping_failure_never_spawns_a_container(self):
        with self.fixture.runtime().open() as resources, self.budget.open(self.fixture.identity) as budget, \
                self.fixture.command().open(resources, sharing=None) as command, patch.object(E.subprocess, 'Popen') as spawn:
            authorize = Mock(side_effect=AssertionError('must not authorize invalid engine'))
            with self.assertRaisesRegex(ValueError, 'OCI'):
                self.engine.run(resources={**resources, 'runtime': {'kind': 'oci'}}, command=command, budget=budget, authorize_start=authorize)
            self.devices.side_effect = ValueError('device mapping unavailable')
            with self.assertRaisesRegex(ValueError, 'device mapping unavailable'):
                self.engine.run(resources=resources, command=command, budget=budget, authorize_start=authorize)
            spawn.assert_not_called()
            authorize.assert_not_called()


if __name__ == '__main__':
    unittest.main()
