#!/usr/bin/python3
"""GPUQ-owned job process. Mount only assigned devices and one user's workspace."""
import hashlib,importlib.util,json,os,re,select,subprocess,sys,time,tempfile
sys.dont_write_bytecode=True  # Retain the same immutable runtime boundary as ray-p0.
from pathlib import Path
HERE=Path(__file__).resolve().parent
TRAINING_CONTROL_PROTOCOL=1
GPU_ALLOCATION_PROTOCOL=2
SHARED_DATA_DIRECTORIES_PROTOCOL=1

def sandbox_information(descriptor,timeout=12,maximum=4096):
    """--info-fd is a stream: bubblewrap writes JSON fields separately."""
    deadline=time.monotonic()+timeout;raw=bytearray()
    try:
        while True:
            remaining=deadline-time.monotonic()
            if remaining<=0 or not select.select([descriptor],[],[],remaining)[0]:
                raise RuntimeError('Sandbox startup timed out')
            chunk=os.read(descriptor,maximum+1-len(raw))
            if not chunk:break
            raw.extend(chunk)
            if len(raw)>maximum:raise ValueError('Sandbox startup information exceeds limit')
        try:information=json.loads(raw)
        except (ValueError,UnicodeError) as error:raise ValueError('Invalid sandbox startup information') from error
        if not isinstance(information,dict) or type(information.get('child-pid')) is not int or not 0<information['child-pid']<=2147483647:
            raise ValueError('Invalid sandbox child PID')
        return information
    finally:os.close(descriptor)

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
    except Exception as error:
        print('GPUQ diagnostics unavailable:',str(error),file=sys.stderr)
        return None,None,None

def finish_job_capture(module,root,spec,identifier,exit_code):
    if module is None:return
    try:module.finish_capture(root,spec,identifier,exit_code)
    except Exception as error:print('GPUQ diagnostic finalization unavailable:',str(error),file=sys.stderr)

def open_dataset_mounts(spec):
    if not spec.get('datasets'):return []
    module=importlib.util.spec_from_file_location('gpuq_node_datasets',HERE/'node-executor.py')
    executor=importlib.util.module_from_spec(module);module.loader.exec_module(executor)
    return executor.dataset_open_mounts(spec)

def open_input_mounts(cfg,spec,terminal):
    mounts=[] if terminal else open_dataset_mounts(spec)
    try:
        if 'sharedDataDirectories' in cfg:
            mounts+=local_module('gpuq_shared_data','shared-data.py').open_mounts(cfg)
        return mounts
    except BaseException:
        for fd,_ in mounts:os.close(fd)
        raise

def open_data_workspace(spec,jid,terminal):
    if not spec.get('dataWorkspace'):return None,None
    if not terminal:raise ValueError('Mutable data workspace is only available to personal terminals')
    module=importlib.util.spec_from_file_location('gpuq_node_data_workspace',HERE/'node-executor.py')
    executor=importlib.util.module_from_spec(module);module.loader.exec_module(executor)
    return executor.data_workspaces().terminal_mount(spec,jid)

def project_runtime(spec,root,cfg,jid,terminal):
    """Old jobs never enter this branch or acquire new default spec fields."""
    if not spec.get('project'):return None
    module=importlib.util.spec_from_file_location('gpuq_project_store',HERE/'project-store.py')
    store_module=importlib.util.module_from_spec(module);sys.modules[module.name]=store_module;module.loader.exec_module(store_module)
    store=store_module.ProjectStore(root,cfg['conda'],reserve_bytes=store_module.workspace_reserve_bytes(cfg),config=cfg)
    if terminal:
        paths=store.dev_paths(spec['userId'],spec['project'])
        return {**paths,'output':paths['scratch'],'readonly':False,'environmentMode':store.environment_mode(spec['userId'],spec['project'])}
    release=store.release(spec['userId'],spec['project'],spec['release'])
    return {**release,**store.run_paths(spec['userId'],spec['project'],spec['release'],jid),'readonly':True,'environmentMode':release['meta'].get('environmentMode','shared')}

