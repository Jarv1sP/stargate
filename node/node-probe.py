#!/usr/bin/python3
"""Forced SSH command: read fixed GPU/GPUQ status only, never accept commands."""
import csv
import ast
from concurrent.futures import ThreadPoolExecutor
import datetime
import io
import json
import math
import os
import re
import stat
import subprocess
import unicodedata
from pathlib import Path

import importlib.util
_spec=importlib.util.spec_from_file_location('probe_profile',Path(__file__).with_name('runtime-profile.py'))
_profile=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_profile)
CONFIG=None
HERE=Path(__file__).resolve().parent
ENV = {"PATH": "/usr/bin:/bin", "HOME": str(Path.home()), "LANG": "C.UTF-8",
       "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}"}
MAX_PROCESSES = 512
MAX_GPU_PROCESSES = 128
MAX_HELPER_BYTES = 256 * 1024


def command(argv, timeout=10):
    result = subprocess.run(argv, env=ENV, capture_output=True, text=True, timeout=timeout)
    if result.returncode or len(result.stdout) > 2_000_000:
        raise ValueError("status command failed")
    return result.stdout






def number(value):
    """N/A and unsupported sensors are unknown, never a synthetic zero."""
    try:
        result = float(value.strip())
        return result if math.isfinite(result) and result >= 0 else None
    except (ValueError, TypeError, AttributeError):
        return None


def label(value, limit=120):
    return ''.join(c for c in str(value).strip() if ord(c) >= 32 and ord(c) != 127)[:limit]


def parse_gpus(raw):
    gpus, seen, malformed = [], set(), False
    for row in csv.reader(io.StringIO(raw)):
        if not row:
            continue
        try:
            index = int(row[0].strip())
            if len(row) < 6 or index < 0 or index in seen:
                raise ValueError('bad row')
            seen.add(index)
            uuid = row[1].strip()
            utilization = number(row[5])
            gpus.append({'index': index, 'uuid': uuid if uuid.startswith('GPU-') else None,
                         'model': label(row[2]), 'memoryTotalMiB': number(row[3]),
                         'memoryUsedMiB': number(row[4]),
                         'utilization': utilization if utilization is None or utilization <= 100 else None,
                         'temperatureC': None, 'powerDrawW': None, 'powerLimitW': None,
                         'processes': [], 'processesAvailable': False})
        except (ValueError, IndexError):
            malformed = True
        if len(gpus) >= 64:
            break
    return gpus, malformed


def parse_processes(raw):
    processes, malformed, truncated = [], False, False
    for row in csv.reader(io.StringIO(raw)):
        if not row:
            continue
        if len(processes) >= MAX_PROCESSES:
            truncated = True
            break
        try:
            if len(row) < 4 or not row[0].strip().startswith('GPU-'):
                raise ValueError('bad row')
            pid = int(row[1].strip())
            if not 0 < pid <= 2_147_483_647:
                raise ValueError('bad pid')
            # Driver output can contain a full executable path: keep basename only.
            executable = row[2].strip()
            name = None if executable.lower() in ('', '[n/a]', 'n/a', '[not supported]', 'not supported') else label(executable.rsplit('/', 1)[-1])
            processes.append({'uuid': row[0].strip(), 'pid': pid, 'name': name,
                              'owner': None, 'memoryUsedMiB': number(row[3]), 'type': 'compute'})
        except (ValueError, IndexError):
            malformed = True
    return processes, malformed, truncated


def process_metadata(pids):
    if not pids:
        return {}
    # Fixed fields only: never args, command lines, environments or executable paths.
    raw = command(['/usr/bin/ps', '-p', ','.join(str(pid) for pid in sorted(pids)),
                   '-o', 'pid=,user=,comm='], 2)
    result = {}
    for line in raw.splitlines()[:MAX_PROCESSES]:
        fields = line.split(None, 2)
        if len(fields) != 3:
            continue
        try:
            pid = int(fields[0])
        except ValueError:
            continue
        if pid in pids:
            result[pid] = {'owner': label(fields[1], 80), 'name': label(fields[2].rsplit('/', 1)[-1])}
    return result


