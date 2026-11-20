"""Fixed authenticated TLS file lane. No manifests, versions or content digests."""
import base64,contextlib,functools,hashlib,hmac,http.client,importlib.util,json,os,re,ssl,threading,time,uuid
from collections import OrderedDict
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import parse_qs,urlsplit

TICKET_LIFETIME=300
TICKET_RENEW_WINDOW=120


class TicketExpired(PermissionError):
    def __init__(self):
        super().__init__('传输凭据已到期，请重新获取。')


@functools.lru_cache(maxsize=None)
def module(name):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m


class DirectUploads:
    def __init__(self,node):
        self.n=node;self.c=node.CONFIG['directUpload'];self.s=module('project-store');self.d=module('local-data')
        self.folder=self.s.private_dir(self.d.root(node.CONFIG,'root')/'file-grants',create=True)
        self.checked=OrderedDict();self.check_lock=threading.Lock()

    def root(self,args):
        if args.get('jobId') or args.get('runId'):return self.n.projects().store.workspace_output('', '',jobid=args.get('jobId',args.get('runId')),create=False)
        if args.get('project'):return self.n.projects().store.dev_paths(args.get('ownerId',args['userId']),args['project'])['code']
        return self.d.dataset_root(self.n.CONFIG,args['dataset'],create=args.get('action')=='put')

    def issue(self,args):
        chunk=args.get('maxChunkBytes',1024**2)
        action=args.get('action','get');key=args.get('uploadId',args.get('key')) if action=='put' else str(uuid.uuid4());root=self.root(args);path=self.d.relative(args['path']);action=args.get('action','get')
        if action not in ('get','put'):raise ValueError('请选择上传或下载。')
        # PUT bodies already carry their size. Keep its stored v1 bound so a
        # service/client rollback can resume this UUID with the old grant API.
        stored_chunk=1024**2 if action=='put' else chunk
        lock=contextlib.nullcontext()
        if action=='put':
            uploads=module('data-uploads').Uploads(self.n.CONFIG,args['userId'],root=root)
            uploads.process('begin',{**args,'key':key})
            lock=uploads.locked(key)
        if not isinstance(key,str) or str(uuid.UUID(key))!=key:raise ValueError('请使用原传输UUID。')
        file=self.folder/(key+'.json')
        # The corresponding upload begin owns the single original-key check.
        with lock:
            now=time.time()
            if file.exists():
                row=self.s.read_json(file)
                if action=='get' and (row['root'],row['path'],row['action'])!=(str(root),path,action):raise ValueError('原下载编号已用于不同请求。')
                changed=False
                if row['expiresAt']<=now+TICKET_RENEW_WINDOW:
                    row.update(ticket=uuid.uuid4().hex,expiresAt=int(now)+TICKET_LIFETIME)
                    changed=True
                if row['chunkBytes']!=stored_chunk:row['chunkBytes']=stored_chunk;changed=True
                if changed:self.s.atomic_json(file,row)
            else:
                row={'id':key,'ticket':uuid.uuid4().hex,'root':str(root),'path':path,'action':action,'expiresAt':int(now)+TICKET_LIFETIME,'userId':args['userId'],'chunkBytes':stored_chunk}
                self.s.atomic_json(file,row)
        der=ssl.PEM_cert_to_DER_cert(Path(self.c['certificate']).read_text())
        file_info={'path':row['path'],'size':args.get('totalSize')} if action=='put' else module('dataset-files').process(self.n.CONFIG,'files.stat',{'path':row['path']},root=root)
        return {'available':True,'protocol':'campus-file','grantId':key,'action':action,'file':file_info,'chunkBytes':chunk,'maxChunkBytes':chunk,'ticket':row['ticket'],'endpoint':self.c['endpoint'],'certificateSha256':hashlib.sha256(der).hexdigest(),
                'expiresAt':row['expiresAt'],'path':row['path']}

    def control_check(self,token):
        c=self.c['personalFiles'];origin=urlsplit(c['portalOrigin']);pin=c.get('certificateSha256')
        context=ssl.create_default_context()
        if pin:context.check_hostname=False;context.verify_mode=ssl.CERT_NONE
        connection=http.client.HTTPSConnection(origin.hostname,origin.port or 443,timeout=4,context=context)
        try:
            connection.connect()
            if pin and not hmac.compare_digest(hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest(),pin):raise PermissionError('登录服务TLS证书验证失败，请联系安装者。')
            body=json.dumps({'ticket':token}).encode();connection.request('POST','/api/files/direct-check',body,{'Content-Type':'application/json'})
            response=connection.getresponse();raw=response.read(4097)
            if response.status>=500:raise TimeoutError('登录服务暂未响应，请沿原编号续传。')
            if response.status!=200 or len(raw)>4096 or json.loads(raw).get('allowed') is not True:raise PermissionError('登录已失效，请重新登录。')
        finally:connection.close()

    def authorize(self,key,token):
        if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',key):raise PermissionError('传输凭据无效，请重新登录。')
        row=self.s.read_json(self.folder/(key+'.json'))
        if time.time()>=row['expiresAt'] or not hmac.compare_digest(row['ticket'],token):raise TicketExpired()
        cache_key=(key,token);stamp=time.monotonic()
        with self.check_lock:
            for cached,expires in list(self.checked.items()):
                if expires<=stamp:self.checked.pop(cached,None)
            valid=self.checked.get(cache_key,0)>stamp
            if valid:self.checked.move_to_end(cache_key)
        if not valid:
            self.control_check(token)
            now=time.time()
            if now>=row['expiresAt']:raise TicketExpired()
            with self.check_lock:
                self.checked[cache_key]=time.monotonic()+min(30,row['expiresAt']-now)
                while len(self.checked)>1024:self.checked.popitem(last=False)
        self.d.require_data_path(self.n.CONFIG,row['root']);return row


