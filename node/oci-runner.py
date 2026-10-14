#!/usr/bin/python3
"""GPUQ-owned OCI process. All persistent mounts live on configured data disks."""
import importlib.util,json,os,re,select,subprocess,sys,time,tempfile
sys.dont_write_bytecode=True  # Native retries retain the immutable cohort, not a bytecode side tree.
from pathlib import Path
HERE=Path(__file__).resolve().parent
RUNTIME_PROFILE=None
CORE_PROFILE=os.environ.get('STARGATE_CORE_PROFILE')
if CORE_PROFILE is not None:
    _profile_spec=importlib.util.spec_from_file_location('gpuq_fixed_runtime_profile',HERE/'runtime-profile.py')
    RUNTIME_PROFILE=importlib.util.module_from_spec(_profile_spec);_profile_spec.loader.exec_module(RUNTIME_PROFILE)
CONFIG_PATH=(HERE/'node-config.json') if RUNTIME_PROFILE is None else RUNTIME_PROFILE.config_path(HERE,selected=CORE_PROFILE)

TRAINING_CONTROL_PROTOCOL=1
GPU_ALLOCATION_PROTOCOL=2
DATASET_PREPARATION_LOCK_TIMEOUT=30
DATASET_PREPARATION_LOCK_BUDGET=120

def local_module(name,filename):
    module=importlib.util.spec_from_file_location(name,HERE/filename)
    loaded=importlib.util.module_from_spec(module);sys.modules[name]=loaded;module.loader.exec_module(loaded)
    return loaded


