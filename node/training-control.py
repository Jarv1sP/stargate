"""Expose one scheduler-owned attempt and its SDK, never their parents.

GPUQ stores checkpoint paths as opaque resume tokens. ACKs can use persistent
sandbox paths; the host coordinator does not need a global /outputs mount.
"""
import os
import ast
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
    """The configured native runtime and its GPU/RAM isolation capability."""
    directory=Path(config['gpuqArchive']).resolve(strict=True).parent/'hami'
    if type(sm_percent) is not int or not 1<=sm_percent<=100:
        raise ValueError('GPU算力比例必须在1到100之间。')
    descriptor=os.open(directory/'libvgpu.so',os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):raise ValueError('GPU资源库必须是数据盘上的普通文件。')
        os.lseek(descriptor,0,os.SEEK_SET);return descriptor
    except BaseException:
        os.close(descriptor);raise


def hami_environment(config,spec,environment):
    placement=spec.get('placement',{})
    if not placement.get('hami'):return {},None
    fd=hami_library(config,placement['smPercent'])
    try:
        budget=f"{placement['vramMiB']}m";sm=str(placement['smPercent'])
        return {'LD_PRELOAD':'/opt/gpuq/libvgpu.so',
                'CUDA_DEVICE_MEMORY_LIMIT':budget,'CUDA_DEVICE_MEMORY_LIMIT_0':budget,
                'CUDA_DEVICE_SM_LIMIT':sm,'CUDA_DEVICE_SM_LIMIT_0':sm,
                'CUDA_DEVICE_MEMORY_SHARED_CACHE':CONTROL+'/hami/usage.cache',
                'GPU_CORE_UTILIZATION_POLICY':'force' if placement['smPercent']<100 else 'disable',
                'HAMI_HOST_PID_MODE':'self','ACTIVE_OOM_KILLER':'false','LIBCUDA_LOG_LEVEL':'0'},fd
    except BaseException:
        os.close(fd);raise


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
    """Return trusted control mounts and FDs to close; called by the trusted host runner."""
    if not config.get('controlRoot'):
        return [], []
    attempt, job = environment.get('GPUQ_ATTEMPT_ID', ''), environment.get('GPUQ_JOB_ID', '')
    if not re.fullmatch(r'A[a-f0-9]{32}', attempt) or not re.fullmatch(r'J[a-f0-9]+', job):
        raise ValueError('Missing scheduler attempt identity')
    control_root = Path(config['controlRoot'])
    if not control_root.is_absolute() or '..' in control_root.parts:
        raise ValueError('Invalid scheduler control root')
    expected = str(control_root / attempt)
    mounts = {'/workspace': workspace}
    if project:
        mounts['/outputs'] = project['output']
    env = {'GPUQ_JOB_ID': job, 'GPUQ_CONSOLE_JOB_ID': spec['id'],
           'GPUQ_ATTEMPT_ID': attempt, 'GPUQ_CONTROL_DIR': CONTROL, 'PYTHONPATH': SDK}
    for key in COUNTERS:
        if key in environment:
            value = environment[key]
            if not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,19}', value) or int(value)>2**63-1:
                raise ValueError('Invalid scheduler counter: ' + key)
            env[key] = value
    if 'GPUQ_ALLOWED_GPU_COUNTS' in environment:
        value = environment['GPUQ_ALLOWED_GPU_COUNTS']
        if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]*(,[1-9][0-9]*){0,63}', value):
            raise ValueError('Invalid allowed GPU counts')
        env['GPUQ_ALLOWED_GPU_COUNTS'] = value
    if environment.get('GPUQ_RESUME_CHECKPOINT'):
        env['GPUQ_RESUME_CHECKPOINT'] = resume_path(environment['GPUQ_RESUME_CHECKPOINT'], mounts)
    descriptors = []
    try:
        rootfd = os.open(control_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            descriptors.append(os.open(attempt, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd))
        finally:
            os.close(rootfd)
        archive = os.open(config['gpuqArchive'], os.O_RDONLY | os.O_NOFOLLOW)
        descriptors.append(archive)
        if not stat.S_ISREG(os.fstat(archive).st_mode):
            raise ValueError('Scheduler SDK is not a regular archive')
        args = ['--dir', '/run/gpuq', '--bind-fd', str(descriptors[0]), CONTROL,
                '--ro-bind-data', str(archive), SDK]
        runtime_env,library=hami_environment(config,spec,environment)
        if library is not None:
            descriptors.append(library);args+=['--ro-bind-data',str(library),'/opt/gpuq/libvgpu.so'];env.update(runtime_env)
        for key, value in env.items():
            args += ['--setenv', key, value]
        return args, descriptors
    except BaseException:
        for descriptor in descriptors:
            os.close(descriptor)
        raise
