"""Runner-side native identity checks, using GPUQ's existing systemd backend.

The binding is private output of the trusted node launch builder, never caller
input. A successful check is a current observation, not a lasting permission;
the runner repeats it after opening inputs and before executing a payload.
"""
from dataclasses import dataclass
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'gpuq'))
from gpuq.backends import UserSystemdBackend
from gpuq.util import process_start_ticks, read_boot_id

UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')
GPU = re.compile(r'GPU-[A-Za-z0-9][A-Za-z0-9-]*\Z')


class NativeExecutionError(RuntimeError):
    code = 'NATIVE_EXECUTION_UNCONFIRMED'


def require(condition, message):
    if not condition:
        raise NativeExecutionError(message)


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    boot_id: str
    start_ticks: int
    control_group: str


def current_process():
    pid = os.getpid()
    ticks = process_start_ticks(pid)
    groups = [line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::')]
    require(type(ticks) is int and ticks >= 0 and len(groups) == 1 and groups[0].startswith('/'),
            'Current process identity is unavailable')
    return ProcessIdentity(pid, read_boot_id(), ticks, groups[0])


def systemd_runner(argv, **kwargs):
    """The native launcher clears the environment; bind the service user's bus."""
    uid = os.getuid()
    runtime = f'/run/user/{uid}'
    environment = {'PATH': '/usr/bin:/bin', 'HOME': pwd.getpwuid(uid).pw_dir, 'LANG': 'C.UTF-8',
                   'XDG_RUNTIME_DIR': runtime, 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + runtime + '/bus'}
    return subprocess.run(argv, env=environment, **kwargs)


@dataclass(frozen=True)
class ExecutionIdentity:
    dispatch_id: str
    job_id: str
    account_id: str
    native_job_id: str
    attempt_id: str
    process: ProcessIdentity
    invocation_id: str
    control_dir: str
    assignments: tuple


class NativeExecutionAuthority:
    def __init__(self, *, native, control_root, machine_id, binding, systemd=None, environment=None, process=current_process):
        names = ('dispatchId', 'jobId', 'accountId', 'machineId', 'nativeDigest', 'nativeOwner', 'nativeName', 'nativeMaxGpus')
        require(isinstance(binding, dict) and all(name in binding for name in names), 'Missing trusted launch binding')
        self._binding = {name: binding[name] for name in names}
        require(all(isinstance(binding[key], str) and UUID.fullmatch(binding[key]) for key in ('dispatchId', 'jobId'))
                and isinstance(binding['nativeDigest'], str) and re.fullmatch(r'[a-f0-9]{64}', binding['nativeDigest'])
                and isinstance(binding['accountId'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}', binding['accountId'])
                and isinstance(machine_id, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', machine_id)
                and binding['machineId'] == machine_id
                and all(isinstance(binding[key], str) and 0 < len(binding[key]) <= 256 and '\0' not in binding[key] for key in ('nativeOwner', 'nativeName'))
                and type(binding['nativeMaxGpus']) is int and 1 <= binding['nativeMaxGpus'] <= 4096, 'Invalid trusted launch binding')
        self._control_root = Path(control_root)
        require(self._control_root.is_absolute() and '..' not in self._control_root.parts, 'Invalid configured control root')
        self._native = native
        self._systemd = systemd if systemd is not None else UserSystemdBackend(runner=systemd_runner, systemctl_binary='/usr/bin/systemctl', timeout=5)
        self._environment = os.environ if environment is None else environment
        self._process = process

    def require_current(self):
        binding, env = self._binding, dict(self._environment)
        native_id, attempt_id = env.get('GPUQ_JOB_ID'), env.get('GPUQ_ATTEMPT_ID')
        require(isinstance(native_id, str) and re.fullmatch(r'J[a-f0-9]{12}', native_id)
                and isinstance(attempt_id, str) and re.fullmatch(r'A[a-f0-9]{32}', attempt_id), 'Missing native runner identity')
        snapshot = self._native.call('execution_snapshot', {'submit_key': binding['dispatchId'], 'attempt_id': attempt_id})
        require(isinstance(snapshot, dict), 'Native attempt was not observed')
        job, attempt, grant = (snapshot.get(name) for name in ('job', 'attempt', 'grant'))
        require(all(isinstance(value, dict) for value in (job, attempt, grant)), 'Incomplete native execution snapshot')
        require(job.get('id') == native_id and job.get('submit_key') == binding['dispatchId']
                and job.get('submit_digest') == binding['nativeDigest'] and job.get('owner') == binding['nativeOwner']
                and job.get('name') == binding['nativeName'] and job.get('allocation_authority') == 'external-v1', 'Native job differs from launch binding')
        require(job.get('state') in ('STARTING', 'RUNNING') and attempt.get('state') in ('STARTING', 'RUNNING')
                and attempt.get('id') == attempt_id and snapshot.get('latest_attempt_id') == attempt_id, 'Native attempt is not current and runnable')
        uuids, indices, leases = attempt.get('gpu_uuids'), attempt.get('gpu_indices'), snapshot.get('leases')
        require(isinstance(uuids, list) and isinstance(indices, list) and 1 <= len(uuids) == len(indices) <= binding['nativeMaxGpus']
                and all(isinstance(value, str) and GPU.fullmatch(value) for value in uuids)
                and all(type(value) is int and value >= 0 for value in indices)
                and len(set(uuids)) == len(uuids) and len(set(indices)) == len(indices), 'Invalid native GPU assignment')
        assignments = tuple(zip(uuids, indices))
        require(isinstance(leases, list) and all(isinstance(lease, dict) and type(lease.get('gpu_index')) is int for lease in leases)
                and leases == [{'gpu_uuid': gpu, 'gpu_index': index} for gpu, index in sorted(assignments, key=lambda pair: pair[1])],
                'Actual GPU leases differ from the attempt assignment')
        require(grant.get('grant_id') == binding['dispatchId'] and type(grant.get('revision')) is int and grant['revision'] > 0
                and type(grant.get('max_gpu_count')) is int and len(assignments) <= grant['max_gpu_count'] <= binding['nativeMaxGpus'], 'Allocation grant does not cover the attempt')
        control = str(self._control_root / attempt_id)
        require(attempt.get('control_dir') == control and env.get('GPUQ_CONTROL_DIR') == control, 'Native control directory differs')
        require(env.get('GPUQ_ASSIGNED_GPU_UUIDS') == ','.join(uuids)
                and env.get('GPUQ_ASSIGNED_GPU_INDICES') == ','.join(map(str, indices))
                and env.get('GPUQ_ASSIGNED_GPU_COUNT') == str(len(assignments)), 'Runner GPU environment differs from native allocation')
        unit = 'gpuq-' + attempt_id.lower() + '.service'
        require(attempt.get('unit_name') in (unit, unit[:-8]), 'Native unit name differs from attempt')
        process = self._process()
        require(attempt.get('boot_id') == process.boot_id, 'Attempt belongs to another boot')
        status = self._systemd.status(unit_name=unit, description_token=attempt.get('unit_token'), invocation_id=attempt.get('invocation_id'))
        require(status.is_active and not status.is_cleanup_ready and status.main_pid == process.pid
                and status.control_group == process.control_group, 'Runner is not the current unit main process')
        require(attempt.get('main_pid') in (None, process.pid) and attempt.get('start_ticks') in (None, process.start_ticks), 'Recorded process identity differs')
        require(self._process() == process, 'Runner process identity changed during observation')
        return ExecutionIdentity(binding['dispatchId'], binding['jobId'], binding['accountId'], native_id, attempt_id,
                                 process, status.invocation_id, control, assignments)
