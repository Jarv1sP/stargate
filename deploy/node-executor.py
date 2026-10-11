#!/usr/bin/python3
"""Forced command. Fixed GPUQ wrapper; user commands only run inside the sandbox."""
import base64, fcntl, hashlib, importlib.util, json, math, os, re, select, sqlite3, stat, subprocess, sys, socket, tempfile, time, uuid
sys.dont_write_bytecode=True  # Immutable cohorts must retain their exact file manifest.
from pathlib import Path
from contextlib import closing
from types import SimpleNamespace
HERE=Path(__file__).resolve().parent
INITIAL_CONFIG_BYTES=(HERE/'node-config.json').read_bytes()
CONFIG=json.loads(INITIAL_CONFIG_BYTES)
ROOT=Path(CONFIG['root'])
RUNTIME=f'/run/user/{os.getuid()}'
ENV={'PATH':'/usr/bin:/bin','HOME':str(Path.home()),'LANG':'C.UTF-8','XDG_RUNTIME_DIR':RUNTIME,'DBUS_SESSION_BUS_ADDRESS':'unix:path='+RUNTIME+'/bus'}
UUID=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
DATASET_ID=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
DATASET_VERSION=re.compile(r'^[a-f0-9]{64}$')
DATASET_MODULE=None
DATASET_UPLOADS=None
TRAINING_DATASET_UPLOADS=None
DATA_WORKSPACES=None
DATA_IMPORTS=None
CLOUD_FILES=None
PROJECT_OPS=None
STORAGE_NODE=None
STORAGE_AUTHORITY=None
STORAGE_AUTHORITY_MODULE=None
STORAGE_ARCHIVE=None
STORAGE_LEASES=None
STORAGE_WAREHOUSE=None
DATASET_TRAINING_SOURCES=None
ADMIN_COMMAND=None
HOST_COMMAND_CAPABILITY='host-command-v1'
DATASET_DELETE_CAPABILITY='dataset-delete-v1'
TASK_DISPLAY_CAPABILITY='console-task-display-v1'
TASK_DISPLAY_EDIT_CAPABILITY='console-task-display-edit-v1'
UPLOAD_INGRESS_OPERATIONS=('storage.upload.admit','storage.upload.locate',
    'datasets.upload.begin','datasets.upload.manifest','datasets.upload.seal','datasets.upload.status',
    'datasets.upload.chunk','datasets.upload.commit','datasets.upload.discard','datasets.upload.pause',
    'datasets.upload.routes','datasets.upload.direct-ticket','datasets.upload.direct-revoke')
DIAGNOSTICS=None
PLATFORM_ROOT_GUARD=None
WORKSPACE_STORAGE=None
policy_module=importlib.util.spec_from_file_location('gpuq_console_scheduling',HERE/'scheduling-policy.py')
SCHEDULING=importlib.util.module_from_spec(policy_module);policy_module.loader.exec_module(SCHEDULING)
PRIORITIES=SCHEDULING.PRIORITY_PRESETS
PRIORITY_RANKS={'idle':0,'normal':2,'high':4,**{'P'+str(i):i for i in range(5)}}

