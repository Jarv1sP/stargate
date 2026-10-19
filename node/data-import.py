"""HTTPS imports into datasets or project workspaces, using the same upload primitive."""
import base64,contextlib,fcntl,http.client,importlib.util,ipaddress,json,os,re,socket,ssl,stat,subprocess,time,uuid
from pathlib import Path
from urllib.parse import urljoin,urlsplit
MAX_REDIRECTS=5
BLOCK=1024**2

def module(name):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

class ImportFailure(ValueError):
    def __init__(self, code, message, state='FAILED'):
        super().__init__(message)
        self.code, self.state = code, state

def checked_url(value):
    if (not isinstance(value, str) or not value or len(value) > 16384
            or '\\' in value or any(ord(c) <= 32 or ord(c) >= 127 for c in value)):
        raise ImportFailure('URL', 'Use a valid HTTPS download link')
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if (parsed.scheme != 'https' or not host or parsed.username is not None
                or parsed.password is not None or parsed.fragment or parsed.port not in (None, 443)
                or '%' in host):
            raise ValueError()
        host = host.encode('idna').decode('ascii').lower()
        # Reject parser discrepancies, dotless service names and non-DNS forms.
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if (len(host) > 253 or '.' not in host or host.endswith('.')
                    or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', p) for p in host.split('.'))):
                raise ValueError()
        target = parsed.path or '/'
        if parsed.query:
            target += '?' + parsed.query
        return host, target
    except (ValueError, UnicodeError):
        raise ImportFailure('URL', 'Use a public HTTPS link on port 443 without embedded credentials') from None

def public_address(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if not address.is_global or address.is_multicast or address.is_reserved:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped or address.sixtofour or address.teredo:
            return False
        if any(address in ipaddress.ip_network(prefix) for prefix in ('64:ff9b::/96', '64:ff9b:1::/48')):
            return False
    return True

def resolve_public(host):
    try:
        records = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        raise ImportFailure('NETWORK', 'Download host could not be resolved; retry later', 'PAUSED') from None
    if not records or any(not public_address(r[4][0]) for r in records):
        raise ImportFailure('PRIVATE_ADDRESS', 'Download links must resolve only to public Internet addresses')
    return records

class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, records):
        super().__init__(host, 443, timeout=20, context=ssl.create_default_context())
        self.records = records

    def connect(self):
        # Do not resolve the hostname again after validation (DNS rebinding).
        for family, kind, protocol, _, address in self.records:
            sock = socket.socket(family, kind, protocol)
            try:
                sock.settimeout(20)
                sock.connect(address)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except ssl.SSLError:
                sock.close()
                raise ImportFailure('TLS', 'Download server TLS certificate verification failed') from None
            except OSError:
                sock.close()
        raise ImportFailure('NETWORK', 'Download server could not be reached; retry later', 'PAUSED')

def checked_headers(value,source_kind):
    if not isinstance(value,dict):return {}
    result={}
    for name in ('User-Agent','Referer','Origin'):
        content=value.get(name)
        if isinstance(content,str) and '\r' not in content and '\n' not in content:result[name]=content
    return result

def open_download(url, offset=0, etag=None, source_kind='https', download_headers=None):
    headers = {'User-Agent': 'GPUQ-DataImport/1.0', 'Accept-Encoding': 'identity'}
    if source_kind == 'aliyun':
        headers['Referer'] = 'https://www.alipan.com/'
    headers.update(checked_headers(download_headers,source_kind))
    if offset:
        headers['Range'] = 'bytes=' + str(offset) + '-'
        if etag:
            headers['If-Range'] = etag
    for hop in range(MAX_REDIRECTS + 1):
        host, target = checked_url(url)
        connection = PinnedHTTPS(host, resolve_public(host))
        try:
            connection.request('GET', target, headers=headers)
            response = connection.getresponse()
        except ImportFailure:
            connection.close()
            raise
        except (OSError, http.client.HTTPException, ValueError):
            connection.close()
            raise ImportFailure('NETWORK', 'Download connection failed; retry later', 'PAUSED') from None
        if response.status in (301, 302, 303, 307, 308):
            location = response.getheader('Location')
            response.close(); connection.close()
            if not location or hop == MAX_REDIRECTS:
                raise ImportFailure('REDIRECT', 'Download redirect is missing or exceeds the redirect limit')
            # No body, cookies or authorization are carried across a redirect.
            url = urljoin(url, location)
            continue
        return connection, response
    raise ImportFailure('REDIRECT', 'Download redirect limit exceeded')

class DataImports:
    def __init__(self,executor):
        self.e=executor;self.s=module('project-store');self.d=module('local-data')
        self.folder=self.s.private_dir(self.d.root(executor.CONFIG,'root')/'imports',create=True)

    def path(self,key):
        if not isinstance(key,str) or str(uuid.UUID(key))!=key:raise ValueError('请使用原导入UUID。')
        return self.folder/(key+'.json')

    def view(self,row):return {k:row.get(k) for k in ('operationId','state','path','bytes','totalBytes','error','sourceKind','dataset','project')}
    @contextlib.contextmanager
    def locked(self,key):
        fd=os.open(self.path(key).with_suffix('.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:self.s.wait_project_lock(fd,fcntl.LOCK_EX,'导入忙，请按原编号查询。');yield
        finally:os.close(fd)
    def update(self,key,**values):
        with self.locked(key):
            current=self.s.read_json(self.path(key))
            if current['state']!='CANCELED':current.update(values);self.s.atomic_json(self.path(key),current)
            return current

    def launch(self,key):
        self.e.run(['/usr/bin/systemd-run','--user','--collect','--unit=gpuq-import-'+key,'--property=KillMode=control-group',
            '--property=MemoryMax=1G','--property=TasksMax=2048','/usr/bin/python3',str(Path(__file__).with_name('node-executor.py')),'--data-import-worker',key])

    def process(self,operation,args):
        action=operation.removeprefix('datasets.import.');key=args.get('operationId',args.get('key'))
        if action=='list':return {'imports':[self.view(self.s.read_json(p)) for p in self.folder.glob('*.json')]}
        file=self.path(key)
        if action=='start':
            checked_url(args['url']);request={k:args.get(k) for k in ('url','sourceKind','downloadHeaders','expectedBytes','dataset','project','ownerId','path')}
            if file.exists():
                row=self.s.read_json(file)
                if row['request']!=request:raise ValueError('原导入编号已用于不同请求。')
                return self.view(row)
            self.d.relative(args['path']);row={**request,'request':request,'userId':args['userId'],'operationId':key,
                'state':'PENDING','bytes':0,'totalBytes':None};self.s.atomic_json(file,row);self.launch(key);return self.view(row)
        row=self.s.read_json(file)
        if action=='cancel':
            with self.locked(key):row=self.s.read_json(file);row['state']='CANCELED';self.s.atomic_json(file,row)
        elif action in ('resume','continue'):
            with self.locked(key):
                row=self.s.read_json(file)
                if row['state'] in ('PENDING','RUNNING','SUCCEEDED'):return self.view(row)
                if 'url' in args:checked_url(args['url'])
                for name in ('url','downloadHeaders'):
                    if name in args:row[name]=args[name];row['request'][name]=args[name]
                previous=row['state'];row.update(state='PENDING',error=None);self.s.atomic_json(file,row)
            try:self.launch(key)
            except Exception as error:
                with self.locked(key):
                    row=self.s.read_json(file)
                    if row['state']=='PENDING':row.update(state=previous,error=str(error)[:400]);self.s.atomic_json(file,row)
                raise
        return self.view(row)

    def worker(self,key):
        row=self.s.read_json(self.path(key));connection=None
        try:
            if row.get('project'):root=self.e.projects().store.dev_paths(row.get('ownerId') or row['userId'],row['project'])['code']
            else:root=self.d.dataset_root(self.e.CONFIG,row['dataset'],create=True)
            uploads=module('data-uploads').Uploads(self.e.CONFIG,row['userId'],root=root)
            # Offset and key remain fixed across failed HTTPS requests.
            try:status=uploads.process('status',{'key':key});offset=status['offset'] or 0
            except FileNotFoundError:offset=0
            opened=open_download(row['url'],offset=offset,source_kind=row.get('sourceKind') or 'https',download_headers=row.get('downloadHeaders'))
            connection,response=opened
            raw_range=response.getheader('Content-Range');length=response.getheader('Content-Length')
            if offset:
                match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',raw_range or '')
                if response.status!=206 or not match or int(match[1])!=offset:raise ValueError('下载源未接受原偏移，请保留原编号重试。')
                size=int(match[3])
            else:
                if response.status!=200 or length is None:raise ValueError('下载源暂未提供文件大小，请稍后重试。')
                size=int(length)
            uploads.process('begin',{'key':key,'path':row['path'],'totalSize':size})
            row=self.update(key,state='RUNNING',totalBytes=size)
            while True:
                if self.s.read_json(self.path(key))['state']=='CANCELED':return 0
                raw=response.read(BLOCK)
                if not raw:break
                status=uploads.process('chunk',{'key':key,'offset':offset,'data':base64.b64encode(raw).decode()});offset=status['offset']
                row=self.update(key,bytes=offset)
            with self.locked(key):
                row=self.s.read_json(self.path(key))
                if row['state']=='CANCELED':return 0
                uploads.process('finish',{'key':key});row.update(state='SUCCEEDED',bytes=size);self.s.atomic_json(self.path(key),row)
            return 0
        except Exception as error:
            self.update(key,state='PAUSED',error=str(error)[:400])
            return 1
        finally:
            if connection:connection.close()