def probe_gpus():
    output = {'gpus': []}
    try:
        raw = command(['/usr/bin/nvidia-smi',
                       '--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu',
                       '--format=csv,noheader,nounits'], 4)
        output['gpus'], malformed = parse_gpus(raw)
        if malformed:
            output['gpuError'] = 'Some GPU status rows are unavailable'
    except (ValueError, OSError, subprocess.SubprocessError):
        output['gpus']=None
        output['gpuError'] = 'GPU status unavailable'
        return output
    by_uuid = {gpu['uuid']: gpu for gpu in output['gpus'] if gpu['uuid']}
    try:
        raw = command(['/usr/bin/nvidia-smi', '--query-gpu=uuid,temperature.gpu,power.draw,power.limit',
                       '--format=csv,noheader,nounits'], 2)
        for row in csv.reader(io.StringIO(raw)):
            if len(row) == 4 and row[0].strip() in by_uuid:
                gpu = by_uuid[row[0].strip()]
                for key, value in zip(('temperatureC', 'powerDrawW', 'powerLimitW'), row[1:]):
                    gpu[key] = number(value)
    except (ValueError, OSError, subprocess.SubprocessError):
        # Sensor support differs by driver; keep the usable base card metrics.
        pass
    try:
        raw = command(['/usr/bin/nvidia-smi',
                       '--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory',
                       '--format=csv,noheader,nounits'], 3)
        processes, malformed, truncated = parse_processes(raw)
        metadata_error = False
        try:
            metadata = process_metadata({p['pid'] for p in processes})
        except (ValueError, OSError, subprocess.SubprocessError):
            metadata, metadata_error = {}, True
        for gpu in output['gpus']:
            gpu['processesAvailable'] = bool(gpu['uuid']) and not malformed and not truncated
            if not gpu['uuid']:
                gpu['processesError'] = 'GPU process matching unavailable'
            elif malformed or truncated:
                gpu['processesError'] = 'GPU process list incomplete'
            elif metadata_error:
                gpu['processesError'] = 'Process owner metadata unavailable'
        for process in processes:
            gpu = by_uuid.get(process.pop('uuid'))
            if gpu is None:
                continue
            if len(gpu['processes']) >= MAX_GPU_PROCESSES:
                gpu['processesAvailable'] = False
                gpu['processesError'] = 'GPU process list incomplete'
                continue
            details = metadata.get(process['pid'], {})
            process['owner'] = details.get('owner') or None
            process['name'] = process['name'] or details.get('name') or None
            gpu['processes'].append(process)
    except (ValueError, OSError, subprocess.SubprocessError):
        for gpu in output['gpus']:
            gpu['processesError'] = 'GPU process status unavailable'
    return output


def public_task_display(value):
    if not isinstance(value,dict):return None
    actor=value.get('submitter') or {}
    if not isinstance(actor,dict):return None
    fields=((value.get('name',''),64,256,False),(value.get('description',''),2000,6000,True),
            (actor.get('name',''),32,128,False),(actor.get('username',''),24,96,False))
    for text,chars,size,multiline in fields:
        if not isinstance(text,str) or len(text)>chars or (not multiline and not text.strip()):return None
        try:
            if len(text.encode('utf8'))>size:return None
        except UnicodeError:return None
        if any(unicodedata.category(c) in ('Cc','Cf','Cs','Zl','Zp') and not(multiline and c in '\n\t') for c in text):return None
    return {'name':value.get('name',''),'description':value.get('description',''),
            'submitter':{'name':actor.get('name',''),'username':actor.get('username','')}}


