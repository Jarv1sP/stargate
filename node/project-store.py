"""Mutable SSD project workspaces; no releases, snapshots or migration."""
import contextlib,fcntl,importlib.util,json,os,re,stat,time,uuid
from pathlib import Path
SLUG=re.compile(r'^[a-z][a-z0-9_-]{0,47}$')
JOB_ID=re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
DIR_FLAGS=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
FILE_FLAGS=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
WORKSPACE_WARNING_BYTES=256*1024**3
WORKSPACE_HARD_FLOOR_BYTES=64*1024**3
PROJECT_LOCK_WAIT_SECONDS=2.0

def data():
    spec=importlib.util.spec_from_file_location('project_data',Path(__file__).with_name('local-data.py'))
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result

def check_platform_root(root,config):return data().require_data_path(config,root)

class ProjectError(ValueError):
    def __init__(self, code, message, details=None):
        self.code = code
        self.details = details or {}
        super().__init__(message)


def fail(code, message):
    raise ProjectError(code, message)


def wait_project_lock(fd, mode, message):
    """Wait only to acquire the same checked descriptor, never replay a body."""
    deadline = time.monotonic() + PROJECT_LOCK_WAIT_SECONDS
    while True:
        try:
            fcntl.flock(fd, mode | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                fail('project_busy', message)
            time.sleep(min(0.05, remaining))


def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':')).encode()


