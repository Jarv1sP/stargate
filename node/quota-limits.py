#!/usr/bin/python3
"""Root-owned project-files hard-limit applier. Installation enables it explicitly.

Only verified p:<owner>/<project>:files IDs are eligible. A root-owned ledger
remembers their identity and grace deadline across restarts and registry edits.
No RPC can enable this program, choose a device, or change its clamps.
"""
import argparse,ctypes,ctypes.util,errno,fcntl,importlib.util,json,os,pwd,re,stat,time,uuid
from pathlib import Path

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

s=load('quota-sample');q=load('quota-ids')
FILES=re.compile(r'^p:([a-zA-Z0-9_-]{1,64})/([a-z][a-z0-9_-]{0,47}):files$')
Q_QUOTAON=0x800002;Q_GETQUOTA=0x800007;Q_SETQUOTA=0x800008
GRACE_SECONDS=7*86400

class Dquot(ctypes.Structure):
    _fields_=s.NextDquot._fields_[:-1]

class Kernel:
    def __init__(self):self.libc=ctypes.CDLL(ctypes.util.find_library('c'),use_errno=True)
    def call(self,command,device,number=0,row=None):
        if self.libc.quotactl((command<<8)|2,os.fsencode(device),number,None if row is None else ctypes.byref(row)):
            code=ctypes.get_errno();raise OSError(code,os.strerror(code))
    def get(self,device,number):
        row=Dquot();self.call(Q_GETQUOTA,device,number,row);return row
    def set(self,device,number,value):
        if number<1000:raise ValueError('不能给保留编号设置上限')
        row=Dquot();row.bhardlimit=(value+1023)//1024;row.valid=1 # QIF_BLIMITS only; soft = 0, no inode changes
        self.call(Q_SETQUOTA,device,number,row)
    def enable(self,device):
        try:self.call(Q_QUOTAON,device)
        except OSError as error:
            if error.errno!=errno.EBUSY:raise


def read_at(folder,name,missing=None):
    try:fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=folder)
    except FileNotFoundError:
        if missing is not None:return missing
        raise
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>8*1024**2:raise ValueError('限额记录必须是普通文件')
        with os.fdopen(os.dup(fd),'rb') as stream:return json.load(stream)
    finally:os.close(fd)


def inputs(root):
    fd=s.open_directory(root)
    try:folder=os.open('quota',s.DIR_FLAGS,dir_fd=fd)
    finally:os.close(fd)
    try:return read_at(folder,'ids.json'),read_at(folder,'limits.json',{'limits':[]})
    finally:os.close(folder)


def write_at(folder,name,value):
    tmp='.write-'+uuid.uuid4().hex
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=folder)
    try:
        with os.fdopen(fd,'w') as stream:json.dump(value,stream,separators=(',',':'));stream.flush();os.fsync(stream.fileno())
        os.replace(tmp,name,src_dir_fd=folder,dst_dir_fd=folder);os.fsync(folder)
    finally:
        try:os.unlink(tmp,dir_fd=folder)
        except FileNotFoundError:pass


def project_id(path):
    fd=s.open_directory(path)
    try:return q.projid(fd)
    finally:os.close(fd)


def protected_ids(points,allowed):
    """Record IDs on non-platform directory roots without trusting registry labels.

    Descend only along the configured platform paths; siblings (Docker, old
    user directories, datasets, etc.) can never become project-files IDs.
    """
    denied={0};allowed=[Path(p) for p in allowed]
    def visit(path):
        if path in allowed:return
        fd=s.open_directory(path)
        try:
            denied.add(q.projid(fd))
            for name in os.listdir(fd):
                try:
                    info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                    if info.st_dev!=os.fstat(fd).st_dev:continue
                    child=path/name
                    if stat.S_ISDIR(info.st_mode) and any(child==p or child in p.parents for p in allowed):visit(child)
                    elif stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode):
                        sub=os.open(name,s.DIR_FLAGS if stat.S_ISDIR(info.st_mode) else q.FILE_FLAGS,dir_fd=fd)
                        try:denied.add(q.projid(sub))
                        finally:os.close(sub)
                except FileNotFoundError:continue
        finally:os.close(fd)
    for point in points:visit(Path(point))
    return denied


def nonfiles_ids(root,workspace):
    """Read fixed non-files roots directly, independent of registry descriptions."""
    denied=set()
    def children(path):
        try:fd=s.open_directory(path)
        except FileNotFoundError:return
        try:
            denied.add(q.projid(fd))
            for name in os.listdir(fd):
                try:
                    child=os.open(name,q.FILE_FLAGS,dir_fd=fd)
                    try:
                        if stat.S_ISDIR(os.fstat(child).st_mode):denied.add(q.projid(child))
                    finally:os.close(child)
                except (FileNotFoundError,IsADirectoryError):continue
                except OSError as error:
                    if error.errno!=errno.ELOOP:raise
        finally:os.close(fd)
    for path in (root,workspace):
        fd=s.open_directory(path)
        try:denied.add(q.projid(fd))
        finally:os.close(fd)
    children(Path(root)/'outputs');children(Path(workspace)/'.oci')
    return denied


def desired_limits(value):
    rows=value['limits'];result={}
    if not isinstance(rows,list):raise ValueError('限额清单必须是列表')
    for row in rows:
        key=f"p:{row['ownerId']}/{row['project']}:files";amount=row['bytes']
        if not FILES.fullmatch(key) or type(amount) is not int or amount<=0:raise ValueError('项目限额无效')
        result[key]=amount
    return result


