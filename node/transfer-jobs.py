"""Directory transfers: original operation, durable file offsets and fixed TLS lane."""
import base64,contextlib,fcntl,hashlib,hmac,http.client,importlib.util,json,os,re,ssl,stat,subprocess,time,uuid
from pathlib import Path
HASH=re.compile(r'[a-f0-9]{64}\Z')

def module(name):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

class PeerClient:
    """Persistent LAN TLS connection: authenticate pin BEFORE sending ticket."""
    def __init__(self, config, ticket):
        if (not isinstance(config, dict)
                or type(config['port']) is not int or not 1 <= config['port'] <= 65535
                or not HASH.fullmatch(config['certificateSha256'])):
            raise ValueError('LAN peer is not explicitly configured')
        self.config, self.ticket, self.connection = config, ticket, None

    def close(self):
        if self.connection:
            self.connection.close()
        self.connection = None

    def connect(self, timeout=25):
        if not self.connection or self.connection.sock is None:
            self.close()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE  # Explicit DER pin is the trust anchor.
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            connection = http.client.HTTPSConnection(self.config['address'], self.config['port'], timeout=timeout, context=context)
            try:
                connection.connect()
                if not hmac.compare_digest(hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest(), self.config['certificateSha256']):
                    raise ValueError('源服务器TLS证书验证失败，请联系安装者。')
            except Exception:
                connection.close()
                raise
            self.connection = connection
    def call(self, action, **fields):
        for attempt in (1, 2):
            reused = self.connection is not None and self.connection.sock is not None
            try:
                timeout=5 if action=='complete' else 25
                self.connect(timeout=timeout)
                self.connection.sock.settimeout(timeout)
                payload = json.dumps({'id': self.ticket['id'], 'action': action, **fields}).encode()
                self.connection.request('POST', '/directory', body=payload,
                    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer '+self.ticket['token']})
                response = self.connection.getresponse()
                raw = response.read(1500001)
                if len(raw) > 1500000:
                    raise ValueError('Peer response is too large')
                value = json.loads(raw)
                if response.status in (429,503):raise TimeoutError('源服务器忙，请按原编号重试。')
                if response.status != 200 or value.get('ok') is not True:
                    raise ValueError('源目录暂未响应，请按原编号查询或续传： '+str(value.get('error', response.status))[:200])
                return value['result']
            except (ConnectionResetError, BrokenPipeError, ssl.SSLEOFError, ssl.SSLZeroReturnError) as error:
                self.close()
                # The source closes keep-alive connections idle for 30 s and on
                # restart. Peer actions are reads or idempotent: resend once on a
                # fresh connection; a fresh connection failing is a real outage.
                if reused and attempt == 1:
                    continue
                raise ConnectionError(str(error)) from error
            except (OSError,http.client.HTTPException) as error:
                self.close()
                raise ConnectionError(str(error)) from error
            except Exception:
                self.close()
                raise


class LocalPeerClient:
    """Use the same source reader without networking for a same-node copy."""
    def __init__(self, jobs, ticket):
        self.jobs, self.ticket = jobs, ticket

    def call(self, action, **fields):
        return self.jobs.read({'id': self.ticket['id'], 'action': action, **fields}, self.ticket['token'])

    def close(self):pass


class TransferJobs:
    def __init__(self,executor):
        self.e=executor;self.config=executor.CONFIG;self.s=module('project-store');self.d=module('local-data')
        self.folder=self.s.private_dir(self.d.root(self.config,'root')/'transfers',create=True)

    def path(self,key,suffix='.json'):
        if not isinstance(key,str) or str(uuid.UUID(key))!=key:raise ValueError('请使用原传输UUID。')
        return self.folder/(key+suffix)

    @contextlib.contextmanager
    def lock(self,key,*,source=False):
        fd=os.open(self.path(key,'.source.lock' if source else '.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:self.s.wait_project_lock(fd,fcntl.LOCK_EX,'传输忙，请沿原编号稍后重试。');yield
        finally:os.close(fd)

    def root(self,ref):
        if ref.get('dataset'):return self.d.dataset_root(self.config,ref['dataset'])
        if ref.get('project'):return self.e.projects().store.dev_paths(ref.get('ownerId') or ref.get('userId','team'),ref['project'])['code']
        raise ValueError('请选择配置数据盘上的数据集目录。')

    def entries(self,row):
        source=Path(row['root'])
        if row.get('file'):
            with self.d.parent(source,row['file']) as (fd,name):
                i=os.stat(name,dir_fd=fd,follow_symlinks=False)
                if not stat.S_ISREG(i.st_mode):raise ValueError('请选择普通文件。')
                yield {'path':name,'type':'file','size':i.st_size,'executable':bool(i.st_mode&0o100)}
            return
        device=source.stat().st_dev
        for folder,dirs,files in os.walk(source,followlinks=False):
            dirs[:]=sorted(n for n in dirs if not n.startswith(('.trash','.upload-')) and not Path(folder,n).is_symlink() and Path(folder,n).stat().st_dev==device)
            relative=Path(folder).relative_to(source)
            for n in dirs:yield {'path':str(relative/n),'type':'directory','size':0}
            for n in sorted(files):
                info=Path(folder,n).lstat()
                if stat.S_ISREG(info.st_mode) and not n.startswith('.upload-'):yield {'path':str(relative/n),'type':'file','size':info.st_size,'executable':bool(info.st_mode&0o100)}

    def prepare(self,args):
        if args['source'].get('environment') is True:return module('project-copy').ProjectCopy(self).prepare(args)
        key=args.get('key',args.get('id'));ref=args['source'];root=self.root(ref)
        relative=self.d.relative(ref.get('path',''),empty=True);source=root/relative
        self.d.require_data_path(self.config,source)
        selected=None
        if relative:
            with self.d.parent(root,relative) as (fd,name):
                info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):raise ValueError('路径不能跟随链接离开数据目录。')
                if stat.S_ISREG(info.st_mode):selected=name;source=source.parent
        request={'source':ref}
        with self.lock(key,source=True):
            file=self.path(key,'.source.json')
            if file.exists():
                row=self.s.read_json(file)
                if row['request']!=request:raise ValueError('原传输编号已用于不同请求。')
            else:
                row={'id':key,'token':uuid.uuid4().hex,'request':request,'root':str(source),'file':selected,'state':'READY'}
                self.s.atomic_json(file,row)
            files=directories=total=0
            for entry in self.entries(row):
                if entry['type']=='file':files+=1;total+=entry['size']
                else:directories+=1
            return {'id':key,'token':row['token'],'state':'READY','fileCount':files,'directoryCount':directories,'totalBytes':total}

    def read(self,args,token):
        row=self.s.read_json(self.path(args['id'],'.source.json'))
        if not hmac.compare_digest(row['token'],token):raise PermissionError('请重新获取已登录的传输凭据。')
        action=args['action']
        if row.get('environment'):
            # The source record's mtime is the last ticket/read activity, even
            # while its exporter holds the separate source lock.
            if action!='complete':os.utime(self.path(args['id'],'.source.json'),None)
            if action=='complete':return module('project-copy').ProjectCopy(self).complete(args['id'],expired_before=args.get('expiredBefore'))
            row=module('project-copy').ProjectCopy(self).observe(row)
            if row['state']=='PREPARING':return {'state':'PREPARING','entries':[],'nextOffset':0}
            if row['state']=='FAILED':return {'state':'FAILED','error':row['error']}
            if action=='full':return module('project-copy').ProjectCopy(self).full(row)
            if row.get('mode')=='incremental' and action=='list':
                return module('project-sync').page(Path(row['root'])/'index.jsonl',int(args.get('offset',0)))
        if action=='list':
            import itertools
            offset=int(args.get('offset',0))
            if offset<0:raise ValueError('目录传输偏移不能为负数。')
            entries=list(itertools.islice(self.entries(row),offset,offset+201))
            return {'entries':entries[:200],'nextOffset':offset+200 if len(entries)>200 else None}
        if action=='file':
            request={k:v for k,v in args.items() if k in ('path','offset','length')}
            return module('dataset-files').process(self.config,'files.get',request,root=row['root'])
        raise ValueError('此传输读取操作不存在。')

    def view(self,row):return {k:row.get(k) for k in ('id','key','state','bytes','totalBytes','error','source','target','createdAt','installed')}

    def status(self,args):
        try:row=self.s.read_json(self.path(args.get('id',args.get('key'))))
        except FileNotFoundError:return {'state':'ABSENT'}
        if row.get('sourceCompletePending'):self.complete_copy(row)
        return self.view(row)

    def launch(self,key):
        return self.e.run(['/usr/bin/systemd-run','--user','--collect','--unit=gpuq-transfer-'+key,
            '--property=KillMode=control-group','--property=MemoryMax=1G','--property=TasksMax=2048',
            '/usr/bin/python3',str(Path(__file__).with_name('node-executor.py')),'--transfer-worker',key],timeout=18)

    def peer_client(self,row):
        if row['sourceMachine']==self.config['machine']:
            return LocalPeerClient(self,row['ticket'])
        return PeerClient(self.config['transferPeers'][row['sourceMachine']],row['ticket'])

    def complete_copy(self,row,peer=None,*,locked=False,expired_before=None):
        own_peer=peer is None
        with contextlib.nullcontext() if locked else self.lock(row['id']):
            current=self.s.read_json(self.path(row['id']));current['sourceCompletePending']=True;self.s.atomic_json(self.path(row['id']),current)
        try:
            if peer is None:peer=self.peer_client(row)
            peer.call('complete',**({'expiredBefore':expired_before} if expired_before is not None else {}))
        except Exception:pass  # Source staging cleanup never blocks a local terminal result.
        else:
            with contextlib.nullcontext() if locked else self.lock(row['id']):
                current=self.s.read_json(self.path(row['id']));current.pop('sourceCompletePending',None);self.s.atomic_json(self.path(row['id']),current)
        finally:
            if own_peer and peer is not None:peer.close()

    def cleanup_copy(self,row,peer=None,*,locked=False,expired_before=None):
        with contextlib.nullcontext() if locked else self.lock(row['id']):
            row=self.s.read_json(self.path(row['id']))
            if row['state'] not in ('SUCCEEDED','FAILED','CANCELED'):return
            try:
                module('project-copy').ProjectCopy(self).cleanup(row)
                uploads=module('data-uploads').Uploads(self.config,row['target'].get('userId','team'))
                for upload_key in row.get('uploadKeys',{}).values():uploads.record(upload_key).unlink(missing_ok=True)
                row.pop('runtime',None);self.s.atomic_json(self.path(row['id']),row)
            finally:self.complete_copy(row,peer,locked=True,expired_before=expired_before)

    def finish_runtime(self,key):
        try:
            row=self.s.read_json(self.path(key))
            if row.get('runtime'):
                self.e.run(['/usr/bin/systemd-run','--user','--no-block','--collect','--unit=gpuq-copy-cleanup-'+key,
                    '--property=MemoryMax=1G','--property=TasksMax=2048',
                    '/usr/bin/python3',str(Path(__file__).with_name('node-executor.py')),'--project-copy-cleanup-worker',key],timeout=5)
        except Exception:pass  # A later terminal query can retry; cleanup cannot change the job result.

    def cleanup_runtime(self,key):
        row=self.s.read_json(self.path(key))
        if row.get('runtime'):self.cleanup_copy(row)

    def start(self,args):
        key=args.get('key',args.get('id'));request={k:args.get(k) for k in ('source','target','ticket','sourceMachine','route')}
        with self.lock(key):
            file=self.path(key)
            if file.exists():
                row=self.s.read_json(file)
                if row['state']=='CANCELED':return self.view(row)
                if row['request']!=request:raise ValueError('原传输编号已用于不同请求。')
                return self.view(row)
            row={**request,'request':request,'actor':args.get('actor',{'userId':args.get('userId')}),'id':key,'key':key,'state':'PENDING','bytes':0,'totalBytes':None,'createdAt':time.time(),'uploadKeys':{}}
            self.s.atomic_json(file,row)
        try:self.launch(key)
        except (ValueError,OSError) as error:
            with self.lock(key):
                row=self.s.read_json(file);row.update(state='FAILED',error=str(error)[:400]);self.s.atomic_json(file,row)
            if row['target'].get('environment'):self.cleanup_copy(row)
        return self.status({'key':key})

    def cancel(self,args):
        key=args.get('key',args.get('id'))
        with self.lock(key):
            try:row=self.s.read_json(self.path(key))
            except FileNotFoundError:row={'id':key,'key':key,'state':'CANCELED'}
            if row['state']!='SUCCEEDED' or row.get('runtime') and self.e.native({'id':key}) is None:
                row['state']='CANCELED';self.s.atomic_json(self.path(key),row)
        if row['state']=='CANCELED' and row.get('target',{}).get('environment'):
            active=self.e.run(['/usr/bin/systemctl','--user','show','--property=ActiveState','--value',
                               'gpuq-transfer-'+key+'.service*']).strip()
            if active in ('','inactive','failed'):self.cleanup_copy(row)
        elif row.get('sourceCompletePending'):self.complete_copy(row)
        return self.view(row)

    def resume(self,args):
        key=args.get('key',args.get('id'))
        with self.lock(key):
            row=self.s.read_json(self.path(key))
            if row['state']=='SUCCEEDED':return self.view(row)
            if row['state']=='FAILED' and row['target'].get('environment'):row['backupKey']=str(uuid.uuid4())
            row['state']='PENDING';row.pop('error',None);row.pop('sourceCompletePending',None);self.s.atomic_json(self.path(key),row)
        self.launch(key);return self.status({'key':key})

    def worker(self,key):
        row=self.s.read_json(self.path(key))
        if row['target'].get('environment') is True:
            with contextlib.ExitStack() as stack:
                try:available=stack.enter_context(module('project-copy').ProjectCopy(self).serialized(row))
                except Exception as error:
                    with self.lock(key):
                        row=self.s.read_json(self.path(key))
                        if row['state']!='CANCELED':row.update(state='FAILED',error=str(error)[:400]);self.s.atomic_json(self.path(key),row)
                    self.cleanup_copy(row);return 1
                return self.receive_worker(key,independent=not available)
        return self.receive_worker(key)

    def collect(self):
        copy=module('project-copy').ProjectCopy(self);results=copy.collect();cutoff=time.time()-86400
        for file in self.folder.glob('*.json'):
            if file.name.endswith('.source.json'):continue
            try:
                row=self.s.read_json(file)
                if not row.get('target',{}).get('environment'):continue
                if row.get('sourceCompletePending'):self.complete_copy(row)
                if row.get('runtime'):
                    node_id=self.e.native({'id':row['id']})
                    if node_id:
                        if self.e.gpu('show',node_id).get('job',{}).get('state') not in ('SUCCEEDED','FAILED','CANCELED','LOST'):continue
                    elif row['state']=='SUCCEEDED':continue  # Portal may still be waiting to dispatch this runtime.
                terminal=row['state'] in ('SUCCEEDED','FAILED','CANCELED')
                if not terminal and file.stat().st_mtime>cutoff:continue
                folder=module('project-copy').runtime_folder(self.config,row['id'])
                destination=copy.destination(row);backup=destination/'code'/'.copy-backups'/(row['id']+'.tar')
                local=folder.exists() or backup.exists() or row.get('createdProject') and (destination/'received').exists() or row.get('runtime')
                if terminal and not local:continue
                with self.lock(row['id']):
                    row=self.s.read_json(file)
                    if row['state'] not in ('SUCCEEDED','FAILED','CANCELED') and file.stat().st_mtime>cutoff:continue
                    active=self.e.run(['/usr/bin/systemctl','--user','show','--property=ActiveState','--value','gpuq-transfer-'+row['id']+'.service*']).strip()
                    if active not in ('','inactive','failed'):continue
                    if row['state'] not in ('SUCCEEDED','FAILED','CANCELED'):
                        row.update(state='FAILED',error='复制已过期，请重新发起复制');self.s.atomic_json(file,row)
                    self.cleanup_copy(row,locked=True,expired_before=cutoff)
                    results.append({'id':row['id'],'kind':'copy-receive','state':row['state']})
            except (OSError,ValueError) as error:
                results.append({'id':file.stem,'kind':'copy-receive','state':'UNKNOWN','error':str(error)[:400]})
        return results

    def receive_worker(self,key,independent=False):
        row=self.s.read_json(self.path(key))
        peer=None
        try:
            peer=self.peer_client(row)
            target=row['target'];copy=module('project-copy').ProjectCopy(self) if target.get('environment') is True else None
            if row['state']=='CANCELED':return 0
            if copy:
                # A lost completion reply must not reinstall a successful copy.
                owner=target.get('ownerId') or target['userId']
                destination=copy.destination(row)
                created=(destination/'project.json').exists() and self.s.read_json(destination/'project.json').get('copyKey')==key
                if row.get('installed') or created:
                    copy.cleanup({**row,'createdProject':row.get('createdProject',created)})
                    self.complete_copy(row,peer)
                    row=self.s.read_json(self.path(key))
                    with self.lock(key):row.update(state='SUCCEEDED',installed=True);self.s.atomic_json(self.path(key),row)
                    return 0
                if row.get('runtime'):
                    self.complete_copy(row,peer)
                    row=self.s.read_json(self.path(key))
                    with self.lock(key):row.update(state='SUCCEEDED');self.s.atomic_json(self.path(key),row)
                    return 0
                root=self.s.private_dir(copy.target(row)/'received',create=True)
            else:root=self.d.dataset_root(self.config,target['dataset'],create=True) if target.get('dataset') else self.root(target)
            uploads=module('data-uploads').Uploads(self.config,target.get('userId','team'),root=root)
            cursor=None if independent and target.get('mode')=='incremental' else 0;done=0
            while cursor is not None:
                page=copy.incremental_page(row,peer,cursor) if copy and target.get('mode')=='incremental' else peer.call('list',offset=cursor)
                if page.get('state')=='PREPARING':
                    if self.status({'id':key})['state']=='CANCELED':return 0
                    time.sleep(1);continue
                if page.get('state')=='FAILED':raise ValueError(page['error'])
                done=self.receive(key,root,peer,page['entries'],done,uploads)
                if done is None:return 0
                cursor=page['nextOffset']
            if copy:
                if self.status({'id':key})['state']=='CANCELED':return 0
                def refresh(entries):
                    nonlocal done
                    done=self.receive(key,root,peer,entries,done,uploads);return done
                def full():
                    while self.status({'id':key})['state']!='CANCELED':
                        page=peer.call('full')
                        if page.get('state')=='PREPARING':time.sleep(1);continue
                        if page.get('state')=='FAILED':raise ValueError(page['error'])
                        return refresh(page['entries'])
                    return None
                if independent:
                    if target.get('mode')=='incremental' and full() is None:return 0
                    if copy.install_runtime(row) is False:return 0
                elif copy.install(row,receive=refresh,receive_full=full) is False:return 0
                self.complete_copy(row,peer)
            with self.lock(key):
                row=self.s.read_json(self.path(key))
                if row['state']!='CANCELED':row.update(state='SUCCEEDED',bytes=done,totalBytes=done);self.s.atomic_json(self.path(key),row)
            return 0
        except Exception as error:
            with self.lock(key):
                row=self.s.read_json(self.path(key))
                state='PAUSED' if not row['target'].get('environment') or isinstance(error,(ConnectionError,TimeoutError,http.client.HTTPException)) else 'FAILED'
                if row['state']!='CANCELED':row.update(state=state,error=str(error)[:400]);self.s.atomic_json(self.path(key),row)
            return 1
        finally:
            try:
                current=self.s.read_json(self.path(key))
                if current.get('target',{}).get('environment') and current['state'] in ('CANCELED','FAILED'):self.cleanup_copy(current,peer)
            finally:
                if peer is not None:peer.close()

    def receive(self,key,root,peer,entries,done,uploads):
        for entry in entries:
            if entry['type']=='directory':
                with self.d.parent(root,entry['path']+'/.directory',create=True):pass
                continue
            with self.lock(key):
                row=self.s.read_json(self.path(key));target=row['target']
                if row['state']=='CANCELED':return None
                upload_key=row['uploadKeys'].setdefault(entry['path'],str(uuid.uuid4()))
                row.update(state='RUNNING');self.s.atomic_json(self.path(key),row)
            begin={'key':upload_key,'path':entry['path'],'totalSize':entry['size'],'executable':entry.get('executable',False),'dataset':target.get('dataset'),'actor':row.get('actor')}
            status=uploads.process('begin',begin);offset=status['offset'] or 0
            while offset<entry['size']:
                chunk=peer.call('file',path=entry.get('remotePath',entry['path']),offset=entry.get('remoteOffset',0)+offset,length=min(1024**2,entry['size']-offset))
                with self.lock(key):
                    row=self.s.read_json(self.path(key))
                    if row['state']=='CANCELED':return None
                    status=uploads.process('chunk',{'key':upload_key,'data':chunk['data'],'offset':offset})
                    if status['offset']==offset:raise ValueError('源文件未返回字节，请按原编号续传。')
                    offset=status['offset'];row['bytes']=done+offset;self.s.atomic_json(self.path(key),row)
            with self.lock(key):
                if self.s.read_json(self.path(key))['state']=='CANCELED':return None
                uploads.process('finish',{'key':upload_key});done+=entry['size']
        return done

    def process(self,operation,args):
        action=operation.removeprefix('transfers.')
        if action=='project.mode':return module('project-copy').ProjectCopy(self).mode(args)
        if action=='project.prepare':return self.prepare(args)
        if action=='project.complete':return module('project-copy').ProjectCopy(self).complete(args['id'])
        if action=='project.start':return self.start(args)
        if action=='prepare':return self.prepare(args)
        if action=='start':return self.start(args)
        if action=='status':return self.status(args)
        if action=='cancel':return self.cancel(args)
        if action=='resume':return self.resume(args)
        if action=='list':return {'transfers':[self.view(self.s.read_json(p)) for p in self.folder.glob('*.json') if not p.name.endswith('.source.json')]}
        raise ValueError('此传输操作不存在。')
