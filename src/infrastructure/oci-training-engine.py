"""Run an already verified immutable image in its existing owner graph.

Project/image preparation, GPU allocation and kernel budgets belong to earlier
stages. This adapter owns only its original attempt's Podman container. It never
replaces an existing name, restarts an uncertain launch, or prunes other objects.
"""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import re
import subprocess
import sys

_STOPPED = {'configured', 'created', 'initialized', 'exited', 'stopped'}


class OciExecutionError(RuntimeError):
    code = 'OCI_EXECUTION_UNCONFIRMED'


def _request(owner, environment, *arguments, checked=True, timeout=30):
    result = subprocess.run(owner.command(*arguments), env=environment, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=timeout)
    if checked and result.returncode != 0:
        if result.stderr:
            print(result.stderr[-4096:], file=sys.stderr, end='')
        raise OciExecutionError('OCI ' + arguments[0] + ' failed')
    return result


def _inspect(owner, environment, cid, *, name, image, labels):
    rows = json.loads(_request(owner, environment, 'inspect', '--type=container', '--format=json', cid).stdout)
    if not isinstance(rows, list) or len(rows) != 1:
        raise OciExecutionError('Invalid OCI inspection reply')
    value = rows[0]
    if (value['Id'] != cid or value['Name'] != name or value['Image'] not in (image, image.removeprefix('sha256:'))
            or any(value['Config']['Labels'].get(key) != item for key, item in labels.items())):
        raise OciExecutionError('OCI container differs from the original attempt')
    state = value['State']
    if (not isinstance(state['Status'], str) or type(state['Running']) is not bool
            or type(state['Pid']) is not int or state['Pid'] < 0):
        raise OciExecutionError('Invalid OCI execution state')
    return state


def _stopped(state):
    return state['Status'] in _STOPPED and state['Running'] is False and state['Pid'] == 0


def _finish(owner, environment, cid, identity):
    state = _inspect(owner, environment, cid, **identity)
    if not _stopped(state):
        # A killed start client can leave a live payload recorded as initialized.
        # kill/wait only understand a committed running state. Force-removing
        # this verified full CID also tears down that incomplete runtime; bind
        # sources and other containers are never targets of the operation.
        _request(owner, environment, 'rm', '--force', '--time=0', cid)
        if _request(owner, environment, 'container', 'exists', cid, checked=False).returncode != 1:
            raise OciExecutionError('OCI removal is unconfirmed; retaining its original identity')
        return
    # Completed/never-started containers need only ordinary removal.
    _request(owner, environment, 'rm', cid)


def _image_environment(owner, image):
    value = json.loads(owner.run('image', 'inspect', '--format={{json .Config.Env}}', image))
    if value is None:
        return {}
    if not isinstance(value, list) or any(not isinstance(item, str) or '=' not in item for item in value):
        raise OciExecutionError('Invalid image environment')
    result = {}
    for item in value:
        key, value = item.split('=', 1)
        if key not in {'PATH', 'PYTHONPATH'}:
            continue
        if key in result:
            raise OciExecutionError('Ambiguous image environment')
        result[key] = value
    return result