def create_server(node):
    direct=DirectUploads(node);config=direct.c
    class Handler(BaseHTTPRequestHandler):
        protocol_version='HTTP/1.1'
        disable_nagle_algorithm=True
        def log_message(self,*args):pass
        def response(self,code,value,raw=False):
            body=value if raw else json.dumps(value).encode()
            self.send_response(code);self.send_header('Content-Length',str(len(body)))
            self.send_header('Content-Type','application/octet-stream' if raw else 'application/json')
            origin=self.headers.get('Origin')
            if origin in config.get('allowedOrigins',[]):self.send_header('Access-Control-Allow-Origin',origin)
            self.end_headers();self.wfile.write(body)
        def do_OPTIONS(self):
            origin=self.headers.get('Origin')
            if origin not in config.get('allowedOrigins',[]):return self.response(403,{'error':'请从已登录的平台上传。'})
            self.send_response(204);self.send_header('Access-Control-Allow-Origin',origin)
            self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type')
            self.send_header('Content-Length','0');self.end_headers()
        def do_GET(self):self.execute()
        def do_POST(self):self.execute()
        def execute(self):
            self.connection.settimeout(30)
            try:
                parsed=urlsplit(self.path)
                if parsed.path=='/capabilities':return self.response(200,{'protocol':2,'sourceReady':True,'fileTransfer':True})
                matched=re.fullmatch(r'/v1/files/([a-f0-9-]{36})/(put|get|status)',parsed.path)
                if not matched:raise ValueError('此传输地址不存在。')
                key,action=matched.groups();row=direct.authorize(key,self.headers.get('Authorization','').removeprefix('Bearer '))
                query=parse_qs(parsed.query);offset=int(query.get('offset',['0'])[0])
                if action=='status':return self.response(200,{'ok':True,'result':module('data-uploads').Uploads(node.CONFIG,row['userId'],root=row['root']).process('status',{'key':key})})
                if action!=row['action']:raise PermissionError('请重新获取对应上传或下载凭据。')
                if action=='get':
                    result=module('dataset-files').process(node.CONFIG,'files.get',{'path':row['path'],'offset':offset,'length':row['chunkBytes']},root=row['root'],binary=True)
                    body=result.pop('data');result.update(protocol=2,path=row['path'])
                    self.send_response(200);self.send_header('Content-Length',str(len(body)));self.send_header('Content-Type','application/octet-stream')
                    self.send_header('X-GPUQ-File-Metadata',base64.urlsafe_b64encode(json.dumps(result).encode()).decode().rstrip('='))
                    self.send_header('Access-Control-Expose-Headers','X-GPUQ-File-Metadata')
                    origin=self.headers.get('Origin')
                    if origin in config.get('allowedOrigins',[]):self.send_header('Access-Control-Allow-Origin',origin)
                    self.end_headers();self.wfile.write(body);return
                length=int(self.headers.get('Content-Length','0'))
                if not 0<=length<=16*1024**2:raise ValueError('单次传输正文不能超过16MiB。')
                uploads=module('data-uploads').Uploads(node.CONFIG,row['userId'],root=row['root'])
                raw=self.rfile.read(length)
                result=uploads.write_request(key,offset,raw)
                if len(raw)!=length:raise ValueError('传输中断，请按原编号和偏移续传。')
                if query.get('final',['false'])[0]=='true':result=uploads.process('finish',{'key':key})
                result.update(protocol=2,path=row['path'],size=result.get('offset'),offset=result.get('offset'))
                self.response(200,{'ok':True,'result':result})
            except Exception as error:
                self.close_connection=True;self.response(403 if isinstance(error,PermissionError) else 400,{'ok':False,'error':str(error)[:400],**({'code':'FILE_TICKET_EXPIRED'} if isinstance(error,TicketExpired) else {}),**({'code':'DATASET_DIRECTORY_LINK','datasetLink':error.dataset_link} if hasattr(error,'dataset_link') else {})})
    server=ThreadingHTTPServer((config['bind'],config['port']),Handler)
    server.daemon_threads=True
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.minimum_version=ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(config['certificate'],config['privateKey']);server.socket=context.wrap_socket(server.socket,server_side=True)
    return server


def serve(node):
    with create_server(node) as server:server.serve_forever()
