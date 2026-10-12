"""A reconnectable PTY inside one GPU lease; detaching never stops its process."""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import stat
import struct
import subprocess
import termios


def serve(command, path):
    path=Path(path)
    if path.exists():
        if not stat.S_ISSOCK(path.lstat().st_mode):raise ValueError('Workspace terminal path is not a socket')
        path.unlink()  # The scheduler starts a new attempt only after the old one stops.
    master,slave=pty.openpty()
    def session():
        os.setsid()
        fcntl.ioctl(0,termios.TIOCSCTTY,0)
    child=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,preexec_fn=session)
    os.close(slave);os.set_blocking(master,False)
    server=socket.socket(socket.AF_UNIX)
    buffer=b'';offset=0;pending=b'';eof=False
    try:
        server.bind(str(path));os.chmod(path,0o600);server.listen(4)
        while child.poll() is None or not eof:
            readable,writable,_=select.select([server,*([master] if not eof else [])],[master] if pending else [],[],0.2)
            if master in writable:
                try:pending=pending[os.write(master,pending):]
                except BlockingIOError:pass
            if master in readable:
                try:data=os.read(master,65536)
                except BlockingIOError:continue
                except OSError:data=b''
                eof=not data;buffer+=data
                if len(buffer)>524288:
                    cut=len(buffer)-524288;buffer=buffer[cut:];offset+=cut
            if server not in readable:continue
            client,_=server.accept()
            with client:
                client.settimeout(3)
                try:
                    with client.makefile('rb') as stream:raw=stream.readline(32769)
                    if len(raw)>32768:raise ValueError('Terminal request too large')
                    request=json.loads(raw)
                    if request.get('action')=='close':
                        client.sendall(b'{"closed":true}\n');break
                    data=base64.b64decode(request.get('input',''),validate=True)
                    if len(data)>8192 or len(pending)+len(data)>65536:raise ValueError('Terminal input buffer full')
                    pending+=data
                    rows=max(8,min(100,int(request.get('rows',32))))
                    cols=max(20,min(250,int(request.get('cols',110))))
                    fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
                    start=max(offset,min(offset+len(buffer),int(request.get('offset',0))))
                    result={'data':base64.b64encode(buffer[start-offset:]).decode(),
                            'offset':offset+len(buffer),'exited':child.poll() is not None and eof,'exitCode':child.poll()}
                except (ValueError,TypeError,OSError) as error:
                    result={'error':str(error)}
                try:client.sendall((json.dumps(result)+'\n').encode())
                except OSError:pass  # A disconnected reader must not stop training.
        return child.poll() if child.poll() is not None else 0
    finally:
        server.close();path.unlink(missing_ok=True);os.close(master)
        if child.poll() is None:
            try:os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError:pass  # It can exit between poll and signal.
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                child.wait()
