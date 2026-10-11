"""Expose one scheduler-owned attempt and its SDK, never their parents.

GPUQ stores checkpoint paths as opaque resume tokens. ACKs can use persistent
sandbox paths; the host coordinator does not need a global /outputs mount.
"""
import os
import ast
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import importlib.util
import stat
from contextlib import closing

CONTROL = '/run/gpuq/control'
SDK = '/opt/gpuq/sdk.pyz'
PROTOCOL_VERSION = 1
COUNTERS = (
    'GPUQ_ASSIGNED_GPU_COUNT', 'GPUQ_ACTUAL_GPU_COUNT', 'GPUQ_MIN_GPU_COUNT',
    'GPUQ_MAX_GPU_COUNT', 'GPUQ_PREVIOUS_GPU_COUNT', 'GPUQ_WORLD_SIZE',
    'GPUQ_MIN_WORLD_SIZE', 'GPUQ_MAX_WORLD_SIZE', 'GPUQ_PREVIOUS_WORLD_SIZE',
    'GPUQ_TARGET_GLOBAL_BATCH_SIZE', 'GPUQ_PER_DEVICE_MICRO_BATCH_SIZE',
)


def hami_library(config,sm_percent):
    """The release-pinned native runtime, checked again before a sandbox bind."""
    directory=Path(config['gpuqArchive']).resolve(strict=True).parent/'hami'
    manifest=json.loads((directory/'manifest.json').read_text())
    sha=manifest.get('sha256')
    if not isinstance(sha,str) or not re.fullmatch('[a-f0-9]{64}',sha) or type(sm_percent) is not int or not 1<=sm_percent<=100 or sm_percent<100 and manifest.get('sm_supported') is not True:
        raise ValueError('HAMi runtime/SM validation unavailable')
    descriptor=os.open(directory/'libvgpu.so',os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or not 4<=info.st_size<=64*1024**2:raise ValueError('Invalid HAMi library')
        first=os.read(descriptor,4);digest=hashlib.sha256(first)
        while chunk:=os.read(descriptor,1024**2):digest.update(chunk)
        if first!=b'\x7fELF' or digest.hexdigest()!=sha:raise ValueError('HAMi library checksum/format mismatch')
        os.lseek(descriptor,0,os.SEEK_SET);return descriptor,sha
    except BaseException:
        os.close(descriptor);raise


def hami_environment(config,spec,environment):
    placement=spec.get('placement',{})
    if not placement.get('hami'):return {},None
    fd,sha=hami_library(config,placement['smPercent'])
    try:
        expected=str(Path(config['gpuqArchive']).resolve(strict=True).parent/'hami/libvgpu.so')
        cache=str(Path(environment['GPUQ_CONTROL_DIR'])/'hami/usage.cache')
        if environment.get('LD_PRELOAD')!=expected or environment.get('GPUQ_HAMI_LIBRARY_SHA256')!=sha or environment.get('CUDA_DEVICE_MEMORY_SHARED_CACHE')!=cache or environment.get('ACTIVE_OOM_KILLER')!='false':raise ValueError('HAMi environment does not belong to scheduler attempt')
        budget=f"{placement['vramMiB']}m";sm=str(placement['smPercent'])
        return {'LD_PRELOAD':'/opt/gpuq/libvgpu.so','GPUQ_HAMI_LIBRARY_SHA256':sha,
                'CUDA_DEVICE_MEMORY_LIMIT':budget,'CUDA_DEVICE_MEMORY_LIMIT_0':budget,
                'CUDA_DEVICE_SM_LIMIT':sm,'CUDA_DEVICE_SM_LIMIT_0':sm,
                'CUDA_DEVICE_MEMORY_SHARED_CACHE':CONTROL+'/hami/usage.cache',
                'GPU_CORE_UTILIZATION_POLICY':'force' if placement['smPercent']<100 else 'disable',
                'HAMI_HOST_PID_MODE':'self','ACTIVE_OOM_KILLER':'false','LIBCUDA_LOG_LEVEL':'0'},fd
    except BaseException:
        os.close(fd);raise


def ready(config, here):
    """One versioned readiness check shared by admission and node probing."""
    try:
        if type(config.get('trainingControlProtocol')) is not int or config['trainingControlProtocol'] != PROTOCOL_VERSION:
            return False
        root, archive = Path(config['controlRoot']), Path(config['gpuqArchive'])
        if not root.is_absolute() or root.is_symlink() or not root.is_dir() or not archive.is_absolute() or archive.is_symlink() or not archive.is_file():
            return False
        tree = ast.parse((here / 'sandbox-runner.py').read_text())
        versions = [node.value.value for node in tree.body if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == 'TRAINING_CONTROL_PROTOCOL' for target in node.targets)
                    and isinstance(node.value, ast.Constant)]
        return len(versions) == 1 and type(versions[0]) is int and versions[0] == PROTOCOL_VERSION
    except (KeyError, OSError, TypeError, SyntaxError):
        return False