class OciTrainingEngine:
    def __init__(self, *, owners, devices, systemd, helpers=None):
        self._owners, self._devices, self._systemd = owners, devices, systemd
        self._helpers = Path(helpers) if helpers is not None else Path(__file__).resolve().parents[2] / 'deploy'

    def _require_delegation(self, identity):
        unit = Path(identity.process.control_group).name
        result = self._systemd(['/usr/bin/systemctl', '--user', 'show', '--no-pager',
            '--property=Delegate,KillMode,ControlGroup,InvocationID', '--', unit],
            check=True, capture_output=True, text=True, timeout=5)
        state = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if (state.get('Delegate') != 'yes' or state.get('KillMode') != 'control-group'
                or state.get('ControlGroup') != identity.process.control_group or state.get('InvocationID') != identity.invocation_id):
            raise OciExecutionError('OCI requires the original delegated task unit')

    def run(self, *, resources, command, budget, authorize_start):
        if resources['runtime']['kind'] != 'oci':
            raise ValueError('OCI engine requires an OCI release')
        execution, project = resources['execution'], resources['project']
        self._require_delegation(execution)
        owner = self._owners(execution.account_id)
        # open_run already verified host capabilities and the exact image. No
        # second project preparation, image pull, or kernel-budget scan here.
        owner.prepare_runtime_directory()
        image = resources['runtime']['identity']
        image_env = _image_environment(owner, image)
        name = 'gpuq-v2-' + execution.attempt_id.lower()
        labels = {'io.gpuq.owner': owner.owner, 'io.gpuq.project': project['meta']['project'],
            'io.gpuq.v2.task': execution.job_id, 'io.gpuq.v2.dispatch': execution.dispatch_id,
            'io.gpuq.v2.attempt': execution.attempt_id}
        identity = {'name': name, 'image': image, 'labels': labels}
        environment = {'HOME': '/home/gpuq', 'XDG_CACHE_HOME': '/home/gpuq/.cache', 'LANG': 'C.UTF-8',
            'PYTHONUNBUFFERED': '1', 'NCCL_CUMEM_HOST_ENABLE': '0', 'NVIDIA_VISIBLE_DEVICES': 'void',
            'PATH': '/opt/gpuq/bin:' + image_env.get('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),
            'GPUQ_OUTPUT_DIR': '/outputs', 'GPUQ_PROJECT': project['meta']['project'],
            'GPUQ_PROJECT_RELEASE': project['meta']['release'], 'GPUQ_PROJECT_ENV_MODE': 'oci', 'GPUQ_OFFLINE_ASSETS': '/workspace/offline',
            **command['environment'], **budget['environment']}
        if 'PYTHONPATH' not in resources['command']['env'] and image_env.get('PYTHONPATH'):
            environment['PYTHONPATH'] += ':' + image_env['PYTHONPATH']
        with ExitStack() as handles:
            mounts = [(resources['descriptors']['code'], '/workspace', True),
                      (resources['descriptors']['home'], '/home/gpuq', False),
                      (resources['descriptors']['output'], '/outputs', False),
                      *[(fd, target, True) for fd, target in resources['dataMounts']], *command['mounts'],
                      (budget['metadataFd'], '/run/gpuq/resources.json', True), (budget['cgroupFd'], '/sys/fs/cgroup', True)]
            for helper in ('job-resources.py', 'gpuq-ray', 'gpuq-network'):
                descriptor = os.open(self._helpers / helper, os.O_RDONLY | os.O_NOFOLLOW)
                handles.callback(os.close, descriptor)
                mounts.append((descriptor, '/opt/gpuq/bin/' + helper, True))
            host_env, _ = handles.enter_context(owner.registry_auth())
            sources = handles.enter_context(owner.named_mounts(mounts, []))
            flags = ['--name', name, '--cgroups=split', '--cgroupns=private', '--user=0', '--pid=private', '--ipc=private',
                '--uts=private', '--hostname=gpuq-job', '--network=slirp4netns:allow_host_loopback=false',
                '--security-opt=no-new-privileges', '--image-volume=ignore', '--pull=never', '--http-proxy=false',
                '--log-driver=none', '--pids-limit=-1', '--shm-size=8g', '--restart=no',
                '--unsetenv=CUDA_VISIBLE_DEVICES', '--workdir', command['workingDirectory']]
            for key, value in labels.items():
                flags += ['--label', key + '=' + value]
            for key, value in environment.items():
                flags += ['--env', key + '=' + value]
            for descriptor, target, readonly in mounts:
                flags += ['--volume', sources[descriptor] + ':' + target + (':ro' if readonly else ':rw')]
            for device in self._devices(owner, [gpu for gpu, _ in execution.assignments]):
                flags += ['--device', device]
            present = _request(owner, host_env, 'container', 'exists', name, checked=False)
            if present.returncode != 1:
                raise OciExecutionError('Original OCI name already exists or could not be observed; not replacing it')
            cid, owned = None, False
            try:
                result = _request(owner, host_env, 'create', *flags, '--entrypoint', json.dumps([command['argv'][0]]),
                                  image, *command['argv'][1:], timeout=60)
                cid = result.stdout.strip()
                if not re.fullmatch(r'[a-f0-9]{64}', cid):
                    raise OciExecutionError('OCI create receipt is unconfirmed; retain ' + name)
                _inspect(owner, host_env, cid, **identity)
                owned = True
                authorize_start()
                # Do not use run --rm: keep the exact object until exit/cleanup
                # is confirmed. CLI exit alone is not a container exit receipt.
                process = subprocess.Popen(owner.command('start', '--attach', cid), env=host_env, stdin=subprocess.DEVNULL)
                try:
                    process.wait()
                finally:
                    if process.poll() is None:
                        process.kill(); process.wait()
                state = _inspect(owner, host_env, cid, **identity)
                if (not _stopped(state) or state['Status'] not in {'exited', 'stopped'}
                        or type(state.get('ExitCode')) is not int or not 0 <= state['ExitCode'] <= 255):
                    raise OciExecutionError('OCI did not confirm a completed execution: ' + cid)
                return state['ExitCode']
            finally:
                if owned:
                    try:
                        _finish(owner, host_env, cid, identity)
                    except Exception as error:
                        # Preserve the original workload exit/error. Unknown
                        # objects keep their identity; native leases are untouched.
                        print('GPUQ V2 OCI: retained ' + cid + '; cleanup unconfirmed: ' + type(error).__name__, file=sys.stderr)
