"""Fixed TLS peer endpoint for directory copies."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json,ssl


def create_server(node,jobs):
    config=node.CONFIG['transferPeer']
    class Handler(BaseHTTPRequestHandler):
        protocol_version='HTTP/1.1'
        def log_message(self,*args):pass
        def answer(self,code,result):
            raw=json.dumps(result).encode();self.send_response(code);self.send_header('Content-Length',str(len(raw)));self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(raw)
        def do_GET(self):self.answer(200,{'protocol':'directory-transfer-v1','sourceReady':True})
        def do_POST(self):
            self.connection.settimeout(30)
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=1600000:raise ValueError('传输请求正文过大。')
                request=json.loads(self.rfile.read(size));token=self.headers.get('Authorization','').removeprefix('Bearer ')
                result=jobs.read(request,token);self.answer(200,{'ok':True,'result':result})
            except Exception as error:
                self.close_connection=True;self.answer(403 if isinstance(error,PermissionError) else 503,{'ok':False,'error':str(error)[:400]})
    server=ThreadingHTTPServer((config['bind'],config['port']),Handler);server.daemon_threads=True
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.minimum_version=ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(config['certificate'],config['privateKey']);server.socket=context.wrap_socket(server.socket,server_side=True)
    return server


def serve(node,jobs):
    with create_server(node,jobs) as server:server.serve_forever()
