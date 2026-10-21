#!/usr/bin/python3
"""Authenticated node operations; all user commands execute in project OCI containers."""
import base64,contextlib,fcntl,importlib.util,json,os,re,select,sqlite3,socket,subprocess,sys,time,uuid
from pathlib import Path
from contextlib import closing
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent

def module(name):
    s=importlib.util.spec_from_file_location('stargate_'+name.replace('-','_'),HERE/(name+'.py'))
    m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);return m

RUNTIME_PROFILE=module('runtime-profile')
CONFIG_PATH=RUNTIME_PROFILE.config_path(HERE)
CONFIG=json.loads(RUNTIME_PROFILE.read_private(CONFIG_PATH))
ROOT=Path(CONFIG['root'])
ENV={'PATH':'/usr/bin:/bin','HOME':str(Path.home()),'LANG':'C.UTF-8','XDG_RUNTIME_DIR':'/run/user/'+str(os.getuid()),'DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/'+str(os.getuid())+'/bus'}
UUID=re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
SCHEDULING=module('scheduling-policy')
PRIORITY_RANKS={'idle':0,'normal':2,'high':4,**{'P'+str(i):i for i in range(5)}}
DIAGNOSTICS=None
PROJECT_OPS=None

def platform_root_check():return module('local-data').require_data_path(CONFIG,ROOT)

def projects():
    global PROJECT_OPS
    if PROJECT_OPS is None:PROJECT_OPS=module('project-ops').ProjectOperations(sys.modules[__name__])
    return PROJECT_OPS

def atomic_json(path,data):return module('project-store').atomic_json(path,data)

def run(argv,timeout=18):
    argv,env=RUNTIME_PROFILE.child_command(argv,ENV,gpu=CONFIG.get('gpu'))
    result=subprocess.run(argv,env=env,text=True,capture_output=True,timeout=timeout)
    if result.returncode:raise ValueError(result.stderr[-1200:] or '节点操作失败，请按原编号查询。')
    return result.stdout

def gpu(*args):return json.loads(run([CONFIG['gpu'],'--json',*args]))

def gpuq_owner(job):return 'portal:'+job['userId']

def workspace(user):return module('local-data').root(CONFIG,'workspacesRoot')

def transfers():return module('transfer-jobs').TransferJobs(sys.modules[__name__])

def data_imports():return module('data-import').DataImports(sys.modules[__name__])

def cloud_files():return module('cloud-files').CloudFiles(sys.modules[__name__])

def scheduling_status(job,data):
    state=data.get('job',data);attempts=data.get('attempts',[])
    return {'schedulerState':state.get('state'),'schedulerPriority':state.get('priority'),
            'priorityMutable':state.get('state')=='PENDING','queueReason':state.get('state_reason'),
            'schedulerPolicy':{k:state.get(k) for k in ('priority','yield_policy','restart_policy','dispatch_mode')},
            'progress':data.get('progress'),'gpuMetrics':data.get('gpuMetrics'),
            'latestAttempt':attempts[0] if attempts else None}

def scheduler_finished(data):
    # Native state already reflects GPUQ process cleanup; no second completion check.
    return data.get('job',data).get('state') in ('SUCCEEDED','FAILED','CANCELED','LOST')

def validate_job(job):
    if not isinstance(job,dict) or not isinstance(job.get('id'),str) or not UUID.fullmatch(job['id']):raise ValueError('任务编号无效。')
    module('local-data').name(job['userId']);module('local-data').name(job['project'])
    if type(job.get('cards')) is not int or not 1<=job['cards']<=CONFIG['cards']:raise ValueError('GPU数量超出节点额度。')
    if not isinstance(job.get('argv'),list) or not job['argv'] or any(not isinstance(a,str) or '\0' in a for a in job['argv']):raise ValueError('命令参数无效。')
    if sum(len(a.encode())+1 for a in job['argv'])>1024**2:raise ValueError('命令参数不能超过1MiB。')
    SCHEDULING.elastic_allocation(job);SCHEDULING.gpu_placement(job)
    return SCHEDULING.normalize_job_policy(job)