def absolute(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or path == Path('/'):
        fail('unsafe_path', 'An absolute, non-root storage path is required')
    return path


@contextlib.contextmanager
def directory(path):
    """Open every ancestor without following links, including the final one."""
    path = absolute(path)
    fd = os.open('/', DIR_FLAGS)
    try:
        for name in path.parts[1:]:
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def workspace_reserve_bytes(config):
    """The existing 64 GiB resource floor."""
    return WORKSPACE_HARD_FLOOR_BYTES


def workspace_storage_check(available, needed=0):
    if any(type(v) is not int or not 0 <= v <= 2**63 - 1 for v in (available, needed)):
        fail('invalid_input', 'Workspace space requirements must be nonnegative integer byte counts')
    if needed and available - needed < WORKSPACE_HARD_FLOOR_BYTES:
        fail('insufficient_space',
             f'Personal workspace hard floor reached: availableBytes={available}, '
             f'requestedBytes={needed}, hardFloorBytes={WORKSPACE_HARD_FLOOR_BYTES}.')
    return {'availableBytes': available, 'hardFloorBytes': WORKSPACE_HARD_FLOOR_BYTES,
            'warningBytes': WORKSPACE_WARNING_BYTES,
            'warning': 'LOW_DISK_SPACE' if available < WORKSPACE_WARNING_BYTES else None}


def require_workspace_space(root,reserve_bytes=None,needed=0,*,target_fd=None):
    with directory(root) as fd:
        v=os.fstatvfs(fd if target_fd is None else target_fd)
        return workspace_storage_check(v.f_bavail*v.f_frsize,needed)


def private_dir(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    with directory(path) as fd:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            fail('unsafe_path', 'Project control directories must be service-owned mode 0700')
    return path


def read_json(path, limit=None):
    fd = os.open(path, FILE_FLAGS)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_mode & 0o022 or limit is not None and info.st_size > limit:
            fail('unsafe_path', 'Unsafe or oversized project metadata')
        chunks = []
        remaining = (info.st_size if limit is None else limit) + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 1024 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        if not remaining:
            fail('changed', '项目记录过大，请联系管理员。')
        return json.loads(b''.join(chunks))
    finally:
        os.close(fd)


def atomic_json(path, value):
    """Control metadata only; the parent is service-private and already checked."""
    tmp = path.parent / ('.write-' + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        with directory(path.parent) as parent:
            os.fsync(parent)
    finally:
        tmp.unlink(missing_ok=True)



class ProjectStore:
    def __init__(self,root,base_path=None,reserve_bytes=None,*,config):
        self.config=config;self.root=data().root(config,'root');self.path=data().root(config,'workspacesRoot')
        self.path=private_dir(self.path)

    def owner_path(self,user,create=False):
        path=self.path/data().name(user)
        return private_dir(path,create=create)

    def _project(self,user,slug):
        path=private_dir(self.owner_path(user)/data().name(slug))
        return path,read_json(path/'project.json')

    def admit(self,user,slug):return self._project(user,slug)

    @contextlib.contextmanager
    def locked(self,user,slug,blocking=True):
        path,_=self._project(user,slug)
        fd=os.open(path/'.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:wait_project_lock(fd,fcntl.LOCK_EX,'项目忙，请沿原编号稍后重试。');yield
        finally:os.close(fd)

    lifetime=locked

    def create(self,user,slug,repo=None):
        owner=self.owner_path(user,create=True);path=owner/data().name(slug)
        require_workspace_space(self.path,needed=1)
        private_dir(path,create=True)
        file=path/'project.json'
        if file.exists():return self.status(user,slug)
        for n in ('code','home'):private_dir(path/n,create=True)
        atomic_json(file,{'project':slug,'userId':user,'ownerId':user,'createdAt':time.time(),
                         'environmentMode':'oci','repo':repo,'archived':False,'name':slug,'group':''})
        return self.status(user,slug)

    def dev_paths(self,user,slug):
        path,meta=self._project(user,slug)
        return {'code':private_dir(path/'code'),'home':private_dir(path/'home')}

    def status(self,user,slug):
        path,meta=self._project(user,slug)
        return {**meta,'git':{'url':meta.get('repo'),'branch':None,'commit':None},
                'workspace':True,'editable':True,'state':'ACTIVE'}

    def list(self,user=None,*,include_usage=False):
        result=[];complete=True
        for owner in sorted(self.path.iterdir()):
            if owner.name.startswith('.') or owner.is_symlink() or not owner.is_dir():continue
            try:folders=sorted(owner.iterdir())
            except OSError:complete=False;continue
            for folder in folders:
                try:
                    if folder.name.startswith('.') or folder.is_symlink() or not folder.is_dir():continue
                    row=self.status(owner.name,folder.name)
                except FileNotFoundError:complete=False;continue
                except ValueError:continue
                except OSError:
                    complete=False
                    if not include_usage:continue
                    row={'project':folder.name,'ownerId':owner.name}
                if include_usage:row.update(data().size(folder,partial=True))
                result.append(row)
        return {'projects':result,'complete':complete} if include_usage else result

    def update(self,user,slug,args):
        with self.locked(user,slug):
            path,meta=self._project(user,slug)
            meta.update({k:args[k] for k in ('name','group','archived') if k in args})
            atomic_json(path/'project.json',meta)
        return self.status(user,slug)

    def workspace_output(self,user,slug,*,jobid,create=True):
        if not isinstance(jobid,str) or not JOB_ID.fullmatch(jobid):raise ValueError('任务编号无效。')
        outputs=private_dir(self.root/'outputs',create=create)
        return private_dir(outputs/jobid,create=create)

    def runtime_paths(self,spec,jobid,terminal=False):
        if spec.get('projectCopy'):
            import importlib.util
            module=importlib.util.spec_from_file_location('runtime_copy',Path(__file__).with_name('project-copy.py'))
            copy=importlib.util.module_from_spec(module);module.loader.exec_module(copy)
            folder=copy.runtime_folder(self.config,spec['projectCopy'])
            paths={name:private_dir(folder/name) for name in ('code','home')}
        else:paths=self.dev_paths(spec.get('ownerId') or spec['userId'],spec['project'])
        return {**paths,'output':self.workspace_output(spec['userId'],spec['project'],jobid=jobid),
                'environmentMode':'oci','workspace':True,'readonly':False}

    def existing_run_paths(self,user,slug,version,jobid):
        return {'output':self.workspace_output(user,slug,jobid=jobid,create=False),'outputShared':False}
