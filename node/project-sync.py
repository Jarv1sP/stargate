"""File-level project merge. Metadata selects bytes; target-only paths survive."""
import importlib.util,io,json,os,shutil,stat,tarfile,uuid
from decimal import Decimal
from pathlib import Path


def module(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


d=module('local-data')


def entries(path):
    with open(path) as stream:
        for line in stream:yield json.loads(line)


def index(bundle,rootfs=False):
    """Freeze the tar member offsets once, then page without rescanning the tree."""
    with open(bundle/'index.jsonl','w') as output:
        for name in (['rootfs.tar'] if rootfs else [])+['workspace.tar']:
            seen={}
            with tarfile.open(bundle/name) as archive:
                for member in archive:
                    path=member.name.removeprefix('./').rstrip('/')
                    if name=='rootfs.tar':
                        if not path or path=='.' or path.split('/')[0] in ('proc','sys','dev','run','tmp','workspace','outputs','job-outputs') or path=='home/gpuq' or path.startswith('home/gpuq/') or path in ('etc/hosts','etc/hostname','etc/resolv.conf'):continue
                        area='rootfs'
                    else:
                        area,prefix=('code','workspace/') if path.startswith('workspace/') else ('home','home/gpuq/')
                        if not path.startswith(prefix):continue
                        path=path[len(prefix):]
                    if any(part.startswith(('.trash','.upload-')) for part in path.split('/')) or area=='code' and (path=='.copy-backups' or path.startswith('.copy-backups/')):continue
                    d.relative(path)
                    kind='file' if member.isfile() else 'directory' if member.isdir() else 'symlink' if member.issym() else 'hardlink' if member.islnk() else None
                    if kind is None:continue
                    row={'area':area,'path':path,'type':kind,'size':member.size,'mode':stat.S_IMODE(member.mode),'uid':member.uid,'gid':member.gid,
                         'mtime':int(Decimal(str(member.pax_headers.get('mtime',member.mtime)))*10**9),'archive':name,'offset':member.offset_data}
                    if kind in ('symlink','hardlink'):row['link']=member.linkname
                    if kind=='hardlink':
                        original=seen[member.linkname.removeprefix('./')]
                        row.update(size=original['size'],offset=original['offset'],link=original['path'],linkArea=original['area'])
                    seen[member.name.removeprefix('./')]=row
                    output.write(json.dumps(row)+'\n')


def page(path,offset):
    with open(path) as stream:
        stream.seek(offset);rows=[]
        size=0
        for _ in range(200):
            line=stream.readline()
            if not line:break
            rows.append(json.loads(line));size+=len(line)
            if size>=1000000:break
        next_offset=stream.tell()
        return {'entries':rows,'nextOffset':next_offset if stream.read(1) else None,'mode':'incremental'}


def existing(root,path):
    try:
        with d.parent(root,path) as (fd,name):return os.stat(name,dir_fd=fd,follow_symlinks=False)
    except (FileNotFoundError,NotADirectoryError):return None
    except OSError as error:
        if error.errno==__import__('errno').ELOOP:return None
        raise


def same(root,row,paths):
    info=existing(root,row['path'])
    if info is None:return False
    if (stat.S_IMODE(info.st_mode),info.st_uid,info.st_gid)!=(row['mode'],row['uid'],row['gid']):return False
    if row['type']=='directory':return stat.S_ISDIR(info.st_mode)
    if row['type']=='symlink':
        if not stat.S_ISLNK(info.st_mode):return False
        with d.parent(root,row['path']) as (fd,name):return os.readlink(name,dir_fd=fd)==row['link']
    if not stat.S_ISREG(info.st_mode) or info.st_size!=row['size'] or info.st_mtime_ns!=row['mtime']:return False
    if row['type']=='hardlink':
        other=existing(paths[row['linkArea']],row['link'])
        return other is not None and (info.st_dev,info.st_ino)==(other.st_dev,other.st_ino)
    return True


def roots(request,rootfs):return {'rootfs':rootfs,**{k:Path(v) for k,v in request['paths'].items()}}


def plan(request,rootfs):
    paths=roots(request,rootfs);total=0
    previous={}
    if Path(request['plan']).exists():
        for row in entries(request['plan']):
            previous[row['area'],row['path']]=row['body']
            try:
                with d.parent(paths[row['area']],row['path']) as (fd,name):
                    for prefix in ('.copy-old-','.copy-new-'):remove_at(fd,prefix+row['body'].rsplit('/',1)[-1])
            except (FileNotFoundError,NotADirectoryError):pass
    with open(request['plan']+'.tmp','w') as stream:
        for row in entries(request['index']):
            if same(paths[row['area']],row,paths):continue
            row['body']=previous.get((row['area'],row['path'])) or 'files/'+str(uuid.uuid4())
            if row['type']=='file':total+=row['size']
            stream.write(json.dumps(row)+'\n')
    os.replace(request['plan']+'.tmp',request['plan'])
    return {'totalBytes':total}


def saved_member(archive,fd,name,arcname,recursive):
    """Archive through held data-directory FDs, including links without following."""
    info=os.stat(name,dir_fd=fd,follow_symlinks=False);member=tarfile.TarInfo(arcname)
    member.mode=stat.S_IMODE(info.st_mode);member.uid=info.st_uid;member.gid=info.st_gid
    member.pax_headers={'mtime':str(Decimal(info.st_mtime_ns)/10**9)}
    if stat.S_ISREG(info.st_mode):
        member.size=info.st_size
        with os.fdopen(os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd),'rb') as data:archive.addfile(member,data)
    elif stat.S_ISLNK(info.st_mode):member.type=tarfile.SYMTYPE;member.linkname=os.readlink(name,dir_fd=fd);archive.addfile(member)
    elif stat.S_ISDIR(info.st_mode):
        member.type=tarfile.DIRTYPE;archive.addfile(member)
        if recursive:
            child=os.open(name,d.DIR_FLAGS,dir_fd=fd)
            try:
                for value in os.listdir(child):saved_member(archive,child,value,arcname+'/'+value,True)
            finally:os.close(child)


