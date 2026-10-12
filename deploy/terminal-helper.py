#!/usr/bin/python3
"""One private PTY per explicit session; the executor fences its single writer."""
import base64,fcntl,importlib.util,json,os,pty,select,socket,stat,struct,subprocess,sys,termios,time
sys.dont_write_bytecode=True  # Keep the immutable runtime free of imported bytecode.
from pathlib import Path
ROOT_SHELLS=('/usr/local/libexec/gpuq-console-root-shell','/usr/local/libexec/amax-console-root-shell')


def root_shell():
    # Only fixed root-owned entrypoints; retain the old deployed sudoers target.
    for value in ROOT_SHELLS:
        path=Path(value)
        try:info=path.lstat()
        except FileNotFoundError:continue
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
            raise ValueError('Unsafe root terminal helper')
        return value
    raise ValueError('Root terminal helper is not installed')


HERE=Path(__file__).resolve().parent
platform_root=Path(json.loads((HERE/'node-config.json').read_text())['root'])
guard_spec=importlib.util.spec_from_file_location('gpuq_platform_root_guard',HERE/'platform-root-guard.py')
guard=importlib.util.module_from_spec(guard_spec);guard_spec.loader.exec_module(guard)
guard.check(platform_root)
root=platform_root/'terminals'
jid=sys.argv[1];sock=root/(jid+'.sock')
os.umask(0o077)
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,110,0,0))
def session():os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
spec=json.loads((root/(jid+'.json')).read_text())
command=['/usr/bin/sudo','-n',root_shell()] if spec.get('hostAdmin') is True else ['/usr/bin/python3',str(HERE/'sandbox-runner.py'),jid,'terminal']
child=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,preexec_fn=session)
os.close(slave);os.set_blocking(master,False)
server=socket.socket(socket.AF_UNIX);server.bind(str(sock));server.listen(4)
buffer=b'';pending=b'';start=0;last_input=time.monotonic();began=last_input;ended=None;size=(32,110);eof=False
def transfer(ready,writable):
 global pending,buffer,start,eof
 if master in writable:
  try:pending=pending[os.write(master,pending):]
  except BlockingIOError:pass
 if master in ready:
  try:data=os.read(master,65536)
  except BlockingIOError:data=None
  except OSError:data=b''
  if data==b'':eof=True
  if data:
   buffer+=data
   if len(buffer)>524288:cut=len(buffer)-524288;buffer=buffer[cut:];start+=cut

try:
 while True:
  if child.poll() is not None:
   ended=ended or time.monotonic()
   if time.monotonic()-ended>60:break
  ready,writable,_=select.select([server,*([master] if not eof else [])],[master] if pending and not ended else [],[],0.2)
  transfer(ready,writable)
  if server in ready:
   client,_=server.accept();client.settimeout(3)
   try:
    raw=b''
    while b'\n' not in raw and len(raw)<32768:
     part=client.recv(32768-len(raw))
     if not part:break
     raw+=part
    req=json.loads(raw);action=req.get('action','exchange')
    if action=='close':client.sendall(b'{"closed":true}\n');break
    guard.check(platform_root)
    data=base64.b64decode(req.get('input',''),validate=True)
    if len(data)>8192:raise ValueError('Input too large')
    if data and not ended:
     if len(pending)+len(data)>65536:raise ValueError('Terminal input buffer full; retry')
     pending+=data;last_input=time.monotonic()
    rows=max(8,min(100,int(req.get('rows',size[0]))));cols=max(20,min(250,int(req.get('cols',size[1]))))
    if (rows,cols)!=size:fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0));size=(rows,cols)
    if data and not ended:
     # Flush accepted input and include its first prompt/echo in this response
     # when available, avoiding another HTTP + SSH round trip. Never retry input
     # or wait indefinitely for silent commands; read-only polls stay immediate.
     deadline=time.monotonic()+0.03;before=start+len(buffer)
     while not eof and time.monotonic()<deadline:
      ready,writable,_=select.select([master],[master] if pending else [],[],max(0,deadline-time.monotonic()))
      transfer(ready,writable)
      if start+len(buffer)>before:break
    offset=max(start,min(start+len(buffer),int(req.get('offset',0))))
    out={'data':base64.b64encode(buffer[offset-start:]).decode(),'offset':start+len(buffer),'exited':ended is not None and eof,'exitCode':child.poll()}
    client.sendall((json.dumps(out)+'\n').encode())
   except Exception as e:
    try:client.sendall((json.dumps({'error':str(e)[:150]})+'\n').encode())
    except OSError:pass
   finally:client.close()
finally:
 server.close()
 try:
  guard.check(platform_root);sock.unlink(missing_ok=True)
 except (OSError,ValueError):pass  # Never unlink on an unverified fallback root.
 if child.poll() is None:child.terminate()
 os.close(master)
