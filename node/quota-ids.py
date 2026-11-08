"""Project-quota IDs: one registry per node and best-effort directory tagging.

The kernel accounts every inode under its project ID, and a directory with
PROJINHERIT hands its ID to new children. Renaming an inode into a PROJINHERIT
directory with a different ID returns EXDEV, so container-type directories
(roots, .trash, .copies, a layer directory itself) never get PROJINHERIT.
Tagging never blocks a user operation: on failure the bytes stay on ID 0 and
show as untracked. Stdlib only, so the root migration can load this file alone.
"""
import contextlib,errno,fcntl,importlib.util,json,os,stat,struct,sys,uuid
from pathlib import Path
FS_IOC_FSGETXATTR=0x801C581F
FS_IOC_FSSETXATTR=0x401C5820
FS_XFLAG_PROJINHERIT=0x200
FSXATTR='IIIII8x'  # xflags, extsize, nextents, projid, cowextsize, pad: 28 bytes
FIRST_ID=1000
PLATFORM='a:platform'
UNASSIGNED='o:unassigned'
UNSUPPORTED=(errno.EOPNOTSUPP,errno.ENOTTY,errno.ENOSYS)
FILE_FLAGS=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC|os.O_NOCTTY

def module(name):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def files_key(owner,project):return f'p:{owner}/{project}:files'
def outputs_key(owner,project):return f'p:{owner}/{project}:outputs'
def env_key(owner,project):return f'p:{owner}/{project}:env'
def images_key(owner):return 'i:'+owner
def dataset_key(name):return 'd:'+name
def external_key(path):return 'x:'+str(path)

def describe(key):
    """('project',owner,project,part) / ('images',owner) / ('dataset',name) / ('external',path) / (kind,)."""
    if not isinstance(key,str):return None
    if key==PLATFORM:return ('platform',)
    if key==UNASSIGNED:return ('unassignedOutputs',)
    kind,_,rest=key.partition(':')
    if kind=='p' and rest.count(':') and '/' in rest:
        name,part=rest.rsplit(':',1);owner,project=name.split('/',1)
        if part in ('files','outputs','env'):return ('project',owner,project,part)
    if kind=='i' and rest:return ('images',rest)
    if kind=='d' and rest:return ('dataset',rest)
    if kind=='x' and rest:return ('external',rest)
    return None

def folder(config):
    """Runtime registry folder <root>/quota, service-owned 0700."""
    s=module('project-store');return s.private_dir(s.data().root(config,'root')/'quota',create=True)

def owned(fd):
    # Root (migration/sampler) keeps the service account as owner of what it writes.
    if os.geteuid()==0:
        info=os.fstat(fd)
        return info.st_uid,info.st_gid
    return None

def read(path):
    """Registry contents; a missing registry is empty."""
    try:fd=os.open(Path(path)/'ids.json',FILE_FLAGS)
    except FileNotFoundError:return {'next':FIRST_ID,'ids':{}}
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):raise ValueError('项目记账登记表不是普通文件，请联系管理员。')
        with os.fdopen(os.dup(fd),'rb') as stream:value=json.load(stream)
    finally:os.close(fd)
    return {'next':int(value.get('next',FIRST_ID)),'ids':{k:int(v) for k,v in value.get('ids',{}).items()}}

def write(path,value):
    path=Path(path);directory=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    tmp='.write-'+uuid.uuid4().hex
    try:
        fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
        try:
            owner=owned(directory)
            if owner:os.fchown(fd,*owner)
            os.write(fd,json.dumps(value,sort_keys=True,separators=(',',':')).encode());os.fsync(fd)
        finally:os.close(fd)
        os.replace(tmp,'ids.json',src_dir_fd=directory,dst_dir_fd=directory);os.fsync(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):os.unlink(tmp,dir_fd=directory)
        os.close(directory)