def backup(request,rootfs):
    paths=roots(request,rootfs);selected=[];covered=[];needed=0;new_bytes=0
    for row in entries(request['plan']):
        if row['type']=='file':new_bytes+=row['size']
        root=paths[row['area']];path=row['path'];info=existing(root,path)
        if info is None or any(area==row['area'] and path.startswith(prefix+'/') for area,prefix in covered):continue
        recursive=stat.S_ISDIR(info.st_mode) and row['type']!='directory'
        needed+=d.size(root/path) if recursive else info.st_size if stat.S_ISREG(info.st_mode) else 0
        selected.append((row,recursive))
        if recursive:covered.append((row['area'],path))
    relative='.copy-backups/'+request['key']+'.tar'
    with d.parent(paths['code'],relative,create=True) as (fd,name):
        try:old=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
        except FileNotFoundError:old=None
        try:
            old_size=os.fstat(old).st_size if old is not None else 0
            # Received bodies, replacement files, old archive and its atomic
            # extension coexist. Keep every overwritten version on resume.
            module('project-store').require_workspace_space(paths['code'],needed=old_size+needed+new_bytes+10240+len(selected)*1024)
            if not selected:return {'files':0}
            temporary=name+'.tmp';out=os.open(temporary,os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600,dir_fd=fd)
            with os.fdopen(out,'w+b') as data:
                if old is not None:
                    with os.fdopen(os.dup(old),'rb') as original:shutil.copyfileobj(original,data)
                    data.seek(0)
                with tarfile.open(fileobj=data,mode='a' if old is not None else 'w',format=tarfile.PAX_FORMAT) as archive:
                    saved=set(archive.getnames());retry='retries/'+uuid.uuid4().hex+'/'
                    for row,recursive in selected:
                        name=row['area']+'/'+row['path'];name=retry+name if name in saved else name
                        with d.parent(paths[row['area']],row['path']) as (parent,leaf):saved_member(archive,parent,leaf,name,recursive)
                data.flush();os.fsync(data.fileno())
            os.replace(temporary,relative.rsplit('/',1)[-1],src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd)
        finally:
            if old is not None:os.close(old)
    return {'files':len(selected)}


