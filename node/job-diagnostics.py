#!/usr/bin/python3
"""Bounded, owner-bound diagnostic snapshots; never changes scheduler state.

Only the private managed runtime is readable. No /tmp discovery, journal query,
process environ or command-line collection. Resource sampling uses a pinned
cgroup directory, not a subprocess on each tick.
"""
import fcntl
import heapq
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
RUNTIME_PROFILE=None
CORE_PROFILE=os.environ.get('STARGATE_CORE_PROFILE')
if CORE_PROFILE is not None:
    _profile_spec=importlib.util.spec_from_file_location('gpuq_fixed_runtime_profile',HERE/'runtime-profile.py')
    RUNTIME_PROFILE=importlib.util.module_from_spec(_profile_spec);_profile_spec.loader.exec_module(RUNTIME_PROFILE)
CONFIG_PATH=(HERE/'node-config.json') if RUNTIME_PROFILE is None else RUNTIME_PROFILE.config_path(HERE,selected=CORE_PROFILE)

_ROOT_GUARD = None


def platform_root_check(root):
    spec=importlib.util.spec_from_file_location('diagnostic_data',HERE/'local-data.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.require_data_path(json.loads(CONFIG_PATH.read_text()),root)


BUNDLE_LIMIT = 1024 * 1024
FILE_LIMIT = 64 * 1024
LOG_BUDGET = 700 * 1024
MAX_LOGS = 32
MAX_OBSERVERS = 16
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
CAPTURE = re.compile(r'[a-f0-9]{32}')
UNIT = re.compile(r'gpuq-[a-zA-Z0-9_-]+\.service')
LOG = re.compile(r'(?:worker[^/]*\.(?:out|err)|python-core-worker[^/]*\.log|(?:raylet|gcs_server|runtime_env_agent|dashboard_agent|agent)[^/]*\.(?:log|out|err))(?:\.[0-9]+)?')
COUNTERS = ('memory.current', 'memory.peak', 'memory.events', 'pids.current', 'pids.peak', 'pids.events', 'cpu.stat', 'cgroup.events')
FINAL = {'COMPLETE', 'PARTIAL', 'UNAVAILABLE'}
RUNNER_PHASES = {'IDENTITY','WORKSPACE_ADMISSION','GPU_ALLOCATION','RESOURCE_BUDGET',
                 'PROJECT_PREPARATION','OCI_EXECUTION','SANDBOX_PREPARATION',
                 'SANDBOX_NETWORK','PAYLOAD_EXECUTION','OCI_PREPARATION','OCI_ENGINE'}
ERROR_PATTERN = re.compile(r'Traceback|\b[A-Za-z_]*(?:Error|Exception)\b|\bSIG(?:ABRT|SEGV|KILL|BUS)\b|CUDA out of memory|pthread_create|Resource temporarily unavailable|\bFATAL\b', re.I)


def redact(text):
    text = re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|\Z)', '[REDACTED PRIVATE KEY]', text, flags=re.S)
    # A tail can begin inside a PEM block: remove all text up to its end marker.
    text = re.sub(r'\A.*?-----END [^-]*PRIVATE KEY-----', '[REDACTED PRIVATE KEY]', text, flags=re.S)
    text = re.sub(r'(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', r'\1[REDACTED]', text)
    text = re.sub(r'''(?ix)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)["']?\s*[:=]\s*)(["'])(.*?)\2''', r'\1"[REDACTED]"', text)
    text = re.sub(r'''(?ix)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"';&]+''', r'\1[REDACTED]', text)
    text = re.sub(r'(https?://)[^/\s:@]+:[^/\s@]+@', r'\1[REDACTED]@', text)
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    return ''.join(c for c in text if c in '\n\t' or ord(c) >= 32)


