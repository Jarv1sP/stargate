"""Owner-private PTY history, paged by byte offset; no input or writer tokens."""
import base64,json,os,stat
from pathlib import Path
CHUNK=65536

def output_fd(folder,jid,create=False):
    fd=os.open(Path(folder)/(jid+'.output'),os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW if create else os.O_RDONLY|os.O_NOFOLLOW,0o600)
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077 or info.st_nlink!=1:
        os.close(fd);raise ValueError('Invalid terminal output')
    return fd

def record_exit(folder,jid,code):
    path=Path(folder)/(jid+'.exit.json');temp=path.with_suffix('.tmp')
    with open(temp,'x') as stream:json.dump({'exitCode':code},stream);stream.flush()
    os.replace(temp,path)

def exit_code(folder,jid):
    try:
        fd=os.open(Path(folder)/(jid+'.exit.json'),os.O_RDONLY|os.O_NOFOLLOW)
    except FileNotFoundError:return None
    with os.fdopen(fd) as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077 or info.st_size>1024:raise ValueError('Invalid terminal exit record')
        code=json.load(stream).get('exitCode')
        return code if type(code) is int else None

def read_output(folder,jid,offset,*,exited=False,code=None,fd=None):
    own=fd is None
    try:
        if own:fd=output_fd(folder,jid)
    except FileNotFoundError:
        return {'data':'','offset':0,'exited':exited,'exitCode':code,'outputAvailable':False}
    try:
        size=os.fstat(fd).st_size;offset=max(0,min(size,int(offset)))
        data=os.pread(fd,CHUNK,offset);end=offset+len(data)
        return {'data':base64.b64encode(data).decode(),'offset':end,'exited':exited and end>=size,'exitCode':code}
    finally:
        if own:os.close(fd)