def allocate(path,keys):
    """Return {key: id}; new keys get the next ID. IDs are never reused."""
    path=Path(path);fd=os.open(path/'ids.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        directory=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:owner=owned(directory)
        finally:os.close(directory)
        if owner:os.fchown(fd,*owner)
        fcntl.flock(fd,fcntl.LOCK_EX)
        value=read(path);missing=[key for key in dict.fromkeys(keys) if key not in value['ids']]
        for key in missing:value['ids'][key]=value['next'];value['next']+=1
        if missing:write(path,value)
        return {key:value['ids'][key] for key in keys}
    finally:os.close(fd)

def getx(fd):
    raw=bytearray(struct.calcsize(FSXATTR));fcntl.ioctl(fd,FS_IOC_FSGETXATTR,raw)
    return struct.unpack(FSXATTR,raw)

def projid(fd):return getx(fd)[3]

def setx(fd,value,inherit=None):
    """Set the project ID; inherit True/False sets or clears PROJINHERIT, None keeps flags."""
    xflags,extsize,nextents,current,cow=getx(fd)
    flags=xflags if inherit is None else xflags|FS_XFLAG_PROJINHERIT if inherit else xflags&~FS_XFLAG_PROJINHERIT
    if (current,xflags)==(value,flags):return False
    fcntl.ioctl(fd,FS_IOC_FSSETXATTR,struct.pack(FSXATTR,flags,extsize,nextents,value,cow));return True

def tag_dir(path,value,inherit=True):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:return setx(fd,value,inherit)
    finally:os.close(fd)

def counter():return {'directories':0,'files':0,'skipped':0,'linked':0,'symlinks':0,'whiteouts':0,'fifos':0,'sockets':0,'errors':{}}

def failed(counts,error):
    name=errno.errorcode.get(error.errno,str(error.errno));counts['errors'][name]=counts['errors'].get(name,0)+1

def open_file(name,parent):
    try:return os.open(name,FILE_FLAGS|getattr(os,'O_NOATIME',0),dir_fd=parent)
    except PermissionError:return os.open(name,FILE_FLAGS,dir_fd=parent)

def rebuild_special(name,parent,counts,*,staging=None):
    """Migration only: special inodes inherit the already tagged parent ID.

    Keep the old name until metadata, including overlay xattrs, is copied.
    /proc anchors xattr calls (no dir_fd in Python 3.10) at the held FD.
    """
    info=os.stat(name,dir_fd=parent,follow_symlinks=False);mode=info.st_mode
    if stat.S_ISSOCK(mode):counts['sockets']+=1;return
    kind='symlinks' if stat.S_ISLNK(mode) else 'fifos' if stat.S_ISFIFO(mode) else 'whiteouts' if stat.S_ISCHR(mode) and info.st_rdev==0 else None
    if kind is None:counts['skipped']+=1;return
    source=f'/proc/self/fd/{parent}/{name}'
    attrs={key:os.getxattr(source,key,follow_symlinks=False) for key in os.listxattr(source,follow_symlinks=False)}
    target=os.readlink(name,dir_fd=parent) if kind=='symlinks' else None
    target_parent=parent if staging is None else staging
    temporary='.quota-'+uuid.uuid4().hex;destination=f'/proc/self/fd/{target_parent}/{temporary}'
    try:
        if kind=='symlinks':os.symlink(target,temporary,dir_fd=target_parent)
        elif kind=='fifos':os.mkfifo(temporary,stat.S_IMODE(mode),dir_fd=target_parent)
        else:os.mknod(temporary,mode,0,dir_fd=target_parent)
        os.chown(temporary,info.st_uid,info.st_gid,dir_fd=target_parent,follow_symlinks=False)
        if kind!='symlinks':os.chmod(destination,stat.S_IMODE(mode),follow_symlinks=False)
        for key,value in attrs.items():os.setxattr(destination,key,value,follow_symlinks=False)
        os.utime(temporary,ns=(info.st_atime_ns,info.st_mtime_ns),dir_fd=target_parent,follow_symlinks=False)
        os.replace(temporary,name,src_dir_fd=target_parent,dst_dir_fd=parent);counts[kind]+=1
    finally:
        with contextlib.suppress(FileNotFoundError):os.unlink(temporary,dir_fd=target_parent)


def tag_tree(path,value,*,top=True,prune=(),linked=False,counts=None,inherit=True,rebuild=False):
    """Directories get the ID and `inherit`, files only the ID.

    Never follows symlinks or leaves the top directory's device. `top=False`
    treats the top as a container-type directory (no PROJINHERIT, ID kept).
    `prune` holds (st_dev, st_ino) of directories that keep their own IDs.
    `linked` skips hard-linked files that already carry a non-zero ID.
    """
    counts=counter() if counts is None else counts
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        device=os.fstat(fd).st_dev
        if top:setx(fd,value,inherit)
        else:setx(fd,projid(fd),False)
        counts['directories']+=1
        for _,dirnames,filenames,dirfd in os.fwalk('.',dir_fd=fd,follow_symlinks=False,onerror=lambda error:failed(counts,error)):
            kept=[]
            for name in dirnames:
                try:
                    info=os.stat(name,dir_fd=dirfd,follow_symlinks=False)
                    # fwalk lists links to directories here too; they are never followed.
                    if info.st_dev!=device or (info.st_dev,info.st_ino) in prune:counts['skipped']+=1;continue
                    if not stat.S_ISDIR(info.st_mode):
                        if rebuild and inherit:rebuild_special(name,dirfd,counts)
                        else:counts['skipped']+=1
                        continue
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=dirfd)
                    try:setx(child,value,inherit)
                    finally:os.close(child)
                    counts['directories']+=1;kept.append(name)
                except OSError as error:failed(counts,error)
            dirnames[:]=kept
            for name in filenames:
                try:
                    info=os.stat(name,dir_fd=dirfd,follow_symlinks=False)
                    if info.st_dev!=device:counts['skipped']+=1;continue
                    if not stat.S_ISREG(info.st_mode):
                        if rebuild and inherit:rebuild_special(name,dirfd,counts)
                        elif stat.S_ISSOCK(info.st_mode):counts['sockets']+=1
                        else:counts['skipped']+=1
                        continue
                    child=open_file(name,dirfd)
                    try:
                        if linked and info.st_nlink>1 and projid(child)!=0:counts['linked']+=1;continue
                        setx(child,value);counts['files']+=1
                    finally:os.close(child)
                except OSError as error:failed(counts,error)
    finally:os.close(fd)
    return counts

