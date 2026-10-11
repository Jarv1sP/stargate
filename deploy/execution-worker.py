#!/usr/bin/python3
"""Local Unix socket -> fixed SSH forced commands. No public listener or shell."""
import hashlib, ipaddress, json, os, re, select, socketserver, stat, subprocess, sys, threading, time
from collections import deque
from pathlib import Path
BASE=Path('/opt/gpuq-console/executor')
HOSTS={n['id']:n for n in json.loads(Path('/opt/gpuq-console/inventory.json').read_text())['nodes']}
RUNTIME=Path('/run/gpuq-console-executor')

class NodeTransportError(ValueError):
    """Fixed, non-secret diagnostics; never expose OpenSSH stderr or key paths."""
    def __init__(self,code,status,phase):
        super().__init__('Node connection failed')
        self.code=code;self.status=status;self.phase=phase

def ssh_transport_failure(completed,phase):
    error=completed.stderr
    if isinstance(error,str):error=error.encode()
    if b'Host key verification failed' in error:
        return NodeTransportError('NODE_SSH_HOSTKEY_FAILED',502,phase)
    if b'Permission denied' in error or b'Authentication failed' in error:
        return NodeTransportError('NODE_SSH_AUTH_FAILED',502,phase)
    return NodeTransportError('NODE_CONNECT_FAILED',503,phase)

class SSHConnections:
    """Fixed-host transport; only creation of an idle master is serialized.

    Control channels carry no operation or input. Each RPC is sent once, even
    if the connection breaks. Idle masters exit after 15 seconds; all sessions
    still execute the same key's forced command on the node.
    """
    def __init__(self, base=BASE, runtime=RUNTIME):
        self.base=base;self.runtime=runtime;self.locks={};self.slots={};self.guard=threading.Lock()

    def identity(self, host):
        user=host['user'];address=host['address']
        if not isinstance(user,str) or not re.fullmatch(r'[a-z_][a-z0-9_-]{0,63}\$?',user):
            raise ValueError('Invalid fixed host')
        try:ipaddress.ip_address(address)
        except (TypeError,ValueError):raise ValueError('Invalid fixed host')
        name=hashlib.sha256(json.dumps([user,address,22,str(self.base)],separators=(',',':')).encode()).hexdigest()[:24]
        with self.guard:
            lock=self.locks.setdefault(name,threading.Lock())
            slots=self.slots.setdefault(name,threading.BoundedSemaphore(8))
        return name,user+'@'+address,lock,slots

    def control_path(self, name):
        parent=os.open(self.runtime,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            s=os.fstat(parent)
            if s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)&0o022:
                raise ValueError('Unsafe SSH runtime directory')
            try:os.mkdir('ssh-mux',0o700,dir_fd=parent)
            except FileExistsError:pass
            private=os.open('ssh-mux',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            try:
                s=os.fstat(private)
                if s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o700:
                    raise ValueError('Unsafe SSH control directory')
                current=(self.runtime/'ssh-mux').lstat()
                if (s.st_dev,s.st_ino)!=(current.st_dev,current.st_ino):
                    raise ValueError('SSH control directory changed')
            finally:os.close(private)
        finally:os.close(parent)
        path=self.runtime/'ssh-mux'/('c-'+name)
        if len(os.fsencode(path))>100:raise ValueError('SSH control path too long')
        return path

    def socket_identity(self, path):
        try:s=path.lstat()
        except FileNotFoundError:return None
        if not stat.S_ISSOCK(s.st_mode) or s.st_uid!=os.getuid() or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)&0o077:
            raise ValueError('Unsafe SSH control socket')
        return s.st_dev,s.st_ino

    def command(self, target, path):
        return ['/usr/bin/ssh','-F','/dev/null','-T','-o','BatchMode=yes','-o','ConnectionAttempts=1',
            '-o','ConnectTimeout=5','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes',
            '-o',f'UserKnownHostsFile={self.base}/known_hosts','-i',str(self.base/'id_ed25519'),
            '-o','ForwardAgent=no','-o','ForwardX11=no','-o','ClearAllForwardings=yes',
            '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=1','-o','ControlMaster=no',
            '-o',f'ControlPath={path}',target]

    def ensure_master(self, target, path, deadline):
        identity=self.socket_identity(path);command=self.command(target,path)
        if identity is not None:
            checked=subprocess.run(command[:-1]+['-O','check',target],capture_output=True,timeout=min(2,max(0.01,deadline-time.monotonic())))
            if checked.returncode==0:return
            # Never remove a live, unrecognized or concurrently replaced socket.
            if not any(word in checked.stderr for word in (b'Connection refused',b'No such file or directory')):
                raise ssh_transport_failure(checked,'master')
            if self.socket_identity(path)==identity:path.unlink()
            elif self.socket_identity(path) is not None:raise ValueError('SSH control socket changed')
        remaining=deadline-time.monotonic()
        if remaining<=0:raise NodeTransportError('NODE_TRANSPORT_BUSY',503,'master')
        # No remote command, forwarding or stdin is requested by this startup.
        master=command[:-1]+['-N','-f','-o','ControlPersist=15s',target]
        master[master.index('ControlMaster=no')]='ControlMaster=yes'
        started=subprocess.run(master,stdin=subprocess.DEVNULL,capture_output=True,timeout=min(7,remaining))
        if started.returncode:raise ssh_transport_failure(started,'master')
        if self.socket_identity(path) is None:raise NodeTransportError('NODE_CONNECT_FAILED',503,'master')

    def rpc_command(self, target, path):
        # If a warm socket disappears/refuses, fail instead of implicitly
        # making another network connection. A future request may reconnect.
        return self.command(target,path)[:-1]+['-o','ProxyCommand=/usr/bin/false',target]

    def call(self, host, request):
        name,target,lock,slots=self.identity(host);deadline=time.monotonic()+27
        if not slots.acquire(timeout=27):raise NodeTransportError('NODE_TRANSPORT_BUSY',503,'capacity')
        phase='master'
        try:
            path=self.control_path(name)
            if not lock.acquire(timeout=max(0,deadline-time.monotonic())):raise NodeTransportError('NODE_TRANSPORT_BUSY',503,'capacity')
            try:self.ensure_master(target,path,deadline)
            finally:lock.release()
            remaining=deadline-time.monotonic()
            if remaining<=0:raise NodeTransportError('NODE_TRANSPORT_BUSY',503,'capacity')
            # Never retry or resend input after a timeout or failed channel.
            phase='rpc'
            return subprocess.run(self.rpc_command(target,path),input=json.dumps(request),text=True,capture_output=True,timeout=remaining)
        except subprocess.TimeoutExpired:raise NodeTransportError('NODE_RESPONSE_TIMEOUT' if phase=='rpc' else 'NODE_CONNECT_FAILED',504 if phase=='rpc' else 503,phase) from None
        except (OSError,subprocess.SubprocessError):raise NodeTransportError('NODE_CONNECT_FAILED',503,phase) from None
        finally:slots.release()

