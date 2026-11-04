#!/usr/bin/python3
"""Local Unix socket -> fixed SSH forced commands. No public listener or shell."""
import hashlib, ipaddress, json, os, re, stat, subprocess, threading, time
from pathlib import Path
CONFIG=json.loads(Path(os.environ.get('STARGATE_VPS_CONFIG','/etc/stargate/vps.json')).read_text())
BASE=Path(CONFIG['transport']['credentialDirectory'])
HOSTS=CONFIG['transport']['hosts']
SSH_CONFIG=CONFIG['transport'].get('sshConfig','/dev/null')
RUNTIME=Path(CONFIG['bridge']['runtimeDirectory'])

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
        return ['/usr/bin/ssh','-F',SSH_CONFIG,'-T','-o','BatchMode=yes','-o','ConnectionAttempts=1',
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