def apply(registry,desired,ledger,workspace,device,kernel,*,default,minimum,maximum,headroom,now,denied=(),clear=False):
    """Plan state is persisted by the caller before any kernel write."""
    names=registry['ids'];next_id=registry['next'];kinds=ledger.setdefault('kinds',{});projects=ledger.setdefault('projects',{})
    if clear:
        names={key:int(number) for number,key in kinds.items() if FILES.fullmatch(key)}
        next_id=max([1000,*names.values()])+1
    counts={}
    for number in names.values():counts[number]=counts.get(number,0)+1
    actions=[];status={}
    for key,number in names.items():
        if type(number) is not int or not 1000<=number<min(next_id,2**32):continue
        token=str(number);match=FILES.fullmatch(key);kind=key if match else 'excluded'
        # Once an ID is known as anything else, relabeling it can never cap it.
        if number in denied or counts[number]!=1:kind='excluded'
        if token not in kinds:
            if match and kind!='excluded':
                path=Path(workspace)/match[1]/match[2]
                try:
                    if project_id(path)!=number or project_id(path/'code')!=number or project_id(path/'home')!=number:kind='excluded'
                except OSError:continue
            kinds[token]=kind
        if not match or kinds[token]!=key or kind=='excluded':continue
        row=kernel.get(device,number);target=max(minimum,min(maximum,desired.get(key,default)))
        saved=projects.get(token)
        if saved is None:
            saved={'desiredBytes':target,'graceUntil':now+GRACE_SECONDS if row.curspace>target else None,
                   'graceBytes':max(target,row.curspace+headroom)};projects[token]=saved
        saved['desiredBytes']=target
        grace=saved['graceUntil'] if saved.get('graceUntil') and now<saved['graceUntil'] else None
        effective=0 if clear else max(target,saved['graceBytes']) if grace else target
        if row.bhardlimit!=(effective+1023)//1024 or row.bsoftlimit:actions.append((device,number,effective))
        status[key]={'desiredLimitBytes':target,'effectiveLimitBytes':effective,'graceUntil':grace}
    return actions,status


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--enabled',action='store_true');p.add_argument('--clear',action='store_true')
    p.add_argument('--account',required=True);p.add_argument('--root',action='append',required=True)
    p.add_argument('--workspaces-root',action='append',required=True)
    p.add_argument('--state-dir',default='/var/lib/stargate-quota-limits')
    p.add_argument('--default-bytes',type=int,default=100_000_000_000)
    p.add_argument('--min-bytes',type=int,default=1_000_000_000);p.add_argument('--max-bytes',type=int,default=10_000_000_000_000)
    p.add_argument('--headroom-bytes',type=int,default=10_000_000_000);p.add_argument('mounts',nargs='+')
    a=p.parse_args(argv)
    # Disabled means no root state, quotactl, enforcement, or grace clock changes.
    if not a.enabled and not a.clear:return 0
    if not 0<a.min_bytes<=a.default_bytes<=a.max_bytes or a.headroom_bytes<0:p.error('安装配置中的项目上限范围无效')
    if len(a.root)!=len(a.workspaces_root):p.error('状态根与项目根必须一一对应')
    if os.geteuid()!=0:raise PermissionError('限额程序必须由 root 运行')
    account=pwd.getpwnam(a.account);kernel=Kernel();now=int(time.time())
    # systemd StateDirectory creates this root-owned directory; links are refused.
    folder=s.open_directory(a.state_dir)
    try:
        info=os.fstat(folder)
        if info.st_uid!=0 or info.st_mode&0o022:raise ValueError('限额状态目录必须由 root 独占写入')
        lock=os.open('limits.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=folder)
        try:
            fcntl.flock(lock,fcntl.LOCK_EX)
            state=read_at(folder,'state.json',{'roots':{}})
            mountinfo=Path('/proc/self/mountinfo').read_text();table=s.mounts(mountinfo)
            denied=protected_ids(a.mounts,[*a.root,*a.workspaces_root])
            for root,workspace in dict.fromkeys(zip(a.root,a.workspaces_root)):
                try:registry,desired=inputs(root)
                except FileNotFoundError:
                    if not a.clear:continue # no registry yet, no IDs to cap
                    registry,desired={'ids':{},'next':1000},{'limits':[]}
                desired=desired_limits(desired)
                number=f'{os.major(os.stat(workspace).st_dev)}:{os.minor(os.stat(workspace).st_dev)}'
                device=next(src for point,dev,src in sorted(table,key=lambda r:-len(r[0])) if dev==number and (workspace==point or workspace.startswith(point.rstrip('/')+'/')))
                fs=next(line.split(' - ')[1].split()[0] for line in mountinfo.splitlines() if line.split()[2]==number)
                ledger=state['roots'].setdefault(root,{})
                actions,status=apply(registry,desired,ledger,workspace,device,kernel,default=a.default_bytes,minimum=a.min_bytes,
                    maximum=a.max_bytes,headroom=a.headroom_bytes,now=now,denied=denied|nonfiles_ids(root,workspace),clear=a.clear)
                write_at(folder,'state.json',state)
                # Repeat at every invocation/boot, never edit fstab. Clear never enables enforcement.
                if a.enabled and not a.clear and fs=='ext4':kernel.enable(device)
                for device,number,amount in actions:kernel.set(device,number,amount)
                s.publish(root,{'checkedAt':now,'enabled':not a.clear,'defaultLimitBytes':a.default_bytes,'projects':status},
                          (account.pw_uid,account.pw_gid),name='quota-limits.json')
        finally:os.close(lock)
    finally:os.close(folder)
    return 0

if __name__=='__main__':
    os.umask(0o077)
    raise SystemExit(main())