def tag_layer(layer,env,images,*,rebuild=False):
    """A container layer: the layer directory keeps the images ID without
    PROJINHERIT (podman stages its deletion by rename), everything below it
    carries one env ID so overlay copy-up stays inside one ID. A partial
    failure puts the children back on the images ID."""
    layer=Path(layer);counts=counter();done=[]
    fd=os.open(layer,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        setx(fd,env if rebuild else images,rebuild)
        for name in sorted(os.listdir(fd)):
            try:
                info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    done.append(layer/name);tag_tree(layer/name,env,counts=counts,rebuild=rebuild)
                elif stat.S_ISREG(info.st_mode):
                    child=open_file(name,fd)
                    try:setx(child,env);counts['files']+=1
                    finally:os.close(child)
                elif rebuild:rebuild_special(name,fd,counts)
            except OSError as error:failed(counts,error)
    finally:
        try:setx(fd,images,False)
        finally:os.close(fd)
    if counts['errors']:
        for child in done:
            with contextlib.suppress(OSError):tag_tree(child,images,rebuild=rebuild)
    return counts

def heal_layer(layer,env):
    """Before each container entry: if one of diff/work lost the env ID, retag it."""
    ids={}
    for name in ('diff','work'):
        fd=os.open(Path(layer)/name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:ids[name]=projid(fd)
        finally:os.close(fd)
    if env not in ids.values() or set(ids.values())=={env}:return False
    if ids['work']!=env:tag_tree(Path(layer)/'work',env)
    if ids['diff']!=env:tag_dir(Path(layer)/'diff',env)
    return True

def note(key,path,error):
    print(f'项目记账打标未完成，相应字节计入未登记：{key} {path} {error}',file=sys.stderr)

def assign(config,key,path,*,tree=False):
    """Runtime: allocate `key` and tag a directory the platform just created."""
    try:
        value=allocate(folder(config),[key])[key]
        if tree:
            counts=tag_tree(path,value)
            if counts['errors']:note(key,path,counts['errors'])
        else:tag_dir(path,value)
        return value
    except Exception as error:
        note(key,path,error);return None