def platform_root_check():
    global PLATFORM_ROOT_GUARD
    if PLATFORM_ROOT_GUARD is None:
        spec=importlib.util.spec_from_file_location('gpuq_platform_root_guard',HERE/'platform-root-guard.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        PLATFORM_ROOT_GUARD=module
    return PLATFORM_ROOT_GUARD.check(ROOT)

def require_upload_ingress_operation(operation):
    # A distinct fixed key may force only this mode in an immutable runtime
    # directory. Neither the client JSON nor shared old config enables it.
    if operation not in UPLOAD_INGRESS_OPERATIONS:
        raise ValueError('Invalid dedicated dataset upload ingress operation')

def workspace_storage_check(needed=0, *, target_fd=None, admission=False):
    """Only configured nodes gain new-start admission; controls stay available."""
    global WORKSPACE_STORAGE
    if 'workspaceReserveBytes' not in CONFIG:
        if admission:return
        # Preserve legacy policy and minimal legacy runtime dependencies. The
        # write caller supplies an already-open no-follow directory descriptor.
        space=os.statvfs(target_fd if target_fd is not None else ROOT)
        if space.f_bavail*space.f_frsize<10*1024**3+needed:raise ValueError('Workspace disk reserve reached')
        return
    if WORKSPACE_STORAGE is None:
        spec=importlib.util.spec_from_file_location('gpuq_workspace_storage',HERE/'project-store.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        WORKSPACE_STORAGE=module
    WORKSPACE_STORAGE.require_workspace_space(ROOT,WORKSPACE_STORAGE.workspace_reserve_bytes(CONFIG),needed,target_fd=target_fd)

def job_diagnostics(job,data):
    global DIAGNOSTICS
    if DIAGNOSTICS is None:
        spec=importlib.util.spec_from_file_location('gpuq_job_diagnostics',HERE/'job-diagnostics.py')
        DIAGNOSTICS=importlib.util.module_from_spec(spec);spec.loader.exec_module(DIAGNOSTICS)
    return DIAGNOSTICS.bundle(ROOT,job,data)

def job_observation(job,data,expected_node_id):
    spec=importlib.util.spec_from_file_location('gpuq_job_observation',HERE/'job-observation.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.observe(ROOT,CONFIG['database'],job,data,expected_node_id)

def dispatch_observation(job):
    spec=importlib.util.spec_from_file_location('gpuq_job_observation',HERE/'job-observation.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.observe_dispatch(ROOT,CONFIG['database'],job)

def job_log_result(job,data,text):
    try:
        package=job_diagnostics(job,data)
        footer=DIAGNOSTICS.summary(package)
    except Exception:
        footer='\n\n[GPUQ 诊断暂不可用；不据此判断 worker 健康或改变任务终态]\n查看：gpuctl diagnostics '+job['id']+' --json\n'
    return {'text':text+footer}

def host_command(operation,args):
    global ADMIN_COMMAND
    if ADMIN_COMMAND is None:
        spec=importlib.util.spec_from_file_location('gpuq_admin_command',HERE/'admin-command.py')
        ADMIN_COMMAND=importlib.util.module_from_spec(spec);sys.modules[spec.name]=ADMIN_COMMAND;spec.loader.exec_module(ADMIN_COMMAND)
    return ADMIN_COMMAND.process(CONFIG,operation,args)

def priority_capability(rank_only=False):
    capabilities=gpu('status').get('daemon',{}).get('capabilities',[])
    if not isinstance(capabilities,list) or not all(c in capabilities for c in ('priority-policy-v1','preempt-idle-only-v1')):
        raise ValueError('Scheduler priority capability is not available; no policy was changed')
    if rank_only and 'priority-rank-v1' not in capabilities:
        raise ValueError('Scheduler rank-only capability is not available; refusing a policy-changing fallback')

def scheduling_status(job,data):
    state=data.get('job',data);attempts=data.get('attempts',[])
    policy={k:state.get(k) for k in ('priority','yield_policy','restart_policy','dispatch_mode')}
    priority=next((name for name,level in PRIORITY_RANKS.items() if policy['priority']==level),None)
    # Classification never rewrites an old task. Editing is only enabled for
    # explicit new Console jobs whose persistent scheduler scope is verified.
    verified=job.get('preemptIdleOnly') is True and state.get('preempt_idle_only') is True
    if 'scheduling' in job:
        submitted=SCHEDULING.normalize_job_policy(job)
        # Rank is deliberately excluded: previous rank-only edits leave the
        # immutable submission unchanged. Verify the rest of the contract.
        verified=(all(state.get(key)==submitted[key] for key in ('yield_policy','restart_policy','dispatch_mode'))
                  and state.get('checkpoint_capability')==('epoch-v1' if submitted['checkpointable'] else 'none')
                  and state.get('preempt_idle_only') is submitted['preempt_idle_only']
                  and state.get('preempt_opt_in_only',False) is submitted.get('preempt_opt_in_only',False))
    mutable=state.get('state')=='PENDING' and verified
    opted_in='scheduling' in job or (job.get('preemptIdleOnly') is True and state.get('preempt_idle_only') is True)
    return {'schedulerState':state.get('state'),'schedulerPriority':state.get('priority'),
            'priority':priority,'schedulerPolicy':policy,'priorityMutable':mutable,
            'queueReason':state.get('state_reason'),
            'progress':data.get('progress'),
            'latestAttempt':({k:attempts[0].get(k) for k in ('id','ordinal','state','exit_code','failure_reason','started_at','finished_at')} if attempts else None),
            'preempted':opted_in and state.get('state')=='CANCELED' and bool(attempts) and attempts[0].get('state')=='PREEMPTED'}

def projects():
    global PROJECT_OPS
    if PROJECT_OPS is None:
        spec=importlib.util.spec_from_file_location('gpuq_project_operations',HERE/'project-ops.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        # Works both when imported for tests/runner and as the forced command.
        PROJECT_OPS=module.ProjectOperations(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    return PROJECT_OPS

def atomic_json(path,data):
    fd,name=tempfile.mkstemp(prefix='.write-',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as stream:json.dump(data,stream);stream.flush();os.fsync(stream.fileno())
        os.replace(name,path)
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(name):os.unlink(name)

def dataset_mount_check(config):
    point=config.get('mountPoint','/data2');cache=config.get('root','/data2/datasets')
    for path in (point,cache):
        if not isinstance(path,str) or not path.startswith('/') or '..' in Path(path).parts or str(Path(path))!=path:raise ValueError('Invalid dataset storage path')
    if point=='/' or Path(point) not in Path(cache).parents:raise ValueError('Dataset cache must be below its required data mount')
    # Exact mountpoint and a different device from /: directory existence alone
    # must never silently redirect dataset writes to a root-disk fallback.
    entries=[]
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left,right=line.split(' - ',1);a=left.split();b=right.split()
        target=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),a[4])
        entries.append((target,a[2],a[5].split(','),b[0]))
    root=next((entry for entry in reversed(entries) if entry[0]=='/'),None)
    mounted=next((entry for entry in reversed(entries) if entry[0]==point),None)
    if not root or not mounted or mounted[1]==root[1] or 'ro' in mounted[2] or mounted[3] not in ('ext4','xfs','btrfs','zfs'):
        raise ValueError('Required local dataset mount is unavailable; refusing root-disk fallback')
    # No symlink in the storage prefix, including ancestors.
    cursor=Path('/')
    for part in Path(cache).parts[1:-1]:
        cursor/=part
        if not stat.S_ISDIR(cursor.lstat().st_mode):raise ValueError('Dataset storage ancestors must be real directories')

def dataset_cache():
    global DATASET_MODULE
    config=CONFIG.get('datasets')
    if not isinstance(config,dict) or set(config)-{'root','mountPoint','sources','reserveBytes','uploads','retireRetentionDays','archiveUpload'}:raise ValueError('Dataset storage is not configured')
    dataset_mount_check(config)
    if DATASET_MODULE is None:
        module=importlib.util.spec_from_file_location('gpuq_dataset_cache',HERE/'dataset-cache.py')
        DATASET_MODULE=importlib.util.module_from_spec(module);sys.modules[module.name]=DATASET_MODULE;module.loader.exec_module(DATASET_MODULE)
    policy=CONFIG.get('storageTier',{'enabled':False})
    if (not isinstance(policy,dict) or set(policy)-{'enabled','budgetBytes','highWater','lowWater'}
            or type(policy.get('enabled',False)) is not bool):raise ValueError('Invalid trusted dataset cache policy')
    budget=policy.get('budgetBytes') if policy.get('enabled',False) else None
    if policy.get('enabled',False) and (type(budget) is not int or not 0<budget<=2**63-1):raise ValueError('Enabled cache policy requires a positive dataset budget')
    reserve=config.get('reserveBytes',10*1024**3)
    cache=DATASET_MODULE.DatasetCache(config.get('root','/data2/datasets'),sources=config.get('sources',{}),reserve_bytes=reserve,mount_point=config.get('mountPoint','/data2'),budget_bytes=budget)
    if 'workspaceReserveBytes' in CONFIG:
        shared_reserve=CONFIG['workspaceReserveBytes']
        if type(shared_reserve) is not int or not 0<=shared_reserve<=2**63-1:raise ValueError('Invalid workspace free-space reserve')
        # Bind aliases share one volume; its workspace reserve cannot be
        # bypassed by a smaller dataset-specific reserve. Separate HDD storage
        # keeps its own reserve, never adds SSD and HDD capacity together.
        with DATASET_MODULE._directory(ROOT) as workspace:
            if os.fstat(workspace).st_dev==cache._root_identity[0]:cache.reserve_bytes=max(reserve,shared_reserve)
    # Lazy to avoid the storage-node constructor calling dataset_cache again.
    # Only configured, sealed authorities can prove a cache is replaceable.
    cache.rebuild_guard=dataset_rebuild_guard
    if 'storageQuota' in CONFIG:
        def quota_guard(actor,dataset,path):
            spec=importlib.util.spec_from_file_location('gpuq_dataset_quota',HERE/'storage-quota.py')
            quota=importlib.util.module_from_spec(spec);spec.loader.exec_module(quota)
            if not quota.scope(CONFIG)['enabled']:return
            owners=cache._dataset(actor,dataset)['owners']
            owner=quota.dataset_owner(CONFIG,actor.user_id,owners)
            if owner is not None:return storage_quota(owner,path)
        cache.quota_guard=quota_guard
    return DATASET_MODULE,cache


def dataset_cache_admission(needed_bytes=0, *, _exclude=()):
    """Private no-delete preflight; explicit administrative collection is separate.

    This check never treats reclaimable bytes as free. Publication still performs
    its atomic live budget/reservation checks; no preparation implicitly evicts
    another user's copy to make room, including detached peer/warehouse workers.
    """
    module,cache=dataset_cache()
    if type(needed_bytes) is not int or not 0<=needed_bytes<=2**63-1:raise ValueError('Invalid cache preparation footprint')
    if cache.budget_bytes is None:return {'enabled':False,'state':'DISABLED'}
    if needed_bytes>cache.budget_bytes:
        raise ValueError(f'Dataset exceeds cache budget: requestedBytes={needed_bytes}, budgetBytes={cache.budget_bytes}; keep the original in the data warehouse')
    if not isinstance(_exclude,tuple) or len(_exclude)>1:raise ValueError('Invalid cache admission exclusion')
    except_stage=None
    if _exclude:
        dataset,version=_exclude[0]
        module._identifier(dataset);module._identifier(version,module.HASH_RE)
        if needed_bytes:except_stage=cache._paths(dataset,version)['.staging']
    with cache._locked():
        cache._budget(needed_bytes,except_stage=except_stage)
        additional=needed_bytes
        if except_stage is not None and cache._version_entry_exists(except_stage):
            # Existing stage remaining bytes are already in _reserved; written
            # payload already reduced kernel free space. Never charge it twice.
            transfer=cache._transfer(except_stage)
            additional=max(0,needed_bytes-transfer['totalBytes'])
        cache._free(cache._reserved()+additional)
    return {'enabled':True,'state':'CHECKED','reclaimedBytes':0}


def dataset_rebuild_guard(actor,dataset,version):
    spec=importlib.util.spec_from_file_location('gpuq_dataset_rebuild_proof',HERE/'dataset-rebuild-proof.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    return helper.configured_guard(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()),actor,dataset,version)

def storage_warehouse():
    global STORAGE_WAREHOUSE
    if CONFIG.get('storageWarehouse') is None:return None
    if STORAGE_WAREHOUSE is None:
        spec=importlib.util.spec_from_file_location('gpuq_fixed_warehouse',HERE/'storage-warehouse.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        STORAGE_WAREHOUSE=module.Warehouse(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    return STORAGE_WAREHOUSE


def dataset_upload_location_cache():
    """Private locate only: validate existing storage, never initialize it."""
    global DATASET_MODULE
    config=CONFIG.get('datasets')
    if not isinstance(config,dict) or set(config)-{'root','mountPoint','sources','reserveBytes','uploads','retireRetentionDays','archiveUpload'}:
        raise ValueError('Dataset storage is not configured')
    if CONFIG.get('storageWarehouse') is not None:
        spec=importlib.util.spec_from_file_location('gpuq_location_warehouse_policy',HERE/'storage-warehouse.py')
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        config=helper.policy(SimpleNamespace(CONFIG=CONFIG))
    dataset_mount_check(config)
    if DATASET_MODULE is None:
        spec=importlib.util.spec_from_file_location('gpuq_dataset_cache',HERE/'dataset-cache.py')
        DATASET_MODULE=importlib.util.module_from_spec(spec);sys.modules[spec.name]=DATASET_MODULE;spec.loader.exec_module(DATASET_MODULE)
    cache=DATASET_MODULE.DatasetCache.__new__(DATASET_MODULE.DatasetCache)
    cache.root=DATASET_MODULE._absolute(config.get('root','/data2/datasets'))
    cache.mount_point=DATASET_MODULE._absolute(config.get('mountPoint','/data2'))
    cache.mount=cache._current_mount()
    with DATASET_MODULE._directory(cache.root) as root:
        info=os.fstat(root);cache._root_identity=info.st_dev,info.st_ino
    return DATASET_MODULE,cache



def dataset_source_cache(dataset=None,version=None):
    warehouse=storage_warehouse()
    if warehouse is not None:
        if dataset is None or (warehouse.cold._paths(dataset)['.registry']/'dataset.json').exists():
            dataset_mount_check(warehouse.config)
            return warehouse.d,warehouse.cold
    return dataset_cache()


def dataset_rebuild_guard_for(executor,actor,dataset,version):
    spec=importlib.util.spec_from_file_location('gpuq_fixed_rebuild_proof',HERE/'dataset-rebuild-proof.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.configured_guard(executor,actor,dataset,version)


def dataset_ingress_view():
    warehouse=storage_warehouse()
    return warehouse.view if warehouse is not None else (sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))


def dataset_uploads():
    global DATASET_UPLOADS
    if DATASET_UPLOADS is None:
        spec=importlib.util.spec_from_file_location('gpuq_dataset_upload',HERE/'dataset-upload.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        DATASET_UPLOADS=module.DatasetUploads(dataset_ingress_view())
    # Revalidate the current data mount even for compact upload status requests.
    dataset_mount_check(DATASET_UPLOADS.n.CONFIG['datasets'])
    return DATASET_UPLOADS


def dataset_training_uploads():
    """Private fixed-cache adapter; public uploads always keep HDD ingress."""
    global TRAINING_DATASET_UPLOADS
    warehouse=storage_warehouse()
    if warehouse is None:
        raise ValueError('A separate warehouse/cache is not configured')
    dataset_mount_check(CONFIG['datasets'])
    if TRAINING_DATASET_UPLOADS is None:
        spec=importlib.util.spec_from_file_location('gpuq_training_dataset_upload',HERE/'dataset-upload.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        TRAINING_DATASET_UPLOADS=module.DatasetUploads(warehouse.cache_view)
    return TRAINING_DATASET_UPLOADS

def data_workspaces():
    global DATA_WORKSPACES
    if DATA_WORKSPACES is None:
        spec=importlib.util.spec_from_file_location('gpuq_data_workspaces',HERE/'data-workspace.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        DATA_WORKSPACES=module.DataWorkspaces(dataset_ingress_view())
    dataset_mount_check(DATA_WORKSPACES.n.CONFIG['datasets'])
    return DATA_WORKSPACES

def data_imports():
    global DATA_IMPORTS
    if DATA_IMPORTS is None:
        spec=importlib.util.spec_from_file_location('gpuq_data_import',HERE/'data-import.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        DATA_IMPORTS=module.DataImports(dataset_ingress_view())
    dataset_mount_check(DATA_IMPORTS.n.CONFIG['datasets'])
    return DATA_IMPORTS

def cloud_files():
    global CLOUD_FILES
    if CLOUD_FILES is None:
        spec=importlib.util.spec_from_file_location('gpuq_cloud_files',HERE/'cloud-files.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        CLOUD_FILES=module.CloudFiles(dataset_ingress_view())
    dataset_mount_check(CLOUD_FILES.n.CONFIG['datasets'])
    return CLOUD_FILES

def dataset_refs(job):
    refs=job.get('datasets',[])
    if not isinstance(refs,list) or len(refs)>16:raise ValueError('Invalid dataset selection')
    seen=set()
    for ref in refs:
        if not isinstance(ref,dict) or not {'dataset','version'}<=set(ref) or set(ref)-{'dataset','version','mountAs'} or not isinstance(ref['dataset'],str) or not DATASET_ID.fullmatch(ref['dataset']) or not isinstance(ref['version'],str) or not DATASET_VERSION.fullmatch(ref['version']):raise ValueError('Invalid immutable dataset reference')
        # mountAs is generated by the trusted portal for cross-node replicas;
        # public submission schemas never accept it. It changes only the name,
        # not the cache identity, owner authorization or read-only lease.
        alias=ref.get('mountAs',ref['dataset'])
        if not isinstance(alias,str) or not DATASET_ID.fullmatch(alias):raise ValueError('Invalid dataset mount alias')
        if alias in seen:raise ValueError('Only one dataset may use each mount name')
        seen.add(alias)
    return refs

def dataset_read_mode(job):
    mode=job.get('datasetReadMode','cache')
    if not isinstance(mode,str) or mode not in ('cache','warehouse'):raise ValueError('Invalid immutable dataset read mode')
    if mode=='warehouse' and not dataset_refs(job):raise ValueError('Warehouse training requires fixed dataset versions')
    return mode

def dataset_training_sources():
    global DATASET_TRAINING_SOURCES
    if DATASET_TRAINING_SOURCES is None:
        spec=importlib.util.spec_from_file_location('gpuq_training_dataset_sources',HERE/'dataset-training-source.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        DATASET_TRAINING_SOURCES=module.TrainingSources(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    return DATASET_TRAINING_SOURCES

def dataset_training_cache(job):
    if dataset_read_mode(job)=='cache':return dataset_cache()
    base={'id':job['id'],'userId':job['userId'],'references':dataset_refs(job)}
    sources=dataset_training_sources()
    return sources.cache(sources.binding(job,base))

def dataset_actor(module,args):
    # userId/hostAdmin originate at the authenticated VPS execution bridge, not
    # a client-provided Principal. Raw actor/admin/path fields are rejected below.
    workspace(args['userId'])
    if type(args.get('hostAdmin',False)) is not bool:raise ValueError('Invalid administrator identity')
    return module.Principal(args['userId'],args.get('hostAdmin',False))

def dataset_error(error):
    return os.strerror(error.errno) if isinstance(error,OSError) and error.errno else str(error)[:300]

def dataset_background_active(key):
    return subprocess.run(['/usr/bin/systemctl','--user','is-active','--quiet','gpuq-data-'+key[:32]],env=ENV,timeout=4).returncode==0

def dataset_background_status(folder,key,spec,cache,actor,*,catalog_snapshot=None,warehouse_catalog_snapshot=None):
    # READY is a current cache fact, never a historical worker receipt: a
    # completed transfer may since have been evicted or its mount removed.
    current={}
    if spec['op']=='prepare' and spec.get('warehouse') is True:
        warehouse=storage_warehouse()
        current=(warehouse.status(actor,spec['dataset'],spec['version']) if warehouse_catalog_snapshot is None
                 else warehouse._catalog_status_snapshot(actor,spec['dataset'],spec['version'],warehouse_catalog_snapshot))
    elif spec['op']=='prepare':
        current=(cache.status(actor,spec['dataset'],spec['version']) if catalog_snapshot is None
                 else cache._catalog_status_snapshot(actor,spec['dataset'],spec['version'],catalog_snapshot))
    if current.get('state')=='READY':return {**current,'operationId':key}
    if spec['op']=='prepare' and spec.get('warehouse') is not True and dataset_recovery_configured(cache,actor,spec['dataset'],spec['version']):current['recoveryConfigured']=True
    result=folder/(key+'.result.json')
    if result.exists():
        receipt=json.loads(result.read_text())
        return {**receipt,**current} if receipt.get('state')=='READY' else {**current,**receipt}
    if dataset_background_active(key):
        return {**current,'operationId':key,'state':{'prepare':'PREPARING','register':'REGISTERING','register-v1':'REGISTERING','unregister':'UNREGISTERING','unregister-v1':'UNREGISTERING'}[spec['op']]}
    if spec['op'] in ('unregister','unregister-v1'):
        return {'operationId':key,'dataset':spec['dataset'],'version':spec.get('version'),'state':'UNKNOWN','error':'Unregister worker outcome is unconfirmed; inspect this operation and its recovery journal before retrying'}
    return {**current,'operationId':key,'state':'FAILED','error':'Dataset worker is not running; retry the prepare or register operation'}

def dataset_prepare_pointer(folder,dataset,version):
    identity=hashlib.sha256(json.dumps([dataset,version]).encode()).hexdigest()
    return folder/('version-'+identity+'.current')

def dataset_current_prepare(folder,dataset,version):
    pointer=dataset_prepare_pointer(folder,dataset,version)
    if not pointer.exists():return None
    key=json.loads(pointer.read_text())['operationId']
    if not isinstance(key,str) or not DATASET_VERSION.fullmatch(key):raise ValueError('Invalid dataset worker pointer')
    spec=json.loads((folder/(key+'.json')).read_text())
    if spec.get('op')!='prepare' or spec.get('dataset')!=dataset or spec.get('version')!=version or hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest()!=key:raise ValueError('Dataset worker identity mismatch')
    return key,spec


def dataset_recovery_configured(cache,actor,dataset,version):
    # Metadata-only capability hint, never a claim that a remote disk is live.
    # The detached prepare worker authenticates the fixed authority again.
    try:
        node=storage_node()
        with cache._locked():
            cache._dataset(actor,dataset)
            node.tier._receipt(actor,cache._tier(dataset,version),dataset,version)
        return True
    except (ValueError,OSError,TypeError,KeyError):return False

def dataset_op(operation,args):
    if operation in ('datasets.list','datasets.status'):
        module,_=dataset_cache()
        with module.wait_for_locks(timeout=5,total=8):return _dataset_op(operation,args)
    return _dataset_op(operation,args)

def _dataset_op(operation,args,*,_request_id=None,_expected_registration=None,_expected_owners=None):
    # Only the private, durably fenced archive-retirement adapter supplies this
    # identity. Public operation fields remain unchanged and reject it.
    if _request_id is not None and (operation!='datasets.unregister' or not isinstance(_request_id,str) or str(uuid.UUID(_request_id))!=_request_id):raise ValueError('Invalid private unregister identity')
    if _expected_registration is not None and (_request_id is None or not isinstance(_expected_registration,list) or len(_expected_registration)!=5 or any(type(item) is not int or item<0 for item in _expected_registration)):raise ValueError('Invalid private unregister registration identity')
    if _expected_owners is not None and (_expected_registration is None or _expected_owners!=[args.get('userId')]):raise ValueError('Invalid private unregister ownership identity')
    definitions={'datasets.capacity':set(),'datasets.list':set(),'datasets.status':{'dataset','version','operationId'},'datasets.prepare':{'dataset','version'},'datasets.register':{'dataset','sourceId','owners','protocol'},'datasets.unregister':{'dataset','version','protocol','portalProvedOtherCopy'}}
    if operation not in definitions or not isinstance(args,dict) or set(args)-definitions[operation]-{'userId','hostAdmin'}:raise ValueError('Invalid dataset operation fields')
    module,cache=dataset_cache();actor=dataset_actor(module,args)
    if operation=='datasets.capacity':
        result=cache.capacity(actor)
        # Read-only role/volume facts. A warehouse volume is never inferred
        # from the training-cache capacity, machine name or archive journal.
        # Older Portal versions ignore this additive projection.
        result['storageOverview']={'protocol':'dataset-storage-node-v1',
            'cache':{'volume':dict(result),'budgetBytes':cache.budget_bytes},'warehouse':None}
        spec=importlib.util.spec_from_file_location('gpuq_storage_observation',HERE/'storage-observation.py')
        observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)
        result['storageOverview']['cache'].update(observer.project_usage(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals())))
        result['datasetFileList']=1
        if CONFIG.get('storageWarehouse') is not None:
            try:
                warehouse=storage_warehouse()
                result['storageOverview']['warehouse']={'state':'READY','volume':warehouse.cold.capacity(actor)}
            except (OSError,ValueError,RuntimeError):
                # Do not leak mount paths/configuration through errors, and do
                # not substitute SSD or the root disk for unavailable HDD.
                result['storageOverview']['warehouse']={'state':'UNAVAILABLE','volume':None}
        elif isinstance(CONFIG.get('storageAuthority'),dict) and CONFIG['storageAuthority'].get('enabled') is True:
            # A protected single-root authority shares its real volume with
            # the training/workspace role. Reuse this exact guarded snapshot;
            # no second stat, authority journal creation or dataset scan.
            archive=CONFIG.get('storageArchive',{})
            tier=CONFIG.get('storageTier',{'enabled':False})
            local=(CONFIG['storageAuthority']=={'enabled':True}
                and isinstance(archive,dict) and set(archive)=={'enabled','machine','authority'}
                and archive.get('enabled') is True and archive.get('machine')==CONFIG.get('machine')
                and isinstance(CONFIG.get('machine'),str) and DATASET_ID.fullmatch(CONFIG['machine'])
                and isinstance(archive.get('authority'),str) and DATASET_ID.fullmatch(archive['authority'])
                and tier.get('enabled',False) is False)
            result['storageOverview']['warehouse']={'state':'READY' if local else 'UNAVAILABLE',
                'volume':dict(result['storageOverview']['cache']['volume']) if local else None}
        if dataset_delete_capability()==1:result['datasetDelete']=1
        return result
    folder=ROOT/'dataset-ops';folder.mkdir(mode=0o700,exist_ok=True)
    if operation=='datasets.list':
        listing,snapshots=cache._list_datasets_snapshot(actor)
        # Cache metadata does not know the detached worker's outcome. Dataset
        # permission was checked by list_datasets; shared owners may observe a
        # transfer without learning its initiating identity or host source.
        for item in listing['datasets']:
            for version in item['versions']:
                if version.get('errorCode')=='CACHE_METADATA_INCOMPLETE':
                    # Display UNKNOWN cannot authorize recovery/deletion or
                    # consume the trusted catalog snapshot used by workers.
                    version['deletionPermissions']={'allowed':False,'memberAllowed':False,'reason':'CACHE_METADATA_INCOMPLETE'}
                    continue
                if dataset_delete_capability()==1:
                    version['deletionPermissions']=cache.deletion_permissions(actor,item['dataset'],version['version'])
                if version['state']=='READY':continue
                if dataset_recovery_configured(cache,actor,item['dataset'],version['version']):
                    version.update(canPrepare=True,recoveryConfigured=True)
                pending=dataset_current_prepare(folder,item['dataset'],version['version'])
                if pending:
                    try:
                        current=dataset_background_status(folder,*pending,cache,actor,
                            catalog_snapshot=snapshots[(item['dataset'],version['version'])])
                    except module.CacheMetadataIncomplete:
                        # A required parent may disappear after the display
                        # snapshot. Strict status/admission remains unchanged.
                        version.update(cache._catalog_incomplete(version))
                        version['deletionPermissions']={'allowed':False,'memberAllowed':False,'reason':'CACHE_METADATA_INCOMPLETE'}
                        version.pop('recoveryConfigured',None)
                        continue
                    version.update({k:v for k,v in current.items() if k in ('state','operationId','error')})
        if dataset_delete_capability()==1:listing['datasetDelete']=1
        warehouse=storage_warehouse()
        if warehouse is not None:
            for item in listing['datasets']:
                for value in item['versions']:
                    try:binding=warehouse.binding(item['dataset'],value['version'])
                    except FileNotFoundError:continue
                    value['logicalDataset']=binding['source']
            originals,warehouse_snapshots=warehouse._list_datasets_snapshot(actor)
            for item in originals['datasets']:
                for value in item['versions']:
                    if value.get('errorCode')=='CACHE_METADATA_INCOMPLETE':continue
                    pending=dataset_current_prepare(folder,item['dataset'],value['version'])
                    if pending:
                        try:value.update(dataset_background_status(folder,*pending,cache,actor,
                            warehouse_catalog_snapshot=warehouse_snapshots[(item['dataset'],value['version'])]))
                        except module.CacheMetadataIncomplete:
                            value.update(cache._catalog_incomplete(value))
                            value.update(warehouseReady=False,warehouseCanPrepare=False,
                                deletionPermissions={'allowed':False,'memberAllowed':False,'reason':'CACHE_METADATA_INCOMPLETE'})
                            value.pop('storageReference',None)
                            value.pop('recoveryConfigured',None)
                    value.pop('dataset',None)
            listing['datasets'].extend(originals['datasets'])
        return listing
    if operation=='datasets.status' and 'operationId' in args:
        key=args['operationId']
        if set(args)-{'userId','hostAdmin','operationId'} or not isinstance(key,str) or not re.fullmatch('[a-f0-9]{64}',key):raise ValueError('Invalid dataset operation ID')
        spec=json.loads((folder/(key+'.json')).read_text())
        if hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest()!=key:raise ValueError('Dataset worker identity mismatch')
        if spec.get('op') in ('unregister','unregister-v1') and spec.get('hostAdmin') is not actor.is_admin:raise ValueError('Administrator authorization changed')
        if not actor.is_admin and spec['userId']!=actor.user_id:raise ValueError('Dataset operation is not owned by this user')
        return dataset_background_status(folder,key,spec,cache,actor)
    dataset=args.get('dataset')
    if not isinstance(dataset,str) or not DATASET_ID.fullmatch(dataset):raise ValueError('Invalid dataset ID')
    if operation=='datasets.unregister':
        warehouse=storage_warehouse()
        warehouse_registration=warehouse is not None and (warehouse.cold._paths(dataset)['.registry']/'dataset.json').exists()
        if warehouse_registration:
            if (cache._paths(dataset)['.registry']/'dataset.json').exists():raise ValueError('Ambiguous dual-root dataset registration')
            cache=warehouse.cold
        version=args.get('version')
        protocol=args.get('protocol')
        if 'protocol' in args and (protocol!='dataset-delete-node-v1' or dataset_delete_capability()!=1):
            raise ValueError('The required v1 protected removal protocol is unavailable')
        proof=args.get('portalProvedOtherCopy')
        if 'portalProvedOtherCopy' in args:
            if (not actor.is_admin or protocol!='dataset-delete-node-v1' or not isinstance(proof,dict)
                    or set(proof)!={'protocol','versions'} or proof['protocol']!='dataset-portal-copy-proof-v1'
                    or not isinstance(proof['versions'],list) or len(proof['versions'])>10000
                    or any(not isinstance(v,str) or not DATASET_VERSION.fullmatch(v) for v in proof['versions'])
                    or len(set(proof['versions']))!=len(proof['versions'])
                    or version is not None and version not in proof['versions']):
                raise ValueError('Only an authenticated administrator may supply exact Portal-proved complete-copy versions')
        if version is not None and (not isinstance(version,str) or not DATASET_VERSION.fullmatch(version)):raise ValueError('Invalid immutable dataset version')
        if not actor.is_admin:
            if version is None or not cache.deletion_permissions(actor,dataset,version)['memberAllowed']:
                raise ValueError('Administrator authorization required; 这份数据只能由管理员删除')
        # Each explicit removal gets its own receipt. Large replica cleanup runs
        # only in the detached worker, never inside the short SSH request.
        task={'op':'unregister-v1' if protocol else 'unregister','dataset':dataset,'version':version,'userId':actor.user_id,'hostAdmin':actor.is_admin,'requestId':_request_id or str(uuid.uuid4())}
        if warehouse_registration:task['warehouse']=True
        if protocol:task['protocol']=protocol
        if proof is not None:task['portalProvedOtherCopy']=proof
        if proof is not None and proof['versions']==[]:
            if version is not None:raise ValueError('Empty proof only permits whole personal registration removal')
            with cache._locked():task['emptyRegistrationSnapshot']=cache._empty_unregister_snapshot(actor,dataset)
        if _expected_registration is not None:task['expectedRegistration']=_expected_registration
        if _expected_owners is not None:task['expectedOwners']=_expected_owners
    elif operation=='datasets.register':
        if CONFIG.get('storageTier',{}).get('enabled') is True:
            raise PermissionError('Dataset originals must use the HDD warehouse upload or workspace publication')
        protocol=args.get('protocol')
        if 'protocol' in args and (protocol!='dataset-delete-node-v1' or dataset_delete_capability()!=1):
            raise ValueError('Explicit new registration requires the v1 node protocol')
        if not actor.is_admin:raise ValueError('Administrator authorization required')
        source=args.get('sourceId');owners=args.get('owners')
        if not isinstance(source,str) or source not in CONFIG['datasets'].get('sources',{}):raise ValueError('Source ID is not approved in node configuration')
        if not isinstance(owners,list) or not owners or len(owners)>10000 or any(not isinstance(owner,str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)',owner) for owner in owners):raise ValueError('Explicit valid dataset owners are required')
        task={'op':'register-v1' if protocol else 'register','dataset':dataset,'sourceId':source,'owners':sorted(set(owners)),'userId':actor.user_id,'hostAdmin':True}
        if protocol:task['protocol']=protocol
    else:
        version=args.get('version')
        if not isinstance(version,str) or not DATASET_VERSION.fullmatch(version):raise ValueError('Invalid immutable dataset version')
        warehouse=storage_warehouse()
        local_original=warehouse is not None and warehouse.contains(actor,dataset,version)
        status=warehouse.status(actor,dataset,version) if local_original else cache.status(actor,dataset,version)
        if status['state']=='READY':return status
        if not local_original and dataset_recovery_configured(cache,actor,dataset,version):status['recoveryConfigured']=True
        task={'op':'prepare','dataset':dataset,'version':version,'userId':actor.user_id,'hostAdmin':actor.is_admin}
        if local_original:task['warehouse']=True
    key=hashlib.sha256(json.dumps(task,sort_keys=True).encode()).hexdigest();unit='gpuq-data-'+key[:32]
    spec=folder/(key+'.json');result=folder/(key+'.result.json')
    if operation=='datasets.status':
        pending=dataset_current_prepare(folder,dataset,version)
        return dataset_background_status(folder,*pending,cache,actor) if pending else status
    guard=dataset_prepare_pointer(folder,dataset,task['version']) if task['op']=='prepare' else folder/key
    with open(str(guard)+'.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if _request_id is not None and spec.exists():
            if json.loads(spec.read_text())!=task:raise ValueError('Fixed unregister identity changed')
            return dataset_background_status(folder,key,task,cache,actor)
        if task['op']=='prepare':
            pending=dataset_current_prepare(folder,dataset,task['version'])
            if pending and dataset_background_active(pending[0]):return {'operationId':pending[0],'dataset':dataset,'version':task['version'],'state':'PREPARING'}
        active=dataset_background_active(key)
        if not active:
            atomic_json(spec,task);result.unlink(missing_ok=True)
            if task['op']=='prepare':atomic_json(dataset_prepare_pointer(folder,dataset,task['version']),{'operationId':key})
            run(['/usr/bin/systemd-run','--user','--collect','--unit='+unit,'--property=KillMode=control-group','--property=UMask=0077','--property=CPUQuota=100%','--property=MemoryMax=2G','--property=IOWeight=10','--property=RuntimeMaxSec=86400','--property=TimeoutStopSec=20','/usr/bin/python3',str(HERE/'node-executor.py'),'--dataset-worker',key],timeout=8)
    return {'operationId':key,'dataset':dataset,**({'version':task['version']} if task['op'] in ('prepare','unregister','unregister-v1') else {}),'state':{'prepare':'PREPARING','register':'REGISTERING','register-v1':'REGISTERING','unregister':'UNREGISTERING','unregister-v1':'UNREGISTERING'}[task['op']]}

def dataset_worker(key):
    if not isinstance(key,str) or not re.fullmatch('[a-f0-9]{64}',key):raise ValueError('Invalid background operation ID')
    folder=ROOT/'dataset-ops';task=json.loads((folder/(key+'.json')).read_text())
    if hashlib.sha256(json.dumps(task,sort_keys=True).encode()).hexdigest()!=key:raise ValueError('Background dataset request was modified')
    try:
        module,cache=dataset_cache();actor=dataset_actor(module,task)
        if task.get('warehouse') is True and task['op'] in ('unregister','unregister-v1'):
            warehouse=storage_warehouse()
            if warehouse is None:raise ValueError('Fixed warehouse registration is unavailable')
            cache=warehouse.cold
        with module.wait_for_locks():
            if task['op'] in ('register','register-v1'):
                if CONFIG.get('storageTier',{}).get('enabled') is True:
                    raise PermissionError('Dataset originals must use the HDD warehouse upload or workspace publication')
                if task['op']=='register-v1' and (task.get('protocol')!='dataset-delete-node-v1' or dataset_delete_capability()!=1):
                    raise ValueError('Explicit v1 registration worker protocol is unavailable')
                out=cache.register_source(actor,task['dataset'],task['sourceId'],task['owners']);out['state']='REGISTERED'
            elif task['op']=='prepare':
                if task.get('warehouse') is True:
                    out=storage_warehouse().prepare(actor,task['dataset'],task['version'])
                    atomic_json(folder/(key+'.result.json'),{**out,'operationId':key})
                    return 0
                record,identity=cache._record_snapshot(actor,task['dataset'],task['version'])
                with cache._locked():
                    cache._check_snapshot(actor,task['dataset'],task['version'],identity)
                    paths=cache._paths(task['dataset'],task['version'])
                    ready=cache._ready(paths,record['manifest'],task['version'])
                    staged=cache._version_entry_exists(paths['.staging'])
                if not ready:
                    dataset_cache_admission(0 if staged else cache._footprint(record['manifest']),
                                            _exclude=((task['dataset'],task['version']),))
                del record
                with cache._locked():
                    cache._dataset(actor,task['dataset'])
                    cached=cache._tier(task['dataset'],task['version'])['role']=='cache'
                # Only a service-verified authority receipt may recover an evicted
                # disposable copy. Never fall back to an old sourceId on failure.
                if cached:
                    out=storage_node().tier.recover(module.Principal('builtin-admin',True),task['dataset'],task['version'])
                else:out=cache.materialize(actor,task['dataset'],task['version'])
            elif task['op'] in ('unregister','unregister-v1'):
                proof=None
                if task['op']=='unregister-v1':
                    if task.get('protocol')!='dataset-delete-node-v1' or dataset_delete_capability()!=1:
                        raise ValueError('Protected v1 worker protocol is unavailable')
                    value=task.get('portalProvedOtherCopy')
                    if value is not None:
                        if not actor.is_admin or value.get('protocol')!='dataset-portal-copy-proof-v1':
                            raise ValueError('Authenticated administrator Portal proof is required')
                        proof=value.get('versions')
                out=cache.unregister(actor,task['dataset'],task.get('version'),_expected_registration=task.get('expectedRegistration'),_expected_owners=task.get('expectedOwners'),
                                     _portal_proved_versions=proof,_expected_empty_registration=task.get('emptyRegistrationSnapshot'));out['state']='UNREGISTERED'
            else:raise ValueError('Invalid background dataset action')
        # Never return transfer tokens, local paths, or source IDs to callers.
        out={k:v for k,v in out.items() if k in ('dataset','version','state','bytes','files','unregistered','registrationRetained','versions','recoveryId')}
    except Exception as error:out={'state':'FAILED','error':dataset_error(error)}
    atomic_json(folder/(key+'.result.json'),{**out,'operationId':key})
    return 0 if out['state']!='FAILED' else 1

class DatasetNotReady(ValueError):
    """An authorized cache status proved that a selected replica is absent."""

def acquire_datasets(job):
    # Both the submit preflight and sandbox runner enter here. A busy metadata
    # lock is not an absent dataset: wait only for acquisition, with one bounded
    # budget shared by nested hold/READY checks. Never replay a mutation or
    # bypass a canceled/released preparation journal.
    if not dataset_refs(job):return []
    module,_=dataset_cache()
    with module.wait_for_locks(timeout=5,total=8):return _acquire_datasets(job)

def _acquire_datasets(job):
    refs=dataset_refs(job)
    if not refs:return []
    if dataset_read_mode(job)=='warehouse':
        # A warehouse reader must never enter the legacy receipt/cache fallback.
        # Persist source/generation intent and cold leases before scheduler admission.
        prepared=storage_leases().handoff_if_present(job)
        if prepared is None:
            storage_leases().prepare(job)
            prepared=storage_leases().handoff_if_present(job)
        if prepared is None:raise ValueError('Warehouse training requires its durable source journal')
        return prepared
    if CONFIG.get('storageArchive',{}).get('enabled') is True or os.path.lexists(ROOT/'storage-leases'):
        prepared=storage_leases().handoff_if_present(job)
        if prepared is not None:return prepared
    module,cache=dataset_cache();actor=module.Principal(job['userId'],False)
    for ref in refs:
        if cache.status(actor,ref['dataset'],ref['version'])['state']!='READY':raise DatasetNotReady('Dataset is not READY; prepare it before reserving GPUs')
    leases=[]
    for ref in refs:
        try:lease=cache.acquire_lease(actor,ref['dataset'],ref['version'],job['id'])
        except module.CacheError:
            # Eviction can win between the status check and lease acquisition.
            # Do not classify permission, mount, I/O or unknown errors by text.
            if cache.status(actor,ref['dataset'],ref['version'])['state']!='READY':
                raise DatasetNotReady('Dataset is not READY; prepare it before reserving GPUs')
            raise
        leases.append(lease)
        # Persist incrementally; errors deliberately retain existing leases.
        atomic_json(ROOT/'jobs'/(job['id']+'.datasets.json'),leases)
    return leases

def reject_unsubmitted_datasets(job,receipt):
    """Called only under the job flock with no native row or dispatch marker.

    Fence future retries before lease cleanup. Even a lost response or cleanup
    error must never turn this rejected immutable job into a later submission.
    """
    identity={'schema':1,'jobId':job['id'],'failureCode':'DATASET_NOT_READY'}
    if receipt.exists():
        if json.loads(receipt.read_text())!=identity:raise ValueError('Invalid dataset rejection receipt')
    else:atomic_json(receipt,identity)
    module,cache=dataset_training_cache(job);actor=module.Principal('scheduler',True)
    for ref in dataset_refs(job):
        with cache._locked():
            cache._record(actor,ref['dataset'],ref['version'])
            # Recover leases created before an interrupted receipt write too;
            # never release another job's or another owner's training lease.
            leases=[lease for lease in cache._leases(ref['dataset'],ref['version'])
                    if lease['jobId']==job['id'] and lease['owner']==job['userId']]
        for lease in leases:cache.release_lease(actor,ref['dataset'],ref['version'],lease['id'])
        with cache._locked():
            if any(lease['jobId']==job['id'] and lease['owner']==job['userId']
                   for lease in cache._leases(ref['dataset'],ref['version'])):
                raise ValueError('Unsubmitted dataset lease cleanup is not confirmed')
    (ROOT/'jobs'/(job['id']+'.datasets.json')).unlink(missing_ok=True)
    if os.path.lexists(ROOT/'storage-leases'/'training'/job['id']):
        storage_leases().finalize_training(job)
    return {'state':'FAILED','notSubmitted':True,'failureCode':'DATASET_NOT_READY','assignedIndices':[],
            'error':'数据副本在提交前已失效，未启动训练。请重新准备数据后新建任务。'}

def dataset_runner_group():
    groups=[line.split(':',2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::')]
    if len(groups)!=1:raise ValueError('Dataset runner requires a verified unified cgroup')
    return groups[0]

def dataset_current_unit(unit,group):
    # Basenames alone are insufficient: a delegated child could imitate one.
    # The trusted bootstrap is GPUQ's execve'd main process, not a descendant.
    try:
        result=subprocess.run(['/usr/bin/systemctl','--user','show',unit,'--property=LoadState,ActiveState,MainPID,ControlGroup'],
            env=ENV,text=True,capture_output=True,timeout=5)
        props=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        return (result.returncode==0 and set(props)=={'LoadState','ActiveState','MainPID','ControlGroup'}
            and props['LoadState']=='loaded' and props['ActiveState'] in ('active','activating')
            and props['MainPID']==str(os.getpid()) and props['ControlGroup']==group)
    except (OSError,ValueError,subprocess.SubprocessError):return False

def dataset_runner_proof(job):
    """Internal runner authority, never an RPC argument or a client retry flag.

    Read one native snapshot, then require the current process to inhabit its
    exact attempt unit. Every earlier consumer must already be stopped. A
    JOB_RETRIED event authorizes a separate epoch; it does not reopen old state.
    Caller holds the Console job flock and repeats this proof before execution.
    """
    validate_job(job,readonly=True)
    spec=ROOT/'jobs'/(job['id']+'.json')
    if spec.is_symlink() or json.loads(spec.read_text())!=job:raise ValueError('Dataset runner immutable specification differs')
    native_id=os.environ.get('GPUQ_JOB_ID','');attempt_id=os.environ.get('GPUQ_ATTEMPT_ID','')
    if not re.fullmatch(r'J[a-f0-9]{12}',native_id) or not re.fullmatch(r'A[a-f0-9]{32}',attempt_id):
        raise ValueError('Dataset runner native identity is missing')
    unit='gpuq-'+attempt_id.lower()+'.service'
    group=dataset_runner_group()
    if not group.startswith('/') or '..' in Path(group).parts or Path(group).name!=unit:
        raise ValueError('Dataset runner is outside its native attempt cgroup')
    if not dataset_current_unit(unit,group):raise ValueError('Dataset runner is not the verified native unit main process')
    control=Path(CONFIG['controlRoot'])/attempt_id
    if os.environ.get('GPUQ_CONTROL_DIR')!=str(control):raise ValueError('Dataset runner control identity differs')
    with closing(sqlite3.connect(f'file:{CONFIG["database"]}?mode=ro',uri=True)) as db:
        db.row_factory=sqlite3.Row;db.execute('BEGIN')
        row=db.execute('SELECT id,submit_key,owner,argv_json,state FROM jobs WHERE submit_key=?',(job['id'],)).fetchone()
        if not row or row['id']!=native_id or row['owner']!=gpuq_owner(job) or row['state'] not in ('STARTING','RUNNING'):
            raise ValueError('Dataset runner native job is not the current authorized execution')
        argv=json.loads(row['argv_json'])
        # GPUQ canonicalizes the executable when accepting a submission. Allow
        # only our fixed system interpreter and its exact current target, not
        # arbitrary aliases, flags, or an interpreter selected by the job.
        interpreters=('/usr/bin/python3',str(Path('/usr/bin/python3').resolve(strict=True)))
        if (not isinstance(argv,list) or len(argv)!=3 or argv[0] not in interpreters or argv[2]!=job['id']
                or Path(argv[1]).resolve()!=HERE/'sandbox-runner.py'):
            raise ValueError('Dataset runner native wrapper identity differs')
        rows=[dict(value) for value in db.execute('SELECT id,job_id,ordinal,state,unit_name,control_dir,created_at,finished_at FROM attempts WHERE job_id=? ORDER BY ordinal LIMIT 1025',(native_id,))]
        event=db.execute("SELECT id,created_at FROM events WHERE job_id=? AND event_type='JOB_RETRIED' ORDER BY id DESC LIMIT 1",(native_id,)).fetchone()
    if not rows or len(rows)>1024:raise ValueError('Dataset runner attempt history is incomplete')
    current=rows[-1];prior=rows[:-1]
    if (current['id']!=attempt_id or current['state'] not in ('STARTING','RUNNING')
            or current['unit_name'] not in (unit,unit[:-8]) or current['control_dir']!=str(control)
            or [value['ordinal'] for value in rows]!=list(range(1,len(rows)+1))):
        raise ValueError('Dataset runner is not the current native attempt')
    def timestamp(value):return type(value) in (int,float) and math.isfinite(value) and value>0
    for value in prior:
        expected='gpuq-'+value['id'].lower()
        if (not re.fullmatch(r'A[a-f0-9]{32}',value['id']) or value['unit_name'] not in (expected,expected+'.service')
                or not timestamp(value['finished_at']) or not dataset_unit_stopped(value)):
            raise ValueError('Earlier dataset consumer termination is unconfirmed')
    retry=None
    if event is not None:
        if (type(event['id']) is not int or event['id']<=0 or not timestamp(event['created_at'])
                or not timestamp(current['created_at']) or event['created_at']>current['created_at']):
            raise ValueError('Native retry epoch is not valid for this attempt')
        earlier=[value for value in prior if value['created_at']<=event['created_at']]
        if not earlier or any(value['finished_at']>event['created_at'] for value in earlier):
            raise ValueError('Native retry precedes termination of its previous consumers')
        retry={'id':event['id'],'createdAt':event['created_at']}
    rejected=ROOT/'jobs'/(job['id']+'.dataset-not-submitted.json')
    canceled=ROOT/'jobs'/(job['id']+'.canceled')
    if os.path.lexists(rejected):raise ValueError('Dataset submission was permanently rejected')
    if os.path.lexists(canceled):
        info=canceled.lstat()
        if not stat.S_ISREG(info.st_mode) or retry is None or info.st_mtime>=retry['createdAt']:
            raise ValueError('Dataset cancellation is newer than the verified native retry')
    return {'nativeJobId':native_id,'attemptId':attempt_id,'ordinal':current['ordinal'],
            'priorAttemptIds':[value['id'] for value in prior], 'retry':retry,
            'specSha256':hashlib.sha256(json.dumps(job,sort_keys=True,separators=(',',':')).encode()).hexdigest()}

def dataset_open_mounts(job,*,runner=False):
    if not dataset_refs(job):return []
    if runner:
        # submit only waits for GPUQ admission, not for this child to finish
        # bootstrapping. Never acquire this lock recursively from submit/sync.
        with open(ROOT/'jobs'/(job['id']+'.lock'),'a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            proof=dataset_runner_proof(job)
            leases=None
            if os.path.lexists(ROOT/'storage-leases'/'training'/job['id']):
                leases=storage_leases().runner_handoff(job,proof)
            if dataset_read_mode(job)=='warehouse' and leases is None:
                raise ValueError('Warehouse runner requires its durable source journal')
            opened=_dataset_open_mounts(job,leases)
            try:
                if dataset_runner_proof(job)!=proof:raise ValueError('Dataset runner authority changed during handoff')
                return opened
            except BaseException:
                for descriptor,_ in opened:os.close(descriptor)
                raise
    return _dataset_open_mounts(job)

def _dataset_open_mounts(job,leases=None):
    if leases is None:leases=acquire_datasets(job)
    opened=[]
    try:
        refs=dataset_refs(job)
        if not isinstance(leases,list) or len(leases)!=len(refs):raise ValueError('Incomplete dataset lease handoff')
        module,cache=dataset_training_cache(job)
        for ref,lease in zip(refs,leases):
            if lease.get('readOnly') is not True:raise ValueError('Dataset lease is not read-only')
            if lease.get('dataset')!=ref['dataset'] or lease.get('version')!=ref['version'] or lease.get('path')!=str(cache._paths(ref['dataset'],ref['version'])['ready']/'data'):
                raise ValueError('Dataset lease source identity differs')
            if dataset_read_mode(job)=='warehouse':
                with storage_leases().mount_source(job,ref,lease) as (module,_,snapshot):
                    with module._directory(Path(lease['path'])) as descriptor:
                        if list(module._stamp(os.fstat(descriptor)))!=snapshot['ready'][2]:raise ValueError('Opened warehouse data identity changed')
                        fd=os.dup(descriptor)
                        opened.append((fd,'/data2/'+ref.get('mountAs',lease['dataset'])))
            else:
                with module._directory(Path(lease['path'])) as descriptor:
                    fd=os.dup(descriptor)
                    opened.append((fd,'/data2/'+ref.get('mountAs',lease['dataset'])))
        return opened
    except BaseException:
        for fd,_ in opened:os.close(fd)
        raise

def dataset_unit_stopped(attempt):
    if attempt.get('state') not in ('EXITED_SUCCESS','EXITED_FAILURE','CANCELED','PREEMPTED'):return False
    name=attempt.get('unit_name','')
    if not isinstance(name,str) or not re.fullmatch(r'gpuq-[a-z0-9_-]+(?:\.service)?',name):return False
    if not name.endswith('.service'):name+='.service'
    try:
        result=subprocess.run(['/usr/bin/systemctl','--user','show',name,'--property=LoadState,ActiveState,SubState,MainPID,ControlGroup'],env=ENV,text=True,capture_output=True,timeout=5)
        props=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        if set(props)!={'LoadState','ActiveState','SubState','MainPID','ControlGroup'}:return False
        if result.returncode and not (result.returncode==1 and props['LoadState']=='not-found'):return False
        # GPUQ uses RemainAfterExit=yes: active/exited with an empty cgroup is
        # finished too, and a collected exact unit can report not-found/code 1.
        quiet=props['ActiveState'] in ('inactive','failed') or (props['ActiveState']=='active' and props['SubState']=='exited')
        if props['MainPID']!='0' or not quiet:return False
        group=props['ControlGroup']
        if not group:return props['LoadState'] in ('loaded','not-found')
        if not group.startswith('/') or '..' in Path(group).parts or Path(group).name!=name:return False
        path=Path('/sys/fs/cgroup')/group.lstrip('/')
        try:events=path.joinpath('cgroup.events').read_text()
        except FileNotFoundError:return not path.exists()
        fields=dict(line.split() for line in events.splitlines())
        return fields.get('populated')=='0'
    except (OSError,ValueError,subprocess.SubprocessError):return False

def scheduler_terminal_confirmed(data):
    """A cancel receipt is not evidence that its attempt/leases have drained.

    Native GPUQ finalizes an attempt and releases its leases atomically. All
    jobs, including jobs without datasets and intentionally shared GPUs, use
    that same proof before the Portal may retire their card reservation.
    """
    if not isinstance(data,dict):return False
    native=data.get('job');attempts=data.get('attempts');leases=data.get('leases');reservations=data.get('scale_up_reservations')
    if not isinstance(native,dict) or native.get('state') not in ('SUCCEEDED','FAILED','CANCELED'):return False
    if native.get('active_attempt_id') not in (None,'') or data.get('active_attempt_id') not in (None,''):return False
    if not isinstance(attempts,list) or not isinstance(leases,list) or leases or not isinstance(reservations,list) or reservations:return False
    return all(isinstance(a,dict) and a.get('state') in ('EXITED_SUCCESS','EXITED_FAILURE','CANCELED','PREEMPTED') for a in attempts)

def cleanup_snapshot_matches(job,data,expected):
    if not isinstance(data,dict):return False
    native=data.get('job',{});attempts=data.get('attempts',[])
    return (isinstance(native,dict) and isinstance(attempts,list) and bool(attempts) and isinstance(attempts[0],dict)
            and native.get('id')==expected['nodeJobId'] and native.get('submit_key')==job['id']
            and type(native.get('version')) is int and native['version']==expected['nativeVersion']
            and type(attempts[0].get('ordinal')) is int
            and attempts[0].get('id')==expected['attemptId'] and attempts[0].get('ordinal')==expected['attemptOrdinal'])

def release_datasets(job,data=None,never_dispatched=False,expected_native=None):
    """Caller owns job flock and fresh no-dispatch or native terminal proof.

    A prepared HELD lease precedes the scheduler .datasets receipt. Absence of
    that receipt is not evidence of no hold. Private journal finalization also
    fences retries after the legacy receipt has already been removed.
    """
    if not dataset_refs(job):return True
    retry_folder=ROOT/'storage-leases'/'training'/job['id']
    has_retries=retry_folder.exists() and any(retry_folder.glob('retry-*.json'))
    if has_retries:
        # Do NOT use a terminal snapshot obtained before waiting for job flock.
        # A newer native attempt might have consumed a retry generation since.
        if never_dispatched:return False
        with closing(sqlite3.connect(f'file:{CONFIG["database"]}?mode=ro',uri=True)) as db:
            row=db.execute('SELECT id FROM jobs WHERE submit_key=?',(job['id'],)).fetchone()
        if not row:return False
        data=gpu('show',row[0])
        if data.get('job',{}).get('id')!=row[0] or data['job'].get('submit_key')!=job['id']:return False
    if expected_native is not None and not cleanup_snapshot_matches(job,data,expected_native):return False
    filename=ROOT/'jobs'/(job['id']+'.datasets.json')
    if not never_dispatched:
        if not scheduler_terminal_confirmed(data):return False
        if not all(dataset_unit_stopped(attempt) for attempt in data['attempts']):return False
    finalized=None
    if os.path.lexists(ROOT/'storage-leases'/'training'/job['id']):
        finalized=storage_leases().finalize_training(job,stopped_native=data if has_retries else None)
    if dataset_read_mode(job)=='warehouse':
        if finalized is None:raise ValueError('Warehouse cleanup requires its durable source journal; holds retained')
        filename.unlink(missing_ok=True)
        return True
    # A journal validates the exact receipt before retiring all its namespaces.
    # Do not release its same IDs twice: legitimate eviction/unregistration can
    # occur as soon as the final lease is gone, before this receipt is unlinked.
    if finalized is None and os.path.lexists(filename):
        module,cache=dataset_training_cache(job);leases=json.loads(filename.read_text());actor=module.Principal('scheduler',True)
        for lease in leases:cache.release_lease(actor,lease['dataset'],lease['version'],lease['leaseId'])
    # Older attempts can lose the receipt after acquiring a lease (or before
    # the durable handoff journal existed). The immutable job and confirmed
    # stopped scheduler/cgroup proof above are the authority, not a TTL or the
    # receipt's absence. Recover only this owner's exact job/reference holds.
    module,cache=dataset_training_cache(job);actor=module.Principal('scheduler',True)
    for ref in dataset_refs(job):
        with cache._locked():
            retained=[lease for lease in cache._leases(ref['dataset'],ref['version'])
                      if lease['jobId']==job['id'] and lease['owner']==job['userId']]
        for lease in retained:cache.release_lease(actor,ref['dataset'],ref['version'],lease['id'])
    filename.unlink(missing_ok=True);return True

def run(argv,timeout=18):
    p=subprocess.run(argv,env=ENV,text=True,capture_output=True,timeout=timeout)
    if p.returncode:raise ValueError((p.stderr or p.stdout or 'GPUQ failed')[-400:])
    if len(p.stdout)>2000000:raise ValueError('GPUQ response too large')
    return p.stdout

def gpu(*args):return json.loads(run([CONFIG['gpu'],'--json',*args]))

def gpuq_owner(job):
    # GPUQ labels are ASCII, but portal identity and ownership use immutable IDs.
    return job['username'] if re.fullmatch(r'[a-z][a-z0-9_-]{1,23}',job['username']) else 'portal-'+hashlib.sha256(job['userId'].encode()).hexdigest()[:24]

def storage_quota(user,path,**kwargs):
    spec=importlib.util.spec_from_file_location('gpuq_storage_quota',HERE/'storage-quota.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.ensure(CONFIG,user,path,**kwargs)

def storage_quota_status(user):
    spec=importlib.util.spec_from_file_location('gpuq_storage_quota',HERE/'storage-quota.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.status(CONFIG,user)

def workspace(user):
    if not isinstance(user,str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)',user):raise ValueError('Invalid identity')
    path=ROOT/'users'/hashlib.sha256(user.encode()).hexdigest()[:32]
    path.mkdir(parents=True,exist_ok=True,mode=0o700)
    if 'storageQuota' in CONFIG:storage_quota(user,path)
    return path

def file_op(operation,args,root=None):
    root=workspace(args['userId']) if root is None else root
    path=args.get('path','.')
    if not isinstance(path,str) or len(path)>1024 or '\0' in path or path.startswith('/') or '\\' in path:raise ValueError('Invalid relative path')
    parts=path.split('/') if path!='.' else []
    if any(p in ('','.','..') or len(p)>255 for p in parts):raise ValueError('Invalid relative path')
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
    fd=os.open(root,flags)
    try:
        if operation=='files.put':
            data=base64.b64decode(args.get('data',''),validate=True)
            if len(data)>1024*1024:raise ValueError('Chunk too large')
            workspace_storage_check(len(data),target_fd=fd)
        directories=parts if operation=='files.list' else parts[:-1]
        for part in directories:
            if operation=='files.put':
                try:os.mkdir(part,mode=0o700,dir_fd=fd)
                except FileExistsError:pass
            nxt=os.open(part,flags,dir_fd=fd);os.close(fd);fd=nxt
        if operation=='files.list':
            out=[]
            for name in sorted(os.listdir(fd))[:1000]:
                st=os.stat(name,dir_fd=fd,follow_symlinks=False)
                out.append({'name':name,'size':st.st_size,'type':'directory' if stat.S_ISDIR(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else 'unsupported'})
            return {'entries':out}
        if not parts:raise ValueError('File path required')
        offset=args.get('offset',0)
        if type(offset)!=int or not 0<=offset<=2**53-1:raise ValueError('Invalid offset')
        f=os.open(parts[-1],(os.O_RDWR|os.O_CREAT if operation=='files.put' else os.O_RDONLY)|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=fd)
        try:
            st=os.fstat(f)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1:raise ValueError('Only unlinked regular files allowed')
            fcntl.flock(f,(fcntl.LOCK_EX if operation=='files.put' else fcntl.LOCK_SH)|fcntl.LOCK_NB)
            if operation=='files.put':
                workspace_storage_check(len(data),target_fd=fd)
                if args.get('truncate') is True:
                    if offset!=0:raise ValueError('Invalid truncate offset')
                    os.ftruncate(f,0);st=os.fstat(f)
                if offset!=st.st_size:raise ValueError('Upload offset mismatch; restart this file')
                if st.st_size+len(data)>2**53-1:raise ValueError('File byte count is not exact')
                os.lseek(f,offset,0)
                view=memoryview(data)
                while view:view=view[os.write(f,view):]
                os.fsync(f)
                return {'path':path,'size':os.fstat(f).st_size}
            def identity(info):
                return (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_uid,info.st_gid,info.st_mode,info.st_nlink)
            fingerprint=hashlib.sha256(json.dumps([args['userId'],args.get('project'),args.get('runId'),path,identity(st)]).encode()).hexdigest()
            expected=args.get('fingerprint')
            if expected is not None and (not isinstance(expected,str) or not re.fullmatch(r'[a-f0-9]{64}',expected)):
                raise ValueError('Invalid download file identity')
            if expected is not None and expected!=fingerprint:
                raise ValueError('Download source changed; preserve the partial file and choose a new destination')
            if offset>st.st_size:raise ValueError('Download offset exceeds file size')
            os.lseek(f,offset,0);data=os.read(f,1024*1024)
            if identity(os.fstat(f))!=identity(st) or identity(os.stat(parts[-1],dir_fd=fd,follow_symlinks=False))!=identity(st):
                raise ValueError('Download source changed while reading; no chunk accepted')
            return {'protocol':2,'fingerprint':fingerprint,'path':path,'size':st.st_size,'offset':offset,'data':base64.b64encode(data).decode(),'eof':offset+len(data)>=st.st_size}
        finally:os.close(f)
    finally:os.close(fd)

def validate_job(job,readonly=False):
    required={'id','userId','username','cards','argv','name','minVramGiB'}
    if not isinstance(job,dict) or not required<=set(job) or set(job)-required-{'datasets','datasetReadMode','project','release','priority','preemptIdleOnly','scheduling','elastic','placement'}:raise ValueError('Invalid job specification')
    if not UUID.fullmatch(job['id']):raise ValueError('Invalid job ID')
    if readonly:
        if not isinstance(job['userId'],str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)',job['userId']):raise ValueError('Invalid identity')
    else:workspace(job['userId'])
    if not re.fullmatch(r'[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}',job['username']):raise ValueError('Invalid username')
    if type(job['cards'])!=int or not 1<=job['cards']<=CONFIG.get('cards',64):raise ValueError('Invalid card count')
    if not isinstance(job['argv'],list) or not 1<=len(job['argv'])<=128 or any(not isinstance(a,str) or '\0' in a for a in job['argv']) or len(json.dumps(job['argv']))>12000:raise ValueError('Invalid argv')
    dataset_refs(job)
    dataset_read_mode(job)
    policy=SCHEDULING.normalize_job_policy(job)
    SCHEDULING.elastic_allocation(job)
    SCHEDULING.gpu_placement(job)
    if 'project' in job or 'release' in job:
        if not isinstance(job.get('project'),str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,47}',job['project']) or not isinstance(job.get('release'),str) or not DATASET_VERSION.fullmatch(job['release']):raise ValueError('Invalid project release')
    return policy

def terminal_pointer(args):
    suffix='host' if args.get('hostAdmin') is True else 'private'
    if type(args.get('dataWorkspace',False)) is not bool:raise ValueError('Invalid personal data terminal scope')
    if args.get('dataWorkspace'):
        if args.get('hostAdmin') is True or args.get('project'):raise ValueError('Data terminal cannot be a project or host root terminal')
        suffix+=':data-workspace'
    if args.get('project'):
        if args.get('hostAdmin') is True:raise ValueError('Project terminal cannot be host root')
        projects().identity(args)
        suffix+=':project:'+args['project']
    identity=hashlib.sha256((args['userId']+suffix).encode()).hexdigest()[:20]
    return ROOT/'terminals'/(identity+'.current')

def terminal_pointers(args):
    """Legacy and every independent session fence for this exact context."""
    legacy=terminal_pointer(args)
    result=[legacy] if legacy.exists() else []
    for path in sorted(legacy.parent.glob(legacy.stem+'.*.current')):
        if not UUID.fullmatch(path.name[len(legacy.stem)+1:-8]):raise ValueError('Invalid terminal session pointer')
        result.append(path)
    return result

def terminal_metadata(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>16384:raise ValueError('Invalid terminal metadata')
        with os.fdopen(fd,'r',closefd=False) as stream:return json.load(stream)
    finally:os.close(fd)

def terminal_owned(args,jid):
    try:spec=terminal_metadata(ROOT/'terminals'/(jid+'.json'))
    except FileNotFoundError:raise ValueError('Terminal not found or not owned') from None
    if (spec.get('userId')!=args['userId'] or spec.get('project')!=args.get('project') or
            (spec.get('hostAdmin') is True)!=(args.get('hostAdmin') is True) or
            (spec.get('dataWorkspace') is True)!=(args.get('dataWorkspace') is True)):
        raise ValueError('Terminal not found or not owned')
    return spec

def terminal_alive(folder,jid):
    if not isinstance(jid,str) or not UUID.fullmatch(jid):return False
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(2);client.connect(str(folder/(jid+'.sock')));client.sendall(b'{"offset":2147483647}\n');raw=b''
            while b'\n' not in raw:
                part=client.recv(65536)
                if not part or len(raw)>1000000:return False
                raw+=part
            result=json.loads(raw)
            return not result.get('error') and result.get('exited') is False
    except (OSError,ValueError):return False

def terminal_context_readonly(args):
    """Validate context without creating a workspace/project or renewing a lease."""
    if not isinstance(args,dict) or set(args)-{'machine','userId','username','id','project','hostAdmin','dataWorkspace','clientId','writerToken'}:
        raise ValueError('Invalid terminal status fields')
    if not isinstance(args.get('userId'),str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)',args['userId']):raise ValueError('Invalid identity')
    if not isinstance(args.get('username'),str) or not re.fullmatch(r'[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}',args['username']):raise ValueError('Invalid username')
    if not isinstance(args.get('id'),str) or not UUID.fullmatch(args['id']):raise ValueError('Invalid terminal ID')
    if any(type(args.get(k,False)) is not bool for k in ('hostAdmin','dataWorkspace')):raise ValueError('Invalid terminal scope')
    if args.get('project') is not None and (not isinstance(args['project'],str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,47}',args['project'])):raise ValueError('Invalid project name')
    if args.get('hostAdmin') and (not CONFIG.get('hostRoot',False) or args.get('project') or args.get('dataWorkspace')):raise ValueError('Invalid host terminal scope')
    if args.get('dataWorkspace') and args.get('project'):raise ValueError('Invalid data terminal scope')

def terminal_file_identity(path):
    try:info=path.lstat()
    except FileNotFoundError:return None
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)

def terminal_unit_observation(jid):
    unit='amax-term-'+jid+'.service'
    fields={'LoadState','ActiveState','SubState','MainPID','ControlGroup','InvocationID'}
    result=subprocess.run(['/usr/bin/systemctl','--user','show',unit,'--property='+','.join(sorted(fields))],
        env=ENV,text=True,capture_output=True,timeout=5)
    lines=result.stdout.splitlines()
    if len(lines)!=len(fields) or any('=' not in line for line in lines):raise ValueError('Terminal unit observation incomplete')
    props=dict(line.split('=',1) for line in lines)
    if set(props)!=fields or result.returncode and not (result.returncode==1 and props['LoadState']=='not-found'):
        raise ValueError('Terminal unit observation unconfirmed')
    if not re.fullmatch(r'[0-9]+',props['MainPID']):raise ValueError('Terminal PID observation invalid')
    group=props['ControlGroup']
    if group and (not group.startswith('/') or '..' in Path(group).parts or Path(group).name!=unit):
        raise ValueError('Terminal cgroup identity unconfirmed')
    populated=None
    if group:
        path=Path('/sys/fs/cgroup')/group.lstrip('/')
        try:
            events=dict(line.split() for line in (path/'cgroup.events').read_text().splitlines())
            populated=events.get('populated')
            if populated not in ('0','1'):raise ValueError('Terminal cgroup observation incomplete')
        except FileNotFoundError:
            if path.exists():raise ValueError('Terminal cgroup observation unconfirmed')
            populated='0'
    quiet=props['ActiveState'] in ('inactive','failed') or (props['ActiveState']=='active' and props['SubState']=='exited')
    stopped=quiet and props['MainPID']=='0' and props['LoadState'] in ('loaded','not-found') and (not group or populated=='0')
    return props,populated,stopped

def terminal_status(args):
    terminal_context_readonly(args);jid=args['id'];folder=ROOT/'terminals'
    terminal_owned(args,jid)
    spec=folder/(jid+'.json');receipt_path=folder/(jid+'.session.json');sock=folder/(jid+'.sock')
    before=(terminal_file_identity(spec),terminal_file_identity(receipt_path),terminal_file_identity(sock))
    receipt=terminal_metadata(receipt_path) if before[1] is not None else None
    state='UNKNOWN';evidence={'confirmed':False,'socket':'UNKNOWN'}
    try:
        first=terminal_unit_observation(jid)
        # A successful no-input socket reply is live evidence, never permission
        # to terminate. Absence alone is insufficient: the unit/cgroup must agree.
        live=terminal_alive(folder,jid) if before[2] is not None else False
        second=terminal_unit_observation(jid)
        after=(terminal_file_identity(spec),terminal_file_identity(receipt_path),terminal_file_identity(sock))
        if first==second and before==after:
            props,populated,stopped=second
            state='STOPPED' if stopped and after[2] is None else 'ALIVE' if live and not stopped else 'UNKNOWN'
            evidence={'confirmed':state!='UNKNOWN','loadState':props['LoadState'],'activeState':props['ActiveState'],
                'subState':props['SubState'],'mainPid':int(props['MainPID']),'cgroupEmpty':populated=='0' if props['ControlGroup'] else stopped,
                'socket':'ABSENT' if after[2] is None else 'RESPONDING' if live else 'UNCONFIRMED'}
    except (OSError,ValueError,subprocess.TimeoutExpired):pass
    lease=receipt.get('leaseExpiresAt') if isinstance(receipt,dict) else None
    expired=isinstance(lease,(int,float)) and not isinstance(lease,bool) and math.isfinite(lease) and lease<=time.time()
    recoverable=bool(isinstance(receipt,dict) and receipt.get('schema')==2 and receipt.get('state') in ('OPEN','DETACHED','CLOSED') and expired and state=='STOPPED')
    return {'protocol':'terminal-session-status-v1','id':jid,'state':state,'evidence':evidence,
        'attachmentState':receipt.get('state','UNKNOWN') if isinstance(receipt,dict) else 'UNKNOWN',
        'writerLeaseExpired':expired,'canCloseStopped':recoverable}

def terminal_close_stopped(args):
    """Owner metadata cleanup only. Never stop a unit, send input or create a PTY."""
    terminal_context_readonly(args);jid=args['id'];folder=ROOT/'terminals'
    terminal_owned(args,jid)
    lock_path=folder/(jid+'.lock');fd=os.open(lock_path,os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.getuid():raise ValueError('Terminal lock identity unconfirmed')
        lock_identity=terminal_file_identity(lock_path)
        if lock_identity is None or lock_identity[:2]!=(info.st_dev,info.st_ino):raise ValueError('Terminal lock identity changed')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        paths=[folder/(jid+'.json'),folder/(jid+'.session.json'),folder/(jid+'.sock')]
        identities=[terminal_file_identity(path) for path in paths]
        first=terminal_status(args)
        if not first['canCloseStopped']:raise ValueError('Terminal writer lease required; stopped state or lease expiry is unconfirmed')
        terminal_owned(args,jid);receipt=terminal_metadata(paths[1])
        second=terminal_status(args)
        if first!=second or not second['canCloseStopped'] or identities!=[terminal_file_identity(path) for path in paths] or terminal_file_identity(lock_path)!=lock_identity:
            raise ValueError('Terminal changed during stopped-session cleanup; query the original ID again')
        # Retain the exact-ID specification AND project fences. A local
        # administrator could start a unit after observation; metadata cleanup
        # must not hide that unit from the publication's own stop proof.
        receipt.update(leaseExpiresAt=0,state='CLOSED');atomic_json(paths[1],receipt)
        return {'protocol':'terminal-session-status-v1','id':jid,'closed':True,'state':'STOPPED','metadataOnly':True}
    finally:os.close(fd)

def stop_terminal(jid):
    # Stable unit protocol shared with existing terminal pointers; not branding.
    unit='amax-term-'+jid+'.service'
    result=subprocess.run(['/usr/bin/systemctl','--user','stop',unit],env=ENV,text=True,capture_output=True,timeout=12)
    if result.returncode:
        active=subprocess.run(['/usr/bin/systemctl','--user','is-active','--quiet',unit],env=ENV,timeout=5)
        if active.returncode==0:raise ValueError('Terminal could not be stopped')

def personal_oci_project(args):
    # Only a new personal project container needs a delegated child cgroup.
    # The client cannot ask for delegation by supplying an environment mode.
    if args.get('hostAdmin') is True or args.get('dataWorkspace') is True or not args.get('project'):
        return False
    if projects().store.environment_mode(args['userId'],args['project'])!='oci':
        return False
    spec=importlib.util.spec_from_file_location('gpuq_terminal_oci_policy',HERE/'personal-oci.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.policy(CONFIG,args['userId'])  # exact authenticated owner cohort
    return True

def terminal_oci_properties(args):
    return ['--property=Delegate=yes'] if personal_oci_project(args) else []

def oci_submission_arguments(job):
    # This is platform-selected from owned metadata, never a user host env.
    return ['--env','GPUQ_CONSOLE_OCI=1'] if personal_oci_project(job) else []

def terminal_op(operation,args):
    if operation=='terminal.status':return terminal_status(args)
    if operation=='terminal.close' and args.get('writerToken') is None and args.get('clientId') is None:return terminal_close_stopped(args)
    if args.get('hostAdmin') is True and not CONFIG.get('hostRoot',False):raise ValueError('Host root terminal is disabled on this node')
    workspace(args['userId'])
    if not re.fullmatch(r'[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}',args['username']):raise ValueError('Invalid username')
    folder=ROOT/'terminals';folder.mkdir(mode=0o700,exist_ok=True)
    legacy=terminal_pointer(args)
    client_id=args.get('clientId')
    if not isinstance(client_id,str) or not UUID.fullmatch(client_id):
        raise ValueError('Terminal client upgrade required: use independent sessions and a writer lease')
    opening=operation=='terminal.open';mode=args.get('mode','new')
    if opening and mode not in ('new','reconnect'):raise ValueError('Choose terminal mode new or reconnect')
    if opening and (not isinstance(args.get('key'),str) or not UUID.fullmatch(args['key'])):raise ValueError('Invalid terminal attachment key')
    if type(args.get('takeover',False)) is not bool or (args.get('takeover') and (not opening or mode!='reconnect')):
        raise ValueError('Takeover requires an explicit reconnect')
    jid=args.get('key') if opening and mode=='new' else args.get('id')
    if not isinstance(jid,str) or not UUID.fullmatch(jid):raise ValueError('Invalid terminal ID')
    pointer=folder/(legacy.stem+'.'+jid+'.current')
    receipt_path=folder/(jid+'.session.json')
    with open(folder/(jid+'.lock'),'a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        now=time.time()
        receipt=terminal_metadata(receipt_path) if receipt_path.exists() else None
        if opening:
            if mode=='new' and not (folder/(jid+'.json')).exists():
                if args.get('hostAdmin') is not True:workspace_storage_check(admission=True)
                oci_properties=terminal_oci_properties(args)
                unit='amax-term-'+jid
                spec={'userId':args['userId'],'username':args['username'],'cards':0,'argv':['/bin/bash','--noprofile','--norc','-i'],'hostAdmin':args.get('hostAdmin') is True}
                if args.get('project'):spec['project']=args['project']
                if args.get('dataWorkspace') is True:spec['dataWorkspace']=True
                with open(folder/(jid+'.json'),'x') as f:json.dump(spec,f);f.flush();os.fsync(f.fileno())
                receipt={'schema':2,'originClient':client_id,'clientId':client_id,'attachKey':args['key'],'writerToken':str(uuid.uuid4()),'leaseExpiresAt':now+30,'state':'OPEN'}
                atomic_json(receipt_path,receipt)
                with open(pointer,'x') as f:f.write(jid);f.flush();os.fsync(f.fileno())
                directory=os.open(folder,os.O_RDONLY|os.O_DIRECTORY)
                try:os.fsync(directory)
                finally:os.close(directory)
                command=['/usr/bin/systemd-run','--user','--collect','--unit',unit,'--property=RuntimeMaxSec=21600','--property=KillMode=control-group','--property=TimeoutStopSec=5']
                if not spec['hostAdmin']:command+=['--property=MemoryMax=8G','--property=CPUQuota=200%','--property=TasksMax=2048']
                command+=oci_properties
                run(command+['/usr/bin/python3',str(HERE/'terminal-helper.py'),jid])
                for _ in range(30):
                    if (folder/(jid+'.sock')).exists():break
                    time.sleep(0.1)
            else:
                terminal_owned(args,jid)
                if receipt and receipt.get('state')=='CLOSED':raise ValueError('Terminal has ended; create a new session')
                if not terminal_alive(folder,jid):raise ValueError('Terminal is not reachable; no replacement was started and no existing session was stopped')
                if mode=='new':
                    # Same-key retry only belongs to its original client. Never
                    # turn an unrelated open into an implicit reconnect/takeover.
                    if not receipt or receipt.get('originClient')!=client_id or receipt.get('clientId')!=client_id:
                        raise ValueError('Terminal key already exists; use a new key or explicit reconnect')
                    if receipt.get('state')!='OPEN' or receipt.get('leaseExpiresAt',0)<=now:
                        raise ValueError('Terminal attachment expired or detached; reconnect explicitly')
                elif receipt and receipt.get('clientId')==client_id and receipt.get('attachKey')==args.get('key') and receipt.get('state')=='OPEN' and receipt.get('leaseExpiresAt',0)>now:
                    # Retrying the exact attachment after a lost reply must not
                    # rotate its token again or grant a different client access.
                    receipt['leaseExpiresAt']=now+30;atomic_json(receipt_path,receipt)
                    return {'id':jid,'hostAdmin':args.get('hostAdmin') is True,'clientId':client_id,
                            'writerToken':receipt['writerToken'],'leaseExpiresAt':receipt['leaseExpiresAt'],'mode':mode}
                elif receipt is None:
                    if not args.get('takeover'):raise ValueError('Legacy terminal requires explicit takeover; upgrade all clients before reconnecting')
                    receipt={'schema':2,'originClient':None,'state':'OPEN'}
                elif receipt.get('leaseExpiresAt',0)>now and not args.get('takeover'):
                    if receipt.get('clientId')!=client_id or receipt.get('writerToken')!=args.get('writerToken'):
                        raise ValueError('Terminal has another active writer; detach it, wait for lease expiry, or explicitly take over')
                # Reconnect rotates the fencing token even for the same client.
                # A delayed close/exchange from the previous attachment is stale.
                if mode=='reconnect':receipt.update(clientId=client_id,attachKey=args.get('key'),writerToken=str(uuid.uuid4()),state='OPEN')
                receipt['leaseExpiresAt']=now+30
                atomic_json(receipt_path,receipt)
            return {'id':jid,'hostAdmin':args.get('hostAdmin') is True,'clientId':client_id,
                    'writerToken':receipt['writerToken'],'leaseExpiresAt':receipt['leaseExpiresAt'],'mode':mode}
        terminal_owned(args,jid)
        if (not receipt or receipt.get('clientId')!=client_id or receipt.get('writerToken')!=args.get('writerToken')
                or receipt.get('leaseExpiresAt',0)<=now or receipt.get('state')!='OPEN'):
            raise ValueError('Terminal writer lease expired or was taken over; reconnect explicitly (old clients must upgrade)')
        if operation=='terminal.detach':
            receipt.update(leaseExpiresAt=0,state='DETACHED');atomic_json(receipt_path,receipt)
            return {'detached':True,'id':jid}
        if operation=='terminal.close':
            stop_terminal(jid)
            if args.get('project') and not projects().terminal_stopped(jid):raise ValueError('Cannot confirm project terminal termination; retry when node services recover')
            if args.get('dataWorkspace') and not data_workspaces().unit_stopped('amax-term-'+jid+'.service'):raise ValueError('Cannot confirm data terminal termination; retry when node services recover')
            (folder/(jid+'.sock')).unlink(missing_ok=True);pointer.unlink(missing_ok=True)
            if legacy.exists() and legacy.read_text()==jid:legacy.unlink()
            receipt.update(leaseExpiresAt=0,state='CLOSED');atomic_json(receipt_path,receipt)
            return {'closed':True}
        if operation!='terminal.exchange':raise ValueError('Unknown terminal operation')
        if receipt['leaseExpiresAt']-now<15:
            receipt['leaseExpiresAt']=now+30;atomic_json(receipt_path,receipt)
        request={key:args[key] for key in ('input','offset','rows','cols') if key in args}
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(4);client.connect(str(folder/(jid+'.sock')));client.sendall((json.dumps(request)+'\n').encode());raw=b''
            while b'\n' not in raw:
                part=client.recv(65536)
                if not part:break
                raw+=part
                if len(raw)>1000000:raise ValueError('Terminal response too large')
            result=json.loads(raw)
            if result.get('error'):raise ValueError(result['error'])
            return result

def transfers():
    spec=importlib.util.spec_from_file_location('gpuq_transfer_jobs',HERE/'transfer-jobs.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.TransferJobs(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))

def project_copies():
    global PROJECT_COPIES
    if globals().get('PROJECT_COPIES') is None:
        spec=importlib.util.spec_from_file_location('gpuq_project_copies',HERE/'project-copy.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        PROJECT_COPIES=module.ProjectCopies(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    return PROJECT_COPIES


def storage_node():
    global STORAGE_NODE
    if STORAGE_NODE is None:
        spec=importlib.util.spec_from_file_location('gpuq_storage_node',HERE/'storage-node.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        configured=CONFIG.get('storageAuthorities',{})
        if not isinstance(configured,dict) or len(configured)>16:raise ValueError('Invalid configured storage authorities')
        authorities={}
        if configured:
            paths,_=dataset_cache();paths._mkdir(ROOT/'storage-grants')
        for key,value in configured.items():
            warehouse=storage_warehouse()
            if (warehouse is not None and value=={'machine':CONFIG.get('machine')}
                    and key==CONFIG['storageArchive']['authority']):
                authorities[key]=storage_authority_module().LocalStoredAuthority(storage_authority(),warehouse.hot,ROOT/'storage-grants'/key)
                continue
            if (not isinstance(key,str) or not DATASET_ID.fullmatch(key) or not isinstance(value,dict)
                    or set(value)!={'machine'} or value['machine']==CONFIG.get('machine')
                    or value['machine'] not in CONFIG.get('transferPeers',{})):
                raise ValueError('Storage authority needs a fixed, different, pinned LAN peer')
            authorities[key]=storage_authority_module().RemoteAuthority(value['machine'],CONFIG['transferPeers'][value['machine']],ROOT/'storage-grants'/key,target_machine=CONFIG['machine'])
        STORAGE_NODE=module.StorageNode.from_executor(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()),authorities=authorities)
        STORAGE_NODE.cache.rebuild_guard=dataset_rebuild_guard
    return STORAGE_NODE


def storage_authority_module():
    global STORAGE_AUTHORITY_MODULE
    if STORAGE_AUTHORITY_MODULE is None:
        spec=importlib.util.spec_from_file_location('gpuq_storage_authority',HERE/'storage-authority.py')
        STORAGE_AUTHORITY_MODULE=importlib.util.module_from_spec(spec);sys.modules[spec.name]=STORAGE_AUTHORITY_MODULE;spec.loader.exec_module(STORAGE_AUTHORITY_MODULE)
    return STORAGE_AUTHORITY_MODULE


def storage_authority():
    global STORAGE_AUTHORITY
    config=CONFIG.get('storageAuthority',{'enabled':False})
    if not isinstance(config,dict) or set(config)!={'enabled'} or type(config['enabled']) is not bool:raise ValueError('Invalid protected authority configuration')
    if not config['enabled']:return None
    if STORAGE_AUTHORITY is None:
        module,cache=dataset_source_cache()
        STORAGE_AUTHORITY=storage_authority_module().AuthorityStore(cache,CONFIG['machine'],ROOT/'storage-authority',principal=module.Principal('builtin-admin',True))
    return STORAGE_AUTHORITY


def dataset_delete_capability():
    # The helper set is delivered atomically by the runtime manifest. Cached
    # probe data alone never authorizes a deletion; each private RPC rechecks.
    config=CONFIG.get('datasets',{})
    retention=config.get('retireRetentionDays',7) if isinstance(config,dict) else None
    if type(retention) is not int or not 7<=retention<=365 or not DATASET_ID.fullmatch(CONFIG.get('machine','')):return 0
    return 1 if all((HERE/name).is_file() and not (HERE/name).is_symlink() for name in
        ('dataset-retirement.py','dataset-retirement-node.py','dataset-rebuild-proof.py','dataset-cache.py','dataset-tier.py','storage-authority.py')) else 0


def dataset_retirement_node(*,dataset=None,version=None,operation_id=None):
    if dataset_delete_capability()!=1:raise ValueError('这台服务器还不支持彻底删除')
    warehouse=storage_warehouse()
    if warehouse is not None:return warehouse.retirement(dataset=dataset,version=version,operation_id=operation_id)
    spec=importlib.util.spec_from_file_location('gpuq_dataset_retirement_node',HERE/'dataset-retirement-node.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.RetirementNode.from_executor(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))


def dataset_retirement_operation(operation,args):
    # Internal bridge only. No operation here is accepted by peer/read/upload
    # ticket routes or public executionCall. Identity is the portal's current
    # Principal; supplied owners/proofs are accepted only for private negatives.
    fields={'capabilities':set(),'locations':{'version','references'},'registration':{'dataset','version'},
            'registration-discard':{'operationId','requestKey'},
            'plan':{'operationId','dataset','version','authorization','references','adminContinue'},
            'fence':{'operationId','adminContinue','retryKey'},'isolate':{'operationId','targets','adminContinue','retryKey'},'status':{'operationId'},
            'restore':{'operationId','retryKey'},'release-absence':{'operationId','sourceResult','retryKey'},
            'cancel':{'operationId','retryKey'},'commit':{'operationId','sourceResult','retryKey'}}
    action=operation.removeprefix('storage.dataset-delete.')
    if action not in fields or not isinstance(args,dict) or set(args)-fields[action]-{'userId','hostAdmin'}:
        raise ValueError('Invalid private version-data retirement fields')
    required=fields[action]-{'retryKey'}-({'authorization','references','adminContinue'} if action=='plan' else {'adminContinue'} if action in ('fence','isolate') else set())
    if not required<=set(args):raise ValueError('Missing private retirement fields')
    if not {'userId','hostAdmin'}<=set(args) or type(args['hostAdmin']) is not bool:
        raise ValueError('Authenticated retirement identity is required')
    module,_=dataset_cache();actor=dataset_actor(module,args)
    if action=='capabilities':return {'protocol':'dataset-delete-node-v1','machine':CONFIG['machine'],'datasetDelete':dataset_delete_capability()}
    node=dataset_retirement_node(dataset=args.get('dataset'),version=args.get('version'),operation_id=args.get('operationId'))
    if action=='registration':
        return {**node.cache.new_registration_proof(actor,args['dataset'],args['version']),'machine':CONFIG['machine']}
    if action=='registration-discard':
        if not isinstance(args['requestKey'],str) or not UUID.fullmatch(args['requestKey']):raise ValueError('A fixed discard request UUID is required')
        row=node._load(args['operationId']);node._owned(actor,row,restoring=True)
        return {**node.cache.discard_new_registration(actor,row['dataset'],row['version'],row['operationId'],args['requestKey']),
                'machine':CONFIG['machine']}
    if action=='locations':return {'protocol':'dataset-delete-node-v1','machine':CONFIG['machine'],'locations':node.grant_locations(args['version'],args['references'])}
    if action=='plan':
        continuation=args.get('adminContinue',False)
        if type(continuation) is not bool or continuation and not actor.is_admin:raise ValueError('Authenticated administrator continuation is required')
        effective=node.resume_actor(actor,args['operationId']) if continuation and node._path(args['operationId']).exists() else actor
        return node.plan(effective,args['dataset'],args['version'],args['operationId'],authorization=args.get('authorization'),references=args.get('references'))
    key=args['operationId']
    if action=='status':
        # Sample worker state first: an inactive worker may have published its
        # result between the two reads. A stale pre-inactive file read is unsafe.
        activities={phase:dataset_retirement_activity(key,phase)
                    for phase in ('fence','isolate','restore','release-absence','cancel','commit')
                    if node._phase_path(key,phase,'launch').exists()}
        result=node.worker_status(actor,key,active=any(state=='RUNNING' for state in activities.values()))
        pending=[];unknown=[]
        for phase,state in activities.items():
            if phase in result['phases']:continue
            (pending if state=='RUNNING' else unknown).append(phase)
        return {**result,'pendingPhases':pending,'unconfirmedPhases':unknown,
                'runningPhases':[phase for phase,state in activities.items() if state=='RUNNING'],
                'stoppedPhases':[phase for phase,state in activities.items() if state=='STOPPED']}
    if action in ('fence','isolate','restore','release-absence','cancel','commit'):
        if action in ('restore','release-absence','cancel') and not actor.is_admin:raise ValueError('Administrator restoration is required')
        # Keep long hash/moves out of the forced-command request. Persist the
        # launch intent once; an uncertain launch is queried, never replayed.
        return dataset_retirement_launch(node,actor,key,action,args.get('targets'),args.get('sourceResult'),args.get('adminContinue',False),args.get('retryKey'))
    raise ValueError('Unknown private retirement operation')


def dataset_retirement_launch(node,actor,key,action,targets,source_result=None,admin_continue=False,retry_key=None):
    # One immutable invocation per step/phase. Lost replies do not launch a
    # second worker, including across executor or portal restarts.
    if type(admin_continue) is not bool or admin_continue and not actor.is_admin:raise ValueError('Authenticated administrator continuation is required')
    if retry_key is not None:
        if not actor.is_admin:raise ValueError('Authenticated administrator retry is required')
        node.retirement.cache._actor(actor,admin=True)
        # An attempt key deduplicates one explicit retry; the operation and
        # phase stay fixed. It is never a new deletion or an automatic replay.
        node._operation(retry_key)
    if action=='cancel':
        for old in ('fence','isolate','restore','release-absence','commit'):
            if node._phase_path(key,old,'launch').exists() and dataset_retirement_activity(key,old)!='STOPPED':
                raise ValueError('Prior deletion worker termination is unconfirmed')
    spec_path=node._phase_path(key,action,'launch')
    with node._lock(key):
        row=node._load(key);node._owned(actor,row,restoring=action in ('restore','release-absence','cancel','commit') and actor.is_admin or admin_continue or retry_key is not None)
        request={'schema':1,'operationId':key,'action':action,'userId':actor.user_id,'hostAdmin':actor.is_admin,'targets':targets,'sourceResult':source_result,'adminContinue':admin_continue}
        if spec_path.exists():
            prior=node._phase_read(key,action,'launch')
            if retry_key is None:
                if prior!=request:raise ValueError('Retirement dispatch request cannot change')
                return {'protocol':'dataset-delete-node-v1','operationId':key,'machine':CONFIG['machine'],'state':'DISPATCHED','action':action}
            if (not isinstance(prior,dict) or set(prior)!=set(request)
                    or prior['schema']!=1 or prior['operationId']!=key or prior['action']!=action
                    or prior['targets']!=targets or prior['sourceResult']!=source_result):
                raise ValueError('Retirement dispatch request cannot change during retry')
            module,_=dataset_cache();original=dataset_actor(module,prior)
            if prior['adminContinue']:
                if type(prior['adminContinue']) is not bool or not original.is_admin:raise ValueError('Corrupt original retry authorization')
                original=node.resume_actor(original,key)
            node._owned(original,row,restoring=action in ('restore','release-absence','cancel','commit') and original.is_admin)
            attempt_path=node.root/(key+'.'+action+'.attempt-'+retry_key+'.json')
            if attempt_path.exists():
                attempt=node._attempt_read(attempt_path)
                if (not isinstance(attempt,dict) or set(attempt)!={'schema','protocol','operationId','action','retryKey','requestedBy','requestSha256','previousResult','createdAt'}
                        or type(attempt['schema']) is not int or attempt['schema']!=1
                        or attempt['protocol']!='dataset-phase-attempt-v1' or attempt['operationId']!=key or attempt['action']!=action
                        or attempt.get('requestSha256')!=node._request_sha(prior)
                        or attempt.get('requestedBy')!=actor.user_id or attempt.get('retryKey')!=retry_key):
                    raise ValueError('Retry audit identity cannot change')
                return {'protocol':'dataset-delete-node-v1','operationId':key,'machine':CONFIG['machine'],'state':'DISPATCHED','action':action}
            for old in ('fence','isolate','restore','release-absence','cancel','commit'):
                if node._phase_path(key,old,'launch').exists() and dataset_retirement_activity(key,old)!='STOPPED':
                    raise ValueError('Prior deletion worker termination is unconfirmed')
            try:previous=node._phase_read(key,action,'result')
            except FileNotFoundError:previous=None
            if previous is not None and (not isinstance(previous,dict) or set(previous)!={'ok','error'}
                    or previous.get('ok') is not False or not isinstance(previous.get('error'),str)):
                raise ValueError('A confirmed succeeded or corrupt phase cannot be retried')
            atomic_json(attempt_path,dict(schema=1,protocol='dataset-phase-attempt-v1',operationId=key,action=action,
                retryKey=retry_key,requestedBy=actor.user_id,requestSha256=node._request_sha(prior),
                previousResult=previous,createdAt=node.retirement._now()))
            node._clear_phase_result(key,action)
            request=prior  # immutable actor, targets and source proof are reused
        elif retry_key is not None:
            raise ValueError('An undispatched phase cannot be retried')
        if action=='isolate' and row['state'] not in ('FENCED','ISOLATING','ISOLATED'):
            raise ValueError('Version must have a confirmed persistent fence before isolation')
        if not spec_path.exists():atomic_json(spec_path,request)
        run(['/usr/bin/systemd-run','--user','--collect','--unit=gpuq-data-delete-'+key+'-'+action,
             '--property=KillMode=control-group','--property=UMask=0077','--property=CPUQuota=100%','--property=MemoryMax=2G',
             '--property=IOWeight=10','--property=TimeoutStopSec=20',
             '/usr/bin/python3',str(HERE/'node-executor.py'),'--dataset-delete-worker',key,action],timeout=8)
        return {'protocol':'dataset-delete-node-v1','operationId':key,'machine':CONFIG['machine'],'state':'DISPATCHED','action':action}


def dataset_retirement_activity(key,action):
    if not isinstance(key,str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',key) or action not in ('fence','isolate','restore','release-absence','cancel','commit'):
        raise ValueError('Invalid fixed retirement worker identity')
    unit='gpuq-data-delete-'+key+'-'+action+'.service'
    try:
        result=subprocess.run(['/usr/bin/systemctl','--user','show',unit,'--property=LoadState,ActiveState,SubState,MainPID,ControlPID'],
                              env=ENV,text=True,capture_output=True,timeout=4)
        values=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        stopped=values.get('MainPID')=='0' and values.get('ControlPID')=='0'
        if values.get('LoadState')=='not-found' and values.get('ActiveState')=='inactive' and stopped:return 'STOPPED'
        if result.returncode!=0:return 'UNKNOWN'
        if values.get('ActiveState') in ('inactive','failed') and stopped:return 'STOPPED'
        if values.get('ActiveState') in ('active','activating','deactivating','reloading'):return 'RUNNING'
    except (OSError,ValueError,subprocess.TimeoutExpired):pass
    return 'UNKNOWN'


def dataset_retirement_worker(key,action):
    if action not in ('fence','isolate','restore','release-absence','cancel','commit'):raise ValueError('Unknown private retirement worker action')
    node=dataset_retirement_node(operation_id=key)
    request=node._phase_read(key,action,'launch')
    if not isinstance(request,dict) or set(request)!={'schema','operationId','action','userId','hostAdmin','targets','sourceResult','adminContinue'} or type(request['schema']) is not int or request['schema']!=1 or request['operationId']!=key or request['action']!=action:
        raise ValueError('Retirement launch intent changed')
    module,_=dataset_cache();actor=dataset_actor(module,request)
    try:
        if type(request['adminContinue']) is not bool:raise ValueError('Invalid continuation flag')
        effective=node.resume_actor(actor,key) if request['adminContinue'] else actor
        if action=='fence':result=node.fence(effective,key)
        elif action=='isolate':result=node.isolate(effective,key,request['targets'])
        elif action=='restore':result=node.restore(actor,key)
        elif action=='cancel':result=node.cancel(actor,key)
        elif action=='commit':result=node.commit(actor,key,request['sourceResult'])
        else:result=node.release_absence(actor,key,request['sourceResult'])
        atomic_json(node._phase_path(key,action,'result'),{'ok':True,'result':result})
        return 0
    except Exception as error:
        # FAILED is not proof of no side effects. Persistent fence and any
        # isolated full bytes remain; status reports the actual durable state.
        atomic_json(node._phase_path(key,action,'result'),{'ok':False,'error':dataset_error(error)})
        return 1


def storage_archive(source_policy=None):
    global STORAGE_ARCHIVE
    if STORAGE_ARCHIVE is None or source_policy is not None:
        spec=importlib.util.spec_from_file_location('gpuq_storage_archive',HERE/'storage-archive.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        if source_policy is not None:
            # Certification concerns the training cache, not the local HDD
            # ingress view on machines with separate cache/warehouse roots.
            executor=sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals())
            return module.StorageArchive.from_executor(executor,source_policy=source_policy)
        STORAGE_ARCHIVE=module.StorageArchive.from_executor(dataset_ingress_view())
    return STORAGE_ARCHIVE


def storage_leases():
    global STORAGE_LEASES
    if STORAGE_LEASES is None:
        spec=importlib.util.spec_from_file_location('gpuq_storage_leases',HERE/'storage-leases.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        STORAGE_LEASES=module.StorageLeases(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    return STORAGE_LEASES


def storage_lease_operation(operation,args):
    if operation.startswith('storage.download.'):
        action=operation.rsplit('.',1)[1]
        if action=='open':return storage_leases().download_open(args)
        if action=='finish':return storage_leases().download_finish(args)
        if action in ('info','manifest','get'):return storage_leases().download_export('datasets.snapshot.'+action,args)
        raise ValueError('Unknown protected download operation')
    if (operation not in ('storage.lease.prepare','storage.lease.cancel') or not isinstance(args,dict)
            or 'job' not in args or set(args)-{'job','expectedNative'}
            or operation=='storage.lease.prepare' and 'expectedNative' in args):
        raise ValueError('Invalid data preparation lease request')
    expected=args.get('expectedNative')
    if 'expectedNative' in args:
        if (not isinstance(expected,dict) or set(expected)!={'nodeJobId','attemptId','attemptOrdinal','nativeVersion'}
                or not isinstance(expected['nodeJobId'],str) or not re.fullmatch(r'J[a-f0-9]{12}',expected['nodeJobId'])
                or not isinstance(expected['attemptId'],str) or not re.fullmatch(r'A[a-f0-9]{32}',expected['attemptId'])
                or type(expected['attemptOrdinal']) is not int or not 0<expected['attemptOrdinal']<=2**53-1
                or type(expected['nativeVersion']) is not int or not 0<=expected['nativeVersion']<=2**53-1):
            raise ValueError('Invalid resource reconciliation identity')
    job=args['job'];validate_job(job,readonly=True);jid=job['id']
    (ROOT/'jobs').mkdir(parents=True,exist_ok=True,mode=0o700)
    with open(ROOT/'jobs'/f'{jid}.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        with closing(sqlite3.connect(f'file:{CONFIG["database"]}?mode=ro',uri=True)) as db:
            row=db.execute('SELECT id FROM jobs WHERE submit_key=?',(jid,)).fetchone()
        spec=ROOT/'jobs'/f'{jid}.json'
        if spec.exists() and json.loads(spec.read_text())!=job:raise ValueError('Job identity mismatch')
        canceled=ROOT/'jobs'/f'{jid}.canceled'
        if operation=='storage.lease.cancel':
            if expected is not None and (not row or row[0]!=expected['nodeJobId'] or not spec.exists()):
                raise ValueError('Resource reconciliation native identity is unavailable or changed')
            if row:
                # Cleanup request is NOT permission to cancel an actual job.
                # Only its native terminal evidence and stopped units suffice.
                data=gpu('show',row[0])
                if expected is not None and (not cleanup_snapshot_matches(job,data,expected)
                        or not scheduler_terminal_confirmed(data)
                        or not all(dataset_unit_stopped(attempt) for attempt in data['attempts'])):
                    raise ValueError('Resource reconciliation attempt changed or termination is unconfirmed; leases retained')
                if not release_datasets(job,data,expected_native=expected):
                    raise ValueError('Training termination is unconfirmed; prepared leases retained')
            else:
                if os.path.lexists(ROOT/'jobs'/f'{jid}.dataset-dispatch-attempted'):
                    raise ValueError('Training dispatch is unknown; prepared leases retained')
                canceled.touch(mode=0o600,exist_ok=True)
                if os.path.lexists(ROOT/'storage-leases'/'training'/jid) or os.path.lexists(ROOT/'jobs'/f'{jid}.datasets.json'):
                    release_datasets(job,never_dispatched=True)
                else:
                    storage_leases().cancel_prepare(job)
            return {'jobId':jid,'state':'CANCELED','released':True,**({'reconciledNative':expected} if expected is not None else {})}
        if row or os.path.lexists(ROOT/'jobs'/f'{jid}.dataset-dispatch-attempted'):
            raise ValueError('Training may already be submitted; preparation cannot change its leases')
        if canceled.exists() or os.path.lexists(ROOT/'jobs'/f'{jid}.dataset-not-submitted.json'):
            raise ValueError('Preparation is permanently canceled or rejected')
        if CONFIG.get('storageArchive',{}).get('enabled') is not True:
            raise ValueError('Managed data preparation is not enabled')
        value=storage_leases().prepare(job)
        return {'jobId':jid,'state':value['state']}


def storage_archive_operation(operation,args):
    # Private trusted bridge only. No matching operation is present in the
    # public execution API, CLI, upload ticket or node peer allowlist.
    methods={'storage.archive.events':'outbox_list','storage.archive.ack':'outbox_ack',
             'storage.archive.enrollment-check':'enrollment_check',
             'storage.archive.retire':'retire',
             'storage.archive.original':'original','storage.archive.provision':'provision',
             'storage.archive.certify':'certify'}
    if operation not in methods:raise ValueError('Unknown internal archive operation')
    if isinstance(args,dict) and 'sourcePolicy' in args:
        if (operation!='storage.archive.certify' and not (
                operation=='storage.archive.retire' and args.get('mode')=='authority-target-v1')):
            raise ValueError('Source policy is only valid for target certification or retirement')
        if args['sourcePolicy'] is None:raise ValueError('Invalid source policy')
        request={key:value for key,value in args.items() if key!='sourcePolicy'}
        return getattr(storage_archive(args['sourcePolicy']),methods[operation])(request)
    return getattr(storage_archive(),methods[operation])(args)


def storage_management(operation,args):
    # This is a control-plane route, not the LAN peer or a user supplied role.
    allowed=('datasets.storage.status','datasets.storage.plan','datasets.storage.pin','datasets.storage.unpin')
    if operation not in allowed or not isinstance(args,dict) or args.get('hostAdmin') is not True:
        raise ValueError('Administrator storage operation required')
    module,_=dataset_cache();actor=dataset_actor(module,args)
    request={k:v for k,v in args.items() if k not in ('userId','hostAdmin')}
    if 'op' in request:raise ValueError('Storage operation cannot be overridden')
    return storage_node().dispatch(actor,{'op':operation.rsplit('.',1)[1],**request})


def storage_collect():
    """Local service entry, deliberately absent from the RPC/peer allowlists."""
    storage=storage_node()
    if not storage.tier.enabled:
        return {'enabled':False,'state':'DISABLED','evicted':[]}
    module,_=dataset_cache()
    try:
        actor=module.Principal('builtin-admin',True)
        result=storage.tier.collect(actor,dry_run=False,max_versions=16)
        # Reuse the existing explicitly enabled local collection entry only.
        # No timer is installed/enabled and this remains absent from RPC routes.
        if dataset_delete_capability()==1:
            result={**result,'retirements':dataset_retirement_node().retirement.collect_expired(actor,enabled=True,max_versions=16)}
            warehouse=storage_warehouse()
            if warehouse is not None:
                result['warehouseRetirements']=warehouse.retirement(originals=True).retirement.collect_expired(actor,enabled=True,max_versions=16)
        return result
    except module.CacheBusy:
        # Foreground uploads/leases win. The existing timer retries after its
        # normal interval; do not spin or weaken the metadata lock. Contention
        # may occur during the final inventory after some safe evictions, so
        # deliberately do not claim an empty eviction list or zero side effects.
        return {'enabled':True,'state':'DEFERRED','reason':'CACHE_BUSY',
                'recheck':'NEXT_SCHEDULED_RUN','evictionOutcome':'CHECK_STATUS'}


DATASET_CACHE_ACTIONS = None

def dataset_cache_actions():
    global DATASET_CACHE_ACTIONS
    if DATASET_CACHE_ACTIONS is None:
        spec=importlib.util.spec_from_file_location('gpuq_dataset_cache_actions',HERE/'dataset-cache-actions.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        DATASET_CACHE_ACTIONS=module.from_executor(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    return DATASET_CACHE_ACTIONS

def dataset_cache_action_operation(operation,args):
    action=operation.removeprefix('storage.cache-action.')
    if action not in ('capabilities','prepare','release','status','cancel') or not isinstance(args,dict) or args.get('hostAdmin') is not False:
        raise ValueError('Invalid authenticated cache action')
    module,_=dataset_cache();actor=dataset_actor(module,args)
    request={key:value for key,value in args.items() if key not in ('userId','hostAdmin')}
    return dataset_cache_actions().dispatch(actor,action,request)


def process(operation,args):
    platform_root_check()
    if operation=='storage.training.prepare':
        spec=importlib.util.spec_from_file_location('gpuq_training_preparation',HERE/'training-preparation.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.dispatch(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()),args)
    if operation=='datasets.training.status':return dataset_training_sources().status(args)
    if operation=='storage.training.plan':
        spec=importlib.util.spec_from_file_location('gpuq_training_storage',HERE/'training-storage.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.plan(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()),args)
    if operation in ('tasks.display.get','tasks.display.set'):
        definition=importlib.util.spec_from_file_location('gpuq_console_task_display_edit',HERE/'task-display.py')
        module=importlib.util.module_from_spec(definition);definition.loader.exec_module(module)
        return module.edit(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()),operation,args)
    if operation=='projects.oci-cohort.sync':
        spec=importlib.util.spec_from_file_location('gpuq_oci_cohort',HERE/'oci-cohort.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.sync(HERE/'node-config.json',args)
    if operation=='projects.quota':
        if not isinstance(args,dict) or set(args)!={'userId'}:raise ValueError('Invalid quota status fields')
        return storage_quota_status(args['userId'])
    if operation.startswith(('storage.lease.','storage.download.')):return storage_lease_operation(operation,args)
    if operation.startswith('storage.archive.'):return storage_archive_operation(operation,args)
    if operation.startswith('storage.dataset-delete.'):return dataset_retirement_operation(operation,args)
    if operation.startswith('storage.cache-action.'):return dataset_cache_action_operation(operation,args)
    if operation.startswith('datasets.storage.'):return storage_management(operation,args)
    if operation.startswith('transfers.'):return transfers().process(operation,args)
    if operation in ('diagnostics','watch'):
        if not isinstance(args,dict) or 'job' not in args or set(args)-{'job','expectedNodeJobId'}:raise ValueError('Invalid diagnostic operation fields')
        expected_node_id=args.get('expectedNodeJobId')
        if 'expectedNodeJobId' in args and (not isinstance(expected_node_id,str) or not re.fullmatch(r'J[a-f0-9]{12}',expected_node_id)):
            raise ValueError('Invalid expected native job identity')
        job=args['job'];validate_job(job,readonly=True)
        spec=ROOT/'jobs'/(job['id']+'.json')
        if spec.exists() and json.loads(spec.read_text())!=job:raise ValueError('Job identity mismatch')
        with closing(sqlite3.connect(f'file:{CONFIG["database"]}?mode=ro',uri=True)) as db:
            row=db.execute('SELECT id FROM jobs WHERE submit_key=?',(job['id'],)).fetchone()
        if row and not spec.exists():raise ValueError('Job identity is unavailable')
        data=gpu('show',row[0]) if row else {'job':{'state':'NOT_SUBMITTED'},'attempts':[]}
        observation={'nativeObservation':job_observation(job,data,expected_node_id)} if expected_node_id is not None else {}
        if operation=='diagnostics':return {**job_diagnostics(job,data),**observation}
        if row is None:observation['dispatchObservation']=dispatch_observation(job)
        state=data.get('job',data);attempts=data.get('attempts',[])
        assigned=attempts[0].get('gpu_indices',[]) if attempts and state.get('state') not in ('SUCCEEDED','FAILED','CANCELED','LOST') else []
        if row and state.get('state') in ('SUCCEEDED','FAILED','CANCELED') and not scheduler_terminal_confirmed(data):
            return {'nodeJobId':row[0],'state':'UNKNOWN','assignedIndices':attempts[0].get('gpu_indices',[]) if attempts else [],
                    **scheduling_status(job,data),**observation,'error':'Job termination is not fully confirmed; card reservation retained'}
        if row and state.get('state') in ('SUCCEEDED','FAILED','CANCELED') and dataset_refs(job) and (ROOT/'jobs'/(job['id']+'.datasets.json')).exists():
            # The periodic lifecycle reconciliation must confirm process
            # cleanup and release leases. A viewer cannot release them.
            return {'nodeJobId':row[0],'state':'UNKNOWN','assignedIndices':[],
                    'error':'Dataset lease cleanup awaits scheduler reconciliation',**scheduling_status(job,data),**observation}
        return {'nodeJobId':row[0] if row else None,'state':state['state'] if row else 'PENDING',
                'assignedIndices':assigned,**scheduling_status(job,data),**observation}
    if operation in ('host.exec','host.status','host.cancel'):return host_command(operation,args)
    if operation.startswith(('projects.snapshot.','projects.sync.','datasets.snapshot.')):
        spec=importlib.util.spec_from_file_location('gpuq_snapshot_sync',HERE/'snapshot-sync.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        return module.SnapshotSync(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals())).process(operation,args)
    if operation.startswith('projects.copy.'):return project_copies().process(operation,args)
    if operation in ('storage.upload.locate','storage.upload.admit'):
        spec=importlib.util.spec_from_file_location('gpuq_dataset_ingress',HERE/'dataset-ingress-node.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return getattr(module,operation.rsplit('.',1)[1])(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()),args)
    if operation.startswith('projects.'):return projects().process(operation,args)
    if operation=='datasets.files.list':
        spec=importlib.util.spec_from_file_location('gpuq_dataset_files',HERE/'dataset-files.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.listing(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()),args)
    if operation.startswith('datasets.upload.'):return dataset_uploads().process(operation,args)
    if operation.startswith('datasets.workspace.'):return data_workspaces().process(operation,args)
    if operation.startswith('datasets.import.'):return data_imports().process(operation,args)
    if operation.startswith('datasets.cloud.'):return cloud_files().process(operation,args)
    if operation in ('datasets.capacity','datasets.list','datasets.status','datasets.prepare','datasets.register','datasets.unregister'):return dataset_op(operation,args)
    if operation in ('terminal.open','terminal.exchange','terminal.close','terminal.detach','terminal.status'):
        if args.get('dataWorkspace') is True and operation=='terminal.open':
            ops=data_workspaces()
            with ops.guard(args):
                ops.writable(args)
                return terminal_op(operation,args)
        if args.get('project') and operation=='terminal.open':
            ops=projects()
            with ops.guard(args):
                ops.writable(args);ops.store.dev_paths(*ops.identity(args))
                return terminal_op(operation,args)
        return terminal_op(operation,args)
    if operation in ('files.upload.status','files.upload.list','files.upload.cancel'):
        allowed={'userId','machine','project','area'}|({'path','uploadId','totalSize','sha256'} if operation=='files.upload.status' else {'uploadId'} if operation=='files.upload.cancel' else set())
        if not args.get('project') or set(args)-allowed:
            raise ValueError('Project upload status requires an exact owned upload identity')
        if args.get('area','code')!='code':raise ValueError('Project upload status is only available for code drafts')
        return projects().files(operation,args)
    if operation.startswith('files.') and operation in ('files.list','files.put','files.get'):
        return projects().files(operation,args) if args.get('project') else file_op(operation,args)
    if operation not in ('sync','cancel','logs','priority'):raise ValueError('Unknown operation')
    if not isinstance(args,dict) or set(args)-({'job','priority','expected','rankOnly','metadata'} if operation=='priority' else {'job','metadata'}):raise ValueError('Invalid job operation fields')
    job=args['job'];policy=validate_job(job);jid=job['id']
    display=None;presentation={'state':'LEGACY'}
    # Cached capabilities can outlive a helper upgrade/downgrade. Presentation
    # must not gate execution reconciliation, and control/logs never spend their
    # request budget on an optional display RPC before the requested operation.
    if 'metadata' in args and operation=='sync':
        try:
            definition=importlib.util.spec_from_file_location('gpuq_console_task_display',HERE/'task-display.py')
            display=importlib.util.module_from_spec(definition);definition.loader.exec_module(display)
        except Exception:
            display=None
            presentation={'state':'UNAVAILABLE','error':'Native task display unavailable; execution identity unchanged'}
        else:
            # Keep the strict submit/sync envelope contract: a forged display
            # actor is rejected before spec persistence or native submission.
            display.validate(job,args['metadata'])
    (ROOT/'jobs').mkdir(parents=True,exist_ok=True,mode=0o700)
    from contextlib import nullcontext
    project_store=projects().store if job.get('project') else None
    with project_store.lifetime(job['userId'],job['project']) if project_store else nullcontext(), open(ROOT/'jobs'/f'{jid}.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        spec=ROOT/'jobs'/f'{jid}.json'
        if operation=='cancel' and dataset_read_mode(job)=='warehouse':
            # Before creating this identity, distinguish a genuinely first
            # cancel from an existing/missing-journal hold. Never infer empty
            # holds from a receipt's absence after the identity was persisted.
            dataset_training_sources().cancel_unseen(job)
        if spec.exists():
            if json.loads(spec.read_text())!=job:raise ValueError('Job identity mismatch')
        else:
            if project_store is not None:project_store.admit(job['userId'],job['project'])
            with open(spec,'x') as f:json.dump(job,f);f.flush();os.fsync(f.fileno())
        # GPUQ is the source of truth for dispatch idempotency, including SSH failures.
        with closing(sqlite3.connect(f'file:{CONFIG["database"]}?mode=ro',uri=True)) as db:
            row=db.execute('SELECT id FROM jobs WHERE submit_key=?',(jid,)).fetchone()
        canceled=ROOT/'jobs'/f'{jid}.canceled'
        attempted=ROOT/'jobs'/f'{jid}.dataset-dispatch-attempted'
        rejected=ROOT/'jobs'/f'{jid}.dataset-not-submitted.json'
        if not row:
            if operation=='priority':raise ValueError('Job is not yet registered with the scheduler; no priority was changed')
            if dataset_refs(job) and os.path.lexists(attempted):
                if operation=='cancel':canceled.touch(mode=0o600,exist_ok=True)
                result={'state':'UNKNOWN','error':'Submission may still be pending; dataset leases and card reservation retained'}
                return job_log_result(job,{'job':{'state':'UNKNOWN'},'attempts':[]},result['error']) if operation=='logs' else result
            if dataset_refs(job) and os.path.lexists(rejected):
                result=reject_unsubmitted_datasets(job,rejected)
                return job_log_result(job,{'job':{'state':'NOT_SUBMITTED'},'attempts':[]},result['error']) if operation=='logs' else result
            if operation=='cancel' or canceled.exists():
                canceled.touch(mode=0o600,exist_ok=True)
                release_datasets(job,never_dispatched=True)
                return {'state':'CANCELED'}
            if operation=='logs':return job_log_result(job,{'job':{'state':'NOT_SUBMITTED'},'attempts':[]},'任务尚未提交到 GPUQ。')
            workspace_storage_check(admission=True)
            if policy['kind']!='legacy':priority_capability()
            if policy['preempt_opt_in_only'] and 'preempt-opt-in-only-v1' not in gpu('status').get('daemon',{}).get('capabilities',[]):raise ValueError('Requester opt-in scope capability unavailable')
            if policy['kind']=='explicit' and not SCHEDULING.ready(CONFIG,HERE):raise ValueError('Training control channel is not ready; no submission attempted')
            if 'elastic' in job:
                if not SCHEDULING.allocation_ready(CONFIG,HERE) or 'elastic-batch-v1' not in gpu('status').get('daemon',{}).get('capabilities',[]):raise ValueError('Elastic scheduler/control channel is not ready; no submission attempted')
            if 'placement' in job:
                placement=job['placement'];caps=gpu('status').get('daemon',{}).get('capabilities',[])
                if not SCHEDULING.allocation_ready(CONFIG,HERE,2) or 'gpu-placement-v1' not in caps or placement['shared'] and 'gpu-sharing-v1' not in caps:raise ValueError('GPU placement/sharing channel is not ready; no submission attempted')
                if placement.get('hami') and not SCHEDULING.hami_ready(CONFIG,HERE,placement['smPercent']):raise ValueError('HAMi runtime is not ready; no submission attempted')
            if job.get('project'):
                projects().store.release(job['userId'],job['project'],job['release'])
                projects().store.run_paths(job['userId'],job['project'],job['release'],jid)
            if dataset_refs(job):
                try:acquire_datasets(job)
                except DatasetNotReady:
                    # The job lock serializes our submit/cancel calls. Re-read
                    # native evidence before issuing a terminal, quota-freeing
                    # result; any ambiguity remains nonterminal.
                    with closing(sqlite3.connect(f'file:{CONFIG["database"]}?mode=ro',uri=True)) as db:
                        native=db.execute('SELECT id FROM jobs WHERE submit_key=?',(jid,)).fetchone()
                    if native or os.path.lexists(attempted):
                        return {'state':'UNKNOWN','error':'Submission outcome is unconfirmed; dataset leases and card reservation retained'}
                    return reject_unsubmitted_datasets(job,rejected)
                # A timed-out submit must not allow cancellation to release a
                # lease while the scheduler may still accept the request.
                atomic_json(attempted,{'jobId':jid})
            scheduling=SCHEDULING.submit_arguments(policy)
            result=gpu('submit',*SCHEDULING.allocation_arguments(job),*scheduling,*oci_submission_arguments(job),'-n','portal-'+jid[:8],'-u',gpuq_owner(job),'--cwd',str(workspace(job['userId'])),'--submit-key',jid,'--','/usr/bin/python3',str(HERE/'sandbox-runner.py'),jid)
            node_id=result['job_id']
        else:node_id=row[0]
        data=gpu('show',node_id);state=data.get('job',data)
        if display is not None:
            try:presentation=display.sync(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()),job,args['metadata'],state)
            except Exception:
                presentation={'state':'UNAVAILABLE','error':'Native task display update unconfirmed; training state unchanged'}
        # Presentation failures must never block cancel or change job lifecycle.
        if operation=='priority':
            expected=args.get('expected');priority=args.get('priority')
            if args.get('rankOnly') is not True:raise ValueError('Rank-only priority update required; upgrade the portal before editing priorities')
            if not isinstance(priority,str) or priority not in PRIORITY_RANKS or not isinstance(expected,dict) or set(expected)!={'priority','yield_policy','restart_policy','dispatch_mode'}:raise ValueError('Invalid expected priority policy')
            if not scheduling_status(job,data)['priorityMutable']:raise ValueError('Only pending safe-policy Console jobs can change priority')
            if expected!={k:state.get(k) for k in expected}:raise ValueError('Priority changed; refresh before retrying')
            priority_capability(rank_only=True)
            gpu('set-rank',node_id,'P'+str(PRIORITY_RANKS[priority]),'--expected-priority','P'+str(expected['priority']),
                '--expected-yield',expected['yield_policy'],'--expected-restart-policy',expected['restart_policy'],'--expected-mode',expected['dispatch_mode'])
            data=gpu('show',node_id);state=data.get('job',data)
        if operation=='logs':
            if not data.get('attempts'):return job_log_result(job,data,'任务正在排队，尚未产生运行日志。')
            return job_log_result(job,data,run([CONFIG['gpu'],'logs','-n','200',node_id])[-200000:])
        if operation=='cancel' and state['state'] not in ('SUCCEEDED','FAILED','CANCELED'):
            gpu('cancel',node_id);data=gpu('show',node_id);state=data.get('job',data)
        attempts=data.get('attempts',[])
        assigned=attempts[0].get('gpu_indices',[]) if attempts and state['state'] not in ('SUCCEEDED','FAILED','CANCELED','LOST') else []
        if state['state'] in ('SUCCEEDED','FAILED','CANCELED') and not scheduler_terminal_confirmed(data):
            return {'nodeJobId':node_id,'state':'UNKNOWN','assignedIndices':attempts[0].get('gpu_indices',[]) if attempts else [],
                    **scheduling_status(job,data),'error':'Job termination is not fully confirmed; card reservation retained'}
        if dataset_refs(job) and state['state'] in ('SUCCEEDED','FAILED','CANCELED') and not release_datasets(job,data):
            return {'nodeJobId':node_id,'state':'UNKNOWN','assignedIndices':assigned,'error':'Job termination is not fully confirmed; dataset leases retained'}
        return {'nodeJobId':node_id,'state':state['state'],'assignedIndices':assigned,**scheduling_status(job,data),
                **({'displaySync':presentation} if 'metadata' in args else {})}

TERMINAL_STREAM_PROTOCOL='terminal-exchange-stream-v1'
TERMINAL_CONTEXT_FIELDS={'userId','username','id','clientId','writerToken','hostAdmin','dataWorkspace','project'}
TERMINAL_FRAME_BYTES=32768

class BoundedRPCInput:
    """Unbuffered framing so a prefetched second frame cannot evade idle timeout."""
    def __init__(self,fd):self.fd=fd;self.pending=bytearray()
    def line(self,limit,deadline):
        while True:
            if time.monotonic()>=deadline:raise TimeoutError('Terminal stream expired')
            end=self.pending.find(b'\n')
            if end>=0:
                if end+1>limit:raise ValueError('Terminal frame too large')
                raw=bytes(self.pending[:end+1]);del self.pending[:end+1];return raw
            if len(self.pending)>limit:raise ValueError('Terminal frame too large')
            remaining=deadline-time.monotonic()
            if remaining<=0 or not select.select([self.fd],[],[],remaining)[0]:raise TimeoutError('Terminal stream expired')
            raw=os.read(self.fd,min(65536,limit+1-len(self.pending)))
            if not raw:
                raw=bytes(self.pending);self.pending.clear();return raw
            self.pending.extend(raw)
    def rest(self,first,limit):
        raw=bytearray(first);raw.extend(self.pending);self.pending.clear()
        while len(raw)<=limit:
            part=os.read(self.fd,min(65536,limit+1-len(raw)))
            if not part:return bytes(raw)
            raw.extend(part)
        raise ValueError('Request too large')

def terminal_runtime_stamp():
    # Cache code, never permission. Detect replacement, modification, addition
    # and removal across the actual local Python closure and configuration.
    out=[]
    for path in sorted(HERE.iterdir()):
        if path.suffix[1:]!='py' and path.name not in ('node-config.json','node-runtime.json'):continue
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise ValueError('Terminal runtime changed')
        out.append((path.name,info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_uid,info.st_gid,info.st_mode))
    return tuple(out)

def terminal_stream_context(context):
    required={'userId','username','id','clientId','writerToken'}
    if (not isinstance(context,dict) or not required<=set(context) or set(context)-TERMINAL_CONTEXT_FIELDS
            or not all(isinstance(context[key],str) and UUID.fullmatch(context[key]) for key in ('id','clientId','writerToken'))
            or not isinstance(context['userId'],str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]{1,18})',context['userId'])
            or not isinstance(context['username'],str) or not re.fullmatch(r'[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}',context['username'])
            or any(type(context[key]) is not bool for key in ('hostAdmin','dataWorkspace') if key in context)):
        raise ValueError('Invalid terminal stream context')
    if context.get('hostAdmin') and not CONFIG.get('hostRoot',False):raise ValueError('Host root terminal is disabled on this node')
    if context.get('project') is not None and (not isinstance(context['project'],str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,47}',context['project'])):
        raise ValueError('Invalid terminal stream context')
    if context.get('dataWorkspace') and (context.get('hostAdmin') or context.get('project')):raise ValueError('Invalid terminal stream context')
    terminal_owned(context,context['id'])
    receipt=terminal_metadata(ROOT/'terminals'/(context['id']+'.session.json'))
    if (receipt.get('clientId')!=context['clientId'] or receipt.get('writerToken')!=context['writerToken']
            or receipt.get('state')!='OPEN' or receipt.get('leaseExpiresAt',0)<=time.time()):
        raise ValueError('Terminal writer lease expired or was taken over; reconnect explicitly')

def serve_terminal_stream(header,reader,write):
    if not isinstance(header,dict) or set(header)!={'protocol','context'} or header['protocol']!=TERMINAL_STREAM_PROTOCOL:
        raise ValueError('Invalid terminal stream handshake')
    began=last=time.monotonic();stamp=terminal_runtime_stamp()
    if (HERE/'node-config.json').read_bytes()!=INITIAL_CONFIG_BYTES:raise ValueError('Terminal runtime changed')
    platform_root_check();terminal_stream_context(header['context'])
    write({'protocol':TERMINAL_STREAM_PROTOCOL,'ready':True})
    for sequence in range(1024):
        raw=reader.line(TERMINAL_FRAME_BYTES,min(began+60,last+15))
        if not raw:return
        if not raw.endswith(b'\n'):raise ValueError('Incomplete terminal stream frame')
        data=json.loads(raw)
        if (not isinstance(data,dict) or set(data)!={'sequence','args'} or type(data['sequence']) is not int
                or data['sequence']!=sequence or not isinstance(data['args'],dict)
                or set(data['args'])-TERMINAL_CONTEXT_FIELDS-{'input','offset','rows','cols'}
                or {key:value for key,value in data['args'].items() if key in TERMINAL_CONTEXT_FIELDS}!=header['context']):
            raise ValueError('Terminal stream context or sequence changed')
        if terminal_runtime_stamp()!=stamp:raise ValueError('Terminal runtime changed')
        try:
            # Includes root mount validation and the on-disk writer fence every
            # time. A channel never caches the result of either authorization.
            result=process('terminal.exchange',data['args'])
            if terminal_runtime_stamp()!=stamp:raise ValueError('Terminal runtime changed after input; refresh without replay')
            response={'sequence':sequence,'ok':True,'result':result}
        except Exception as error:
            write({'sequence':sequence,'ok':False,'error':str(error)[:400]});return
        write(response);last=time.monotonic()
    return

def write_rpc_line(value):
    raw=(json.dumps(value,separators=(',',':'))+'\n').encode()
    if len(raw)>1048576:raise ValueError('Terminal response too large')
    sys.stdout.buffer.write(raw);sys.stdout.buffer.flush()

DATASET_FILES_RPC_OPERATIONS=('datasets.list','datasets.capacity','datasets.files.list')

def dataset_files_rpc(data):
    """Separate immutable forced path: metadata and owner-bound directory only.

    Not an upgrade to an upload key or the pinned general-purpose executor.
    The bridge chooses this trusted path; callers cannot request another RPC.
    """
    if (not isinstance(data,dict) or set(data)!={'operation','args'}
            or data['operation'] not in DATASET_FILES_RPC_OPERATIONS
            or not isinstance(data['args'],dict)):
        raise ValueError('Invalid dataset metadata RPC')
    return process(data['operation'],data['args'])

if __name__=='__main__':
    os.umask(0o077)
    upload_ingress_only=len(sys.argv)==2 and sys.argv[1]=='--dataset-upload-ingress-rpc'
    platform_root_check()
    if len(sys.argv)==3 and sys.argv[1]=='--storage-archive-worker':sys.exit(storage_archive().worker(sys.argv[2]))
    if len(sys.argv)==4 and sys.argv[1]=='--dataset-delete-worker':sys.exit(dataset_retirement_worker(sys.argv[2],sys.argv[3]))
    if len(sys.argv)==2 and sys.argv[1]=='--storage-collect':
        print(json.dumps(storage_collect()));sys.exit(0)
    if len(sys.argv)==4 and sys.argv[1]=='--transfer-worker':sys.exit(transfers().worker(sys.argv[2],int(sys.argv[3])))
    if len(sys.argv)==4 and sys.argv[1]=='--training-transfer-worker':sys.exit(transfers().worker(sys.argv[2],int(sys.argv[3]),require_training=True))
    if len(sys.argv)==4 and sys.argv[1]=='--project-copy-worker':sys.exit(project_copies().worker(sys.argv[2],int(sys.argv[3])))
    if len(sys.argv)==2 and sys.argv[1]=='--transfer-peer-daemon':
        spec=importlib.util.spec_from_file_location('gpuq_transfer_peer',HERE/'transfer-peer.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        module.serve(sys.modules[__name__],transfers(),authority=storage_authority(),copies=project_copies);sys.exit(0)
    if len(sys.argv)==2 and sys.argv[1]=='--direct-upload-daemon':
        spec=importlib.util.spec_from_file_location('gpuq_direct_upload',HERE/'direct-upload.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        module.serve(dataset_ingress_view(),dataset_uploads());sys.exit(0)
    if len(sys.argv)==3 and sys.argv[1]=='--dataset-worker':sys.exit(dataset_worker(sys.argv[2]))
    if len(sys.argv)==3 and sys.argv[1]=='--training-dataset-worker':
        spec=importlib.util.spec_from_file_location('gpuq_training_preparation',HERE/'training-preparation.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        sys.exit(module.dataset_worker(sys.modules[__name__],sys.argv[2]))
    if len(sys.argv)==3 and sys.argv[1]=='--dataset-cache-worker':sys.exit(dataset_cache_actions().release_worker(sys.argv[2]))
    if len(sys.argv)==5 and sys.argv[1]=='--dataset-upload-worker':sys.exit(dataset_uploads().worker(*sys.argv[2:]))
    if len(sys.argv)==4 and sys.argv[1]=='--data-workspace-worker':sys.exit(data_workspaces().worker(*sys.argv[2:]))
    if len(sys.argv)==5 and sys.argv[1]=='--data-import-worker':sys.exit(data_imports().worker(*sys.argv[2:]))
    if len(sys.argv)==5 and sys.argv[1]=='--cloud-files-worker':sys.exit(cloud_files().worker(*sys.argv[2:]))
    if len(sys.argv)==4 and sys.argv[1]=='--data-workspace-recover':
        print(json.dumps(data_workspaces().recover(*sys.argv[2:])));sys.exit(0)
    if len(sys.argv) in (3,5) and sys.argv[1]=='--project-worker':sys.exit(projects().worker(*sys.argv[2:]))
    if len(sys.argv)==5 and sys.argv[1]=='--project-local-import-worker':sys.exit(projects().local_imports().worker(*sys.argv[2:]))
    try:
        files_rpc_mode=len(sys.argv)==2 and sys.argv[1]=='--dataset-files-rpc'
        reader=BoundedRPCInput(sys.stdin.fileno())
        first=reader.line(1600000,time.monotonic()+27)
        try:header=json.loads(first)
        except (ValueError,UnicodeDecodeError):header=None
        if isinstance(header,dict) and header.get('protocol')==TERMINAL_STREAM_PROTOCOL:
            if upload_ingress_only:raise ValueError('Terminal streams are not allowed by the upload ingress key')
            if files_rpc_mode:raise ValueError('Terminal streams are not allowed by the dataset metadata key')
            if len(first)>TERMINAL_FRAME_BYTES or not first.endswith(b'\n'):raise ValueError('Invalid terminal stream handshake')
            serve_terminal_stream(header,reader,write_rpc_line);sys.exit(0)
        raw=reader.rest(first,1600000)
        data=json.loads(raw)
        if upload_ingress_only:require_upload_ingress_operation(data['operation'])
        if files_rpc_mode:result=dataset_files_rpc(data)
        else:result=process(data['operation'],data['args'])
        print(json.dumps({'ok':True,'result':result}))
    except Exception as e:print(json.dumps({'ok':False,'error':str(e)[:400]}))
