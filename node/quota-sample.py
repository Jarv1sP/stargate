#!/usr/bin/python3
"""Read-only project-quota sampler, run as root by stargate-quota-sample.timer.

For each data filesystem (bind aliases counted once) it lists every project ID
with quotactl(Q_GETNEXTQUOTA, PRJQUOTA) and writes <root>/samples/quota.json,
owned by the service account. It never sets a limit. Self-contained: the
installer runs a root-owned copy of this file, not the service-owned release.
"""
import argparse,ctypes,ctypes.util,errno,json,os,pwd,re,stat,struct,uuid
from datetime import datetime,timezone
from pathlib import Path
Q_GETNEXTQUOTA=0x800009
PRJQUOTA=2
DIR_FLAGS=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC


class NextDquot(ctypes.Structure):
    _fields_=[('bhardlimit',ctypes.c_uint64),('bsoftlimit',ctypes.c_uint64),('curspace',ctypes.c_uint64),
              ('ihardlimit',ctypes.c_uint64),('isoftlimit',ctypes.c_uint64),('curinodes',ctypes.c_uint64),
              ('btime',ctypes.c_uint64),('itime',ctypes.c_uint64),('valid',ctypes.c_uint32),('id',ctypes.c_uint32)]


def usage(device,libc=None,*,limits=False):
    """{id: (bytes, inodes)} for every project ID with usage; OSError(ESRCH) when quota is off."""
    libc=libc or ctypes.CDLL(ctypes.util.find_library('c'),use_errno=True)
    command=(Q_GETNEXTQUOTA<<8)|PRJQUOTA;result={};current=0
    while True:
        row=NextDquot()
        if libc.quotactl(command,os.fsencode(device),current,ctypes.byref(row))!=0:
            code=ctypes.get_errno()
            if code==errno.ENOENT and result:return result
            raise OSError(code,os.strerror(code))
        result[row.id]=({'bytes':row.curspace,'inodes':row.curinodes,'limitBytes':row.bhardlimit*1024,'softLimitBytes':row.bsoftlimit*1024} if limits else (row.curspace,row.curinodes))
        if row.id==0xFFFFFFFF:return result
        current=row.id+1


def enforcement(device,libc=None):
    """Linux Q_XGETQSTATV works on both ext4 and XFS; unknown stays null."""
    libc=libc or ctypes.CDLL(ctypes.util.find_library('c'),use_errno=True)
    raw=ctypes.create_string_buffer(256);raw[0]=b'\x01' # fs_quota_statv v1
    if libc.quotactl((((ord('X')<<8)+8)<<8)|PRJQUOTA,os.fsencode(device),0,ctypes.byref(raw))!=0:return None
    return bool(struct.unpack_from('H',raw.raw,2)[0] & (1<<5)) # FS_QUOTA_PDQ_ENFD


def mounts(text):
    """mountinfo rows: (mount point, major:minor, source)."""
    rows=[]
    for line in text.splitlines():
        head,_,tail=line.partition(' - ');fields=head.split();rest=tail.split()
        if len(fields)<5 or len(rest)<2:continue
        point=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m[1],8)),fields[4])
        rows.append((point,fields[2],re.sub(r'\\([0-7]{3})',lambda m:chr(int(m[1],8)),rest[1])))
    return rows