def resume_path(value, mounts):
    """Resolve only a file in this job's existing persistent mounts."""
    if not isinstance(value, str) or not value.startswith('/') or any(c in value for c in ('\0', '\n', '\r')):
        raise ValueError('Invalid checkpoint path')
    path = Path(value)
    if '..' in path.parts or str(path) != value:
        raise ValueError('Checkpoint path must be normalized')
    for target, source in mounts.items():
        root = Path(source).resolve(strict=True)
        for prefix in (Path(target), root):
            try:
                relative = path.relative_to(prefix)
            except ValueError:
                continue
            checkpoint = (root / relative).resolve(strict=True)
            if not checkpoint.is_relative_to(root) or not checkpoint.is_file():
                raise ValueError('Checkpoint escaped its persistent job mount')
            return str(Path(target) / checkpoint.relative_to(root))
    raise ValueError('Checkpoint is outside persistent job mounts; refusing a fresh restart')


def prepare(config, spec, workspace, project, environment):
    """Return bwrap args and FDs to close; called by the trusted host runner."""
    if not config.get('controlRoot'):
        return [], []
    attempt, job = environment.get('GPUQ_ATTEMPT_ID', ''), environment.get('GPUQ_JOB_ID', '')
    if not re.fullmatch(r'A[a-f0-9]{32}', attempt) or not re.fullmatch(r'J[a-f0-9]+', job):
        raise ValueError('Missing scheduler attempt identity')
    control_root = Path(config['controlRoot'])
    if not control_root.is_absolute() or '..' in control_root.parts:
        raise ValueError('Invalid scheduler control root')
    expected = str(control_root / attempt)
    if environment.get('GPUQ_CONTROL_DIR') != expected:
        raise ValueError('Control directory does not belong to this attempt')
    with closing(sqlite3.connect(Path(config['database']).as_uri() + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT a.control_dir FROM attempts a JOIN jobs j ON j.id=a.job_id '
                         'WHERE a.id=? AND j.id=? AND j.submit_key=?', (attempt, job, spec['id'])).fetchone()
    if row is None or row[0] != expected:
        raise ValueError('Attempt does not belong to this Console job')
    if 'storageQuota' in config:
        quota_spec = importlib.util.spec_from_file_location('gpuq_training_quota', Path(__file__).with_name('storage-quota.py'))
        quota = importlib.util.module_from_spec(quota_spec); quota_spec.loader.exec_module(quota)
        quota.ensure(config, spec['userId'], expected)
    mounts = {'/workspace': workspace}
    if project:
        mounts['/outputs'] = project['output']
    files, env = open_attempt(config, job_id=job, task_id=spec['id'], attempt_id=attempt,
                             environment=environment, mounts=mounts, placement=spec.get('placement', {}))
    args = ['--dir', '/run/gpuq']
    for descriptor, target, readonly in files:
        args += ['--ro-bind-data' if readonly else '--bind-fd', str(descriptor), target]
    for key, value in env.items():
        args += ['--setenv', key, value]
    return args, [descriptor for descriptor, _, _ in files]


def open_attempt(config, *, job_id, task_id, attempt_id, environment, mounts, placement):
    """Open IPC for an already authorized attempt; caller owns returned FDs.

    Legacy prepare validates its SQL binding above. V2 uses its native execution
    authority before entering here; task_id need not equal the native submit key.
    No database lookup, directory creation or resource release happens here.
    """
    env = {'GPUQ_JOB_ID': job_id, 'GPUQ_CONSOLE_JOB_ID': task_id,
           'GPUQ_ATTEMPT_ID': attempt_id, 'GPUQ_CONTROL_DIR': CONTROL, 'PYTHONPATH': SDK}
    for key in COUNTERS:
        if key in environment:
            value = environment[key]
            if not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,19}', value) or int(value)>2**63-1:
                raise ValueError('Invalid scheduler counter: ' + key)
            env[key] = value
    if 'GPUQ_ALLOWED_GPU_COUNTS' in environment:
        value = environment['GPUQ_ALLOWED_GPU_COUNTS']
        if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]*(,[1-9][0-9]*){0,4095}', value):
            raise ValueError('Invalid allowed GPU counts')
        env['GPUQ_ALLOWED_GPU_COUNTS'] = value
    if environment.get('GPUQ_RESUME_CHECKPOINT'):
        env['GPUQ_RESUME_CHECKPOINT'] = resume_path(environment['GPUQ_RESUME_CHECKPOINT'], mounts)
    descriptors = []
    try:
        rootfd = os.open(config['controlRoot'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            descriptors.append(os.open(attempt_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd))
        finally:
            os.close(rootfd)
        archive = os.open(config['gpuqArchive'], os.O_RDONLY | os.O_NOFOLLOW)
        descriptors.append(archive)
        if not stat.S_ISREG(os.fstat(archive).st_mode):
            raise ValueError('Scheduler SDK is not a regular archive')
        files = [(descriptors[0], CONTROL, False), (archive, SDK, True)]
        runtime_env,library=hami_environment(config,{'placement': placement},environment)
        if library is not None:
            descriptors.append(library);files.append((library,'/opt/gpuq/libvgpu.so',True));env.update(runtime_env)
        return files, env
    except BaseException:
        for descriptor in descriptors:
            os.close(descriptor)
        raise
