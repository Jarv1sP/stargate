"""Execute an already prepared base-Python training task inside bubblewrap.

No project preparation, policy decisions, GPU allocation or durable release.
TrainingRuntime owns the input/control/budget handles through this invocation.
"""
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import tempfile

_spec = importlib.util.spec_from_file_location('v2_sandbox_network', Path(__file__).with_name('sandbox-network.py'))
_network = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_network)

# Connect only once all namespaces/mounts are ready. EOF is not permission to run.
# This trusted system Python has no user environment or import hooks.
_START = '''import json,os,socket
with socket.socket(socket.AF_UNIX) as ready:
    ready.connect('/run/gpuq/bootstrap/ready')
    if ready.recv(1)!=b'1': raise SystemExit(125)
with open('/run/gpuq/command.json') as stream: command=json.load(stream)
os.chdir(command['workingDirectory'])
os.execvpe(command['argv'][0],command['argv'],command['environment'])
'''


class BwrapTrainingEngine:
    def __init__(self, *, network, devices, bwrap='/usr/bin/bwrap', helpers=None):
        self._network, self._devices, self._bwrap = network, devices, bwrap
        self._helpers = Path(helpers) if helpers is not None else Path(__file__).resolve().parents[2] / 'deploy'

    def run(self, *, resources, command, budget, authorize_start):
        project = resources['project']
        if resources['runtime']['kind'] != 'base':
            raise ValueError('Base engine cannot execute an OCI release')
        uuids = [gpu for gpu, _ in resources['execution'].assignments]
        devices = self._devices(uuids)
        base = project['meta']['base']['basePath']
        mode = project['environmentMode']
        defaults = {'PATH': '/opt/project-env/bin:/opt/gpuq/bin:' + ('/opt/conda/bin:' if mode == 'shared' else '') + '/usr/bin:/bin',
            'HOME': '/home/gpuq', 'LANG': 'C.UTF-8', 'PYTHONUNBUFFERED': '1', 'PYTHONNOUSERSITE': '1',
            'PYTHONDONTWRITEBYTECODE': '1', 'VIRTUAL_ENV': '/opt/project-env', 'PIP_REQUIRE_VIRTUALENV': 'true',
            'XDG_CACHE_HOME': '/home/gpuq/.cache', 'OMP_NUM_THREADS': '1', 'NCCL_CUMEM_HOST_ENABLE': '0',
            'SSL_CERT_FILE': '/etc/ssl/certs/ca-certificates.crt', 'CURL_CA_BUNDLE': '/etc/ssl/certs/ca-certificates.crt',
            'REQUESTS_CA_BUNDLE': '/etc/ssl/certs/ca-certificates.crt', 'NVIDIA_VISIBLE_DEVICES': ','.join(uuids),
            'GPUQ_PROJECT': project['meta']['project'], 'GPUQ_PROJECT_RELEASE': project['meta']['release'],
            'GPUQ_PROJECT_ENV_MODE': mode, 'GPUQ_OUTPUT_DIR': '/outputs', 'GPUQ_OFFLINE_ASSETS': '/workspace/offline'}
        payload = {'argv': command['argv'], 'workingDirectory': command['workingDirectory'],
                   'environment': {**defaults, **command['environment'], **budget['environment']}}
        with ExitStack() as handles:
            inherited = [*resources['descriptors'].values(), *(fd for fd, _ in resources['dataMounts']),
                         *(fd for fd, _, _ in command['mounts']), budget['cgroupFd'], budget['metadataFd']]

            def data_file(name, content):
                fd = os.memfd_create(name, os.MFD_CLOEXEC)
                handles.callback(os.close, fd)
                with os.fdopen(os.dup(fd), 'wb') as stream:
                    stream.write(content)
                os.lseek(fd, 0, os.SEEK_SET)
                inherited.append(fd)
                return str(fd)

            info_reader, info_writer = _network.pipe(handles)
            info_w = info_writer.fileno()
            inherited.append(info_w)
            startup = handles.enter_context(tempfile.TemporaryDirectory(prefix='.launch-', dir=resources['execution'].control_dir))
            startup_fd = os.open(startup, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            handles.callback(os.close, startup_fd)
            inherited.append(startup_fd)
            listener = handles.enter_context(socket.socket(socket.AF_UNIX))
            # A short FD-relative bind also supports long configured control roots.
            listener.bind('/proc/self/fd/' + str(startup_fd) + '/ready')
            listener.listen(1)
            args = [self._bwrap, '--unshare-all', '--new-session', '--die-with-parent', '--cap-drop', 'ALL', '--hostname', 'gpuq-job',
                '--info-fd', str(info_w), '--ro-bind', '/usr', '/usr',
                '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
                '--proc', '/proc', '--ro-bind', '/sys', '/sys', '--ro-bind-fd', str(budget['cgroupFd']), '/sys/fs/cgroup',
                '--dev', '/dev', '--tmpfs', '/dev/shm', '--tmpfs', '/tmp', '--tmpfs', '/run', '--dir', '/run/gpuq',
                '--dir', '/data2', '--dir', '/datasets', '--dir', '/etc', '--dir', '/opt/gpuq/bin',
                '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache', '--ro-bind', '/etc/alternatives', '/etc/alternatives',
                '--ro-bind', '/etc/ssl', '/etc/ssl', '--ro-bind', base, '/opt/conda',
                '--ro-bind-data', str(budget['metadataFd']), '/run/gpuq/resources.json',
                '--bind-fd', str(startup_fd), '/run/gpuq/bootstrap',
                '--ro-bind-data', data_file('training-command', json.dumps(payload).encode()), '/run/gpuq/command.json',
                '--ro-bind-data', data_file('training-dns', self._network.resolv_conf), '/etc/resolv.conf',
                '--ro-bind-data', data_file('training-hosts', b'127.0.0.1 localhost gpuq-job\n::1 localhost\n'), '/etc/hosts',
                '--ro-bind-data', data_file('training-passwd', f'gpuq:x:{os.getuid()}:{os.getgid()}:GPUQ:/home/gpuq:/bin/bash\n'.encode()), '/etc/passwd',
                '--clearenv']
            if base != '/opt/conda':
                args += ['--ro-bind', base, base]
            for name, target in [('code', '/workspace'), ('env', '/opt/project-env'), ('home', '/home/gpuq'), ('output', '/outputs')]:
                args += ['--ro-bind-fd' if name in ('code', 'env') else '--bind-fd', str(resources['descriptors'][name]), target]
            for descriptor, target in resources['dataMounts']:
                args += ['--ro-bind-fd', str(descriptor), target]
            for descriptor, target, readonly in command['mounts']:
                args += ['--ro-bind-data' if readonly else '--bind-fd', str(descriptor), target]
            for name in ('job-resources.py', 'gpuq-ray', 'gpuq-network'):
                args += ['--ro-bind', str(self._helpers / name), '/opt/gpuq/bin/' + name]
            for path in devices:
                args += ['--dev-bind', path, path]
            if devices:
                args += ['--ro-bind', '/proc/driver/nvidia', '/proc/driver/nvidia']
            process = subprocess.Popen(args + ['--', '/usr/bin/python3', '-I', '-S', '-c', _START],
                pass_fds=tuple(inherited), env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, stdin=subprocess.DEVNULL)
            namespace_fd = None
            try:
                info_writer.close()
                pid = _network.sandbox_pid(info_reader.fileno())
                namespace_fd = os.pidfd_open(pid)
                handles.callback(os.close, namespace_fd)
                ready = select.select([listener, namespace_fd], [], [], 12)[0]
                if namespace_fd in ready or listener not in ready:
                    raise RuntimeError('Sandbox bootstrap did not become ready')
                approval = handles.enter_context(listener.accept()[0])
                with self._network.open(pid) as network:
                    authorize_start()
                    approval.sendall(b'1'); approval.close()
                    while True:
                        try:
                            return process.wait(timeout=0.25)
                        except subprocess.TimeoutExpired:
                            if network.poll() is not None:
                                raise RuntimeError('Sandbox network helper exited during training')
            finally:
                # The outer bwrap may exit before its inner namespace process.
                # Hold that exact process identity, not a later reused numeric PID.
                try:
                    if namespace_fd is not None:
                        try:
                            signal.pidfd_send_signal(namespace_fd, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        if not select.select([namespace_fd], [], [], 3)[0]:
                            raise RuntimeError('Sandbox namespace cleanup unconfirmed')
                finally:
                    _network.stop_process(process)
