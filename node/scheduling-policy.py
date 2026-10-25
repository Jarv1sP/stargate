"""Explicit queue rank and voluntary yielding; current queue policy."""
import importlib.util
import re
import json
import sqlite3
from contextlib import closing
from pathlib import Path

PRIORITY_PRESETS = {'idle': (0, 'now'), 'normal': (2, 'never'), 'high': (4, 'never')}


def validate(value):
    fields = {'rank','yieldPolicy','restartPolicy','checkpointable'}
    if not isinstance(value,dict) or not fields<=set(value):
        raise ValueError('Invalid explicit scheduling contract')
    if value.get('mode','queue') not in ('queue','preempt-save','preempt-now'):
        raise ValueError('Invalid requester mode')
    if value['rank'] not in ('P0','P1','P2','P3','P4') or value['yieldPolicy'] not in ('never','now','save') or value['restartPolicy'] not in ('never','on-preempt') or type(value['checkpointable']) is not bool:
        raise ValueError('Invalid explicit scheduling values')
    return value


def normalize_job_policy(job):
    policy = {'kind': 'default', 'priority': 0, 'dispatch_mode': 'queue',
              'yield_policy': 'never', 'restart_policy': 'never',
              'checkpointable': False, 'preempt_idle_only': False,'preempt_opt_in_only':False}
    if 'scheduling' in job:
        value = validate(job['scheduling'])
        policy.update(kind='explicit', priority=int(value['rank'][1]),
                      yield_policy=value['yieldPolicy'], restart_policy=value['restartPolicy'],
                      checkpointable=value['checkpointable'],dispatch_mode=value.get('mode','queue'),
                      preempt_opt_in_only=value.get('mode','queue')!='queue')
    elif 'priority' in job or 'preemptIdleOnly' in job:
        name = job.get('priority')
        if not isinstance(name, str) or name not in PRIORITY_PRESETS or job.get('preemptIdleOnly') is not True:
            raise ValueError('Explicit safe scheduling policy required')
        rank, yielding = PRIORITY_PRESETS[name]
        policy.update(kind='preset', priority=rank, yield_policy=yielding, preempt_idle_only=True,
                      restart_policy='on-preempt' if name=='idle' and not job.get('interactive') else 'never')
    return policy


def submit_arguments(policy):
    # queue already preempts strictly lower-ranked explicit now/save volunteers.
    # Only voluntary yielding is passed to the scheduler.
    result = ['-p', 'P'+str(policy['priority']), '-m', policy['dispatch_mode'],
              '--yield', policy['yield_policy'], '--restart-policy', policy['restart_policy']]
    if policy['preempt_idle_only']:
        result.append('--preempt-idle-only')
    if policy['checkpointable']:
        result.append('--checkpointable')
    if policy['preempt_opt_in_only']:
        result.append('--preempt-opt-in-only')
    return result


def elastic_allocation(job):
    value=job.get('elastic')
    if 'elastic' not in job:return None
    if not isinstance(value,dict) or not {'minCards','globalBatch','microBatch','autoExpand'} <= set(value):
        raise ValueError('Invalid elastic allocation contract')
    cards=job['cards'];minimum=value['minCards'];target=value['globalBatch'];micro=value['microBatch']
    if type(cards) is not int or not 1<=cards<=64 or type(minimum) is not int or not 1<=minimum<=cards or any(type(n) is not int or not 1<=n<=2**53-1 for n in (target,micro)) or type(value['autoExpand']) is not bool:
        raise ValueError('Invalid elastic allocation values')
    allowed=[n for n in range(minimum,cards+1) if target%(n*micro)==0]
    if not allowed:raise ValueError('No exact-batch-compatible card count')
    return allowed


def allocation_arguments(job):
    placement=gpu_placement(job)
    result=['--gpu',','.join(map(str,placement['gpuIndices']))] if placement else ['-g',str(job['cards'])]
    if placement and placement['shared']:
        # The public budget is exact MiB; n/1024 is exactly representable and
        # native CLI converts it back to MiB with ceil, without rounding drift.
        result+=['--share','--vram-gb',str(placement['vramMiB']/1024)]
        if placement.get('hami'):result+=['--hami','--sm-percent',str(placement['smPercent'])]
    if elastic_allocation(job) is not None:
        value=job['elastic']
        result+=['--elastic-start','--min-gpus',str(value['minCards']),'--global-batch',str(value['globalBatch']),'--micro-batch',str(value['microBatch'])]
        if value['autoExpand']:result.append('--auto-expand')
    return result


def allocated_spec(job,indices,uuids,config=None,environment=None):
    """A runtime copy only: stored cards remains the maximum quota reservation."""
    allowed=elastic_allocation(job) or [job['cards']]
    if len(indices) not in allowed or len(uuids)!=len(indices) or len(set(indices))!=len(indices) or len(set(uuids))!=len(uuids) or any(not re.fullmatch('[0-9]+',i) for i in indices) or any(not u.startswith('GPU-') for u in uuids):
        raise ValueError('Missing or incompatible GPUQ allocation')
    return {**job,'cards':len(indices)}


def gpu_placement(job):
    if 'placement' not in job:return None
    value=job['placement']
    if not isinstance(value,dict) or not {'gpuIndices','shared'}<=set(value):raise ValueError('Invalid GPU placement contract')
    indices=value['gpuIndices'];cards=job['cards']
    if 'elastic' in job or type(cards) is not int or not 1<=cards<=64 or not isinstance(indices,list) or len(indices)!=cards or any(type(n) is not int or not 0<=n<=2**53-1 for n in indices) or len(set(indices))!=cards or type(value['shared']) is not bool:raise ValueError('Invalid GPU placement values')
    if value['shared']:
        policy=normalize_job_policy(job)
        if cards!=1 or type(value.get('vramMiB')) is not int or not 1<=value['vramMiB']<=2**31-1 or type(value.get('hami')) is not bool or policy['yield_policy']!='never' or policy['restart_policy']!='never' or policy['dispatch_mode']!='queue':raise ValueError('Sharing requires one protected GPU and a memory budget')
        if value['hami']:
            if type(value.get('smPercent')) is not int or not 1<=value['smPercent']<=100:raise ValueError('Invalid HAMi SM percentage')
        elif 'smPercent' in value:raise ValueError('SM limit requires HAMi')

    return value


def hami_ready(config,here,sm_percent=100):
    try:
        if not allocation_ready(config,here,2):return False
        import os
        module=importlib.util.spec_from_file_location('gpuq_hami_control',here/'training-control.py');control=importlib.util.module_from_spec(module);module.loader.exec_module(control)
        descriptor,_=control.hami_library(config,sm_percent);os.close(descriptor);return True
    except (OSError,ValueError,ImportError,AttributeError,KeyError,TypeError):return False