def filesystems(points,mountinfo,read=None):
    """One row per device in configuration order; aliases share the row."""
    table=mounts(mountinfo);result=[];by_device={}
    for point in points:
        try:info=os.stat(point)
        except OSError as error:
            result.append({'mountPoints':[str(point)],'device':None,'quota':False,'error':error.strerror});continue
        if info.st_dev in by_device:by_device[info.st_dev]['mountPoints'].append(str(point));continue
        number=f'{os.major(info.st_dev)}:{os.minor(info.st_dev)}'
        source=next((src for mount,dev,src in sorted(table,key=lambda r:-len(r[0])) if dev==number and (str(point)==mount or str(point).startswith(mount.rstrip('/')+'/'))),None)
        row={'mountPoints':[str(point)],'device':source,'quota':False,'enforced':None,'ids':{}}
        try:
            v=os.statvfs(point)
            row.update(totalBytes=v.f_blocks*v.f_frsize,usedBytes=(v.f_blocks-v.f_bfree)*v.f_frsize,availableBytes=v.f_bavail*v.f_frsize)
            if source is None:raise OSError(errno.ENODEV,'device not found in mountinfo')
            values=usage(source,limits=True) if read is None else read(source)
            row['ids']={str(key):value if isinstance(value,dict) else {'bytes':value[0],'inodes':value[1]} for key,value in sorted(values.items())}
            row['enforced']=enforcement(source)
            row['quota']=True
        except OSError as error:
            # ESRCH: project quota not enabled on this filesystem; usage shows unknown.
            row.update(quota=False,ids={},error=errno.errorcode.get(error.errno,str(error.errno)))
        by_device[info.st_dev]=row;result.append(row)
    return result


def open_directory(path):
    fd=os.open('/',DIR_FLAGS)
    try:
        for part in Path(path).parts[1:]:
            child=os.open(part,DIR_FLAGS,dir_fd=fd);os.close(fd);fd=child
        return fd
    except BaseException:os.close(fd);raise


def publish(root,value,owner,*,name='quota.json'):
    """Atomic write into a service-owned directory without following links."""
    base=open_directory(root)
    try:
        try:os.mkdir('samples',0o700,dir_fd=base);os.chown('samples',*owner,dir_fd=base,follow_symlinks=False)
        except FileExistsError:pass
        folder=os.open('samples',DIR_FLAGS,dir_fd=base)
    finally:os.close(base)
    tmp='.write-'+uuid.uuid4().hex
    try:
        fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=folder)
        try:
            os.fchown(fd,*owner);os.write(fd,json.dumps(value,sort_keys=True,separators=(',',':')).encode());os.fsync(fd)
        finally:os.close(fd)
        os.replace(tmp,name,src_dir_fd=folder,dst_dir_fd=folder);os.fsync(folder)
    finally:
        try:os.unlink(tmp,dir_fd=folder)
        except FileNotFoundError:pass
        os.close(folder)


def registry_next(root):
    """Capture the registry before sampling so later allocations stay unknown."""
    base=open_directory(root)
    try:folder=os.open('quota',DIR_FLAGS,dir_fd=base)
    finally:os.close(base)
    try:fd=os.open('ids.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=folder)
    finally:os.close(folder)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('登记表不是普通文件')
        with os.fdopen(os.dup(fd),'rb') as stream:return int(json.load(stream)['next'])
    finally:os.close(fd)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account',required=True)
    parser.add_argument('--root',action='append',required=True,help='profile state root; repeatable')
    parser.add_argument('mounts',nargs='+',help='dataMountPoints in configuration order')
    args=parser.parse_args(argv)
    # The installer resolves roots once; a root that later turns into a link fails
    # closed in open_directory instead of steering root writes elsewhere.
    roots=list(dict.fromkeys(args.root))
    points=[str(Path(point).resolve(strict=True)) for point in args.mounts]
    account=pwd.getpwnam(args.account)
    next_ids={}
    for root in roots:
        try:next_ids[root]=registry_next(root)
        except (OSError,ValueError,KeyError):next_ids[root]=None
    value={'checkedAt':datetime.now(timezone.utc).isoformat(),
           'filesystems':filesystems(points,Path('/proc/self/mountinfo').read_text())}
    failures=0
    for root in roots:
        try:publish(root,{**value,'next':next_ids[root]},(account.pw_uid,account.pw_gid))
        except OSError as error:failures+=1;print(f'用量样本未写入 {root}：{error}',flush=True)
    return 1 if failures==len(roots) else 0


if __name__=='__main__':
    os.umask(0o077)
    raise SystemExit(main())