def _dir(path, create=False):
    """Open every component without following symlinks, including ancestors."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Invalid diagnostics directory')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in path.parts[1:]:
            if create:
                try: os.mkdir(name, 0o700, dir_fd=fd)
                except FileExistsError: pass
            new = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = new
        return fd
    except BaseException:
        os.close(fd); raise


def _private(path, create=False):
    fd = _dir(path, create)
    s = os.fstat(fd)
    if s.st_uid != os.getuid() or s.st_mode & 0o077:
        os.close(fd); raise ValueError('诊断目录不能越出数据盘或跟随链接。')
    return fd


def _read_at(fd, name, limit, tail=False):
    file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(file)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('Diagnostic source must be an unlinked-safe regular file')
        if tail: os.lseek(file, max(0, info.st_size - limit), os.SEEK_SET)
        data = os.read(file, limit + (0 if tail else 1))
        if len(data) > limit: raise ValueError('Diagnostic record exceeds limit')
        return data, info.st_size > limit
    finally: os.close(file)


def _read(path, limit=BUNDLE_LIMIT):
    fd = _private(Path(path).parent)
    try: return json.loads(_read_at(fd, Path(path).name, limit)[0])
    finally: os.close(fd)


def _write(path, data):
    raw = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()
    if len(raw) > BUNDLE_LIMIT: raise ValueError('Diagnostic package exceeds limit')
    parent = _private(Path(path).parent)
    name = '.write-' + os.urandom(12).hex()
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        with os.fdopen(fd, 'wb') as out: out.write(raw); out.flush(); os.fsync(out.fileno())
        os.rename(name, Path(path).name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try: os.unlink(name, dir_fd=parent)
        except FileNotFoundError: pass
        os.close(parent)


def _identity(spec):
    if not isinstance(spec, dict) or not UUID.fullmatch(spec.get('id', '')) or not isinstance(spec.get('userId'), str):
        raise ValueError('任务编号不可用，请按原编号查询。')
    return {'jobId': spec['id'], 'owner': spec['userId']}


def _folder(root, spec, capture=None, create=False):
    platform_root_check(root)
    _identity(spec)
    base = Path(root) / 'diagnostics'
    os.close(_private(base, create))
    folder = base / spec['id']; os.close(_private(folder, create))
    if capture is not None:
        if not isinstance(capture, str) or not CAPTURE.fullmatch(capture): raise ValueError('Invalid diagnostic capture')
        folder /= capture; os.close(_private(folder, create))
    return folder


def _show(unit, env):
    if not UNIT.fullmatch(unit): raise ValueError('Invalid diagnostic unit')
    out = subprocess.run(['/usr/bin/systemctl', '--user', 'show', unit, '--property=Id,InvocationID,ControlGroup,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,MainPID'], env=env, text=True, capture_output=True, timeout=4, check=True)
    return dict(line.split('=', 1) for line in out.stdout.splitlines() if '=' in line)


def _group_path(group, unit):
    if not isinstance(group, str) or not group.startswith('/') or '..' in Path(group).parts or str(Path(group)) != group or Path(group).name != unit:
        raise ValueError('Invalid diagnostic cgroup')
    return Path('/sys/fs/cgroup') / group.lstrip('/')


def _sample(fd):
    result = {}
    for name in COUNTERS:
        try:
            # cgroup virtual files have nlink=1 and report size=0; read directly.
            source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            try: text = os.read(source, 8192).decode('ascii')
            finally: os.close(source)
            if '.' not in name or name.endswith(('.events', '.stat')):
                result[name] = {key: int(value) for key, value in (line.split() for line in text.splitlines())}
            else: result[name] = int(text.strip())
        except (OSError, ValueError, UnicodeError): pass
    return result


def _resources(report, current):
    resources = report.setdefault('resources', {'peaks': {}, 'counters': {}, 'available': []})
    resources['available'] = sorted(set(resources['available']) | set(current))
    for key, value in current.items():
        if isinstance(value, int): resources['peaks'][key] = max(resources['peaks'].get(key, 0), value)
        elif key != 'cgroup.events':
            previous = resources['counters'].setdefault(key, {})
            for field, count in value.items(): previous[field] = max(previous.get(field, 0), count)
    resources['peakNote'] = 'memory.peak/pids.peak are kernel peaks when available; *.current values are sampled high-water marks, not guaranteed peaks.'
    report['updatedAt'] = time.time()


def _names(fd, maximum=4096):
    names = []
    with os.scandir(fd) as entries:
        for entry in entries:
            names.append(entry.name)
            if len(names) >= maximum: break
    return sorted(names)


def collect_logs(runtime):
    logs, budget, rejected, entries_left = [], LOG_BUDGET, 0, 4096
    runtimefd = _dir(runtime)
    try:
        try: ray = os.open('ray', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=runtimefd)
        except FileNotFoundError: return logs, rejected
        try:
            # Session timestamps sort chronologically. Never follow session_latest.
            for session in reversed(_names(ray, 256)):
                if not re.fullmatch(r'session_[A-Za-z0-9_.-]{1,160}', session) or session == 'session_latest': continue
                sessionfd = logfd = None
                try:
                    sessionfd = os.open(session, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=ray)
                    logfd = os.open('logs', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=sessionfd)
                    names = sorted(_names(logfd, entries_left), key=lambda n: (not n.endswith('.err'), not n.startswith('python-core-worker'), n))
                    entries_left -= len(names)
                    for name in names:
                        if not LOG.fullmatch(name) or len(name) > 240: continue
                        if len(logs) >= MAX_LOGS or budget < 256: return logs, rejected
                        try:
                            raw, truncated = _read_at(logfd, name, min(FILE_LIMIT, budget), True)
                            text = redact(raw.decode('utf-8', errors='replace'))
                            # Redaction may expand short values, so charge final UTF-8.
                            text = text.encode()[:min(FILE_LIMIT, budget)].decode('utf-8', errors='ignore')
                            cost = len(json.dumps(text, ensure_ascii=False).encode())
                            if cost > budget:
                                # JSON escaping can expand newlines/backslashes;
                                # reserve worst-case encoding even before storage.
                                text = text.encode()[:max(0, (budget - 2) // 6)].decode('utf-8', errors='ignore')
                                cost = len(json.dumps(text, ensure_ascii=False).encode()); truncated = True
                            budget -= cost
                            logs.append({'source': redact('ray/' + session + '/logs/' + name), 'text': text, 'truncated': truncated})
                        except (OSError, ValueError): rejected += 1
                    if entries_left <= 0: return logs, rejected
                except (OSError, ValueError): rejected += 1
                finally:
                    if logfd is not None: os.close(logfd)
                    if sessionfd is not None: os.close(sessionfd)
        finally: os.close(ray)
    finally: os.close(runtimefd)
    return logs, rejected


def _logs(report, folder):
    report['logSelection'] = {'maxFiles': MAX_LOGS, 'maxFileBytes': FILE_LIMIT, 'maxEntriesInspected': 4096, 'note': 'Bounded whitelist tails, not exhaustive logs; absence of an error is not a measurement of worker health.'}
    try:
        report['logs'], report['rejectedSources'] = collect_logs(folder / 'runtime')
    except (OSError, ValueError): report['logCaptureError'] = 'Managed runtime unavailable or unsafe'
    report['workerErrorEvidence'] = any(ERROR_PATTERN.search(log['text']) for log in report.get('logs', []))


def _policy(root):
    # This node-local file is administrator-controlled, never a request field.
    config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
    days = config.get('diagnosticsRetentionDays', 30)
    if type(days) is not int or not 1 <= days <= 365: raise ValueError('Invalid diagnostic retention days')
    return days


def start_capture(root, spec, unit, control_group, env, indices, uuids):
    shown = _show(unit, env); capture = shown.get('InvocationID', '')
    if not CAPTURE.fullmatch(capture):raise ValueError('任务诊断暂时不可用，请稍后查询。')
    group = _group_path(control_group, unit)
    groupfd = _dir(group)
    try: group_stat = os.fstat(groupfd); initial = _sample(groupfd)
    finally: os.close(groupfd)
    folder = _folder(root, spec, capture, True)
    runtime = folder / 'runtime'; os.close(_private(runtime, True))
    config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
    identity = {**_identity(spec), 'captureId': capture, 'unit': unit, 'controlGroup': control_group, 'createdAt': time.time()}
    attempt = re.fullmatch(r'gpuq-a([a-f0-9]{32})\.service',unit)
    if attempt: identity['nativeAttemptId']='A'+attempt[1]
    _write(folder / 'identity.json', identity)
    report = {'schema': 1, 'jobId': spec['id'], 'captureId': capture, 'state': 'STARTING', 'createdAt': identity['createdAt'], 'retentionDays': _policy(root), 'gpuAllocation': {'indices': indices, 'uuids': uuids, 'observedAt': identity['createdAt']}, 'logs': [], 'scope': {'managedRuntime': '/run/gpuq/runtime/ray', 'externalTmpCaptured': False, 'note': 'Only managed Ray runtime is captured. RAY_TMPDIR or ray.init(_temp_dir=...) overrides outside it are not captured; no /tmp discovery.', 'redaction': 'Best effort; review before sharing. No argv or environment captured.', 'bundleLimitBytes': BUNDLE_LIMIT}}
    if attempt: report['nativeAttemptId']=identity['nativeAttemptId']
    _resources(report, initial); _write(folder / 'report.json', report)
    command = ['/usr/bin/systemd-run', '--user', '--quiet', '--collect', '--unit=gpuq-diag-' + spec['id'][:8] + '-' + capture, '--property=Type=exec', '--property=MemoryMax=128M', '--property=CPUQuota=10%', '--property=TasksMax=16', '--property=IOWeight=10', '--property=KillMode=control-group', '--property=RuntimeMaxSec=2592000', '--property=UMask=0077', '--property=StandardOutput=null', '--property=StandardError=null', '/usr/bin/python3', str(HERE / 'job-diagnostics.py'), '--observe', spec['id'], capture]
    if RUNTIME_PROFILE is not None:
        command,env=RUNTIME_PROFILE.child_command(command,env,selected=CORE_PROFILE)
    try: subprocess.run(command, env=env, capture_output=True, check=True, timeout=5)
    except Exception:
        report.update(state='UNAVAILABLE', error='Diagnostic observer could not start', finalizedAt=time.time()); _write(folder / 'report.json', report)
        return {'runtimePath': str(runtime), 'captureId': capture, 'available': False}
    return {'runtimePath': str(runtime), 'captureId': capture, 'available': True}


def runner_stderr(root, spec, capture_id, raw, *, phase='OCI_ENGINE', truncated=False):
    """A bounded private engine tail, never a payload completion verdict."""
    if phase not in RUNNER_PHASES or type(truncated) is not bool or not isinstance(raw,(str,bytes)):
        raise ValueError('Invalid runner stderr evidence')
    if isinstance(raw,str): raw=raw.encode('utf-8',errors='replace')
    truncated=truncated or len(raw)>FILE_LIMIT
    text=redact(raw[-FILE_LIMIT:].decode('utf-8',errors='replace'))
    text=re.sub(r'(?i)(--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization)\s+)(?:"[^"\n]*"|\'[^\'\n]*\'|[^\s]+)',r'\1[REDACTED]',text)
    # Engine errors may contain host paths or echoed command options. Do not
    # preserve host paths in the separately downloadable diagnostic package.
    text=re.sub(r'(?<![\w:])/(?:[^\s\"\'<>]+)', '[PATH]', text)
    text=text.encode()[-FILE_LIMIT:].decode('utf-8',errors='ignore')
    if len(json.dumps(text).encode())>FILE_LIMIT:
        text=text.encode()[-(FILE_LIMIT-2)//6:].decode('utf-8',errors='ignore');truncated=True
    folder=_folder(root,spec,capture_id)
    _write(folder/'runner-stderr.json',{'phase':phase,'text':text,'truncated':truncated,
                                       'observedAt':time.time(),'evidenceOnly':True})


def _runner_error(error, phase):
    result={'phase':phase,'errorClass':type(error).__name__[:80],
            'message':'Runner exception; inspect the bounded stderr and original main log'}
    # Never stringify CalledProcessError/TimeoutExpired: their representation
    # can contain the complete command, argv or other private values.
    if isinstance(error,ValueError):
        message=str(error)
        if message=='OCI registry drop-in directories changed during operation':
            result.update(reason='OCI_REGISTRY_INTEGRITY_CHANGED',message=message)
        space=re.fullmatch(r'Personal workspace free-space reserve reached: availableBytes=([0-9]+), reserveBytes=([0-9]+), requestedBytes=([0-9]+)\.',message)
        if space:
            result.update(reason='WORKSPACE_RESERVE',message='Personal workspace free-space reserve reached',
                          **dict(zip(('availableBytes','reserveBytes','requestedBytes'),map(int,space.groups()))))
    return result


def finish_capture(root, spec, capture_id, exit_code, *, phase=None, error=None):
    if type(exit_code) is not int: raise ValueError('Invalid runner exit code')
    if phase is not None and phase not in RUNNER_PHASES:raise ValueError('Invalid runner phase')
    folder = _folder(root, spec, capture_id)
    identity = _read(folder / 'identity.json')
    counters={};resource_error=None
    try:
        fd = _dir(_group_path(identity['controlGroup'], identity['unit']))
    except OSError:
        resource_error='Final resource sampling unavailable'
    else:
        try:
            info = os.fstat(fd)
            try:
                counters = _sample(fd)
                if not counters:resource_error='Final resource sampling unavailable'
            except (OSError,ValueError):resource_error='Final resource sampling unavailable'
        finally: os.close(fd)
    # Observer remains sole report writer; this durable exit_record avoids races.
    exit_record={'exitCode':exit_code,'observedAt':time.time(),'resources':counters}
    if identity.get('nativeAttemptId'):exit_record['nativeAttemptId']=identity['nativeAttemptId']
    if phase is not None:exit_record['phase']=phase
    if error is not None:exit_record['error']=_runner_error(error,phase)
    if resource_error is not None:exit_record['resourceCaptureError']=resource_error
    _write(folder / 'runner-exit.json',exit_record)


def _runner_records(report, folder):
    """Read the private exit_record even if the observer/cgroup ended first."""
    try:
        exit_record=_read(folder/'runner-exit.json',65536)
        report['runnerExit']={k:exit_record[k] for k in ('exitCode','observedAt')}
        for key in ('phase','error','resourceCaptureError','nativeAttemptId'):
            if key in exit_record:report['runnerExit'][key]=exit_record[key]
    except FileNotFoundError:exit_record=None
    try:report['runnerStderr']=_read(folder/'runner-stderr.json',2*FILE_LIMIT)
    except FileNotFoundError:pass
    return exit_record


def _observer_slot(base):
    for i in range(MAX_OBSERVERS):
        fd = os.open(base / ('.observer-' + str(i) + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); return fd
        except BlockingIOError: os.close(fd)
    return None


def observe(root, spec, capture, env, sleep=time.sleep):
    folder = _folder(root, spec, capture); report = _read(folder / 'report.json'); identity = _read(folder / 'identity.json')
    capture_lock = os.open(folder / 'observer.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try: fcntl.flock(capture_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: os.close(capture_lock); return
    slot = _observer_slot(Path(root) / 'diagnostics')
    if slot is None:
        report.update(state='UNAVAILABLE', error='Diagnostic observer concurrency limit reached', finalizedAt=time.time()); _write(folder / 'report.json', report); os.close(capture_lock); return
    groupfd = None
    try:
        groupfd = _dir(_group_path(identity['controlGroup'], identity['unit']))
        info = os.fstat(groupfd)
        report['state'] = 'CAPTURING'; next_logs = 0
        deadline = report['createdAt'] + 2591900
        while True:
            platform_root_check(root)
            now = time.time(); current = _sample(groupfd); _resources(report, current)
            ended = not current or current.get('cgroup.events', {}).get('populated') == 0
            exit_record=_runner_records(report,folder)
            if exit_record is not None:_resources(report,exit_record['resources']);ended=True
            if now >= next_logs or ended or now >= deadline: _logs(report, folder); next_logs = now + 10
            if ended or now >= deadline:
                report.update(state='COMPLETE' if 'runnerExit' in report else 'PARTIAL', finalizedAt=now)
                if 'runnerExit' not in report: report['error'] = 'Runner final exit_record unavailable; only observed counters and scheduler history are authoritative'
                try:
                    shown = _show(identity['unit'], env)
                    quiet = shown.get('MainPID') == '0' and (shown.get('ActiveState') in ('inactive', 'failed') or shown.get('SubState') == 'exited')
                    # A still-running runner reports ExecMainStatus=0 before
                    # its actual exit. Never present that as final success.
                    if shown.get('InvocationID') == capture and quiet: report['unitExit'] = {k: shown[k] for k in ('ActiveState', 'SubState', 'Result', 'ExecMainCode', 'ExecMainStatus') if k in shown}
                except (OSError, ValueError, subprocess.SubprocessError): pass
                _write(folder / 'report.json', report); break
            _write(folder / 'report.json', report); sleep(2)
    except (OSError, ValueError, KeyError):
        # A missing bind is not a diagnostic failure to persist on the fallback
        # filesystem. Recheck before the best-effort error report as well.
        platform_root_check(root)
        _runner_records(report,folder)
        _logs(report, folder); report.update(state='PARTIAL', error='Diagnostic cgroup or capture became unavailable', finalizedAt=time.time()); _write(folder / 'report.json', report)
    finally:
        if groupfd is not None: os.close(groupfd)
        os.close(slot)
        os.close(capture_lock)


def allocation_history(scheduler):
    """Only real scheduler lease boundaries; never infer from attempt timestamps."""
    result = {'historyAvailable': False, 'allocationHistory': [], 'historyTruncated': False,
              'historyNextBeforeId': None,
              'historyNote': 'Lease acquisition/release times are scheduler records, not first/last GPU kernel times. Historical releases before collection began are unavailable.'}
    rows = scheduler.get('allocation_history')
    if scheduler.get('allocation_history_available') is not True or not isinstance(rows, list):
        return result
    job_id = scheduler.get('job', scheduler).get('id')
    cleaned = []
    fields = ('id', 'job_id', 'attempt_id', 'gpu_uuid', 'gpu_index', 'acquired_at',
              'released_at', 'release_reason', 'source')
    for row in rows[:256]:
        if (not isinstance(row, dict) or not all(key in row for key in fields)
                or row['job_id'] != job_id or type(row['id']) is not int or row['id'] < 1
                or type(row['gpu_index']) is not int or row['gpu_index'] < 0
                or any(not isinstance(row[key], str) or not 1 <= len(row[key]) <= 256
                       for key in ('job_id', 'attempt_id', 'gpu_uuid'))
                or row['source'] not in ('observed', 'migrated_active')
                or any(type(row[key]) not in (int, float) or not math.isfinite(row[key])
                       for key in ('acquired_at',) if row[key] is not None)
                or row['acquired_at'] is None
                or row['released_at'] is not None and (type(row['released_at']) not in (int, float)
                                                     or not math.isfinite(row['released_at']))
                or row['release_reason'] is not None and (not isinstance(row['release_reason'], str)
                                                         or len(row['release_reason']) > 400)):
            result['historyNote'] = 'Allocation history could not be validated; no allocation/release times were inferred.'
            return result
        value = {key: row[key] for key in fields}
        if value['release_reason'] is not None: value['release_reason'] = redact(value['release_reason'])
        cleaned.append(value)
    more = scheduler.get('allocation_history_truncated') is True or len(rows) > 256
    cursor = scheduler.get('allocation_history_next_before_id') if len(rows) <= 256 else cleaned[-1]['id']
    if more and (type(cursor) is not int or cursor < 1):
        cursor = None  # Explicit truncation still prevents a false complete history.
    result.update(historyAvailable=True, allocationHistory=cleaned,
                  historyTruncated=more, historyNextBeforeId=cursor if more else None)
    return result


def bundle(root, spec, scheduler):
    result = {'schema': 1, 'jobId': spec['id'], 'schedulerState': scheduler.get('job', scheduler).get('state', 'UNKNOWN'), 'state': 'UNAVAILABLE', 'captures': [], 'attempts': []}
    result['gpuMetrics'] = scheduler.get('gpuMetrics')
    result['after'] = scheduler.get('job', scheduler).get('after', [])
    result['queueReason'] = scheduler.get('job', scheduler).get('state_reason')
    result.update(allocation_history(scheduler))
    for attempt in scheduler.get('attempts', [])[:16]:
        result['attempts'].append({k: attempt[k] for k in ('id', 'state', 'exit_code', 'failure_reason', 'gpu_indices', 'gpu_uuids', 'created_at', 'started_at', 'finished_at') if k in attempt})
    try: folder = _folder(root, spec)
    except FileNotFoundError:
        result['note'] = 'No persistent diagnostics were collected for this job (old, queued or unavailable collector).'; return result
    fd = _private(folder)
    try: names = _names(fd, 256)
    finally: os.close(fd)
    latest = None
    for name in names:
        if not CAPTURE.fullmatch(name): continue
        report = _read(_folder(root, spec, name) / 'report.json')
        if latest is None or report['createdAt'] > latest['createdAt']: latest = report
    # A package is latest capture + compact immutable attempt history, not an
    # unbounded concatenation of repeated attempts.
    if latest:
        report = latest
        if report['state'] in ('STARTING', 'CAPTURING') and time.time() - report.get('updatedAt', 0) > 30:
            report = {**report, 'state': 'PARTIAL', 'error': 'Observer heartbeat is stale; completion is 暂未取得完整结果，请查询原任务编号'}
        _runner_records(report,_folder(root,spec,report['captureId']))
        result.update(state=report['state'], captures=[report], workerErrorEvidence=report.get('workerErrorEvidence', False))
    result['note'] = 'Worker log errors are evidence, not scheduler exit status. Missing counters are unknown, never zero.'
    # Include escaped JSON size (outer bridge uses ensure_ascii=True) in cap.
    while len(json.dumps(result).encode()) > BUNDLE_LIMIT and result.get('captures', [{}])[0].get('logs'):
        result['captures'][0]['logs'].pop(); result['truncated'] = True
    if len(json.dumps(result).encode()) > BUNDLE_LIMIT: raise ValueError('Diagnostic metadata exceeds package limit')
    return result


def summary(package):
    """Short main-log footer; evidence only, never a new scheduler verdict."""
    capture = (package.get('captures') or [{}])[0]
    counters = capture.get('resources', {}).get('counters', {})
    memory, pids = counters.get('memory.events', {}), counters.get('pids.events', {})
    if capture.get('runnerExit',{}).get('resourceCaptureError'):
        # Earlier samples remain valid observations, not a observed final 0.
        memory={};pids={}
    excerpts = []
    for log in capture.get('logs', []):
        matching = [line.strip() for line in log.get('text', '').splitlines() if ERROR_PATTERN.search(line)]
        if matching:
            excerpts.append(redact(log.get('source', '').rsplit('/', 1)[-1])[:120] + ': ' + redact(matching[-1])[:240])
        if len(excerpts) == 3: break
    lines = ['[GPUQ 持久诊断 · 日志线索不改变任务终态]',
             '采集状态：' + str(package.get('state', 'UNAVAILABLE')) + '；调度状态：' + str(package.get('schedulerState', 'UNKNOWN')),
             'Worker 错误线索：' + ('命中可能的错误特征（也可能来自正常退出日志），请结合退出码与调度状态查看' if excerpts or package.get('workerErrorEvidence') else '未命中已知特征，不代表 worker 健康'),
             'OOM=' + str(memory.get('oom', '未知')) + ' / OOM kill=' + str(memory.get('oom_kill', '未知')) + ' / PID 拒绝=' + str(pids.get('max', '未知'))]
    lines.extend(excerpts)
    lines.append('完整诊断与历史 GPU 分配：gpuctl diagnostics ' + package['jobId'] + ' --json；网页日志窗口选择「诊断包 / 历史分配」。')
    if package.get('state') in ('UNAVAILABLE', 'PARTIAL'): lines.append('采集缺失或不完整；旧任务 / 自定义临时目录的 worker 日志可能未保留。')
    if capture.get('runnerExit'):
        result=capture['runnerExit'];lines.append('Runner 退出码：'+str(result['exitCode'])+'；阶段：'+str(result.get('phase','未记录')))
        if result.get('error'):lines.append('Runner 错误：'+str(result['error'].get('message','未记录')))
    if capture.get('runnerStderr',{}).get('text'):
        lines.append('OCI stderr 线索（不是完成证明）：'+capture['runnerStderr']['text'][-1000:])
    return '\n\n' + '\n'.join(lines) + '\n'


def _page(folder, pattern, after, limit):
    """Streaming lexical page: bounded memory, no fixed-prefix starvation.

    Enumeration is O(directory entries); the separate GC service has a hard
    runtime/CPU cap. Unlike sorting all names, memory does not scale with history.
    """
    fd = _private(folder)
    try:
        with os.scandir(fd) as entries:
            return heapq.nsmallest(limit, (item.name for item in entries if pattern.fullmatch(item.name) and item.name > after))
    finally: os.close(fd)


def _stopped(identity):
    """Never inspect another invocation's counters or treat missing data as 0."""
    try: fd = _dir(_group_path(identity['controlGroup'], identity['unit']))
    except FileNotFoundError: return True
    try:
        return _sample(fd).get('cgroup.events', {}).get('populated') == 0
    finally: os.close(fd)


