"""Import real CD2 IDs into ordinary directories; credentials remain private."""
import contextlib,fcntl,importlib.util,json,os,selectors,subprocess,uuid
from pathlib import Path
def module(name):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
class CloudFiles:
    def __init__(self,executor):
        self.n=executor;self.s=module('project-store');self.d=module('local-data')
        self.folder=self.s.private_dir(self.d.root(executor.CONFIG,'root')/'cloud-files',create=True)
    def path(self,key):
        if not isinstance(key,str) or str(uuid.UUID(key))!=key:raise ValueError('请使用原云传输UUID。')
        return self.folder/(key+'.json')
    @contextlib.contextmanager
    def locked(self,key):
        fd=os.open(self.path(key).with_suffix('.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:self.s.wait_project_lock(fd,fcntl.LOCK_EX,'云传输忙，请按原编号查询。');yield
        finally:os.close(fd)
    def view(self,row):return {k:row.get(k) for k in ('operationId','state','bytes','size','path','remotePath','action','fileId','error')}
    def root(self,args,create=False):
        if args.get('project'):return self.n.projects().store.dev_paths(args.get('ownerId') or args['userId'],args['project'])['code']
        return self.d.dataset_root(self.n.CONFIG,args['dataset'],create=create)
    def command(self):
        c=self.n.CONFIG['cloudFiles']
        return [c['nodeExecutable'],str(Path(__file__).with_name('cloud-files-worker.mjs')),c['privateConfig']]
    def launch(self,key):
        self.n.run(['/usr/bin/systemd-run','--user','--collect','--unit=gpuq-cloud-'+key,'--property=MemoryMax=1G',
            '--property=KillMode=control-group','/usr/bin/python3',str(Path(__file__).with_name('node-executor.py')),'--cloud-files-worker',key])
    def process(self,operation,args):
        action=operation.removeprefix('datasets.cloud.');config=self.n.CONFIG.get('cloudFiles') or {}
        if action=='info':return {'enabled':config.get('enabled') is True}
        if action=='list':
            result=subprocess.run(self.command(),input=json.dumps({'action':'list'}),text=True,capture_output=True,env=self.n.ENV,timeout=60)
            if result.returncode:raise ValueError('云文件列表暂时未知，请稍后刷新。')
            if len(result.stdout.encode())>1024**2:raise ValueError('云文件列表正文过大，请联系管理员。')
            for line in result.stdout.splitlines():
                frame=json.loads(line)
                if frame.get('kind')=='result':return frame['result']
            raise ValueError('云文件列表暂时未知，请稍后刷新。')
        key=args.get('operationId',args.get('key'));file=self.path(key)
        with self.locked(key):
            if action in ('upload','download'):
                request={k:args.get(k) for k in ('dataset','project','ownerId','path','fileId','size','name')};request['action']=action
                if action=='upload':
                    with self.d.parent(self.root(args),self.d.relative(args['path'])) as (parent,name):
                        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
                        try:
                            info=os.fstat(fd)
                            if not __import__('stat').S_ISREG(info.st_mode):raise ValueError('请选择普通文件。')
                            request['size']=info.st_size
                        finally:os.close(fd)
                if not isinstance(request['size'],int) or isinstance(request['size'],bool) or request['size']<0:raise ValueError('请选择云文件及其大小。')
                if file.exists():
                    row=self.s.read_json(file)
                    if row['request']!=request:raise ValueError('原云传输编号已用于不同请求。')
                    if row['state'] not in ('PAUSED','UNKNOWN'):return self.view(row)
                else:row={**request,'request':request,'operationId':key,'userId':args['userId'],'state':'PENDING','bytes':0}
                row['state']='PENDING';self.s.atomic_json(file,row)
                try:self.launch(key)
                except Exception:row['state']='UNKNOWN';self.s.atomic_json(file,row)
            else:
                row=self.s.read_json(file)
                if action=='cancel':row['state']='CANCELED';self.s.atomic_json(file,row)
                elif action=='status' and row.get('remotePath') and row['state']=='PENDING':
                    try:
                        result=subprocess.run(self.command(),input=json.dumps({'action':'status','path':row['remotePath'],'size':row['size']}),text=True,capture_output=True,env=self.n.ENV,timeout=30)
                        for line in result.stdout.splitlines():
                            frame=json.loads(line)
                            if frame.get('kind')=='result':
                                value=frame['result'];row.update(state=value['state'],fileId=value.get('id'));self.s.atomic_json(file,row)
                    except (ValueError,OSError,subprocess.TimeoutExpired):return {**self.view(row),'state':'UNKNOWN','error':'云上传状态暂时未知，请按原编号查询。'}
                elif action!='status':raise ValueError('此云文件操作不存在。')
            return self.view(row)
    def update(self,key,**values):
        with self.locked(key):
            row=self.s.read_json(self.path(key))
            if row['state']!='CANCELED':row.update(values);self.s.atomic_json(self.path(key),row)
            return row
    def worker(self,key):
        row=self.s.read_json(self.path(key));fd=None;process=None
        if row['state']=='CANCELED':return 0
        try:
            root=self.root(row,create=True)
            relative=self.d.relative(row['path']);uploads=module('data-uploads').Uploads(self.n.CONFIG,row['userId'],root=root)
            if row['action']=='download':
                begin=uploads.process('begin',{'key':key,'path':relative,'totalSize':row['size']})
                if begin['state']=='COMPLETE':self.update(key,state='COMPLETE',bytes=row['size']);return 0
                upload_row=self.s.read_json(uploads.record(key))
                with self.d.parent(root,relative) as (parent,name):fd=os.open(upload_row['temp'],os.O_RDWR|os.O_NOFOLLOW,dir_fd=parent)
                offset=os.fstat(fd).st_size
            else:
                with self.d.parent(root,relative) as (parent,name):fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
                offset=row.get('bytes',0)
            request={'action':row['action'],'size':row['size'],'fileId':row.get('fileId'),'offset':offset,
                     'operationId':key,'name':row.get('name') or Path(relative).name,'fileHandle':row.get('fileHandle')}
            process=subprocess.Popen(self.command(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                env={**self.n.ENV,'GPUQ_CLOUD_FILE_FD':str(fd)},pass_fds=(fd,))
            process.stdin.write(json.dumps(request).encode());process.stdin.close();pending=b'';result=None
            selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ)
            try:
                while process.poll() is None or selector.select(0):
                    if self.s.read_json(self.path(key))['state']=='CANCELED':process.terminate();return 0
                    if not selector.select(1):continue
                    raw=os.read(process.stdout.fileno(),65536)
                    if not raw:break
                    pending+=raw
                    if len(pending)>1024**2:raise ValueError('云传输响应正文过大。')
                    while b'\n' in pending:
                        line,pending=pending.split(b'\n',1);frame=json.loads(line)
                        if frame.get('kind')=='progress':self.update(key,state='RUNNING',bytes=frame.get('bytes'))
                        elif frame.get('kind')=='handle':self.update(key,fileHandle=frame['fileHandle'],bytes=0)
                        elif frame.get('kind')=='result':result=frame.get('result')
                        elif frame.get('kind')=='error':raise ValueError(frame.get('error','云传输失败，请按原编号续传。'))
            finally:selector.close()
            if process.wait(timeout=10)!=0:raise ValueError('云传输暂时未知，请按原编号续传。')
            if row['action']=='download' and os.fstat(fd).st_size!=row['size']:raise ValueError('云下载尚未完成，请按原编号续传。')
            with self.locked(key):
                current=self.s.read_json(self.path(key))
                if current['state']=='CANCELED':return 0
                if row['action']=='download':uploads.process('finish',{'key':key})
                current.update(state='COMPLETE',bytes=row['size'])
                if row['action']=='upload':
                    if not result:raise ValueError('云上传状态暂时未知，请按原编号续传。')
                    current.update(state=result.get('state','UNKNOWN'),fileId=result.get('id'),remotePath=result.get('path'));current.pop('fileHandle',None)
                if row['action']=='download' and row.get('dataset'):
                    self.s.atomic_json(self.s.private_dir(Path(self.n.CONFIG['root'])/'dataset-uploaders',create=True)/(row['dataset']+'.json'),{'userId':row['userId']})
                self.s.atomic_json(self.path(key),current)
            return 0
        except Exception as error:self.update(key,state='PAUSED',error=str(error)[:400]);return 1
        finally:
            if fd is not None:os.close(fd)
            if process is not None and process.poll() is None:process.terminate();process.wait(timeout=10)
