#!/usr/bin/python3
"""Enforced budgets, GPU-local CPU sets, thread defaults and opt-in Ray helpers.

The cgroup remains the security boundary. Ray's logical resources and the JSON
snapshot are admission/discovery aids, not an additional resource reservation.
"""
import csv
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys

GIB = 1024 ** 3
RESOURCE_FILE = '/run/gpuq/resources.json'
RAY_SPILL_DIR = '/tmp/gpuq-ray-spill'
THREAD_VARIABLES = ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS',
                    'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'TORCHINDUCTOR_COMPILE_THREADS')


def thread_defaults(budget, cpus=()):
    count = math.floor(budget['cpuLimit'])
    if cpus: count = min(count, len(cpus))
    return dict.fromkeys(THREAD_VARIABLES, str(max(1, count)))


def _cpu_list(value):
    result = set()
    for part in value.strip().split(','):
        ends = list(map(int, part.split('-')))
        result.update(range(ends[0], ends[-1] + 1))
    return result


def cpuset_available(proc=Path('/proc/self/cgroup'), root=Path('/sys/fs/cgroup')):
    try:
        group = next(line[3:] for line in proc.read_text().splitlines() if line.startswith('0::'))
        return 'cpuset' in (root / group.lstrip('/') / 'cgroup.controllers').read_text().split()
    except (OSError, StopIteration):
        return False


