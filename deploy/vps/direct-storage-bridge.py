"""One private Unix-socket -> fixed node SSH transport.

The Portal authorizes the account and operation; the node validates scoped
arguments. There is no dataset/version routing, fallback, or second scheduler.
"""
import importlib.util
import json
import os
from pathlib import Path
import socketserver
import sys

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('direct_node_transport',HERE/'ssh-transport.py')
transport=importlib.util.module_from_spec(spec);sys.modules[spec.name]=transport;spec.loader.exec_module(transport)
SETTINGS=transport.CONFIG['bridge']
RUNTIME=Path(SETTINGS['runtimeDirectory'])
RUNTIME.mkdir(mode=0o700,exist_ok=True)
connection=transport.SSHConnections(transport.BASE,RUNTIME)

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(35)
        try:
            raw=self.rfile.readline(1600001)
            if len(raw)>1600000:raise ValueError('Node request is too large')
            request=json.loads(raw)
            if (request['machine'] not in transport.HOSTS
                    or not isinstance(request['operation'],str) or not isinstance(request['args'],dict)):
                raise ValueError('Invalid node request')
            result=connection.call(transport.HOSTS[request['machine']],
                {'operation':request['operation'],'args':request['args']})
            if result.returncode:raise transport.ssh_transport_failure(result,'rpc')
            response=json.loads(result.stdout)
            if not isinstance(response,dict) or type(response.get('ok')) is not bool:
                raise ValueError('Invalid node response')
        except transport.NodeTransportError as error:
            response={'ok':False,'error':str(error),'code':error.code,'status':error.status,'outcomeUnconfirmed':True}
        except Exception as error:
            response={'ok':False,'error':str(error)[:300],'outcomeUnconfirmed':True}
        self.wfile.write((json.dumps(response)+'\n').encode())

class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads=True

if __name__=='__main__':
    os.umask(0o007)
    socket=Path(SETTINGS['socket'])
    if socket.exists():
        if not socket.is_socket():raise ValueError('Unexpected object at the node socket path')
        socket.unlink()
    with Server(str(socket),Handler) as server:
        os.chmod(socket,0o660);os.chown(socket,SETTINGS['socketUid'],SETTINGS['socketGid'])
        server.serve_forever()
