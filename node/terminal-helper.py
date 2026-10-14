#!/usr/bin/python3
"""One private PTY per explicit session; the executor fences its single writer."""
import base64,fcntl,importlib.util,json,os,pty,select,socket,stat,struct,subprocess,sys,termios,time
sys.dont_write_bytecode=True  # Keep the immutable runtime free of imported bytecode.
from pathlib import Path
HERE=Path(__file__).resolve().parent
RUNTIME_PROFILE=None
CORE_PROFILE=os.environ.get('STARGATE_CORE_PROFILE')
if CORE_PROFILE is not None:
    _profile_spec=importlib.util.spec_from_file_location('gpuq_fixed_runtime_profile',HERE/'runtime-profile.py')
    RUNTIME_PROFILE=importlib.util.module_from_spec(_profile_spec);_profile_spec.loader.exec_module(RUNTIME_PROFILE)
CONFIG_PATH=(HERE/'node-config.json') if RUNTIME_PROFILE is None else RUNTIME_PROFILE.config_path(HERE,selected=CORE_PROFILE)

configuration=json.loads(CONFIG_PATH.read_text());platform_root=Path(configuration['root'])
guard_spec=importlib.util.spec_from_file_location('terminal_data',HERE/'local-data.py')
guard=importlib.util.module_from_spec(guard_spec);guard_spec.loader.exec_module(guard)
guard.require_data_path(configuration,platform_root)
output_spec=importlib.util.spec_from_file_location('gpuq_terminal_output',HERE/'terminal-output.py')
output=importlib.util.module_from_spec(output_spec);output_spec.loader.exec_module(output)
root=platform_root/'terminals'
jid=sys.argv[1];sock=root/(jid+'.sock')
os.umask(0o077)
history=output.output_fd(root,jid,create=True)
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,110,0,0))
def session():os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
spec=json.loads((root/(jid+'.json')).read_text())
command=['/usr/bin/python3',str(HERE/'oci-runner.py'),jid,'terminal']

if RUNTIME_PROFILE is not None:
    command,child_env=RUNTIME_PROFILE.child_command(command,os.environ,selected=CORE_PROFILE)
else:child_env=None
child=subprocess.Popen(command,env=child_env,stdin=slave,stdout=slave,stderr=slave,preexec_fn=session)
os.close(slave);os.set_blocking(master,False)
server=socket.socket(socket.AF_UNIX);server.bind(str(sock));server.listen(4)
pending=b'';last_input=time.monotonic();began=last_input;ended=None;size=(32,110);eof=False
def transfer(ready,writable):
 global pending,eof
 if master in writable:
  try:pending=pending[os.write(master,pending):]
  except BlockingIOError:pass
 if master in ready:
  try:data=os.read(master,65536)
  except BlockingIOError:data=None
  except OSError:data=b''
  if data==b'':eof=True
  if data:
   view=memoryview(data)
   while view:view=view[os.write(history,view):]

try:
 while True:
  if child.poll() is not None:
   ended=ended or time.monotonic()
   if eof:break
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
    guard.require_data_path(configuration,platform_root)
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
     deadline=time.monotonic()+0.03;before=os.fstat(history).st_size
     while not eof and time.monotonic()<deadline:
      ready,writable,_=select.select([master],[master] if pending else [],[],max(0,deadline-time.monotonic()))
      transfer(ready,writable)
      if os.fstat(history).st_size>before:break
    out=output.read_output(root,jid,req.get('offset',0),exited=child.poll() is not None and eof,code=child.poll(),fd=history)
    client.sendall((json.dumps(out)+'\n').encode())
   except Exception as e:
    try:client.sendall((json.dumps({'error':str(e)[:150]})+'\n').encode())
    except OSError:pass
   finally:client.close()
finally:
 if child.poll() is not None and eof:output.record_exit(root,jid,child.poll())
 os.close(history)
 server.close()
 try:
  guard.require_data_path(configuration,platform_root);sock.unlink(missing_ok=True)
 except (OSError,ValueError):pass  # Never unlink on an unverified fallback root.
 if child.poll() is None:child.terminate()
 os.close(master)
