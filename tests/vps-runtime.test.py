"""Production VPS transport and collection, using local sockets and fake SSH IO."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import tempfile
import threading
import tarfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='vps-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        for folder in ('executor', 'collector', 'runtime', 'status'):
            (self.base/folder).mkdir(mode=0o700)
        self.host = dict(user='nodeops', address='192.0.2.1')
        self.config = dict(
            transport=dict(credentialDirectory=str(self.base/'executor'), hosts={'node-example': self.host}),
            bridge=dict(runtimeDirectory=str(self.base/'runtime'), socket=str(self.base/'bridge.sock'),
                        socketUid=os.getuid(), socketGid=os.getgid()),
            collector=dict(credentialDirectory=str(self.base/'collector'), hosts={'node-example': self.host},
                           target=str(self.base/'status/snapshot.json'), targetUid=os.getuid(), targetGid=os.getgid()),
            futureSetting='ignored')
        self.private = self.base/'vps.json'
        self.private.write_text(json.dumps(self.config))
        environment = patch.dict(os.environ, STARGATE_VPS_CONFIG=str(self.private))
        environment.start()
        self.addCleanup(environment.stop)
        self.bridge = load('vps_bridge', ROOT/'deploy/vps/direct-storage-bridge.py')
        self.transport = self.bridge.transport
        self.collector = load('vps_collector', ROOT/'deploy/vps/collect-status.py')

    def serve(self, call):
        self.bridge.connection.call = call
        server = self.bridge.Server(str(self.base/'bridge.sock'), self.bridge.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.shutdown)

    def request(self, operation='data.upload.begin', **extra):
        request = dict(machine='node-example', operation=operation,
                       args=dict(key='11111111-1111-4111-8111-111111111111', totalSize=3), **extra)
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(str(self.base/'bridge.sock'))
            client.sendall((json.dumps(request)+'\n').encode())
            with client.makefile('rb') as stream:
                return json.loads(stream.readline())

    def test_bridge_forwards_new_node_operations_and_ignores_extra_envelope_fields(self):
        calls = []
        def call(host, request):
            calls.append((host, request))
            return subprocess.CompletedProcess([], 0, json.dumps(dict(ok=True, result=dict(state='UPLOADING'))), '')
        self.serve(call)
        for operation in ('data.upload.begin', 'projects.retire.restore', 'cloud.files.upload', 'terminal.exchange'):
            response = self.request(operation, futureField='ignored')
            self.assertEqual(response, dict(ok=True, result=dict(state='UPLOADING')))
            host, request = calls[-1]
            self.assertEqual(host, self.host)
            self.assertEqual(request['operation'], operation)
            self.assertNotIn('futureField', request)
        self.assertEqual(len(calls), 4)

    def test_bridge_keeps_uncertain_writes_unknown_without_replaying_them(self):
        for result in ('lost', 'invalid', 'ssh'):
            with self.subTest(result=result):
                calls = []
                def call(host, request):
                    calls.append(request)
                    if result == 'lost':
                        raise self.transport.NodeTransportError('NODE_RESPONSE_TIMEOUT', 504, 'rpc')
                    return subprocess.CompletedProcess([], 255 if result == 'ssh' else 0, 'incomplete', 'private SSH detail')
                self.bridge.connection.call = call
                if result == 'lost':
                    self.serve(call)
                response = self.request()
                self.assertFalse(response['ok'])
                self.assertTrue(response['outcomeUnconfirmed'])
                self.assertEqual(len(calls), 1)
                self.assertNotIn('private SSH detail', response['error'])

    def ssh_calls(self, connections, outcome=None):
        calls = []
        sockets = []
        self.addCleanup(lambda: [s.close() for s in sockets])
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            if 'ControlMaster=yes' in argv:
                path = next(value.split('=', 1)[1] for value in argv if value.startswith('ControlPath='))
                control = socket.socket(socket.AF_UNIX)
                control.bind(path)
                Path(path).chmod(0o600)
                sockets.append(control)
            if 'input' in kwargs:
                if outcome == 'timeout':
                    raise subprocess.TimeoutExpired(argv, kwargs['timeout'])
                if outcome == 'lost':
                    raise OSError('connection closed')
                return subprocess.CompletedProcess(argv, 0, '{"ok":true,"result":{}}', '')
            return subprocess.CompletedProcess(argv, 0, b'', b'')
        return calls, run

    def test_transport_reuses_one_master_and_keeps_ssh_authentication_and_forced_commands(self):
        connections = self.transport.SSHConnections()
        calls, run = self.ssh_calls(connections)
        with patch.object(self.transport.subprocess, 'run', side_effect=run):
            for key in ('first', 'second'):
                connections.call(self.host, dict(operation='data.upload.begin', args=dict(key=key)))
        self.assertEqual(sum('ControlMaster=yes' in argv for argv, _ in calls), 1)
        self.assertEqual(sum('-O' in argv for argv, _ in calls), 1)
        requests = [(argv, kwargs) for argv, kwargs in calls if 'input' in kwargs]
        self.assertEqual(len(requests), 2)
        for argv, kwargs in requests:
            self.assertIn('StrictHostKeyChecking=yes', argv)
            self.assertIn('ProxyCommand=/usr/bin/false', argv)
            self.assertIn('ForwardAgent=no', argv)
            self.assertIn('ClearAllForwardings=yes', argv)
            self.assertIn(str(self.base/'executor/id_ed25519'), argv)
            self.assertIn('UserKnownHostsFile='+str(self.base/'executor/known_hosts'), argv)
            self.assertEqual(argv[-1], 'nodeops@192.0.2.1')
            self.assertEqual(json.loads(kwargs['input'])['operation'], 'data.upload.begin')

    def test_transport_never_replays_sent_writes_or_terminal_input_after_a_lost_reply(self):
        for outcome in ('timeout', 'lost'):
            with self.subTest(outcome=outcome):
                connections = self.transport.SSHConnections(runtime=self.base/('runtime-'+outcome))
                connections.runtime.mkdir(mode=0o700)
                calls, run = self.ssh_calls(connections, outcome)
                with patch.object(self.transport.subprocess, 'run', side_effect=run):
                    with self.assertRaises(self.transport.NodeTransportError):
                        connections.call(self.host, dict(operation='terminal.exchange', args=dict(input='run once\n')))
                self.assertEqual(sum('input' in kwargs for _, kwargs in calls), 1)

    def test_transport_reports_authentication_errors_without_exposing_ssh_stderr(self):
        for stderr, code in ((b'Permission denied private key path', 'NODE_SSH_AUTH_FAILED'),
                             (b'Host key verification failed', 'NODE_SSH_HOSTKEY_FAILED')):
            with self.subTest(code=code):
                with patch.object(self.transport.subprocess, 'run', return_value=subprocess.CompletedProcess([], 255, b'', stderr)) as run:
                    with self.assertRaises(self.transport.NodeTransportError) as error:
                        self.transport.SSHConnections().call(self.host, dict(operation='sync', args={}))
                self.assertEqual(error.exception.code, code)
                self.assertEqual(str(error.exception), 'Node connection failed')
                self.assertEqual(run.call_count, 1)

    def collect(self):
        mask = os.umask(0o027)
        try:
            with redirect_stdout(io.StringIO()):
                self.collector.main()
        finally:
            os.umask(mask)
        return json.loads(Path(self.config['collector']['target']).read_text())

    def test_collector_writes_one_atomic_snapshot_using_private_credentials_and_configured_host(self):
        target = Path(self.config['collector']['target'])
        target.write_text('{"old":"complete snapshot"}')
        response = dict(version=1, gpus=[dict(index=0, name='Test GPU')], gpuq=dict(connected=True, jobs=[]))
        original = self.collector.os.replace
        def replace(source, destination):
            self.assertEqual(json.loads(target.read_text()), {'old': 'complete snapshot'})
            self.assertTrue(json.loads(Path(source).read_text())['hosts'][0]['reachable'])
            return original(source, destination)
        with patch.object(self.collector.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(response), '')) as run, \
                patch.object(self.collector.os, 'replace', side_effect=replace) as commit, \
                patch.object(self.collector.os, 'fsync', wraps=os.fsync) as sync:
            snapshot = self.collect()
        self.assertEqual(commit.call_count, 1)
        self.assertEqual(sync.call_count, 1)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640)
        host = snapshot['hosts'][0]
        self.assertEqual((host['id'], host['reachable'], host['samplingStale']), ('node-example', True, False))
        argv = run.call_args.args[0]
        self.assertEqual(argv[-2:], ['nodeops@192.0.2.1', 'status'])
        self.assertIn(str(self.base/'collector/id_ed25519'), argv)
        self.assertIn('StrictHostKeyChecking=yes', argv)
        self.assertEqual(list(target.parent.glob('.snapshot-*')), [])

    def test_collector_bounded_retry_and_retained_sample_are_the_production_behavior(self):
        target = Path(self.config['collector']['target'])
        target.write_text(json.dumps(dict(checkedAt='previous', hosts=[dict(
            id='node-example', reachable=True, checkedAt='previous', gpus=[dict(index=0)],
            gpuq=dict(connected=True, jobs=[dict(id='running')]))])))
        with patch.object(self.collector.subprocess, 'run', side_effect=subprocess.TimeoutExpired('ssh', 1)) as run:
            snapshot = self.collect()
        host = snapshot['hosts'][0]
        self.assertEqual(run.call_count, 2)
        self.assertTrue(host['samplingStale'])
        self.assertEqual(host['checkedAt'], 'previous')
        self.assertEqual(host['gpuq']['jobs'], [dict(id='running')])
        self.assertFalse(host['hostCommand']['available'])

    def test_collector_first_failure_is_unreachable_and_auth_failures_are_not_retried(self):
        with patch.object(self.collector.subprocess, 'run', return_value=subprocess.CompletedProcess([], 255, '', 'Permission denied')) as run:
            snapshot = self.collect()
        self.assertEqual(run.call_count, 1)
        host = snapshot['hosts'][0]
        self.assertFalse(host['reachable'])
        self.assertFalse(host['gpuq']['connected'])
        self.assertEqual(host['gpus'], [])

    def test_collector_failed_publication_keeps_previous_complete_snapshot(self):
        target = Path(self.config['collector']['target'])
        target.write_text('{"old":"complete snapshot"}')
        with patch.object(self.collector, 'HOSTS', {}), \
                patch.object(self.collector.os, 'replace', side_effect=OSError('temporary disk error')):
            with self.assertRaisesRegex(OSError, 'disk error'):
                self.collect()
        self.assertEqual(json.loads(target.read_text()), {'old': 'complete snapshot'})
        self.assertEqual(list(target.parent.glob('.snapshot-*')), [])

    def test_collector_command_reads_the_private_file(self):
        self.config['collector']['hosts'] = {}
        self.private.write_text(json.dumps(self.config))
        result = subprocess.run([os.sys.executable, '-B', str(ROOT/'deploy/vps/collect-status.py')],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['hosts'], 0)
        self.assertEqual(json.loads(Path(self.config['collector']['target']).read_text())['hosts'], [])

    def test_gray_configuration_uses_the_same_runtime_with_only_isolated_values(self):
        setup = (ROOT/'deploy/gray-local/bridge-entrypoint.sh').read_text()
        program = setup.split("python3 - <<'PY'\n", 1)[1].split('\nPY', 1)[0]
        inventory = dict(nodes=[dict(id='node-example', user='nodeops', address='192.0.2.1')])
        config = self.base/'generated.json'
        with patch.dict(os.environ, STARGATE_VPS_CONFIG=str(config)), \
                patch.object(Path, 'read_text', return_value=json.dumps(inventory)):
            exec(program, {})
        generated = json.loads(config.read_text())
        self.assertEqual(generated['transport']['hosts'], {'node-example': self.host})
        self.assertEqual(generated['collector']['hosts'], {'node-example': self.host})
        self.assertEqual(generated['transport']['credentialDirectory'], '/opt/gray/executor')
        self.assertEqual(generated['collector']['credentialDirectory'], '/opt/gray/collector')
        self.assertIn('python3 /opt/stargate-vps/direct-storage-bridge.py', setup)
        self.assertIn('python3 /opt/stargate-vps/collect-status.py', setup)
        self.assertIn('COPY deploy/vps/ /opt/stargate-vps/', (ROOT/'deploy/gray-local/bridge.Dockerfile').read_text())
        run = (ROOT/'scripts/gray-local/run.sh').read_text()
        self.assertIn('-t "$GRAY_BRIDGE_IMAGE" "$run/src"', run)

    def test_existing_service_and_timer_templates_parse_with_systemd(self):
        unit_root = ROOT/'deploy/vps/systemd'
        # Offline parse: does not start services or read a private configuration.
        with tempfile.TemporaryDirectory() as directory:
            environment = {**os.environ, 'SYSTEMD_UNIT_PATH': directory+':/usr/lib/systemd/system'}
            result = subprocess.run(['systemd-analyze', 'verify', '--man=no', '--generators=no',
                                     *map(str, unit_root.glob('*.service')), *map(str, unit_root.glob('*.timer'))],
                                    env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(shutil.which('docker'), 'requires local Docker for the build context regression')
    def test_gray_image_context_contains_runtime_sources_but_no_private_or_cache_files(self):
        environment = {**os.environ, 'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_BUILDKIT': '0'}
        environment.pop('DOCKER_CONTEXT', None)
        def docker(*args, check=True):
            return subprocess.run(['docker', *args], env=environment, capture_output=True, timeout=60, check=check)
        if docker('info', '--format', '{{.ServerVersion}}', check=False).returncode:
            self.skipTest('local Docker daemon is not available')
        context = self.base/'context'
        context.mkdir()
        shutil.copy2(ROOT/'.dockerignore', context/'.dockerignore')
        shutil.copytree(ROOT/'deploy/vps', context/'deploy/vps')
        (context/'deploy/gray-local').mkdir(parents=True)
        shutil.copy2(ROOT/'deploy/gray-local/bridge-entrypoint.sh', context/'deploy/gray-local/bridge-entrypoint.sh')
        (context/'private.json').write_text('synthetic private fixture')
        (context/'deploy/vps/__pycache__').mkdir(exist_ok=True)
        (context/'deploy/vps/__pycache__/fixture.pyc').write_bytes(b'not source')
        (context/'Dockerfile').write_text('FROM scratch\nCOPY . /context/\nCMD ["/unused"]\n')
        image = self.base/'image-id'
        container = None
        try:
            docker('build', '--network=none', '--force-rm', '--iidfile', str(image), str(context))
            container = docker('create', image.read_text().strip()).stdout.decode().strip()
            with tarfile.open(fileobj=io.BytesIO(docker('export', container).stdout)) as archive:
                for name in ('deploy/vps/collect-status.py', 'deploy/vps/direct-storage-bridge.py',
                             'deploy/vps/ssh-transport.py', 'deploy/gray-local/bridge-entrypoint.sh'):
                    self.assertEqual(archive.extractfile('context/'+name).read(), (ROOT/name).read_bytes())
                self.assertNotIn('context/private.json', archive.getnames())
                self.assertNotIn('context/deploy/vps/__pycache__/fixture.pyc', archive.getnames())
        finally:
            if container:
                docker('rm', '-f', container, check=False)
            if image.exists():
                docker('image', 'rm', image.read_text().strip(), check=False)


if __name__ == '__main__':
    unittest.main()