def gpu_cpu_layout(gpus, cpus, sysfs=Path('/sys')):
    """Fixed, disjoint segments per physical GPU, local to its NUMA node."""
    cpus = sorted(cpus)
    if not gpus or not cpus: return {}
    remaining, cores = set(cpus), []
    for cpu in cpus:
        if cpu not in remaining: continue
        try:
            siblings = _cpu_list((sysfs / 'devices/system/cpu' / ('cpu' + str(cpu)) / 'topology/thread_siblings_list').read_text())
        except (OSError, ValueError):
            siblings = {cpu}
        core = sorted((siblings | {cpu}) & remaining)
        cores.append(core)
        remaining.difference_update(core)
    groups = {}
    try:
        for gpu in gpus:
            node = int((sysfs / 'bus/pci/devices' / gpu['pci'] / 'numa_node').read_text())
            local = sorted(_cpu_list((sysfs / 'devices/system/node' / ('node' + str(node)) / 'cpulist').read_text()) & set(cpus))
            if not local: raise ValueError('NUMA locality unavailable')
            groups.setdefault(node, (local, []))[1].append(gpu)
    except (OSError, ValueError, KeyError):
        groups = {None: (cpus, list(gpus))}

    def split(groups):
        result = {}
        for local, cards in groups:
            local = set(local)
            local_cores = [core for core in cores if core[0] in local]
            width, extra = divmod(len(local_cores), len(cards))
            start = 0
            for position, gpu in enumerate(sorted(cards, key=lambda gpu: gpu['index'])):
                end = start + width + (position < extra)
                result[gpu['uuid']] = sorted(cpu for core in local_cores[start:end] for cpu in core)
                start = end
        return result

    result = split(groups.values())
    if any(len(segment) < len(cpus) // len(gpus) for segment in result.values()):
        result = split([(cpus, gpus)])
    return result


def allocated_cpus(uuids, config):
    cpus = sorted(os.sched_getaffinity(0))
    try:
        raw = subprocess.run(['/usr/bin/nvidia-smi', '--query-gpu=index,uuid,pci.bus_id',
                              '--format=csv,noheader,nounits'], check=True, capture_output=True,
                             text=True, timeout=5).stdout
        gpus = [{'index': int(row[0]), 'uuid': row[1].strip(),
                 'pci': row[2].strip().lower()[-12:]} for row in csv.reader(io.StringIO(raw)) if row]
        if not set(uuids) <= {gpu['uuid'] for gpu in gpus}: raise ValueError('GPU topology unavailable')
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return []
    layout = gpu_cpu_layout(gpus, cpus)
    return sorted({cpu for uuid in uuids for cpu in layout[uuid]})


def memory_pool(config):
    """Deployment-owned shared ancestor, never a path supplied by a job."""
    pool = (config or {}).get('memoryPool')
    if pool is None:
        return None
    if (not isinstance(pool, dict) or not {'cgroup','maxBytes'} <= set(pool)
            or not isinstance(pool['cgroup'], str)
            or not pool['cgroup'].endswith('/gpuq-workloads.slice')
            or type(pool['maxBytes']) is not int or pool['maxBytes'] <= 0):
        raise ValueError('Invalid shared memory pool configuration')
    cgroup_path(pool['cgroup'])
    return pool


def verify_memory_pool(group, config, root=Path('/sys/fs/cgroup')):
    pool = memory_pool(config)
    if pool is None:
        return
    parent = cgroup_path(pool['cgroup'], root)
    job = cgroup_path(group, root)
    if parent not in job.parents:
        raise ValueError('Job is outside the shared memory pool')
    enforced = _limit(parent, 'memory.max', required=True)
    if enforced is None or enforced > pool['maxBytes']:
        raise ValueError('Shared memory pool limit is not enforced')
    if (parent / 'memory.oom.group').read_text().strip() != '0':
        raise ValueError('Shared memory pool must not OOM-kill all jobs together')


def requested_limits(spec, terminal=False, config=None):
    cards = spec.get('cards')
    if not terminal and (type(cards) is not int or not 1 <= cards <= 64):
        raise ValueError('Invalid GPU resource request')
    pool = memory_pool(config)
    memory = max(1, pool['maxBytes'] // 2) if pool else (8 if terminal else cards * (config or {}).get('jobMemoryGiBPerCard', 64)) * GIB
    if 'memoryLimitGiB' in spec:
        limit = spec['memoryLimitGiB']
        if type(limit) is not int or not 1 <= limit <= 1048576:
            raise ValueError('Invalid memory limit')
        memory = min(pool['maxBytes'] if pool else memory, limit * GIB)
    try:
        gpu_count = len(list(Path('/proc/driver/nvidia/gpus').iterdir()))
    except OSError:
        gpu_count = (config or {}).get('cards', 0)
    per_card = max(4, (os.cpu_count() or 1) // gpu_count) if type(gpu_count) is int and gpu_count > 0 else 4
    return {'cpu': 2 if terminal else cards * per_card, 'memory': memory, 'pids': 2048}


def cgroup_path(group, root=Path('/sys/fs/cgroup')):
    """Only accept the runner's kernel-provided absolute unified cgroup path."""
    parts = PurePosixPath(group).parts
    if not group.startswith('/') or group.startswith('//') or '..' in parts or '\x00' in group:
        raise ValueError('Invalid job cgroup')
    path = Path(root)
    for part in parts[1:]:
        path = path / part
        if path.is_symlink():
            raise ValueError('Symlink in job cgroup')
    return path


def _limit(path, name, required=False):
    try:
        value = (path / name).read_text().strip()
    except FileNotFoundError:
        if required:
            raise ValueError('Missing enforced job limit: ' + name)
        return None
    if name == 'cpu.max':
        fields = value.split()
        if len(fields) != 2 or not fields[1].isdigit() or int(fields[1]) <= 0:
            raise ValueError('Invalid cpu.max')
        if fields[0] == 'max':
            return None
        value = fields[0]
        denominator = int(fields[1])
    else:
        if value == 'max':
            return None
        denominator = 1
    if not value.isdigit() or int(value) <= 0:
        raise ValueError('Invalid enforced job limit: ' + name)
    return int(value) / denominator if name == 'cpu.max' else int(value)


def read_budget(spec, group, uuids, terminal=False, *, root=Path('/sys/fs/cgroup'),
                affinity_count=None, physical_memory=None, config=None):
    requested = requested_limits(spec, terminal, config)
    verify_memory_pool(group, config, root)
    if len(uuids) != (0 if terminal else spec['cards']) or len(set(uuids)) != len(uuids):
        raise ValueError('GPU allocation does not match resource request')
    path = cgroup_path(group, root)
    names = {'cpu': 'cpu.max', 'memory': 'memory.max', 'pids': 'pids.max'}
    limits = {key: _limit(path, name, required=True) for key, name in names.items()}
    # systemctl success alone is not evidence that all requested limits exist.
    for key, value in limits.items():
        if value is None or value > requested[key] + (1e-6 if key == 'cpu' else 0):
            raise ValueError('Job ' + key + ' limit is not enforced')
    parent = path.parent
    while parent != Path(root).parent:
        for key, name in names.items():
            value = _limit(parent, name)
            if value is not None:
                limits[key] = min(limits[key], value)
        if parent == Path(root):
            break
        parent = parent.parent
    if affinity_count is None:
        affinity_count = len(os.sched_getaffinity(0))
    if physical_memory is None:
        physical_memory = os.sysconf('SC_PHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
    limits['cpu'] = min(limits['cpu'], affinity_count)
    limits['memory'] = min(limits['memory'], physical_memory)
    budget = {'schemaVersion': 1, 'jobId': spec['id'], 'cgroupVersion': 2,
              'cpuLimit': limits['cpu'], 'memoryLimitBytes': limits['memory'],
              'pidsLimit': limits['pids'], 'gpuCount': len(uuids), 'gpuUuids': list(uuids),
              'requested': requested, 'cgroupPath': '/sys/fs/cgroup'}
    if memory_pool(config):
        budget['memoryShared'] = True
    validate_budget(budget)
    return budget


def validate_budget(budget):
    if not isinstance(budget, dict):
        raise ValueError('Unsupported job resource metadata')
    cpu = budget.get('cpuLimit')
    if type(cpu) not in (int, float) or not math.isfinite(cpu) or cpu <= 0:
        raise ValueError('Invalid CPU budget')
    for name in ('memoryLimitBytes', 'pidsLimit'):
        if type(budget.get(name)) is not int or budget[name] <= 0:
            raise ValueError('Invalid ' + name)
    if type(budget.get('gpuCount')) is not int or not 0 <= budget['gpuCount'] <= 64:
        raise ValueError('Invalid GPU budget')
    return budget


def resource_environment(budget):
    validate_budget(budget)
    return {'GPUQ_RESOURCES_FILE': RESOURCE_FILE, 'GPUQ_CPU_LIMIT': format(budget['cpuLimit'], 'g'),
            'GPUQ_MEMORY_LIMIT_BYTES': str(budget['memoryLimitBytes']),
            'GPUQ_PIDS_LIMIT': str(budget['pidsLimit']), 'GPUQ_GPU_COUNT': str(budget['gpuCount'])}


def load_budget():
    # Fixed read-only sandbox path: do not trust a caller-supplied budget override.
    return validate_budget(json.loads(Path(RESOURCE_FILE).read_text()))


def ray_init_kwargs(budget):
    validate_budget(budget)
    # Ray 2.58 derives the raylet int32 maximum_startup_concurrency flag from
    # num_cpus without normalizing an integral float (32.0 becomes invalid).
    # Never round a fractional cgroup quota up to additional logical resources.
    cpus = math.floor(budget['cpuLimit'])
    if cpus < 1:
        raise ValueError('Ray profile requires at least one whole CPU of quota')
    total = budget['memoryLimitBytes']
    reserve = max(total // 10, 512 * 1024 ** 2)
    object_store = min(total // 5, 8 * GIB)
    worker_memory = total - reserve - object_store
    if object_store < 80 * 1024 ** 2 or worker_memory <= 0:
        raise ValueError('Memory budget is too small for the Ray profile')
    # _memory is Ray's existing private logical worker-memory argument. This
    # never disables the memory monitor or expands the kernel MemoryMax limit.
    return {'num_cpus': cpus, 'num_gpus': budget['gpuCount'],
            'object_store_memory': object_store, '_memory': worker_memory,
            'include_dashboard': False, 'object_spilling_directory': RAY_SPILL_DIR}


def ray_environment(budget, environ):
    """Opt-in only. No monkeypatching Python, CUDA visibility, or generic jobs."""
    validate_budget(budget)
    result = dict(environ)
    # Ray 2.x RAY_CONFIG reads these environment keys when each compiled setting
    # exists; obsolete/unknown environment keys are ignored (unlike _system_config).
    # Older Ray uses host hardware_concurrency()/4 for several of these pools.
    for key in ('num_server_call_thread', 'core_worker_num_server_call_thread',
                'gcs_server_rpc_server_thread_num', 'gcs_server_rpc_client_thread_num',
                'object_manager_rpc_threads_num', 'worker_num_grpc_internal_threads'):
        result['RAY_' + key] = '2'
    result['RAY_enable_worker_prestart'] = 'false'
    result['RAY_prestart_worker_first_driver'] = 'false'
    for key in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS',
                'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
        result[key] = '1'
    # An explicit opt-in profile must not inherit Ray's host-CPU bypass or a
    # stale external-cluster address. The job-local cgroup view is authoritative.
    result.pop('RAY_USE_MULTIPROCESSING_CPU_COUNT', None)
    result.pop('RAY_OVERRIDE_RESOURCES', None)
    result.pop('RAY_ADDRESS', None)
    result['RAY_USAGE_STATS_ENABLED'] = '0'
    # Persist bounded diagnostics, not potentially huge spilled objects. /tmp
    # is the existing job-private tmpfs, charged to its unchanged MemoryMax.
    result['RAY_object_spilling_directory'] = RAY_SPILL_DIR
    if result.get('GPUQ_RAY_TEMP_DIR') == '/run/gpuq/runtime/ray':
        result['RAY_TMPDIR'] = '/run/gpuq/runtime'
    return result


def ray_start_command(budget, argv, python=sys.executable, temp_dir=None):
    values = ray_init_kwargs(budget)
    # This helper starts one local head. Keep a small explicit option surface so
    # abbreviations/duplicate flags cannot silently replace the budget.
    allowed_flags = {'--block', '--verbose'}
    for value in argv:
        if value not in allowed_flags:
            raise ValueError('gpuq-ray start only accepts --block and --verbose')
    cpus = values['num_cpus']
    command = [python, '-m', 'ray.scripts.scripts', 'start', '--head',
               '--num-cpus=' + str(cpus), '--num-gpus=' + str(values['num_gpus']),
               '--memory=' + str(values['_memory']),
               '--object-store-memory=' + str(values['object_store_memory']),
               '--object-spilling-directory=' + RAY_SPILL_DIR,
               '--include-dashboard=false', '--disable-usage-stats']
    if temp_dir:
        command.append('--temp-dir=' + temp_dir)
    return command + list(argv)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ('-h', '--help'):
        print('gpuq-ray resources | init-kwargs | start [--block] [--verbose] | exec COMMAND [ARG...]')
        return 0
    action, *arguments = argv
    budget = load_budget()
    if action in ('resources', 'init-kwargs'):
        if arguments:
            raise ValueError('Unexpected arguments')
        print(json.dumps(budget if action == 'resources' else ray_init_kwargs(budget), sort_keys=True))
        return 0
    env = ray_environment(budget, os.environ)
    if action == 'start':
        command = ray_start_command(budget, arguments, temp_dir=env.get('GPUQ_RAY_TEMP_DIR'))
    elif action == 'exec' and arguments:
        command = arguments
    else:
        raise ValueError('Use resources, init-kwargs, start, or exec COMMAND')
    os.execvpe(command[0], command, env)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('gpuq-ray:', str(error), file=sys.stderr)
        sys.exit(2)