def project_path(mode,resources=False):
    if mode not in ('shared','isolated'):raise ValueError('Invalid project environment mode')
    return '/opt/project-env/bin:'+('/opt/gpuq/bin:' if resources else '')+('/opt/conda/bin:' if mode=='shared' else '')+'/usr/bin:/bin'

def project_bootstrap(command,mode):
    if mode not in ('shared','isolated'):raise ValueError('Invalid project environment mode')
    # Runs only inside the project sandbox. Never rewrite an initialized venv.
    bootstrap='''import fcntl,os,pathlib,stat,subprocess,sys
mode=sys.argv[1]
root=pathlib.Path('/opt/project-env')
p=root/'pyvenv.cfg'
lock=os.open('/home/gpuq/.gpuq-env-init.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
try:
    info=os.fstat(lock)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise RuntimeError('Unsafe environment initialization lock')
    fcntl.flock(lock,fcntl.LOCK_EX)
    if not p.exists() and not p.is_symlink():
        if any(root.iterdir()):raise RuntimeError('Project environment is not empty; inspect it or create a new project, no automatic reinstall was attempted')
        subprocess.run(['/opt/conda/bin/python','-m','venv',*(['--system-site-packages'] if mode=='shared' else []),'--copies',str(root)],check=True)
    if mode=='isolated':
        fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size>65536:raise RuntimeError('Invalid project venv configuration')
            config=os.read(fd,65537).decode('utf-8')
        finally:os.close(fd)
        values=[line.split('=',1)[1].strip().lower() for line in config.splitlines() if '=' in line and line.split('=',1)[0].strip().lower()=='include-system-site-packages']
        if values!=['false']:raise RuntimeError('Isolated project venv must disable system site packages; no automatic reinstall was attempted')
finally:os.close(lock)
os.execvpe(sys.argv[2],sys.argv[2:],os.environ)
'''
    return ['/usr/bin/python3','-c',bootstrap,mode,*command]

def workspace_admission(cfg,root):
    # Recheck when a queued job actually starts, before untrusted execution.
    # Host-root terminals do not use this sandbox runner. No periodic policing.
    if 'workspaceReserveBytes' not in cfg:return
    module=local_module('gpuq_workspace_storage','project-store.py')
    module.require_workspace_space(root,module.workspace_reserve_bytes(cfg))