SSH_CONNECTIONS=SSHConnections()
TERMINAL_STREAM_HOSTS=()  # Explicit per-node rollout; old forced commands stay unchanged.
TERMINAL_STREAM_PROTOCOL='terminal-exchange-stream-v1'
TERMINAL_CONTEXT_FIELDS={'userId','username','id','clientId','writerToken','hostAdmin','dataWorkspace','project'}

class TerminalCapacity(ValueError):
    """No input or handshake has been sent for this new context."""

class TerminalSSHConnections(SSHConnections):
    """Separate fixed-key mux: warm terminal sessions cannot starve job RPCs."""
    def identity(self,host):
        name,target,lock,slots=super().identity(host)
        return 't-'+name,target,lock,slots

TERMINAL_CONNECTIONS=TerminalSSHConnections()

class TerminalChannel:
    """One fixed context, FIFO exchanges, and no resend after any input attempt."""
    def __init__(self,connection,host,context):
        self.connection=connection;self.host=host;self.context=context
        self.condition=threading.Condition();self.waiters=deque();self.active=False;self.dead=False
        self.process=None;self.pending=bytearray();self.sequence=0;self.slot=None
        self.created=self.last=time.monotonic()

    def reserve(self):
        with self.condition:
            if self.dead or len(self.waiters)>=32:raise ValueError('Terminal stream unavailable')
            ticket=object();self.waiters.append(ticket);return ticket

    def retire_if_idle(self,now,force=False,*,defer_close=False):
        with self.condition:
            if self.active or self.waiters:return False
            if not force and now-self.last<14 and now-self.created<55:return False
            # Fence reservations immediately; the owned SSH process can then
            # be closed without holding the pool's cross-session admission lock.
            self.dead=True
        if not defer_close:self.close()
        return True

    def close(self):
        process=self.process;self.process=None;self.pending.clear()
        try:
            if process is not None:
                try:process.stdin.close()
                except OSError:pass
                if process.poll() is None:
                    try:process.terminate()
                    except ProcessLookupError:pass
                    try:process.wait(timeout=.2)
                    except subprocess.TimeoutExpired:
                        process.kill();process.wait(timeout=1)  # Only this owned SSH client, not a node service.
                process.stdout.close()
        finally:
            if self.slot is not None:self.slot.release();self.slot=None

    def line(self,limit,deadline):
        while True:
            if time.monotonic()>=deadline:raise ValueError('Terminal exchange unconfirmed; refresh without replay')
            end=self.pending.find(b'\n')
            if end>=0:
                if end+1>limit:raise ValueError('Terminal response too large')
                raw=bytes(self.pending[:end+1]);del self.pending[:end+1];return json.loads(raw)
            remaining=deadline-time.monotonic()
            if len(self.pending)>limit or remaining<=0 or not select.select([self.process.stdout],[],[],remaining)[0]:
                raise ValueError('Terminal exchange unconfirmed; refresh without replay')
            raw=os.read(self.process.stdout.fileno(),min(65536,limit+1-len(self.pending)))
            if not raw:raise ValueError('Terminal exchange unconfirmed; refresh without replay')
            self.pending.extend(raw)

    def send(self,value,deadline):
        raw=(json.dumps(value,separators=(',',':'))+'\n').encode()
        if len(raw)>32768:raise ValueError('Terminal input frame too large')
        while raw:
            remaining=deadline-time.monotonic()
            if remaining<=0 or not select.select([], [self.process.stdin],[],remaining)[1]:
                raise ValueError('Terminal exchange unconfirmed; refresh without replay')
            count=os.write(self.process.stdin.fileno(),raw)
            if count<=0:raise ValueError('Terminal exchange unconfirmed; refresh without replay')
            raw=raw[count:]

    def start(self,deadline):
        name,target,lock,slots=self.connection.identity(self.host)
        if not slots.acquire(timeout=max(0,deadline-time.monotonic())):raise ValueError('Node connection failed')
        self.slot=slots
        path=self.connection.control_path(name)
        if not lock.acquire(timeout=max(0,deadline-time.monotonic())):raise ValueError('Node connection failed')
        try:self.connection.ensure_master(target,path,deadline)
        finally:lock.release()
        self.process=subprocess.Popen(self.connection.rpc_command(target,path),stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,bufsize=0)
        os.set_blocking(self.process.stdin.fileno(),False)
        self.send({'protocol':TERMINAL_STREAM_PROTOCOL,'context':self.context},deadline)
        ack=self.line(32768,deadline)
        if ack!={'protocol':TERMINAL_STREAM_PROTOCOL,'ready':True}:raise ValueError('Terminal stream handshake rejected')
        # No terminal input has been sent before the fixed protocol ACK.
        self.created=self.last=time.monotonic();self.sequence=0

    def exchange(self,ticket,args,deadline):
        with self.condition:
            while not self.dead and (self.active or self.waiters[0] is not ticket):
                remaining=deadline-time.monotonic()
                if remaining<=0:
                    self.waiters.remove(ticket);self.condition.notify_all();raise ValueError('Terminal exchange queue expired')
                self.condition.wait(remaining)
            if self.dead:
                self.waiters.remove(ticket);raise ValueError('Terminal stream unavailable')
            self.waiters.popleft();self.active=True
        try:
            # Rotate before sending a new frame, never as a response to lost ACK.
            if self.process is not None and (time.monotonic()-self.created>=55 or time.monotonic()-self.last>=14 or self.sequence>=1000):self.close()
            if self.process is None:self.start(deadline)
            if self.process.poll() is not None:raise ValueError('Terminal stream unavailable; refresh without replay')
            self.send({'sequence':self.sequence,'args':args},deadline)
            response=self.line(1048576,deadline)
            if (not isinstance(response,dict) or type(response.get('sequence')) is not int
                    or response['sequence']!=self.sequence or type(response.get('ok')) is not bool
                    or set(response)!=({'sequence','ok','result'} if response['ok'] else {'sequence','ok','error'})):
                raise ValueError('Terminal exchange unconfirmed; refresh without replay')
            self.sequence+=1;self.last=time.monotonic()
            del response['sequence']
            if not response['ok']:self.dead=True;self.close()
            return response
        except Exception:
            self.dead=True;self.close();raise
        finally:
            with self.condition:self.active=False;self.condition.notify_all()

