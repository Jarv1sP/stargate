"""Bound terminal keyring use and reclaim only detached, shell-only terminals."""
import contextlib,fcntl,os,sqlite3,subprocess,time
from pathlib import Path

IDLE_SECONDS=24*60*60
OPEN_LIMIT=20  # User-approved resource ceiling: each OCI terminal consumes a kernel keyring.
CGROUP_ROOT=Path('/sys/fs/cgroup')
PROC_ROOT=Path('/proc')
SHELL=['/bin/bash','--noprofile','--norc','-i']


class Terminals:
    def __init__(self,node):
        self.node=node;self.folder=node.ROOT/'terminals';self.store=node.module('project-store')

    def specs(self):
        for path in self.folder.glob('*.json'):
            if not self.node.UUID.fullmatch(path.stem):continue
            if any(path.with_name(path.stem+suffix).exists() for suffix in ('.exit.json','.void.json')):continue
            yield self.store.read_json(path)

    def units(self):
        try:
            output=self.node.run(['/usr/bin/systemctl','--user','list-units','--all','--plain','--no-legend','--no-pager','amax-term-*'],timeout=1)
        except (OSError,ValueError,subprocess.TimeoutExpired):return None
        states={}
        for line in output.splitlines():
            fields=line.split()
            if len(fields)<4 or not fields[0].startswith('amax-term-') or not fields[0].endswith('.service'):continue
            states[fields[0][len('amax-term-'):-len('.service')]]=True if fields[2] in ('active','activating','deactivating') else False if fields[2] in ('inactive','failed') else None
        return states

    def gpu_states(self):
        # One read snapshot replaces a native lookup plus gpu show for every historical terminal.
        try:
            with contextlib.closing(sqlite3.connect('file:'+self.node.CONFIG['database']+'?mode=ro',uri=True,timeout=0.5)) as db:
                return dict(db.execute('SELECT submit_key,state FROM jobs'))
        except sqlite3.Error:return None

    @contextlib.contextmanager
    def locked(self,args):
        # Runtime project copies can outlive the original project's directory.
        data=self.node.module('local-data');owner=data.name(args.get('ownerId') or args['userId']);project=data.name(args['project'])
        locks=self.store.private_dir(self.folder/'.admission',create=True)
        locks=self.store.private_dir(locks/owner,create=True)
        fd=os.open(locks/(project+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:self.store.wait_project_lock(fd,fcntl.LOCK_EX,'终端新建繁忙，请沿原编号稍后重试。');yield
        finally:os.close(fd)

    def admission(self,args):
        owner=args.get('ownerId') or args['userId']
        candidates=[]
        for spec in self.specs():
            if (spec.get('ownerId') or spec.get('userId'),spec.get('project'))!=(owner,args['project']):continue
            jid=spec['id']
            if spec.get('interactive') and (self.node.ROOT/'jobs'/(jid+'.canceled.json')).exists():continue
            try:session=self.store.read_json(self.folder/(jid+'.session.json'))
            except FileNotFoundError:session={}
            if not spec.get('interactive') and session.get('state')=='CLOSED':continue
            candidates.append((spec,session))
        units=self.units() if any(not spec.get('interactive') for spec,_ in candidates) else {}
        gpu_states=self.gpu_states() if any(spec.get('interactive') for spec,_ in candidates) else {}
        opened=[];closable=[]
        for spec,session in candidates:
            jid=spec['id']
            if spec.get('interactive'):
                if gpu_states is not None and jid not in gpu_states and session.get('state')=='CLOSED':continue
                state=(gpu_states or {}).get(jid)
                alive=True if state in ('PENDING','RUNNING','STARTING','PREEMPTING') else False if state in ('SUCCEEDED','FAILED','CANCELED','LOST') else None
            else:alive=units.get(jid,False) if units is not None else None
            if alive is False:continue
            opened.append(spec)
            if alive is True:closable.append(spec)
        if len(opened)<OPEN_LIMIT:return None
        closable.sort(key=lambda spec:spec.get('createdAt',self.folder.joinpath(spec['id']+'.json').stat().st_mtime))
        ids=[spec['id'] for spec in closable[:3]]
        commands=['gpuctl terminal close '+jid+' --machine '+args.get('machine','SERVER') for jid in ids]
        next_step='请先关闭较早的终端，再新建：\n'+'\n'.join(commands) if commands else '当前会话状态未知，请按原编号查询，稍后再试。'
        return {'id':args['key'],'state':'REJECTED','created':False,'openCount':len(opened),'limit':OPEN_LIMIT,
                'oldestIds':ids,'reason':f'本项目在此节点已有 {len(opened)} 个未结束或状态未知的终端，上限为 {OPEN_LIMIT}。'+next_step}

    def idle(self,spec,session,now):
        if spec.get('interactive') or session.get('state')=='CLOSED' or session.get('leaseExpiresAt',0)>now:return False
        # Existing helpers keep writing their original output FD after upgrades.
        # Always include mtimes, even when explicit fields have since been added.
        stamps=[session.get('lastInteractionAt',0)]
        stamps.extend((self.folder/(spec['id']+suffix)).stat().st_mtime for suffix in ('.session.json','.output'))
        return now-max(stamps)>=IDLE_SECONDS

    def shell_only(self,jid):
        state=self.node.terminal_unit_observation(jid);group=state.get('ControlGroup','')
        if state.get('ActiveState')!='active' or not group.startswith('/') or '..' in Path(group).parts:return False
        base=CGROUP_ROOT/group.lstrip('/');pids=set();payloads=0
        def failed(error):raise error
        for directory,_,files in os.walk(base,onerror=failed):
            if not any(part.startswith('libpod-payload') for part in Path(directory).relative_to(base).parts):continue
            if 'cgroup.procs' not in files:continue
            payloads+=1;pids.update((Path(directory)/'cgroup.procs').read_text().split())
        if not payloads or len(pids)!=1:return False
        process=PROC_ROOT/next(iter(pids))
        argv=process.joinpath('cmdline').read_bytes().rstrip(b'\0').split(b'\0')
        return argv==[arg.encode() for arg in SHELL]

    def collect(self):
        collected=[]
        for path in self.folder.glob('*.json'):
            jid=path.stem
            if not self.node.UUID.fullmatch(jid):continue
            try:
                # Same ID lock as open/exchange/close: a new attachment or input
                # cannot race the final idle observation and stop.
                fd=os.open(self.folder/(jid+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
                try:
                    try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    except BlockingIOError:continue
                    spec=self.store.read_json(path);session=self.store.read_json(self.folder/(jid+'.session.json'))
                    if not self.idle(spec,session,time.time()) or not self.shell_only(jid):continue
                    if not self.idle(spec,session,time.time()):continue
                    self.node.terminal_close(self.folder,jid,spec,session,reason='idle')
                    collected.append({'kind':'terminal','id':jid,**self.node.terminal_status({'id':jid})})
                finally:os.close(fd)
            except Exception as error:
                # Unreadable activity/process data never means an idle shell.
                collected.append({'kind':'terminal','id':jid,'state':'UNKNOWN','error':str(error)[:400]})
        return collected