def _retire_capture(path, now):
    lock = os.open(path / 'observer.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return
        _retire_capture_locked(path, now)
    finally: os.close(lock)


def _retire_capture_locked(path, now):
    identity = _read(path / 'identity.json'); report = _read(path / 'report.json')
    if not _stopped(identity): return
    # A dead observer can leave CAPTURING forever on disk. Persist a truthful
    # terminal snapshot before deleting only this stopped raw runtime.
    runtime = path / 'runtime'
    if report.get('state') not in FINAL:
        report.update(state='PARTIAL', finalizedAt=now, error='Observer ended without a final exit_record; original cgroup is now stopped')
    if not report.get('finalizedAt'): report['finalizedAt'] = now
    if runtime.exists():
        os.close(_dir(runtime))
        _logs(report, path)
        report['rawRuntimeCleanup'] = 'pending'; _write(path / 'report.json', report)
        if not shutil.rmtree.avoids_symlink_attacks: return
        shutil.rmtree(runtime)
    report['rawRuntimeCleanup'] = 'removed-after-stop'
    _write(path / 'report.json', report)
    retention = report.get('retentionDays', 30)
    if type(retention) is not int or not 1 <= retention <= 365: raise ValueError('Invalid retained diagnostic policy')
    if now - report['finalizedAt'] > retention * 86400 and shutil.rmtree.avoids_symlink_attacks: shutil.rmtree(path)


def prune(root, now=None, max_jobs=64, max_captures=16):
    """Single bounded GC pass, resumed by timer using a persistent cursor."""
    platform_root_check(root)
    now = time.time() if now is None else now
    base = Path(root) / 'diagnostics'
    try: os.close(_private(base))
    except FileNotFoundError: return
    lock = os.open(base / '.gc.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return
        try: cursor = _read(base / 'gc-cursor.json', 4096)
        except FileNotFoundError: cursor = {'job': '', 'capture': '', 'within': False}
        if cursor.get('job') and not UUID.fullmatch(cursor['job']) or cursor.get('capture') and not CAPTURE.fullmatch(cursor['capture']): raise ValueError('Invalid GC cursor')
        jobs = ([cursor['job']] if cursor.get('within') else [])
        jobs += _page(base, UUID, cursor.get('job', ''), max_jobs - len(jobs))
        if not jobs:
            _write(base / 'gc-cursor.json', {'job': '', 'capture': '', 'within': False}); return
        for job in jobs:
            after = cursor.get('capture', '') if cursor.get('within') and cursor.get('job') == job else ''
            folder = base / job
            try:
                captures = _page(folder, CAPTURE, after, max_captures + 1)
                for capture in captures[:max_captures]:
                    platform_root_check(root)
                    try: _retire_capture(folder / capture, now)
                    except (OSError, ValueError, KeyError): pass
                    # Persist after each capture: a large rmtree can be killed
                    # and is then retried safely, rather than skipping the work.
                    cursor = {'job': job, 'capture': capture, 'within': True}; _write(base / 'gc-cursor.json', cursor)
                if len(captures) > max_captures: return
            except (OSError, ValueError, KeyError): pass
            platform_root_check(root)
            cursor = {'job': job, 'capture': '', 'within': False}; _write(base / 'gc-cursor.json', cursor)
    finally: os.close(lock)


if __name__ == '__main__':
    os.umask(0o077)
    config = json.loads(CONFIG_PATH.read_text())
    platform_root_check(Path(config['root']))
    if sys.argv[1:] == ['--gc']:
        config = json.loads(CONFIG_PATH.read_text()); prune(Path(config['root'])); raise SystemExit(0)
    if len(sys.argv) != 4 or sys.argv[1] != '--observe' or not UUID.fullmatch(sys.argv[2]) or not CAPTURE.fullmatch(sys.argv[3]): raise SystemExit(2)
    config = json.loads(CONFIG_PATH.read_text()); root = Path(config['root'])
    spec = json.loads((root / 'jobs' / (sys.argv[2] + '.json')).read_text())
    runtime = '/run/user/' + str(os.getuid())
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(Path.home()), 'XDG_RUNTIME_DIR': runtime, 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + runtime + '/bus'}
    observe(root, spec, sys.argv[3], env)
    prune(root)