def start_job_capture(root,spec,unit,group,env,indices,uuids):
    """Diagnostics are best effort; only the per-attempt runtime enters the job."""
    if not (HERE/'job-diagnostics.py').exists():return None,None,None
    try:
        module=local_module('gpuq_job_diagnostics','job-diagnostics.py')
        capture=module.start_capture(root,spec,unit,group,env,indices,uuids)
        if not capture.get('available'):
            print('GPUQ diagnostic observer unavailable; preserving job-local runtime only',file=sys.stderr)
        identifier=capture.get('captureId')
        if not isinstance(identifier,str) or not re.fullmatch('[a-f0-9]{32}',identifier):raise ValueError('Invalid diagnostic capture identity')
        expected=root/'diagnostics'/spec['id']/identifier/'runtime'
        if capture.get('runtimePath')!=str(expected):raise ValueError('Invalid diagnostic runtime path')
        cursor=root
        for part in expected.relative_to(root).parts:
            cursor=cursor/part
            if cursor.is_symlink():raise ValueError('Symlink in diagnostic runtime path')
        descriptor=os.open(expected,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        return module,identifier,descriptor
    except Exception:
        print('GPUQ diagnostics unavailable; original job execution is unchanged',file=sys.stderr)
        return None,None,None


def finish_job_capture(module,root,spec,identifier,exit_code,*,phase=None,error=None):
    if module is None:return
    try:module.finish_capture(root,spec,identifier,exit_code,phase=phase,error=error)
    except Exception:print('GPUQ diagnostic finalization unavailable; original exit is unchanged',file=sys.stderr)


class JobCapture:
    """One trusted invocation; never bind a replacement identity after failure."""
    def __init__(self):
        self.module=self.root=self.spec=self.identifier=self.runtimefd=None
        self.phase='IDENTITY'

    def bind(self,root,spec,unit,group,env,indices,uuids):
        self.root,self.spec=root,spec
        self.module,self.identifier,self.runtimefd=start_job_capture(root,spec,unit,group,env,indices,uuids)

    def stderr(self,raw,*,phase='OCI_ENGINE',truncated=False):
        if self.module is None:return
        try:self.module.runner_stderr(self.root,self.spec,self.identifier,raw,phase=phase,truncated=truncated)
        except Exception:print('GPUQ runner stderr capture unavailable',file=sys.stderr)

    def finish(self,code,error=None):
        finish_job_capture(self.module,self.root,self.spec,self.identifier,code,phase=self.phase,error=error)


def main():
    capture=JobCapture()
    try:
        code=run_job(capture,resource_module='job-resources.py')
    except Exception as error:
        capture.finish(125,error)
        raise
    else:
        capture.finish(code)
        return code
    finally:
        if capture.runtimefd is not None:os.close(capture.runtimefd)


def run_job(capture,*,resource_module):
    jid=sys.argv[1]
    if not re.fullmatch(r'[a-f0-9-]{36}',jid):raise ValueError('Invalid job ID')
    cfg=json.loads(CONFIG_PATH.read_text());root=Path(cfg['root'])
    local_module('gpuq_local_data','local-data.py').require_data_path(cfg,root)
    terminal=len(sys.argv)>2 and sys.argv[2]=='terminal'
    spec=json.loads((root/('terminals' if terminal else 'jobs')/f'{jid}.json').read_text())
    interactive=terminal or spec.get('interactive') is True
    indices=os.environ.get('GPUQ_ASSIGNED_GPU_INDICES','').split(',')
    uuids=os.environ.get('GPUQ_ASSIGNED_GPU_UUIDS','').split(',')
    group=next(line.split(':',2)[2].strip() for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    unit=group.rsplit('/',1)[-1]
    if not unit.startswith('amax-term-' if terminal else 'gpuq-') or not unit.endswith('.service'):raise ValueError('Not running inside an authorized job unit')
    env={'PATH':'/usr/bin:/bin','HOME':str(Path.home()),'XDG_RUNTIME_DIR':f'/run/user/{os.getuid()}','DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{os.getuid()}/bus'}
    if not terminal:capture.bind(root,spec,unit,group,env,indices,uuids)
    runtimefd=capture.runtimefd
    capture.phase='GPU_ALLOCATION'
    if terminal:indices=[];uuids=[]
    else:runtime_spec=local_module('gpuq_allocation','scheduling-policy.py').allocated_spec(spec,indices,uuids,cfg,os.environ)
    if not terminal:
        devices=local_module('gpuq_gpu_devices','gpu-devices.py').device_paths(uuids)
        memory=subprocess.check_output(['/usr/bin/nvidia-smi','--id',','.join(uuids),'--query-gpu=memory.total','--format=csv,noheader,nounits'],text=True)
        sizes=[int(line.strip()) for line in memory.splitlines()]
        if len(sizes)!=len(indices) or any(size<spec.get('minVramGiB',0)*1024-512 for size in sizes):raise ValueError('Allocated GPU memory does not meet request')
    # Apply limits BEFORE any untrusted code runs, inside the original GPUQ unit.
    capture.phase='RESOURCE_BUDGET'
    resources=local_module('gpuq_job_resources',resource_module)
    requested=resources.requested_limits(spec if terminal else runtime_spec,terminal,cfg)
    resources.verify_memory_pool(group,cfg)
    subprocess.run(['/usr/bin/systemctl','--user','set-property','--runtime',unit,f'MemoryMax={requested["memory"]}',*(['MemorySwapMax=0'] if cfg.get('memoryPool') else []),f'CPUQuota={requested["cpu"]*100}%','TasksMax=2048'],env=env,check=True)
    # The same job UUID addresses the scheduler, controls and output directory.
    budget=resources.read_budget({**(spec if terminal else runtime_spec),'id':jid},group,uuids,terminal,config=cfg)
    cgroupfd=os.open(resources.cgroup_path(group),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    resourcefd=os.memfd_create('gpuq-resources');os.write(resourcefd,json.dumps(budget,sort_keys=True).encode());os.lseek(resourcefd,0,0)
    capture.phase='PROJECT_PREPARATION'
    store_module=local_module('gpuq_project_store','project-store.py')
    store=store_module.ProjectStore(root,config=cfg)
    project=store.runtime_paths(spec,jid,interactive)
    workspace=project['code']
    # Mount by open FD to pin the directory and avoid a path replacement race.
    workfd=os.open(workspace,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    project_fds={name:os.open(project[name],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW) for name in ('home','output')} if project else {}
    data=local_module('gpuq_local_data','local-data.py')
    dataset_fds=[(data.open_directory(data.root(cfg,'datasetsRoot')),'/datasets')]
    datafd=datalock=None
    if project and project['environmentMode']=='oci':
        capture.phase='OCI_EXECUTION'
        try:
            code=local_module('gpuq_personal_oci','personal-oci.py').run_project(cfg,{**spec,"id":jid},project,interactive,uuids,workfd,project_fds,dataset_fds,datafd,runtimefd,resourcefd,cgroupfd,stderr_sink=None if terminal else capture.stderr)
            return code
        finally:
            for fd in [workfd,cgroupfd,resourcefd,*project_fds.values(),*(fd for fd,_ in dataset_fds),*([datafd] if datafd is not None else []),*([datalock] if datalock is not None else [])]:os.close(fd)


if __name__ == "__main__":sys.exit(main())
