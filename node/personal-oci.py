"""Rootless mutable OCI workspaces on the SSD data disk."""
import contextlib,fcntl,importlib.util,json,os,re,select,shutil,stat,subprocess,time,uuid
from pathlib import Path
HERE=Path(__file__).resolve().parent
STDERR_LIMIT=65536

def module(name):
    s=importlib.util.spec_from_file_location(name,HERE/(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def need(condition,message):
    if not condition:raise ValueError(message)

def translate_control(arguments, sources=None):
    """Translate only the trusted training-control module's narrow bwrap DSL."""
    result, i = [], 0
    while i < len(arguments):
        op = arguments[i]
        if op == '--dir':
            i += 2
        elif op in ('--bind-fd', '--ro-bind-data'):
            fd, target = arguments[i+1:i+3]
            need(str(int(fd)) == fd and target in ('/run/gpuq/control', '/opt/gpuq/sdk.pyz', '/opt/gpuq/libvgpu.so'),
                 'Unexpected OCI scheduler mount')
            source = (sources or {}).get(int(fd), '/proc/'+str(os.getpid())+'/fd/'+fd)
            result += ['--volume', source+':'+target+(':'+'ro' if op == '--ro-bind-data' else ':rw')]
            i += 3
        elif op == '--setenv':
            key, value = arguments[i+1:i+3]
            need(isinstance(key, str) and isinstance(value, str) and len(key) <= 256 and len(value) <= 65536
                 and (re.fullmatch('[A-Z][A-Z0-9_]*', key) or key == 'RAY_object_spilling_directory')
                 and '\x00' not in value, 'Invalid scheduler environment')
            result += ['--env', key+'='+value]
            i += 3
        else:
            raise ValueError('Unsupported OCI training-control mount operation')
    return result

def cdi_selection(config,uuids):
    path=Path(config.get('personalOci',{}).get('cdiSpec','/etc/gpuq-console/cdi/gpuq-nvidia.json'))
    value=json.loads(path.read_text())
    selected=[d for d in value.get('devices',[]) if d.get('name') in uuids]
    if any(gpu not in {d.get('name') for d in selected} for gpu in uuids):raise ValueError('所选GPU的CDI尚未配置，请联系安装者。')
    # The installer generates this trusted NVIDIA CDI from the installed driver.
    # Let the engine apply its read-only driver mounts; select only allocated GPUs.
    return [value['kind']+'='+gpu for gpu in uuids]


class PersonalOCI:
    proxy={}
    def __init__(self,config,user):
        self.config,self.user=config,user;self.s=module('project-store');self.d=module('local-data')
        self.root=self.d.root(config,'root');self.owner=self.d.name(user)
        self.policy=config['personalOci'];self.folder=self.s.private_dir(self.d.root(config,'workspacesRoot')/'.oci',create=True)
        self.folder=self.s.private_dir(self.folder/self.owner,create=True)
        lock=os.open(self.folder/'runtime.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            self.s.wait_project_lock(lock,fcntl.LOCK_EX,'个人容器正在恢复，请稍后重试。')
            for name in ('graph','run','tmp','home'):self.s.private_dir(self.folder/name,create=True)
            try:
                with os.fdopen(os.open(self.folder/'tmp/alive',os.O_RDONLY|os.O_NOFOLLOW),'rb') as alive:
                    cached_boot=alive.read(128).strip()
            except FileNotFoundError:cached_boot=b''
            if cached_boot and cached_boot!=Path('/proc/sys/kernel/random/boot_id').read_bytes().strip():
                # Podman normally keeps these in tmpfs. Data-disk runtimes need
                # the same reboot cleanup; graph and project files persist.
                for name in ('run','tmp'):
                    shutil.rmtree(self.folder/name)
                    self.s.private_dir(self.folder/name,create=True)
        finally:os.close(lock)
        self.runtime_tmp=self.folder/'run'
        self.env={'PATH':'/usr/bin:/bin','HOME':str(self.folder/'home'),'TMPDIR':str(self.folder/'tmp'),
                  'XDG_RUNTIME_DIR':'/run/user/'+str(os.getuid()),'LANG':'C.UTF-8',
                  'REGISTRY_AUTH_FILE':str(self.folder/'auth.json'),
                  'CONTAINERS_REGISTRIES_CONF':str(self.folder/'registries.conf'),
                  'CONTAINERS_CONF':str(self.folder/'containers.conf')}
        # The node's outbound proxy serves image pulls and every container (git, pip, conda).
        proxy=config.get('proxy')
        self.proxy={} if not proxy else {name:value for key,value in (('http_proxy',proxy),('https_proxy',proxy),
            ('no_proxy',config.get('noProxy','localhost,127.0.0.1'))) for name in (key,key.upper())}
        self.env.update(self.proxy)
        self.s.atomic_json(self.folder/'auth.json',{'auths':{}})
        for name,raw in {'registries.conf':'unqualified-search-registries = []\n',
                         'containers.conf':'[containers]\nenv_host = false\nhttp_proxy = false\nvolumes = []\n[engine]\nremote = false\n'}.items():
            file=self.folder/name
            if not file.exists():
                fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                with os.fdopen(fd,'w') as stream:stream.write(raw)

    @contextlib.contextmanager
    def registry_auth(self):yield dict(self.env),None

    def command(self,*args):
        return ['/usr/bin/podman','--root='+str(self.folder/'graph'),'--runroot='+str(self.folder/'run'),
                '--tmpdir='+str(self.folder/'tmp'),'--storage-driver=overlay','--cgroup-manager=cgroupfs',
                '--runtime=/usr/bin/crun','--hooks-dir='+str(self.folder/'empty-hooks'),
                '--cdi-spec-dir='+str(Path(self.config.get('personalOci',{}).get('cdiSpec','/etc/gpuq-console/cdi/gpuq-nvidia.json')).parent),'--events-backend=file',*args]

    def run(self,*args,timeout=30):
        self.s.private_dir(self.folder/'empty-hooks',create=True);self.s.private_dir(self.folder/'empty-cdi',create=True)
        result=subprocess.run(self.command(*args),env=self.env,capture_output=True,text=True,timeout=timeout)
        if result.returncode:raise ValueError('容器操作失败：'+result.stderr[-1200:])
        return result.stdout.strip()

    def state_path(self,slug):
        if getattr(self,'state_folder',None) is not None:return self.state_folder/'oci.json'
        folder,_=self.s.ProjectStore(self.root,config=self.config)._project(self.owner,slug)
        return folder/'oci.json'

    @contextlib.contextmanager
    def locked(self,slug,wait=True):
        import fcntl
        fd=os.open(self.state_path(slug).with_suffix('.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:self.s.wait_project_lock(fd,fcntl.LOCK_EX,'容器忙，请稍后重试。');yield
        finally:os.close(fd)

    def load(self,slug):
        try:return self.s.read_json(self.state_path(slug))
        except FileNotFoundError:return {'image':self.policy['baseImage'],'container':None}

    def workspace_container(self,slug):
        with self.locked(slug):
            head=self.load(slug)
            if head.get('container') is None:
                self.run('pull','--tls-verify=true',head['image'],timeout=1800)
                head['container']='gpuq-dev-'+uuid.uuid4().hex
                self.run('create','--name',head['container'],'--network=none','--entrypoint','/bin/sh',head['image'])
                self.s.atomic_json(self.state_path(slug),head)
            return head

    def execute(self,spec,project,terminal,uuids,mounts,*,control=(),pass_fds=()):
        if os.getuid()==0:raise ValueError('容器只能以非宿主root身份运行。')
        # The engine state, rootfs, named mounts and runtime files all live on data disks.
        with self.named_mounts(mounts,control):
            flags=self.arguments(spec,project,terminal,uuids,mounts,control)
            return self.execute_workspace(spec,flags,dict(self.env))

    def workspace_command(self,user,project,argv,*,paths=None,archive=None,timeout=300):
        paths=paths or self.s.ProjectStore(self.root,config=self.config).dev_paths(user,project)
        with self.s.directory(paths['code']) as fd:
            flags=['--cgroups=disabled','--pid=private','--ipc=private','--uts=private',
                '--network=slirp4netns:allow_host_loopback=false','--security-opt=no-new-privileges',
                '--user=0','--workdir=/workspace','--volume',str(paths['code'])+':/workspace:rw',
                '--volume',str(paths['home'])+':/home/gpuq:rw','--env=HOME=/home/gpuq','--pull=never',
                *['--env='+k+'='+v for k,v in self.proxy.items()]]
            if archive is not None:flags+=['--volume',str(self.d.require_data_path(self.config,archive))+':/run/gpuq/project-copy.tar:ro']
            # Git executes in the same writable project rootfs, never as a host command.
            head=self.workspace_container(project)
            request={'engine':self.command(),'graph':str(self.folder/'graph'),'hostUid':os.getuid(),
                     'container':head['container'],'execution':'gpuq-git-'+uuid.uuid4().hex,
                     'flags':flags,'argv':argv}
            path=self.folder/'tmp'/('git-'+uuid.uuid4().hex+'.json');self.s.atomic_json(path,request)
            try:
                result=subprocess.run(self.command('unshare','/usr/bin/python3','-I','-B',str(HERE/'workspace-rootfs.py'),str(path)),env=self.env,capture_output=True,text=True,timeout=timeout)
                if result.returncode:raise ValueError('容器git操作失败：'+result.stderr[-1200:])
                return result.stdout.strip()
            finally:path.unlink(missing_ok=True)

    def git(self,user,project,argv):
        return self.workspace_command(user,project,['git',*argv])

    def copy_files(self,project,action,*,paths,**fields):
        # Caller holds the existing project lock for backup + merge + completion.
        request={'engine':self.command(),'graph':str(self.folder/'graph'),'hostUid':os.getuid(),
                 'container':self.load(project)['container'],'copy':{'action':action,'paths':{k:str(v) for k,v in paths.items()},**fields}}
        path=self.folder/'tmp'/('copy-'+uuid.uuid4().hex+'.json');self.s.atomic_json(path,request)
        try:
            result=subprocess.run(self.command('unshare','/usr/bin/python3','-I','-B',str(HERE/'workspace-rootfs.py'),str(path)),env=self.env,capture_output=True,text=True,timeout=3600)
            if result.returncode:raise ValueError('项目文件同步失败：'+result.stderr[-1200:])
            return json.loads(result.stdout)
        finally:path.unlink(missing_ok=True)

    def network(self,user,project):
        script="""import json,socket,ssl
result={}
for host in ('github.com','pypi.org'):
    try:
        with socket.create_connection((host,443),timeout=5) as tcp:
            with ssl.create_default_context().wrap_socket(tcp,server_hostname=host) as tls:
                result[host]={'reachable':True,'tls':tls.version()}
    except Exception as error:result[host]={'reachable':False,'error':type(error).__name__}
print(json.dumps(result))
"""
        return json.loads(self.workspace_command(user,project,['python3','-c',script]))

    def record_stderr(self, raw, *, phase='OCI_ENGINE', truncated=False):
        sink = getattr(self, 'stderr_sink', None)
        if sink is None or not raw: return
        if isinstance(raw, str): raw = raw.encode('utf-8', errors='replace')
        try: sink(raw[-STDERR_LIMIT:], phase=phase, truncated=truncated or len(raw) > STDERR_LIMIT)
        except Exception: pass

    def call(self, command, *, env, pass_fds):
        """Keep stdout/main stderr, plus one bounded private evidence tail.

        No wrapper shell, command logging, container logs, recursive scan or
        additional cancellation. Do not wait for unrelated inherited writers
        after the exact engine process exits.
        """
        if getattr(self, 'stderr_sink', None) is None:
            return subprocess.call(command, env=env, pass_fds=pass_fds)
        process = subprocess.Popen(command, env=env, pass_fds=pass_fds, stderr=subprocess.PIPE)
        tail = bytearray(); total = 0; last_saved = time.monotonic(); eof = False; drain_deadline = None
        try:
            while True:
                if process.poll() is not None:
                    if drain_deadline is None: drain_deadline = time.monotonic() + 1
                    if time.monotonic() >= drain_deadline: break
                ready = select.select([process.stderr], [], [], .5)[0]
                if ready:
                    raw = os.read(process.stderr.fileno(), 4096)
                    if not raw: eof = True; break
                    total += len(raw); tail.extend(raw)
                    if len(tail) > STDERR_LIMIT: del tail[:-STDERR_LIMIT]
                    try:
                        offset = 0
                        while offset < len(raw):
                            written = os.write(2, raw[offset:])
                            if written <= 0: break
                            offset += written
                    except OSError: pass
                    if time.monotonic() - last_saved >= 5:
                        self.record_stderr(bytes(tail), truncated=total > STDERR_LIMIT)
                        last_saved = time.monotonic()
                elif process.poll() is not None: break
            return process.wait()
        except BaseException:
            # Preserve subprocess.call's original exceptional cleanup: only
            # this exact engine child, not its unit or another owner's process.
            try: process.kill()
            except OSError: pass
            process.wait()
            raise
        finally:
            self.record_stderr(bytes(tail), truncated=total > STDERR_LIMIT or not eof)
            process.stderr.close()

    def arguments(self, spec, project, terminal, uuids, mounts, control=()):
        # All host sources are already-open descriptors owned by the trusted
        # runner, never a user-provided host path. No nested daemon/socket.
        args = ['--group-add=keep-groups', '--cgroups=split', '--cgroupns=private', '--user=0', '--pid=private', '--ipc=private',
                '--uts=private', '--hostname=gpuq-job', '--network=slirp4netns:allow_host_loopback=false',
                '--security-opt=no-new-privileges', '--image-volume=ignore', '--pull=never',
                *['--env='+k+'='+v for k,v in self.proxy.items()],
                # The existing parent unit enforces TasksMax=2048 and memory /
                # CPU limits across Podman + conmon + every payload descendant.
                # No competing nested pids controller in a populated unit.
                # gpuq-ray caps its object store at 8 GiB. Reserving only the
                # engine's small default shm forces disk-backed object storage.
                # tmpfs pages remain charged to the existing parent MemoryMax.
                '--log-driver=none', '--pids-limit=-1', '--shm-size=8g', '--workdir=/workspace',
                '--label', 'io.gpuq.owner='+self.owner, '--label', 'io.gpuq.project='+spec['project'],
                '--env=HOME=/home/gpuq', '--env=XDG_CACHE_HOME=/home/gpuq/.cache',
                '--env=GPUQ_OUTPUT_DIR=/outputs', '--env=GPUQ_PROJECT='+spec['project'],
                '--env=GPUQ_PROJECT_ENV_MODE=oci', '--env=GPUQ_OFFLINE_ASSETS=/workspace/offline',
                '--env=GPUQ_MACHINE='+self.config.get('machine', ''),
                '--env=GPUQ_CONSOLE_JOB_ID='+spec.get('id', ''), '--env=NCCL_CUMEM_HOST_ENABLE=0',
                '--env=LANG=C.UTF-8', '--env=PYTHONUNBUFFERED=1',
                '--env=NVIDIA_VISIBLE_DEVICES=void', '--unsetenv=CUDA_VISIBLE_DEVICES']
        args += ['--unsetenv=GPUQ_PROJECT_RELEASE']
        for fd, target, readonly in mounts:
            need(type(fd) is int and fd >= 0 and isinstance(target, str) and target.startswith('/')
                 and '..' not in Path(target).parts and ':' not in target, 'Unsafe OCI mount')
            source = getattr(self, '_mount_sources', {}).get(fd, '/proc/'+str(os.getpid())+'/fd/'+str(fd))
            args += ['--volume', source+':'+target+(':ro' if readonly else ':rw')]
        if terminal:
            args += ['--interactive', '--tty', '--env=TERM=xterm-256color']
        if uuids:
            for device in cdi_selection(self.config,uuids):args += ['--device',device]
            if getattr(self,'cpu_set',[]):args += ['--cpuset-cpus='+','.join(map(str,self.cpu_set))]
        if not terminal and spec.get('interactive'):args+=['--interactive','--tty','--env=TERM=xterm-256color']
        args += translate_control(list(control), getattr(self, '_mount_sources', {}))
        return args

    @contextlib.contextmanager
    def named_mounts(self, mounts, control):
        """Rootless re-exec needs named sources, derived only from trusted FDs.

        Hold the no-follow path chain and compare each edge before/after use.
        The client cannot supply host paths. Anonymous resource metadata alone
        is copied into a bounded new private file; no host credentials/cache.
        """
        entries = list(mounts)
        i = 0
        while i < len(control):
            if control[i] in ('--bind-fd', '--ro-bind-data'):
                entries.append((int(control[i+1]), control[i+2], control[i] == '--ro-bind-data'))
                i += 3
            elif control[i] == '--setenv': i += 3
            elif control[i] == '--dir': i += 2
            else: raise ValueError('Unsupported OCI training-control mount operation')
        sources, held, edges, snapshots = {}, [], [], []
        def identity(info):
            return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)
        try:
            for fd, target, readonly in entries:
                need(type(fd) is int and fd >= 0, 'Invalid trusted OCI mount descriptor')
                info = os.fstat(fd); name = os.readlink('/proc/self/fd/'+str(fd))
                if name == '/memfd:gpuq-resources (deleted)':
                    need(readonly and target == '/run/gpuq/resources.json' and stat.S_ISREG(info.st_mode)
                         and 0 < info.st_size <= 65536, 'Unsupported anonymous OCI mount')
                    raw = os.pread(fd, 65537, 0)
                    need(len(raw) == info.st_size, 'OCI resource metadata changed')
                    path = self.folder/'tmp'/('resources-'+uuid.uuid4().hex+'.json')
                    with self.s.directory(path.parent) as parent:
                        parent_info = os.fstat(parent)
                        need(parent_info.st_uid == os.geteuid() and stat.S_IMODE(parent_info.st_mode) == 0o700,
                             'OCI resource snapshot parent is not private')
                        copied = os.open(path.name, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600, dir_fd=parent)
                        try:
                            offset = 0
                            while offset < len(raw):
                                written = os.write(copied, raw[offset:]); need(written > 0, 'OCI resource snapshot incomplete'); offset += written
                            os.fsync(copied); copied_info = os.fstat(copied)
                        finally: os.close(copied)
                        snapshots.append((path, identity(copied_info))); os.fsync(parent)
                    name = str(path); info = copied_info
                else:
                    need(stat.S_ISDIR(info.st_mode) or readonly and stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                         'Unsupported OCI mount descriptor type')
                # Trusted runtime files are staged on the data disk, rather than
                # exposing their original system-disk paths inside the container.
                runtime_targets={'/opt/gpuq/sdk.pyz','/opt/gpuq/libvgpu.so',
                    '/opt/gpuq/bin/gpuq-network','/opt/gpuq/bin/gpuq-ray','/opt/gpuq/bin/job-resources.py'}
                if readonly and stat.S_ISREG(info.st_mode) and target in runtime_targets:
                    path=self.folder/'tmp'/('runtime-'+uuid.uuid4().hex)
                    module('local-data').require_data_path(self.config,path.parent)
                    with self.s.directory(path.parent) as parent:
                        copied=os.open(path.name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o500,dir_fd=parent)
                        try:
                            offset=0
                            while offset<info.st_size:
                                raw=os.pread(fd,min(1024**2,info.st_size-offset),offset)
                                need(bool(raw),'运行时文件读取中断，请重试原任务。')
                                written=0
                                while written<len(raw):written+=os.write(copied,raw[written:])
                                offset+=len(raw)
                            os.fsync(copied);copied_info=os.fstat(copied)
                        finally:os.close(copied)
                        snapshots.append((path,identity(copied_info)));os.fsync(parent)
                    name=str(path);info=copied_info
                path = Path(name)
                if target!='/sys/fs/cgroup':module('local-data').require_data_path(self.config,path)
                need(path.is_absolute() and str(path) == name and '..' not in path.parts and ':' not in name
                     and '\n' not in name and '\x00' not in name and not name.endswith(' (deleted)'),
                     'OCI descriptor has no safe named source')
                parent = os.open('/', os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); held.append(parent)
                for index, part in enumerate(path.parts[1:]):
                    parent_info = os.fstat(parent)
                    child = os.stat(part, dir_fd=parent, follow_symlinks=False)
                    need(parent_info.st_uid in (0, os.geteuid())
                         and (not parent_info.st_mode & 0o022 or parent_info.st_uid == 0
                              and parent_info.st_mode & stat.S_ISVTX and child.st_uid in (0, os.geteuid())),
                         'OCI mount source parent can be replaced by another user: '
                         f'target={target!r} parent={str(Path(*path.parts[:index+1]))!r} '
                         f'mode={stat.S_IMODE(parent_info.st_mode):04o} uid={parent_info.st_uid} gid={parent_info.st_gid}')
                    need(not stat.S_ISLNK(child.st_mode), 'Symlink in OCI mount source')
                    edges.append((parent, part, identity(child)))
                    if index < len(path.parts)-2:
                        parent = os.open(part, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=parent); held.append(parent)
                    else: need(identity(child) == identity(info), 'OCI named source differs from trusted descriptor')
                need(fd not in sources or sources[fd] == name, 'Ambiguous OCI mount descriptor')
                sources[fd] = name
            self._mount_sources = sources
            yield
        finally:
            self._mount_sources = {}
            try:
                for path, before in snapshots:
                    with self.s.directory(path.parent) as parent:
                        os.unlink(path.name, dir_fd=parent); os.fsync(parent)
            finally:
                for fd in reversed(held): os.close(fd)

    def execute_workspace(self, spec, flags, registry_env):
        head=self.workspace_container(spec['project'])
        request={'engine':self.command(),'graph':str(self.folder/'graph'),'hostUid':os.getuid(),
                 'container':head['container'],'owner':self.owner,'project':spec['project'],
                 'execution':'gpuq-live-'+uuid.uuid4().hex,'flags':flags,'argv':spec['argv'],
                 'threadDefaults':getattr(self,'thread_defaults',{})}
        if spec.get('interactive'):
            request['terminalSocket']=str(self.root/'terminals'/(spec['id']+'.sock'))
        path=self.folder/'tmp'/('live-'+uuid.uuid4().hex+'.json')
        self.s.atomic_json(path,request)
        try:
            return self.call(self.command('unshare','/usr/bin/python3','-I','-B',str(HERE/'workspace-rootfs.py'),str(path)),
                             env=registry_env,pass_fds=())
        finally:path.unlink(missing_ok=True)


def run_project(config, spec, project, terminal, uuids, workfd, project_fds,
                dataset_fds, datafd=None, runtimefd=None, resourcefd=None, cgroupfd=None, *, stderr_sink=None):
    """Both existing scheduler profiles enter here after allocation/limits."""
    owner = PersonalOCI(config, spec.get('ownerId') or spec['userId'])
    resources = module('job-resources')
    owner.cpu_set = resources.allocated_cpus(uuids,config) if uuids and resources.cpuset_available() else []
    if spec.get('projectCopy'):owner.state_folder=module('project-copy').runtime_folder(config,spec['projectCopy'])
    owner.stderr_sink = stderr_sink
    mounts = [(workfd, '/workspace', False), (project_fds['home'], '/home/gpuq', False),
              (project_fds['output'], '/outputs', False)]
    mounts += [(fd, target, not terminal) for fd, target in dataset_fds]
    if runtimefd is not None:
        mounts.append((runtimefd, '/run/gpuq/runtime', False))
    if resourcefd is not None:
        mounts.append((resourcefd, '/run/gpuq/resources.json', True))
    # Keep the job's exact resource view read-only, not the host cgroup tree.
    if cgroupfd is not None:
        mounts.append((cgroupfd, '/sys/fs/cgroup', True))
    control, extra = ([], []) if terminal else module('training-control').prepare(
        config, spec, project['code'], project, os.environ)
    try:
        fd=os.open(Path(config['root'])/'outputs',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        extra.append(fd)
        mounts.append((fd,'/job-outputs',False))
        # Add helpers without hiding an image's own Conda/venv PATH. No host
        # environment forwarding: the immutable image supplies its base PATH.
        image_path='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        control += ['--setenv', 'PATH', '/opt/gpuq/bin:'+image_path]
        if resourcefd is not None:
            budget = json.loads(os.pread(resourcefd, 65536, 0))
            for key, value in resources.resource_environment(budget).items():
                control += ['--setenv', key, value]
            owner.thread_defaults = resources.thread_defaults(budget,owner.cpu_set)
            for key in owner.thread_defaults:
                if key in os.environ: control += ['--setenv', key, os.environ[key]]
        if runtimefd is not None:
            for key, value in {'RAY_TMPDIR':'/run/gpuq/runtime','GPUQ_RAY_TEMP_DIR':'/run/gpuq/runtime/ray',
                               'RAY_object_spilling_directory':'/tmp/gpuq-ray-spill'}.items():
                control += ['--setenv', key, value]
        for name in ('gpuq-network', 'gpuq-ray', 'job-resources.py'):
            path = HERE/name
            if path.exists():
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                extra.append(fd)
                mounts.append((fd, '/opt/gpuq/bin/'+name, True))
        # FDs belong to the trusted runner. Named sources are derived and
        # opened without following links by execute(); untrusted code never receives these FDs.
        return owner.execute(spec, project, terminal, uuids, mounts, control=control)
    finally:
        for fd in extra:
            os.close(fd)
