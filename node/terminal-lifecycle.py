"""Bound terminal keyring use and reclaim only detached, shell-only terminals."""
import fcntl,os,time
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
            if self.node.UUID.fullmatch(path.stem):yield self.store.read_json(path)

    def admission(self,args):
        owner=args.get('ownerId') or args['userId']
        opened=[]
        for spec in self.specs():
            if (spec.get('ownerId') or spec.get('userId'),spec.get('project'))!=(owner,args['project']):continue
            if self.node.terminal_alive(self.folder,spec['id']) is False:continue
            opened.append(spec)
        if len(opened)<OPEN_LIMIT:return None
        opened.sort(key=lambda spec:spec.get('createdAt',self.folder.joinpath(spec['id']+'.json').stat().st_mtime))
        ids=[spec['id'] for spec in opened[:3]]
        commands=['gpuctl terminal close '+jid+' --machine '+args.get('machine','SERVER') for jid in ids]
        return {'id':args['key'],'state':'REJECTED','created':False,'openCount':len(opened),'limit':OPEN_LIMIT,
                'oldestIds':ids,'reason':f'本项目在此节点已有 {len(opened)} 个未结束终端，上限为 {OPEN_LIMIT}。请先关闭较早的终端，再新建：\n'+'\n'.join(commands)}

    def idle(self,spec,session,now):
        if spec.get('interactive') or session.get('state')=='CLOSED' or session.get('leaseExpiresAt',0)>now:return False
        # Existing helpers keep writing their original output FD after upgrades.
        # Always include mtimes, even when explicit fields have since been added.
        stamps=[session.get('lastInteractionAt',0)]
        try:activity=self.store.read_json(self.folder/(spec['id']+'.activity.json'))
        except FileNotFoundError:activity={}
        stamps.extend(activity.get(key,0) for key in ('lastInputAt','lastOutputAt'))
        stamps.extend((self.folder/(spec['id']+suffix)).stat().st_mtime for suffix in ('.json','.session.json','.output'))
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