def native(job):
    with closing(sqlite3.connect('file:'+CONFIG['database']+'?mode=ro',uri=True)) as db:
        row=db.execute('SELECT id FROM jobs WHERE submit_key=?',(job['id'],)).fetchone()
    return row[0] if row else None

def job_operation(operation,args):
    fields={'id','userId','username','project','cards','argv','name','minVramGiB','memoryLimitGiB','ownerId','interactive','workspace','scheduling','placement','elastic','projectCopy','after'}
    supplied={k:v for k,v in args['job'].items() if k in fields}
    for k,keys in {'scheduling':{'rank','yieldPolicy','restartPolicy','checkpointable','mode'},'placement':{'gpuIndices','shared','vramMiB','smPercent','hami'},'elastic':{'minCards','globalBatch','microBatch','autoExpand'}}.items():
        if isinstance(supplied.get(k),dict):supplied[k]={n:v for n,v in supplied[k].items() if n in keys}
    validate_job(supplied);jid=supplied['id']
    folder=module('project-store').private_dir(ROOT/'jobs',create=True)
    lock=os.open(folder/(jid+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        module('project-store').wait_project_lock(lock,fcntl.LOCK_EX,'任务忙，请按原编号查询。')
        file=folder/(jid+'.json')
        if file.exists():
            job=module('project-store').read_json(file)
            if operation=='sync' and job!=supplied:raise ValueError('原任务编号已用于不同请求，请恢复原请求。')
        else:
            job=supplied
            if operation=='sync':
                if job.get('projectCopy'):module('project-store').read_json(module('project-copy').runtime_folder(CONFIG,job['projectCopy'])/'project.json')
                else:projects().store.admit(job.get('ownerId') or job['userId'],job['project'])
            if operation in ('sync','cancel'):atomic_json(file,job)
        node_id=native(job)
        dispatched=folder/(jid+'.dispatch.json');canceled=folder/(jid+'.canceled.json')
        if node_id is None and operation=='cancel':
            state='CANCEL_REQUESTED' if dispatched.exists() else 'CANCELED'
            atomic_json(canceled,{'state':state})
            if state=='CANCELED' and job.get('projectCopy'):transfers().finish_runtime(job['projectCopy'])
            return {'state':'UNKNOWN' if state=='CANCEL_REQUESTED' else state,'error':'未知，请按原编号查询。' if state=='CANCEL_REQUESTED' else None}
        if node_id is None and operation=='sync':
            if canceled.exists():
                state=module('project-store').read_json(canceled)['state']
                if state=='CANCELED' and job.get('projectCopy'):transfers().finish_runtime(job['projectCopy'])
                return {'state':'CANCELED' if state=='CANCELED' else 'UNKNOWN','error':'未知，请按原编号查询。' if state!='CANCELED' else None}
            if job.get('interactive'):
                terminal_folder=module('project-store').private_dir(ROOT/'terminals',create=True)
                atomic_json(terminal_folder/(jid+'.json'),job)
                if not (terminal_folder/(jid+'.session.json')).exists():atomic_json(terminal_folder/(jid+'.session.json'),{'state':'DETACHED','clientId':None,'leaseExpiresAt':0})
            policy=SCHEDULING.normalize_job_policy(args['job'])
            resources=module('job-resources').requested_limits(job,False,CONFIG)
            # Scheduler uses the original UUID to prevent repeated submissions.
            atomic_json(dispatched,{'state':'SUBMITTING'})
            result=gpu('submit',*SCHEDULING.allocation_arguments(job),*SCHEDULING.submit_arguments(policy),
                *(item for dependency in job.get('after',[]) for item in ('--after',dependency)),
                '--env','GPUQ_CONSOLE_OCI=1','-n','portal-'+jid[:8],'-u',gpuq_owner(job),
                '--cwd',str(workspace(job['userId'])),'--submit-key',jid,'--','/usr/bin/python3',str(HERE/'oci-runner.py'),jid)
            node_id=result['job_id']
        # No GPUQ row for this submit key: safe to resubmit, GPUQ dedups by the original key.
        if node_id is None:return {'state':'UNKNOWN','schedulerState':'NOT_SUBMITTED','error':'未知，请按原编号查询。','assignedIndices':[]}
        data=gpu('show',node_id);state=data.get('job',data)
        if (operation=='cancel' or canceled.exists()) and state.get('state') not in ('SUCCEEDED','FAILED','CANCELED'):
            gpu('cancel',node_id);data=gpu('show',node_id);state=data.get('job',data)
        if operation=='priority':
            rank=args['priority']
            if rank not in PRIORITY_RANKS:raise ValueError('请选择有效的任务优先级。')
            gpu('set-rank',node_id,'P'+str(PRIORITY_RANKS[rank]))
            data=gpu('show',node_id);state=data.get('job',data)
        if job.get('projectCopy') and scheduler_finished(data):transfers().finish_runtime(job['projectCopy'])
        if operation=='logs':return job_log_result(job,data,run([CONFIG['gpu'],'logs','-n','200',node_id])[-200000:])
        if operation=='diagnostics':return job_diagnostics(job,data)
        if 'metadata' in args:
            try:module('task-display').sync(sys.modules[__name__],job,args['metadata'],state)
            except Exception:pass  # Display edits do not change the task result.
        attempts=data.get('attempts',[])
        return {'nodeJobId':node_id,'state':state.get('state','UNKNOWN'),
                'assignedIndices':attempts[0].get('gpu_indices',[]) if attempts and not scheduler_finished(data) else [],
                'error':state.get('state_reason') if job.get('after') and state.get('state')=='CANCELED' else None,
                **scheduling_status(job,data)}
    finally:os.close(lock)


def terminal_unit_observation(jid):
    props=run(['/usr/bin/systemctl','--user','show','amax-term-'+jid+'.service','--property=ActiveState,SubState,MainPID,ControlGroup'],timeout=5)
    return dict(l.split('=',1) for l in props.splitlines() if '=' in l)

def terminal_alive(folder,jid):
    try:
        spec_file=folder/(jid+'.json')
        if spec_file.exists():
            spec=module('project-store').read_json(spec_file)
            if spec.get('interactive'):
                node_id=native(spec)
                if node_id is None:return None
                state=gpu('show',node_id).get('job',{})
                if state.get('state') in ('RUNNING','STARTING','PREEMPTING'):return True
                if state.get('state') in ('SUCCEEDED','FAILED','CANCELED','LOST'):return False
                return None
        state=terminal_unit_observation(jid)
    except (ValueError,subprocess.TimeoutExpired):return None
    if state.get('ActiveState') in ('active','activating','deactivating'):return True
    if state.get('ActiveState') in ('inactive','failed') and state.get('MainPID')=='0':return False
    return None

def terminal_output():return module('terminal-output')

def terminal_absent(folder,jid):
    # Caller holds this ID's exclusive lock, including when voiding a late open.
    try:
        if any((folder/(jid+suffix)).exists() for suffix in ('.json','.session.json','.sock')):return False
        props=run(['/usr/bin/systemctl','--user','show','amax-term-'+jid+'.service','--property=LoadState,ActiveState,MainPID'],timeout=5)
        state=dict(line.split('=',1) for line in props.splitlines() if '=' in line)
        if state.get('LoadState')!='not-found':return False
        atomic_json(folder/(jid+'.void.json'),{'id':jid,'voidedAt':time.time()})
        return True
    except Exception:return False

def terminal_missing(folder,jid):
    return {'id':jid,'state':'NOT_FOUND','canCreate':True,'created':False} if terminal_absent(folder,jid) else {'id':jid,'state':'UNKNOWN'}

def terminal_status(args):
    folder=ROOT/'terminals';rows=[]
    ids=[args['id']] if args.get('id') else [p.stem for p in folder.glob('*.json') if UUID.fullmatch(p.stem)]
    for jid in ids:
        if not UUID.fullmatch(jid):raise ValueError('终端编号无效。')
        try:spec=module('project-store').read_json(folder/(jid+'.json'))
        except FileNotFoundError:
            if not args.get('id'):continue
            fd=None
            try:
                folder=module('project-store').private_dir(folder,create=True)
                fd=os.open(folder/(jid+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
                module('project-store').wait_project_lock(fd,fcntl.LOCK_EX,'终端忙，请按原编号稍后查询。')
                if not (folder/(jid+'.json')).exists():return terminal_missing(folder,jid)
                spec=module('project-store').read_json(folder/(jid+'.json'))
            except Exception:return {'id':jid,'state':'UNKNOWN'}
            finally:
                if fd is not None:os.close(fd)
        live=terminal_alive(folder,jid)
        rows.append({**spec,'id':jid,'state':('ALIVE' if args.get('id') else 'RUNNING') if live is True else 'STOPPED' if live is False else 'UNKNOWN',
                     'alive':live,'readOnly':live is not True})
    if args.get('id'):return rows[0] if rows else {'id':args['id'],'state':'UNKNOWN'}
    return {'sessions':rows}

def terminal_op(operation,args):
    if args.get('hostAdmin'):raise ValueError('平台不提供宿主终端。')
    if operation=='terminal.status':return terminal_status(args)
    folder=module('project-store').private_dir(ROOT/'terminals',create=True)
    opening=operation=='terminal.open';mode=args.get('mode','new')
    jid=args.get('key') if opening and mode=='new' else args.get('id')
    if not isinstance(jid,str) or not UUID.fullmatch(jid):raise ValueError('终端编号无效。')
    file=folder/(jid+'.json');session=folder/(jid+'.session.json')
    fd=os.open(folder/(jid+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        module('project-store').wait_project_lock(fd,fcntl.LOCK_EX,'终端忙，请重连原会话。')
        if opening and mode=='new' and (folder/(jid+'.void.json')).exists():
            return {'id':jid,'state':'NOT_FOUND','canCreate':True,'created':False,'error':'这个终端连接键已确认未创建并作废，请重新新建终端。'}
        if not file.exists() and (not opening or mode!='new'):return terminal_missing(folder,jid)
        session_state=module('project-store').read_json(session) if session.exists() else None
        if opening:
            if not file.exists():
                projects().store.admit(args.get('ownerId') or args['userId'],args['project'])
                spec={'id':jid,'userId':args['userId'],'ownerId':args.get('ownerId') or args['userId'],'username':args.get('username'),'project':args['project'],
                      'cards':0,'argv':['/bin/bash','--noprofile','--norc','-i'],'hostAdmin':False}
                atomic_json(file,spec)
                session_state={'clientId':args['clientId'],'writerToken':str(uuid.uuid4()),'state':'OPEN','leaseExpiresAt':time.time()+30}
                atomic_json(session,session_state)
                # The terminal shares the persistent OCI environment with all jobs.
                command=['/usr/bin/systemd-run','--user','--collect','--unit=amax-term-'+jid,
                    '--property=KillMode=control-group','--property=KillSignal=SIGHUP','--property=TimeoutStopSec=5',
                    '--property=Delegate=yes','--property=MemoryMax=8G',
                    '--property=CPUQuota=200%','--property=TasksMax=2048']
                if CONFIG.get('memoryPool'):command+=['--slice=gpuq-workloads.slice','--property=OOMPolicy=kill']
                run(command+['/usr/bin/python3',str(HERE/'terminal-helper.py'),jid])
            elif session_state is not None and session_state.get('clientId')!=args['clientId'] and session_state.get('leaseExpiresAt',0)>time.time() and not args.get('takeover'):
                return {'id':jid,'state':'BUSY','takeoverRequired':True}
            else:
                writer=session_state.get('writerToken') if session_state and session_state.get('clientId')==args['clientId'] and not args.get('takeover') else str(uuid.uuid4())
                session_state=session_state or {};session_state.update(clientId=args['clientId'],writerToken=writer,leaseExpiresAt=time.time()+30,state='OPEN')
                atomic_json(session,session_state)
            live=terminal_alive(folder,jid)
            return {'id':jid,'clientId':args['clientId'],'writerToken':session_state['writerToken'],'leaseExpiresAt':session_state['leaseExpiresAt'],
                    'state':'OPEN' if live else 'UNKNOWN' if live is None else 'STOPPED','readOnly':live is False,'hostAdmin':False}
        # The writer token authenticates one PTY writer; any team member may explicitly take over.
        if args.get('writerToken') and (session_state is None or not __import__('hmac').compare_digest(session_state.get('writerToken',''),args['writerToken'])):
            raise PermissionError('终端连接已被接管，请重新连接。')
        if operation=='terminal.detach':
            if session_state:session_state.update(state='DETACHED',leaseExpiresAt=0);atomic_json(session,session_state)
            return {'id':jid,'detached':True,**terminal_status({'id':jid})}
        if operation=='terminal.close':
            spec=module('project-store').read_json(file)
            if spec.get('interactive'):job_operation('cancel',{'job':spec})
            else:
                try:run(['/usr/bin/systemctl','--user','stop','amax-term-'+jid+'.service'])
                except ValueError as e:
                    if 'not loaded' not in str(e):raise  # Shell already exited and its unit was collected.
            if session_state:session_state['state']='CLOSED';atomic_json(session,session_state)
            return terminal_status({'id':jid})
        if operation=='terminal.exchange':
            if not args.get('writerToken'):raise PermissionError('请先连接终端。')
            if session_state:
                session_state['leaseExpiresAt']=time.time()+30;atomic_json(session,session_state)
            sock=folder/(jid+'.sock')
            if not sock.exists():
                live=terminal_alive(folder,jid)
                if live is False:return terminal_output().read_output(folder,jid,args.get('offset',0),exited=True)
                return {'state':'UNKNOWN','error':'终端暂未响应，请重连原会话；输入结果未知时不要重放。'}
            request={k:args[k] for k in ('input','offset','rows','cols') if k in args}
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(3);connection.connect(str(sock));connection.sendall((json.dumps(request)+'\n').encode())
                with connection.makefile('rb') as stream:return json.loads(stream.readline(1024**2))
        raise ValueError('此终端操作不存在。')
    finally:os.close(fd)


def process(operation,args):
    platform_root_check()
    if operation=='jobs.reconcile-resources':return job_operation('watch',args)
    if operation.startswith('projects.') or operation.startswith('files.') and args.get('project') and args.get('area')!='output':
        if operation=='files.direct.prepare':return module('direct-upload').DirectUploads(sys.modules[__name__]).issue(args)
        return projects().process(operation,args)
    if operation=='datasets.list':return module('dataset-files').datasets(CONFIG)
    if operation in ('files.list','files.get','files.stat'):
        if args.get('area')=='output':
            jid=args['runId']
            root=projects().store.workspace_output('','',jobid=jid,create=False)
            return module('dataset-files').process(CONFIG,operation,args,root=root)
        return module('dataset-files').process(CONFIG,operation,args)
    if operation=='files.direct.prepare':return module('direct-upload').DirectUploads(sys.modules[__name__]).issue(args)
    if operation.startswith('data.upload.'):
        root=projects().store.dev_paths(args.get('ownerId',args['userId']),args['project'])['code'] if args.get('project') else None
        return module('data-uploads').dispatch(CONFIG,operation,args,root=root)
    if operation=='datasets.delete':
        root=module('local-data').dataset_root(CONFIG,args['dataset'])
        return module('project-purge').Trash(CONFIG).delete(root,args['key'],'dataset',args.get('actor',{'userId':args['userId']}),dataset=args['dataset'])
    if operation=='outputs.delete':return module('outputs-delete').process(sys.modules[__name__],args)
    if operation.startswith('transfers.'):return transfers().process(operation,args)
    if operation.startswith('datasets.import.'):return data_imports().process(operation,args)
    if operation.startswith('datasets.cloud.'):return cloud_files().process(operation,args)
    if operation.startswith('terminal.'):return terminal_op(operation,args)
    if operation in ('tasks.display.get','tasks.display.set'):return module('task-display').edit(sys.modules[__name__],operation,args)
    if operation in ('sync','watch','cancel','logs','diagnostics','priority','reconcile-resources'):return job_operation(operation,args)
    raise ValueError('此节点操作不存在。')

TERMINAL_STREAM_PROTOCOL='terminal-exchange-stream-v1'
TERMINAL_CONTEXT_FIELDS={'userId','username','id','clientId','writerToken','hostAdmin','project'}
TERMINAL_FRAME_BYTES=32768

def job_diagnostics(job,data):
    global DIAGNOSTICS
    if DIAGNOSTICS is None:
        spec=importlib.util.spec_from_file_location('gpuq_job_diagnostics',HERE/'job-diagnostics.py')
        DIAGNOSTICS=importlib.util.module_from_spec(spec);spec.loader.exec_module(DIAGNOSTICS)
    return DIAGNOSTICS.bundle(ROOT,job,data)

def job_log_result(job,data,text):
    try:
        package=job_diagnostics(job,data)
        footer=DIAGNOSTICS.summary(package)
    except Exception:
        footer='\n\n[GPUQ 诊断暂不可用；不据此判断 worker 健康或改变任务终态]\n查看：gpuctl diagnostics '+job['id']+' --json\n'
    return {'text':text+footer}

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

def write_rpc_line(value):
    raw=(json.dumps(value,separators=(',',':'))+'\n').encode()
    if len(raw)>1048576:raise ValueError('Terminal response too large')
    sys.stdout.buffer.write(raw);sys.stdout.buffer.flush()

def serve_terminal_stream(header,reader,write):
    context=header.get('context',{});sequence=0
    write({'ok':True,'protocol':TERMINAL_STREAM_PROTOCOL})
    while True:
        raw=reader.line(TERMINAL_FRAME_BYTES,time.monotonic()+25)
        if not raw:return
        request=json.loads(raw)
        try:result=process('terminal.exchange',{**context,**request.get('args',{})});write({'ok':True,'sequence':request.get('sequence',sequence),'result':result})
        except Exception as error:write({'ok':False,'sequence':request.get('sequence',sequence),'error':str(error)[:400]});return
        sequence+=1

if __name__=='__main__':
    os.umask(0o077)
    try:
        if len(sys.argv)>1:
            action=sys.argv[1]
            if action=='--project-init-worker':raise SystemExit(projects().initialize(sys.argv[2],sys.argv[3]))
            if action=='--transfer-worker':raise SystemExit(transfers().worker(sys.argv[2]))
            if action=='--project-copy-export-worker':raise SystemExit(module('project-copy').ProjectCopy(transfers()).export(sys.argv[2]))
            if action=='--project-copy-cleanup-worker':
                try:transfers().cleanup_runtime(sys.argv[2])
                except Exception as error:raise SystemExit(str(error)[:400])
                raise SystemExit(0)
            if action=='--transfer-peer-daemon':module('transfer-peer').serve(sys.modules[__name__],transfers());raise SystemExit(0)
            if action=='--direct-upload-daemon':module('direct-upload').serve(sys.modules[__name__]);raise SystemExit(0)
            if action=='--storage-collect':print(json.dumps(module('project-purge').Trash(CONFIG).collect()));raise SystemExit(0)
            if action=='--data-import-worker':raise SystemExit(data_imports().worker(sys.argv[2]))
            if action=='--cloud-files-worker':raise SystemExit(cloud_files().worker(sys.argv[2]))
        reader=BoundedRPCInput(sys.stdin.fileno());first=reader.line(1600000,time.monotonic()+27)
        try:header=json.loads(first)
        except ValueError:header=None
        if isinstance(header,dict) and header.get('protocol')==TERMINAL_STREAM_PROTOCOL:
            serve_terminal_stream(header,reader,write_rpc_line)
        else:
            request=json.loads(reader.rest(first,1600000))
            if request['operation']=='datasets.list' or request['operation']=='projects.list' and request['args'].get('includeUsage') is True:
                os.setpriority(os.PRIO_PROCESS,0,19)
                subprocess.run(['/usr/bin/ionice','-c3','-p',str(os.getpid())],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            print(json.dumps({'ok':True,'result':process(request['operation'],request['args'])}))
    except Exception as error:print(json.dumps({'ok':False,'error':str(error)[:400]}))