def probe_gpuq():
    output = {'connected': False, 'jobs': []}
    if os.path.isfile(CONFIG['gpu']):
        try:
            status = json.loads(command([CONFIG['gpu'], "--json", "q", "--limit", "100"], 12))
            if not isinstance(status, dict):
                raise ValueError('Invalid GPUQ status')
            daemon = status.get("daemon", {})
            jobs = status.get('jobs', [])
            if not isinstance(daemon, dict) or not isinstance(jobs, list):
                raise ValueError('Invalid GPUQ status')
            allowed = ("id", "name", "owner", "state", "gpu_count", "assigned_gpu_count",
                       "assigned_gpu_indices", "active_attempt_id", "priority", "priority_name", "share_gpu", "created_at",
                       "yield_policy", "dispatch_mode", "restart_policy", "state_reason", "preempt_idle_only")
            output = {
                "connected": True, "health": daemon.get("health", "unknown"),
                "observeOnly": daemon.get("observe_only"),
                "capabilities": [c for c in (daemon.get('capabilities') if isinstance(daemon.get('capabilities'), list) else []) if c in ('priority-policy-v1','preempt-idle-only-v1','priority-rank-v1','preempt-opt-in-only-v1','elastic-batch-v1','gpu-placement-v1','gpu-sharing-v1')],
                "schedulableIndices": daemon.get("schedulable_gpu_indices", []),
                "jobs": [{**{key: job.get(key) for key in allowed},
                          **({'display_metadata':display} if (display:=public_task_display(job.get('display_metadata'))) is not None else {})}
                         for job in jobs[:100] if isinstance(job, dict)],
                "limit": 100,
            }
            output['capabilities'] += ['console-task-display-v1','console-task-display-edit-v1','console-yield-v1','console-placement-v1']
        except (ValueError, OSError, subprocess.SubprocessError):
            output["error"] = "GPUQ status unavailable"
    else:
        output["error"] = "GPUQ not installed at the managed entry point"
    return output


def process_cgroups(pid):
    """Only read cgroup membership, never commands, environments or user files."""
    if type(pid) is not int or not 0 < pid <= 2147483647:
        return None
    try:
        content = Path('/proc', str(pid), 'cgroup').read_text()
        if len(content) > 16384:
            return None
        return {part for line in content.splitlines() for part in line.split(':', 2)[-1].split('/') if part.endswith('.service')}
    except (OSError, UnicodeError):
        return None


def attach_scheduling(output):
    """Exact active-attempt cgroup match; a shared GPU/owner is not evidence."""
    units = {}
    for job in output.get('gpuq', {}).get('jobs', []):
        attempt = job.get('active_attempt_id')
        if isinstance(attempt, str) and re.fullmatch(r'A[a-f0-9]{32}', attempt) and job.get('state') in ('RUNNING', 'STARTING', 'PREEMPTING'):
            # Production generations use both A and a for the prefix. Match
            # only these two exact names for the same canonical attempt ID.
            for unit in ('gpuq-' + attempt + '.service', 'gpuq-a' + attempt[1:] + '.service'):
                units[unit] = job
    memberships = {}
    for gpu in output.get('gpus') or []:
        for process in gpu.get('processes', []):
            pid = process['pid']
            if pid not in memberships:
                memberships[pid] = process_cgroups(pid)
            matched = [units[unit] for unit in memberships[pid] or () if unit in units]
            if len(matched) != 1:
                continue  # Unknown also includes incomplete/older queue samples.
            job = matched[0]
            if gpu['index'] not in (job.get('assigned_gpu_indices') or []):
                continue
            priority = job.get('priority')
            if type(priority) is not int or not 0 <= priority <= 4:
                continue
            process['scheduling'] = {'jobId': job.get('id'), 'priority': priority, 'yieldPolicy': job.get('yield_policy')}
    return output


def probe(config=None):
    global CONFIG
    CONFIG=config if config is not None else json.loads(_profile.read_private(_profile.config_path()))
    output={"version":1,"checkedAt":datetime.datetime.now(datetime.timezone.utc).isoformat()}
    with ThreadPoolExecutor(max_workers=2) as pool:
        gpuq=pool.submit(probe_gpuq);output.update(probe_gpus());output['gpuq']=gpuq.result()
    spec=importlib.util.spec_from_file_location('probe_data',HERE/'local-data.py')
    data=importlib.util.module_from_spec(spec);spec.loader.exec_module(data)
    try:output['disks']=data.disk_samples(CONFIG)
    except (OSError,ValueError):output['disks']=None
    output['tasks']=output['gpuq'].get('jobs') if output['gpuq'].get('connected') else None
    output=attach_scheduling(output)
    jobs={j['id']:j for j in output['tasks'] or []}
    for card in output.get('gpus') or []:
        for process in card.get('processes',[]):
            job=jobs.get(process.get('scheduling',{}).get('jobId'))
            process['task']={k:job.get(k) for k in ('id','name','owner','state','display_metadata')} if job else None
    return output


if __name__ == "__main__":
    # SSH_ORIGINAL_COMMAND and stdin are intentionally ignored.
    print(json.dumps(probe(), ensure_ascii=False))