class TerminalChannels:
    def __init__(self,connection):self.connection=connection;self.channels={};self.guard=threading.Lock();self.reaper=None
    @staticmethod
    def close_retired(channels):
        for channel in channels:
            try:channel.close()
            except (OSError,subprocess.TimeoutExpired):
                # close() releases the owned semaphore slot in finally. A
                # cleanup failure must not strand another session's reservation.
                print('Terminal SSH client cleanup failed',file=sys.stderr,flush=True)
    def reap(self):
        while True:
            time.sleep(1)
            retired=[]
            with self.guard:
                for key,channel in list(self.channels.items()):
                    if channel.retire_if_idle(time.monotonic(),defer_close=True):
                        del self.channels[key];retired.append(channel)
                done=not self.channels
                if done:self.reaper=None
            self.close_retired(retired)
            if done:return
    def call(self,host,args):
        if not isinstance(args,dict) or not {'userId','username','id','clientId','writerToken'}<=set(args) or set(args)-TERMINAL_CONTEXT_FIELDS-{'input','offset','rows','cols'}:
            raise ValueError('Invalid terminal stream fields')
        context={key:value for key,value in args.items() if key in TERMINAL_CONTEXT_FIELDS}
        if (len(json.dumps(context).encode())>4096
                or not all(isinstance(context[key],str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',context[key]) for key in ('id','clientId','writerToken'))):
            raise ValueError('Invalid terminal stream context')
        name,_,_,_=self.connection.identity(host)
        key=(name,hashlib.sha256(json.dumps(context,sort_keys=True,separators=(',',':')).encode()).hexdigest())
        deadline=time.monotonic()+27;retired=[]
        with self.guard:
            # The reaper owns unrelated expired contexts. Existing exchanges
            # must not pay another terminal's SSH shutdown latency on each key.
            channel=self.channels.get(key)
            if channel is None or channel.dead:
                peers=[(k,v) for k,v in self.channels.items() if k[0]==name]
                # At most six warm channels on the dedicated terminal master.
                # Normal RPCs retain their own master and eight-channel budget.
                if len(peers)>=6:
                    for old,candidate in sorted(peers,key=lambda item:item[1].last):
                        if candidate.retire_if_idle(time.monotonic(),force=True,defer_close=True):
                            del self.channels[old];retired.append(candidate);break
                    else:raise TerminalCapacity('Terminal stream capacity reached')
                channel=TerminalChannel(self.connection,host,context);self.channels[key]=channel
            ticket=channel.reserve()
            if self.reaper is None:
                self.reaper=threading.Thread(target=self.reap,daemon=True);self.reaper.start()
        # Retired contexts keep their slot until the SSH process is closed;
        # active/waiting contexts cannot be evicted and the eight-slot cap stays.
        self.close_retired(retired)
        return channel.exchange(ticket,args,deadline)

TERMINAL_CHANNELS=TerminalChannels(TERMINAL_CONNECTIONS)
def terminal_exchange(host,args,machine):
    # execution.mjs retains its authorized machine in the trusted args envelope.
    # Verify that duplicate routing field, then strip only it for the protocol.
    if not isinstance(args,dict) or args.get('machine')!=machine:raise ValueError('Invalid terminal machine context')
    normalized={key:value for key,value in args.items() if key!='machine'}
    try:return TERMINAL_CHANNELS.call(host,normalized)
    except TerminalCapacity:
        # Only a new-context capacity refusal, before any input is dispatched.
        # A sent/unconfirmed input, handshake error or writer error never falls back.
        p=SSH_CONNECTIONS.call(host,{'operation':'terminal.exchange','args':args})
        if p.returncode:raise ssh_transport_failure(p,'rpc')
        return json.loads(p.stdout)

INTERNAL_STORAGE=('storage.archive.events','storage.archive.ack','storage.archive.original',
    'storage.archive.enrollment-check','storage.archive.retire',
    'storage.archive.provision','storage.archive.certify','storage.lease.prepare','storage.lease.cancel',
    'storage.download.open','storage.download.info','storage.download.manifest','storage.download.get','storage.download.finish')
CLOUD_FILES=tuple('datasets.cloud.'+action for action in ('info','list','status','upload','verify','download','cancel'))
INTERNAL_STORAGE+=CLOUD_FILES+('projects.oci-cohort.sync',)
# Internal bridge only; these never enter the public transfer operation list.
INTERNAL_STORAGE+=('transfers.confirm-unprepared-cancel','transfers.release-unprepared-source')
INTERNAL_STORAGE+=tuple('storage.dataset-delete.'+action for action in ('capabilities','locations','registration','registration-discard','plan','fence','isolate','status','restore','release-absence','cancel','commit'))
INTERNAL_STORAGE+=tuple('projects.copy.'+action for action in ('prepare','start','status','cancel','revoke','release','probe'))
INTERNAL_STORAGE+=('projects.archive','projects.unarchive','projects.retire.plan','projects.retire','projects.retire.status')
# Exact owner-bound draft RPCs; Portal and node checks still establish identity.
INTERNAL_STORAGE+=('files.upload.list','files.upload.cancel','projects.local-import.begin','projects.local-import.status','projects.local-import.cancel')
INTERNAL_STORAGE+=('tasks.display.get','tasks.display.set')
INTERNAL_STORAGE+=('storage.upload.locate','storage.upload.admit')
INTERNAL_STORAGE+=('datasets.files.list',)
INTERNAL_STORAGE+=('datasets.training.status','storage.training.plan')
INTERNAL_STORAGE+=tuple('storage.cache-action.'+action for action in ('capabilities','prepare','release','status','cancel'))
INTERNAL_STORAGE+=('datasets.workspace.remove-plan','datasets.workspace.remove','datasets.workspace.remove-status')
class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(35)
        try:
            data=json.loads(self.rfile.readline(1600001))
            if data['machine'] not in HOSTS or data['operation'] not in INTERNAL_STORAGE+('terminal.status',)+('datasets.storage.status','datasets.storage.plan','datasets.storage.pin','datasets.storage.unpin','transfers.capabilities','transfers.source.prepare','transfers.confirm-source-release','transfers.release-source','transfers.start','transfers.status','transfers.cancel','transfers.resume','datasets.upload.routes','datasets.upload.pause','datasets.upload.direct-ticket','datasets.upload.direct-revoke','sync','cancel','logs','diagnostics','watch','priority','host.exec','host.status','host.cancel','files.list','files.put','files.get','files.upload.status','terminal.open','terminal.exchange','terminal.close','terminal.detach','datasets.capacity','datasets.list','datasets.status','datasets.prepare','datasets.register','datasets.unregister','datasets.upload.begin','datasets.upload.manifest','datasets.upload.seal','datasets.upload.status','datasets.upload.chunk','datasets.upload.commit','datasets.upload.discard','datasets.workspace.list','datasets.workspace.put','datasets.workspace.get','datasets.workspace.status','datasets.workspace.publish','datasets.import.start','datasets.import.status','datasets.import.list','datasets.import.cancel','datasets.import.discard','projects.list','projects.quota','projects.create','projects.status','projects.publish','projects.verify','projects.snapshot.info','projects.snapshot.manifest','projects.snapshot.get','datasets.snapshot.info','datasets.snapshot.manifest','datasets.snapshot.get','projects.sync.begin','projects.sync.manifest','projects.sync.seal','projects.sync.status','projects.sync.chunk','projects.sync.finish','projects.sync.cancel'): raise ValueError('Invalid operation')
            host=HOSTS[data['machine']]
            if data['operation']=='terminal.exchange' and data['machine'] in TERMINAL_STREAM_HOSTS:
                result=terminal_exchange(host,data['args'],data['machine'])
            else:
                p=SSH_CONNECTIONS.call(host,{'operation':data['operation'],'args':data['args']})
                if p.returncode:raise ssh_transport_failure(p,'rpc')
                try:result=json.loads(p.stdout)
                except (json.JSONDecodeError,UnicodeError):raise NodeTransportError('NODE_RESPONSE_INVALID',502,'rpc') from None
        except NodeTransportError as e:result={'ok':False,'error':str(e),'code':e.code,'status':e.status,'phase':e.phase,'outcomeUnconfirmed':True}
        except Exception as e: result={'ok':False,'error':str(e)[:200]}
        self.wfile.write((json.dumps(result)+'\n').encode())
class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads=True
if __name__=='__main__':
    os.umask(0o007)
    sock='/run/gpuq-console-executor/bridge.sock'
    if os.path.exists(sock):os.unlink(sock)
    with Server(sock,Handler) as server:
        os.chmod(sock,0o660);os.chown(sock,0,1000);server.serve_forever()