def metadata(fd,name,row):
    os.chown(name,row['uid'],row['gid'],dir_fd=fd,follow_symlinks=False)
    if row['type']!='symlink':
        child=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
        try:os.fchmod(child,row['mode'])
        finally:os.close(child)
    os.utime(name,ns=(row['mtime'],row['mtime']),dir_fd=fd,follow_symlinks=False)


def remove_at(fd,name):
    try:info=os.stat(name,dir_fd=fd,follow_symlinks=False)
    except FileNotFoundError:return
    if stat.S_ISDIR(info.st_mode):shutil.rmtree('/proc/self/fd/'+str(fd)+'/'+name)
    else:os.unlink(name,dir_fd=fd)


def apply(request,rootfs):
    with module('copy-batches').CopyBatches(request['bundle']) as batches:
        return apply_files(request,rootfs,batches)


def apply_files(request,rootfs,batches):
    paths=roots(request,rootfs);rows=list(entries(request['plan']));bundle=Path(request['bundle'])
    module('project-store').require_workspace_space(paths['code'],needed=sum(row['size'] for row in rows if row['type']=='file'))
    # Parent type changes precede their children; directory metadata is set last.
    rows.sort(key=lambda row:(row['type']=='hardlink',row['path'].count('/'),row['path']))
    for row in rows:
        root=paths[row['area']]
        with d.parent(root,row['path'],create=True) as (fd,name):
            info=existing(root,row['path']);directory=info is not None and stat.S_ISDIR(info.st_mode)
            retired='.copy-old-'+row['body'].rsplit('/',1)[-1]
            if row['type']=='directory' and directory:remove_at(fd,retired);continue
            temporary='.copy-new-'+row['body'].rsplit('/',1)[-1];remove_at(fd,temporary)
            if row['type']=='directory':os.mkdir(temporary,0o700,dir_fd=fd)
            elif row['type']=='symlink':os.symlink(row['link'],temporary,dir_fd=fd)
            elif row['type']=='hardlink':
                with d.parent(paths[row['linkArea']],row['link']) as (source,link):os.link(link,temporary,src_dir_fd=source,dst_dir_fd=fd,follow_symlinks=False)
            else:
                out=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
                try:
                    source=bundle/(row['body'] if request.get('incremental') else row['archive'])
                    raw=batches.body(row['body']) if request.get('incremental') else None
                    with (io.BytesIO(raw) if raw is not None else open(source,'rb')) as stream,os.fdopen(os.dup(out),'wb') as target:
                        stream.seek(0 if request.get('incremental') else row['offset']);left=row['size']
                        while left:
                            raw=stream.read(min(left,1024**2))
                            if not raw:raise ValueError('项目文件尚未收齐，请沿原复制编号续传。')
                            target.write(raw);left-=len(raw)
                        target.flush();os.fsync(target.fileno())
                finally:os.close(out)
            # Publish only a complete inode, including executable permissions.
            metadata(fd,temporary,row)
            if info is not None and directory!=(row['type']=='directory'):
                # Old contents were saved before this atomic type replacement.
                os.rename(name,retired,src_dir_fd=fd,dst_dir_fd=fd)
            os.replace(temporary,name,src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd);remove_at(fd,retired)
    for row in reversed(rows):
        with d.parent(paths[row['area']],row['path']) as (fd,name):
            if row['type']=='directory':metadata(fd,name,row)
    return {'files':len(rows)}


def execute(request,rootfs):
    if request['action']=='image':
        fd=d.open_directory(rootfs)
        try:
            with tarfile.open(Path(request['bundle'])/'rootfs.tar','w',format=tarfile.PAX_FORMAT) as archive:
                for name in os.listdir(fd):saved_member(archive,fd,name,name,True)
        finally:os.close(fd)
        return {}
    return {'plan':plan,'backup':backup,'apply':apply}[request['action']](request,rootfs)