def main():
    jid=sys.argv[1]
    if not re.fullmatch(r'[a-f0-9-]{36}',jid):raise ValueError('Invalid job ID')
    cfg=json.loads((HERE/'node-config.json').read_text());root=Path(cfg['root'])
    local_module('gpuq_platform_root_guard','platform-root-guard.py').check(root)
    terminal=len(sys.argv)>2 and sys.argv[2]=='terminal'
    spec=json.loads((root/('terminals' if terminal else 'jobs')/f'{jid}.json').read_text())
    workspace_admission(cfg,root)
    indices=os.environ.get('GPUQ_ASSIGNED_GPU_INDICES','').split(',')
    uuids=os.environ.get('GPUQ_ASSIGNED_GPU_UUIDS','').split(',')
    if terminal:indices=[];uuids=[]
    else:runtime_spec=local_module('gpuq_allocation','scheduling-policy.py').allocated_spec(spec,indices,uuids,cfg,os.environ)
    if not terminal:
        devices=local_module('gpuq_gpu_devices','gpu-devices.py').device_paths(uuids)
        memory=subprocess.check_output(['/usr/bin/nvidia-smi','--id',','.join(uuids),'--query-gpu=memory.total','--format=csv,noheader,nounits'],text=True)
        sizes=[int(line.strip()) for line in memory.splitlines()]
        if len(sizes)!=len(indices) or any(size<spec.get('minVramGiB',0)*1024-512 for size in sizes):raise ValueError('Allocated GPU memory does not meet request')
    # Apply limits BEFORE any untrusted code runs, inside the original GPUQ unit.
    group=next(line.split(':',2)[2].strip() for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    unit=group.rsplit('/',1)[-1]
    if not unit.startswith('amax-term-' if terminal else 'gpuq-') or not unit.endswith('.service'):raise ValueError('Not running inside an authorized job unit')
    env={'PATH':'/usr/bin:/bin','HOME':str(Path.home()),'XDG_RUNTIME_DIR':f'/run/user/{os.getuid()}','DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{os.getuid()}/bus'}
    subprocess.run(['/usr/bin/systemctl','--user','set-property','--runtime',unit,f'MemoryMax={8 if terminal else runtime_spec["cards"]*32}G',f'CPUQuota={200 if terminal else runtime_spec["cards"]*400}%','TasksMax=2048'],env=env,check=True)
    if not terminal and 'storageQuota' in cfg:local_module('gpuq_storage_quota','storage-quota.py').ensure_attempt(cfg,spec,os.environ)
    capture_module,capture_id,runtimefd=(None,None,None) if terminal else start_job_capture(root,spec,unit,group,env,indices,uuids)
    workspace=root/'users'/hashlib.sha256(spec['userId'].encode()).hexdigest()[:32]
    workspace.mkdir(parents=True,exist_ok=True,mode=0o700)
    if 'storageQuota' in cfg:local_module('gpuq_storage_quota','storage-quota.py').ensure(cfg,spec['userId'],workspace)
    project=project_runtime(spec,root,cfg,jid,terminal)
    if project:workspace=project['code']
    # Mount by open FD to pin the directory and avoid a path replacement race.
    workfd=os.open(workspace,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    project_fds={name:os.open(project[name],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW) for name in ('env','home','output')} if project else {}
    dataset_fds=open_input_mounts(cfg,spec,terminal)
    datafd,datalock=open_data_workspace(spec,jid,terminal)
    if project and project['environmentMode']=='oci':
        try:
            code=local_module('gpuq_personal_oci','personal-oci.py').run_project(cfg,spec,project,terminal,uuids,workfd,project_fds,dataset_fds,datafd,runtimefd)
            finish_job_capture(capture_module,root,spec,capture_id,code)
            return code
        finally:
            for fd in [workfd,*project_fds.values(),*(fd for fd,_ in dataset_fds),*([datafd] if datafd is not None else []),*([runtimefd] if runtimefd is not None else []),*([datalock] if datalock is not None else [])]:os.close(fd)
    info_r,info_w=os.pipe();block_r,block_w=os.pipe()
    args=['/usr/bin/bwrap','--unshare-all',*([] if terminal else ['--new-session']),'--die-with-parent','--cap-drop','ALL','--hostname','gpuq-job',
          '--info-fd',str(info_w),'--block-fd',str(block_r),'--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/sbin','/sbin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
          '--proc','/proc','--ro-bind','/proc/driver/nvidia','/proc/driver/nvidia','--ro-bind','/sys','/sys','--dev','/dev','--tmpfs','/dev/shm','--tmpfs','/tmp','--tmpfs','/run','--dir','/etc',
          '--ro-bind','/etc/ld.so.cache','/etc/ld.so.cache','--ro-bind','/etc/alternatives','/etc/alternatives','--ro-bind','/etc/ssl','/etc/ssl',
          '--ro-bind-fd' if project and project['readonly'] else '--bind-fd',str(workfd),'/workspace','--chdir','/workspace','--clearenv']
    if project:
        args+=['--ro-bind-fd' if project['readonly'] else '--bind-fd',str(project_fds['env']),'/opt/project-env',
               '--bind-fd',str(project_fds['home']),'/home/gpuq','--bind-fd',str(project_fds['output']),'/outputs']
    args+=['--dir','/opt/gpuq','--dir','/opt/gpuq/bin',
           '--ro-bind',str(HERE/'gpuq-network'),'/opt/gpuq/bin/gpuq-network']
    if runtimefd is not None:args+=['--dir','/run/gpuq','--bind-fd',str(runtimefd),'/run/gpuq/runtime']
    if dataset_fds:
        args+=['--dir','/data2','--dir','/datasets']
        for descriptor,target in dataset_fds:args+=['--ro-bind-fd',str(descriptor),target]
    if datafd is not None:
        args+=['--bind-fd',str(datafd),'/data2','--chdir','/data2','--setenv','GPUQ_DATA_WORKSPACE','/data2']
    for source in ([] if terminal else ['/dev/nvidiactl','/dev/nvidia-uvm','/dev/nvidia-uvm-tools']+devices):
        if not Path(source).exists():raise ValueError('Allocated GPU device missing')
        args+=['--dev-bind',source,source]
    # Read-only Python distribution; host home, SSH keys, sockets and other data are absent.
    conda=cfg['conda'];args+=['--ro-bind',conda,'/opt/conda']
    if conda!='/opt/conda':args+=['--ro-bind',conda,conda]
    # Namespace NUMA support can differ across ranks; force a consistent shared
    # memory backend instead of NCCL's per-rank cuMem-host fallback (2.28.9).
    args+=['--setenv','NCCL_CUMEM_HOST_ENABLE','0']
    if terminal:args+=['--setenv','TERM','xterm-256color','--setenv','PS1',spec['username']+'@'+cfg.get('machine','gpu')+r':\w\$ ']
    # Both names identify the same job so existing training scripts keep working.
    for key,value in {'PATH':'/opt/conda/bin:/usr/bin:/bin','HOME':'/workspace','USER':spec['username'],'LOGNAME':spec['username'],'LANG':'C.UTF-8','PYTHONUNBUFFERED':'1','PYTHONUSERBASE':'/workspace/.local','OMP_NUM_THREADS':'1','SSL_CERT_FILE':'/etc/ssl/certs/ca-certificates.crt','CURL_CA_BUNDLE':'/etc/ssl/certs/ca-certificates.crt','REQUESTS_CA_BUNDLE':'/etc/ssl/certs/ca-certificates.crt','CUDA_VISIBLE_DEVICES':','.join(uuids),'NVIDIA_VISIBLE_DEVICES':','.join(uuids),'GPUQ_JOB_ID':jid,'AMAX_JOB_ID':jid}.items():args+=['--setenv',key,value]
    # CUDA re-enumerates the mounted device subset. A host UUID visibility filter
    # can mask that subset on some drivers; device mounts, not env vars, enforce it.
    args+=['--unsetenv','CUDA_VISIBLE_DEVICES']
    if project:
        for key,value in {'PATH':project_path(project['environmentMode'],resources=True),'HOME':'/home/gpuq',
                          'VIRTUAL_ENV':'/opt/project-env','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1',
                          'PIP_REQUIRE_VIRTUALENV':'true','GPUQ_PROJECT':spec['project'],
                          'GPUQ_PROJECT_RELEASE':spec.get('release','development'),'GPUQ_OUTPUT_DIR':'/outputs',
                          'XDG_CACHE_HOME':'/home/gpuq/.cache','GPUQ_PROJECT_ENV_MODE':project['environmentMode'],
                          'GPUQ_OFFLINE_ASSETS':'/workspace/offline'}.items():args+=['--setenv',key,value]
        args+=['--unsetenv','PYTHONUSERBASE']
    else:args+=['--setenv','PATH','/opt/gpuq/bin:/opt/conda/bin:/usr/bin:/bin']
    if runtimefd is not None:
        # Persist only managed Ray logs; object spill stays in job-private tmpfs.
        for key,value in {'RAY_TMPDIR':'/run/gpuq/runtime','GPUQ_RAY_TEMP_DIR':'/run/gpuq/runtime/ray',
                          'RAY_object_spilling_directory':'/tmp/gpuq-ray-spill'}.items():args+=['--setenv',key,value]
    # Do not forward to the host's loopback-only resolved stub: host loopback is
    # intentionally inaccessible to jobs. Use the current real uplink resolvers.
    resolvers=[]
    for path in ['/run/systemd/resolve/resolv.conf','/etc/resolv.conf']:
        if Path(path).exists():
            for line in Path(path).read_text().splitlines():
                fields=line.split()
                if len(fields)>=2 and fields[0]=='nameserver' and not fields[1].startswith(('127.','::1')) and fields[1] not in resolvers:resolvers.append(fields[1])
        if resolvers:break
    if not resolvers:raise RuntimeError('No non-loopback uplink DNS configured')
    resolv=os.memfd_create('resolv');os.write(resolv,(''.join('nameserver '+ip+'\n' for ip in resolvers[:3])).encode());os.lseek(resolv,0,0)
    passwd=os.memfd_create('passwd');os.write(passwd,f'{spec["username"]}:x:{os.getuid()}:{os.getgid()}:GPUQ user:{"/home/gpuq" if project else "/workspace"}:/bin/bash\n'.encode());os.lseek(passwd,0,0)
    hosts=os.memfd_create('hosts');os.write(hosts,b'127.0.0.1 localhost gpuq-job\n::1 localhost\n');os.lseek(hosts,0,0)
    # EOF on bwrap's block-fd also unblocks it. The independent readiness gate makes
    # a failed network setup fail closed rather than briefly starting the job.
    gatefile=tempfile.NamedTemporaryFile(prefix='.gate-',dir=root);gatefile.write(b'0');gatefile.flush();ready=gatefile.fileno()
    gate='import os,sys; ready=open("/run/.ready","rb").read(1); sys.exit(125) if ready!=b"1" else os.execvpe(sys.argv[1],sys.argv[1:],os.environ)'
    command=spec['argv']
    if project and terminal:
        # Trusted bootstrap executes only INSIDE the namespace, with no GPU and
        # no host workspace/credentials. Never run package hooks on the host.
        command=project_bootstrap(command,project['environmentMode'])
    control_args,control_fds=([],[]) if terminal or not cfg.get('controlRoot') else local_module('gpuq_training_control','training-control.py').prepare(cfg,spec,workspace,project,os.environ)
    args+=control_args+['--ro-bind',gatefile.name,'/run/.ready','--ro-bind-data',str(hosts),'/etc/hosts','--ro-bind-data',str(passwd),'/etc/passwd','--ro-bind-data',str(resolv),'/etc/resolv.conf','--','/usr/bin/python3','-c',gate,*command]
    try:process=subprocess.Popen(args,pass_fds=(info_w,block_r,workfd,resolv,passwd,hosts,*control_fds,*(() if runtimefd is None else (runtimefd,)),*(() if datafd is None else (datafd,)),*project_fds.values(),*(fd for fd,_ in dataset_fds)))
    finally:
        for descriptor in control_fds:os.close(descriptor)
        for descriptor,_ in dataset_fds:os.close(descriptor)
        if datafd is not None:os.close(datafd)
        for descriptor in project_fds.values():os.close(descriptor)
        if runtimefd is not None:os.close(runtimefd)
    os.close(info_w);os.close(block_r);os.close(workfd);os.close(resolv);os.close(passwd);os.close(hosts)
    network=None
    try:
        information=sandbox_information(info_r)
        ready_r,ready_w=os.pipe()
        network=subprocess.Popen([cfg.get('slirp','/usr/bin/slirp4netns'),'--configure','--disable-host-loopback','--enable-seccomp','--ready-fd',str(ready_w),str(information['child-pid']),'tap0'],pass_fds=(ready_w,),env={**env,'LD_LIBRARY_PATH':str(HERE/'netlib')},stdout=subprocess.DEVNULL)
        os.close(ready_w)
        if not select.select([ready_r],[],[],12)[0] or os.read(ready_r,1)!=b'1':raise RuntimeError('Sandbox networking unavailable')
        os.close(ready_r);os.pwrite(ready,b'1',0);os.write(block_w,b'1');os.close(block_w)
        code=process.wait()
        if capture_module is not None:finish_job_capture(capture_module,root,spec,capture_id,code)
        return code
    finally:
        if process.poll() is None:process.kill();process.wait()
        gatefile.close()
        if network and network.poll() is None:network.terminate();network.wait(timeout=5)
        if datalock is not None:os.close(datalock)

if __name__=='__main__':
    try:sys.exit(main())
    except Exception as e:print('GPUQ sandbox:',str(e),file=sys.stderr);sys.exit(125)
