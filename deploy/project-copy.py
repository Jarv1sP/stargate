"""Durable, owner-scoped OCI project copy over the pinned LAN peer listener.

An operation ID is fenced before background launch. Unknown launch/results are
never replayed onto another node. Only immutable releases enter this protocol.
"""
import base64
import contextlib
import fcntl
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import secrets
import subprocess
import time

HERE = Path(__file__).resolve().parent
def module(name):
    paths={'transfer-jobs':'transfer-jobs.py','portable-project':'portable-project.py'}
    spec=importlib.util.spec_from_file_location('gpuq_copy_'+name.replace('-','_'),HERE/paths[name])
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
t=module('transfer-jobs')
p=module('portable-project')
FINAL={'READY','SUCCEEDED','CANCELED','FAILED'}


class ProjectPeer(t.PeerClient):
    def call(self, action, **fields):
        try:
            self.connect()
            payload=json.dumps({'id':self.ticket['id'],'action':action,**fields}).encode()
            self.connection.request('POST','/project-snapshot',body=payload,
                headers={'Content-Type':'application/json','Authorization':'Bearer '+self.ticket['token']})
            response=self.connection.getresponse();raw=response.read(1500001)
            p.need(len(raw)<=1500000,'Portable peer response is too large')
            value=json.loads(raw)
            p.need(response.status==200 and value.get('ok') is True,'Portable source unavailable')
            return value['result']
        except Exception:self.close();raise


class ProjectCopies(t.TransferJobs):
    def __init__(self,node):
        self.n=node
        self.store=node.projects().store
        self.portable=p.PortableProjects(self.store)
        self.root=node.ROOT/'project-copies'
        self.portable.s.private_dir(self.root,create=True)

    @staticmethod
    def unit(key,attempt):return 'gpuq-project-copy-'+t.identifier(key)+'-'+str(attempt)+'.service'

    def identity(self,args):
        self.actor(args);t.identifier(args.get('id'))
        p.need(isinstance(args.get('project'),str) and self.portable.s.SLUG.fullmatch(args['project']),'Invalid project identity')
        self.store._identity(args['userId'],args.get('project'))
        p.need(isinstance(args.get('release'),str) and t.HASH.fullmatch(args['release']),'Invalid immutable project release')

    def probe(self,args):
        p.need(isinstance(args,dict) and set(args)<={'userId','project','release','from'},'Invalid project portability fields')
        self.actor(args)
        self.store._identity(args['userId'],args.get('project'))
        self.store.admit(args['userId'],args['project'])
        engine=self.store._oci(args['userId']);engine.verify_host()
        sources=[]
        for machine,peer in self.n.CONFIG.get('transferPeers',{}).items():
            # The same constructor used by receive validates explicit LAN IP,
            # port and TLS certificate pin; no network request or ticket here.
            ProjectPeer(peer,{}).close();sources.append(machine)
        if 'from' in args:p.need(args['from'] in sources,'No trusted LAN project source is configured')
        try:
            status=self.store.status(args['userId'],args['project'])
            p.need(status.get('environmentMode')=='oci','Existing target project is not OCI; use a different project name')
        except Exception as error:
            if getattr(error,'code',None)!='not_found':raise
        result={'protocol':'portable-project-v1','enabled':True,'project':args['project'],
                'environmentMode':'oci','architecture':{'x86_64':'amd64','aarch64':'arm64'}.get(platform.machine(),platform.machine()),
                'sources':sources,'releaseReady':False}
        if 'release' in args:
            # A read-only compatibility probe has no operation ID. Only the
            # immutable release needs validation; prepare/start bind an ID.
            p.need(isinstance(args['release'],str) and t.HASH.fullmatch(args['release']),
                   'Invalid immutable project release')
            source=self.store.release(args['userId'],args['project'],args['release'])
            p.need(source['meta'].get('environmentMode')=='oci','Cross-node environments require a published OCI project')
            image=engine.portable_image(args['project'],source['meta']['oci'])
            result.update(releaseReady=True,release=args['release'],image=image['image'],architecture=image['architecture'],
                          codeBytes=source['meta']['bytes'],codeEntries=source['meta']['entries'],
                          imageUnpackedBytes=image['unpackedBytes'])
            sampler=getattr(engine,'portable_image_entries',None)
            try:result['imageEntries']=sampler(args['project'],source['meta']['oci']) if callable(sampler) else None
            except Exception:
                # Additive admission evidence cannot change the old copy
                # protocol. New storage plans reject unknown inode evidence.
                result['imageEntries']=None
        return result

    def launch(self,spec):
        self.n.atomic_json(self.path(spec['id']),spec)
        try:
            self.n.run(['/usr/bin/systemd-run','--user','--collect','--unit='+self.unit(spec['id'],spec['attempt']),
                '--property=Type=exec','--property=KillMode=control-group','--property=UMask=0077',
                '--property=CPUQuota=200%','--property=MemoryMax=2G','--property=TasksMax=128',
                '--property=RuntimeMaxSec=86400','--property=TimeoutStopSec=10',
                '/usr/bin/python3',str(self.n.HERE/'node-executor.py'),'--project-copy-worker',spec['id'],str(spec['attempt'])],timeout=8)
        except (OSError,ValueError,subprocess.SubprocessError):pass

    def start_spec(self,args,payload):
        self.identity(args);key=args['id']
        with self.store.lifetime(args['userId'],args['project']),self.lock(key):
            p.need(self.store.lifecycle(args['userId'],args['project'])['state'] not in ('RETIRING','RETIRED'),
                   'Project is retired or its retirement is unconfirmed')
            if payload['role']=='import':self.store.admit(args['userId'],args['project'])
            p.need(not any(self.path(key,suffix).exists() for suffix in ('.cancel','.revoked')),
                   'Project copy was canceled or revoked; use an explicit controlled retry')
            try:
                spec=self.load(key);p.need(spec['digest']==t.digest(payload),'Copy ID belongs to different immutable content')
            except FileNotFoundError:
                # The export-cache lock serializes reference publication with
                # cleanup. A new operation cannot race deletion of its bundle.
                cache_lock=(self.store._file_lock(self.portable.folder(args['userId'],'exports',args['project'])/'.lock')
                            if payload['role']=='export' else contextlib.nullcontext())
                with cache_lock, self.lock('00000000-0000-0000-0000-000000000000','.admission.lock'):
                    try:slots=self.load('00000000-0000-0000-0000-000000000000','.slots.json')['slots']
                    except FileNotFoundError:slots=[]
                    retained=[]
                    for slot in slots:
                        try:state=self.status({'id':slot['id'],'userId':slot['userId']})['state']
                        except FileNotFoundError:state='UNKNOWN'
                        if state not in FINAL:retained.append(slot)
                    p.need(len(retained)<4,'Four active or unconfirmed project copies already exist')
                    p.need(len(list(self.root.glob('*.json')))<20000,'Project copy history is full')
                    spec={**payload,'id':key,'digest':t.digest(payload),'attempt':1,'createdAt':time.time()}
                    retained.append({'id':key,'userId':args['userId']})
                    self.n.atomic_json(self.path('00000000-0000-0000-0000-000000000000','.slots.json'),{'slots':retained})
                    self.launch(spec)
            return self.status({'id':key,'userId':args['userId']})

    def prepare(self,args):
        p.need(set(args)=={'id','userId','project','release','targetMachine'},'Invalid project export fields')
        self.identity(args)
        target=args['targetMachine']
        p.need(isinstance(target,str) and t.MACHINE.fullmatch(target) and target!=self.machine(),'Select a different exact target node')
        result=self.start_spec(args,{**{k:args[k] for k in ('userId','project','release','targetMachine')},'role':'export'})
        if result['state']!='READY':return result
        with self.lock(args['id'],'.ticket.lock'):
            p.need(not any(self.path(args['id'],suffix).exists() for suffix in ('.cancel','.revoked')),
                   'Source project copy was canceled or revoked')
            try:grant=self.load(args['id'],'.grant.json')
            except FileNotFoundError:
                grant={**{k:args[k] for k in ('id','userId','project','release','targetMachine')},
                       'token':secrets.token_urlsafe(32),'expiresAt':time.time()+86400,
                       'info':self.portable.info(args['userId'],args['project'],args['release'])}
                self.n.atomic_json(self.path(args['id'],'.grant.json'),grant)
            p.need(not grant.get('revoked') and grant['expiresAt']>time.time(),'Source project grant expired or revoked; inspect original copy')
            return {**result,'source':{'id':args['id'],'token':grant['token'],**grant['info']}}

    def start(self,args):
        p.need(set(args)=={'id','userId','project','release','sourceMachine','source'},'Invalid project copy fields')
        self.identity(args)
        source=args['source'];machine=args['sourceMachine']
        p.need(isinstance(machine,str) and machine!=self.machine(),'Project source must be a different node')
        p.need(isinstance(source,dict) and set(source)=={'id','token','protocol','state','project','release','manifestBytes','manifestSha256','totalBytes','entries'}
             and source['id']==args['id'] and source['protocol']=='portable-project-v1' and source['state']=='READY'
             and source['project']==args['project'] and source['release']==args['release']
             and isinstance(source['token'],str) and re.fullmatch('[A-Za-z0-9_-]{43}',source['token'])
             and isinstance(source['manifestSha256'],str) and t.HASH.fullmatch(source['manifestSha256'])
             and type(source['manifestBytes']) is int and 1<=source['manifestBytes']<=self.store.MAX_BYTES
             and type(source['totalBytes']) is int and 0<=source['totalBytes']<=self.store.MAX_BYTES
             and type(source['entries']) is int and 0<=source['entries']<=self.store.max_entries+7,'Invalid immutable project source grant')
        ProjectPeer(self.n.CONFIG.get('transferPeers',{}).get(machine),source).close()
        return self.start_spec(args,{**{k:args[k] for k in ('userId','project','release','sourceMachine','source')},'role':'import'})

    def status(self,args):
        p.need(set(args)=={'id','userId'},'Invalid copy status fields')
        spec=self.owned(args);active=self.activity(self.unit(spec['id'],spec['attempt']))
        try:result=self.load(spec['id'],'.result.json')
        except FileNotFoundError:result={}
        if result.get('attempt')!=spec['attempt']:result={}
        # A crash may happen after the atomic release rename but before the
        # final receipt. Confirm that exact immutable artifact instead of
        # launching a second worker or leaving a successful copy UNKNOWN.
        if active is False and not result and not self.path(spec['id'],'.cancel').exists():
            try:
                if spec['role']=='import':
                    self.store.release(spec['userId'],spec['project'],spec['release']);recovered='SUCCEEDED'
                else:
                    self.portable.info(spec['userId'],spec['project'],spec['release']);recovered='READY'
                result={'state':recovered,'attempt':spec['attempt'],'recoveredFromImmutableRelease':True}
                self.n.atomic_json(self.path(spec['id'],'.result.json'),result)
            except (OSError,ValueError):pass
        state=result.get('state','UNKNOWN')
        if active is not False:state='RUNNING' if active is True else 'UNKNOWN'
        elif self.path(spec['id'],'.cancel').exists() and state not in ('READY','SUCCEEDED'):state='CANCELED'
        try:progress=self.load(spec['id'],'.progress.json')
        except FileNotFoundError:progress={}
        return {'id':spec['id'],'state':state,'attempt':spec['attempt'],'project':spec['project'],'release':spec['release'],
                'role':spec['role'],'route':'lan','bytes':progress.get('bytes',0),
                'totalBytes':spec.get('source',{}).get('totalBytes'),
                'warnings':self.store.size_warnings(spec['source']['totalBytes']) if 'source' in spec else [],
                'error':result.get('error'),'developmentChanged':False}

    def cancel(self,args):
        p.need(set(args)=={'id','userId'},'Invalid copy cancellation fields');self.actor(args)
        key=t.identifier(args['id'])
        with self.lock(key):
            try:spec=self.owned(args)
            except FileNotFoundError:
                for suffix in ('.cancel','.revoked'):
                    if self.path(key,suffix).exists():p.need(self.load(key,suffix)['userId']==args['userId'],'Different copy owner')
                self.n.atomic_json(self.path(key,'.cancel'),{'userId':args['userId'],'at':time.time()})
                return {'id':key,'state':'CANCELED','cleaned':True}
            self.n.atomic_json(self.path(key,'.cancel'),{'userId':args['userId'],'at':time.time()})
            try:self.n.run(['/usr/bin/systemctl','--user','stop',self.unit(key,spec['attempt'])],timeout=15)
            except (OSError,ValueError,subprocess.SubprocessError):pass
            result=self.status(args)
            result['cleaned']=self.reap_stopped(spec)
            return result

    def revoke(self,args):
        """Fence source reads/late dispatch, without stopping or deleting files.

        Separate from cancellation: an unreachable target may still have a
        writer. Keep its shared export reference until normal stop/cleanup is
        confirmed. The ticket lock drains a current bounded read first.
        """
        p.need(set(args)=={'id','userId'},'Invalid project source revocation fields')
        self.actor(args);key=t.identifier(args['id'])
        with self.lock(key):
            try:
                spec=self.owned(args)
                p.need(spec['role']=='export','Only a source export can be revoked')
            except FileNotFoundError:pass
            with self.lock(key,'.ticket.lock'):
                for suffix in ('.cancel','.revoked'):
                    if self.path(key,suffix).exists():
                        p.need(self.load(key,suffix)['userId']==args['userId'],'Different copy owner')
                try:grant=self.load(key,'.grant.json')
                except FileNotFoundError:grant=None
                if grant is not None:
                    p.need(grant['userId']==args['userId'],'Different project grant owner')
                # Persist the permanent fence before acknowledging or changing
                # the optional grant. It also blocks prepare delayed in transit.
                self.n.atomic_json(self.path(key,'.revoked'),{'userId':args['userId'],'at':time.time()})
                if grant is not None:
                    grant['revoked']=True;self.n.atomic_json(self.path(key,'.grant.json'),grant)
        return {'id':key,'sourceRevoked':True,'fenced':True}

    def release(self,args):
        """Reclaim private transport files, never published code or OCI images.

        A final result is not enough: both systemd and the worker lock must
        confirm that no writer remains. Unknown/live operations fail closed.
        """
        p.need(set(args)=={'id','userId'},'Invalid project release fields')
        with self.lock(t.identifier(args.get('id'))):
            spec=self.owned(args);result=self.status(args)
            result['cleaned']=self.reap_stopped(spec)
            return result

    def reap_stopped(self,spec):
        key=spec['id']
        if self.activity(self.unit(key,spec['attempt'])) is not False:return False
        try:result=self.load(key,'.result.json')
        except FileNotFoundError:result={}
        canceled=self.path(key,'.cancel').exists()
        if not canceled and (result.get('attempt')!=spec['attempt'] or result.get('state') not in FINAL):return False
        # READY export still serves a live consumer until explicit cancellation
        # revokes its grant. Releasing it early would break a legitimate copy.
        if spec['role']=='export' and result.get('state')=='READY' and not canceled:return False
        fd=os.open(self.path(key,'.worker.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:return False
            if spec['role']=='import':
                self.remove_import(spec)
            else:
                with self.lock(key,'.ticket.lock'):
                    try:
                        grant=self.load(key,'.grant.json');grant['revoked']=True
                        self.n.atomic_json(self.path(key,'.grant.json'),grant)
                    except FileNotFoundError:pass
                    parent=self.portable.folder(spec['userId'],'exports',spec['project'])
                    with self.store._file_lock(parent/'.lock'):
                        stage=parent/('.stage-'+key)
                        if stage.exists() or stage.is_symlink():self.store._remove_stage(stage)
                        held=False
                        for path in self.root.glob('*.json'):
                            if not t.UUID.fullmatch(path.stem) or path.stem==key:continue
                            other=self.load(path.stem)
                            if any(other.get(k)!=spec[k] for k in ('userId','project','release','role')):continue
                            if self.path(other['id'],'.cancel').exists():
                                # A canceled worker might still be writing the
                                # same export. Keep it until definitely stopped.
                                if self.activity(self.unit(other['id'],other['attempt'])) is not False:held=True;break
                                continue
                            try:done=self.load(other['id'],'.result.json')
                            except FileNotFoundError:done={}
                            if (self.activity(self.unit(other['id'],other['attempt'])) is not False
                                or done.get('attempt')!=other['attempt'] or done.get('state') not in ('FAILED','CANCELED')):
                                held=True;break
                        if not held:
                            cache=parent/spec['release']
                            if cache.exists() or cache.is_symlink():self.store._remove_stage(cache)
            self.n.atomic_json(self.path(key,'.cleanup.json'),{'at':time.time(),'transportFilesReleased':True})
            return True
        finally:os.close(fd)

    def remove_import(self,spec):
        folder=self.portable.folder(spec['userId'],'imports')/spec['id']
        if folder.exists() or folder.is_symlink():self.store._remove_stage(folder)

    def read(self,request,token):
        p.need(isinstance(request,dict) and set(request)<={'id','action','path','offset'},'Invalid project snapshot request')
        key=t.identifier(request.get('id'))
        with self.lock(key,'.ticket.lock'):
            grant=self.load(key,'.grant.json')
            p.need(isinstance(token,str) and hmac.compare_digest(token,grant['token'])
                 and not grant.get('revoked') and grant['expiresAt']>time.time()
                 and not any(self.path(key,suffix).exists() for suffix in ('.cancel','.revoked')),
                 'Project grant is invalid or expired')
            return self.portable.read(grant['userId'],grant['project'],grant['release'],request.get('action'),
                **{k:request[k] for k in ('path','offset') if k in request})

    def worker(self,key,attempt):
        key=t.identifier(key)
        with self.lock(key,'.worker.lock'):
            spec=self.load(key);result={'state':'FAILED','attempt':attempt}
            p.need(spec['attempt']==attempt and not self.path(key,'.started-'+str(attempt)).exists(),'Copy worker cannot restart implicitly')
            self.n.atomic_json(self.path(key,'.started-'+str(attempt)),{'attempt':attempt})
            try:
                if any(self.path(key,suffix).exists() for suffix in ('.cancel','.revoked')):raise InterruptedError()
                if spec['role']=='export':
                    self.portable.export(spec['userId'],spec['project'],spec['release'],operation=key)
                    result['state']='READY'
                else:
                    self.receive(spec);result['state']='SUCCEEDED'
            except InterruptedError:result.update(state='CANCELED',error='Copy canceled; development files unchanged')
            except Exception as error:result.update(state='FAILED',error=str(error)[:240])
            if spec['role']=='import':
                try:self.remove_import(spec)
                except Exception:result['cleanupPending']=True
            self.n.atomic_json(self.path(key,'.result.json'),result)
            return 0 if result['state'] in ('READY','SUCCEEDED') else 1

    def receive(self,spec):
        client=ProjectPeer(self.n.CONFIG['transferPeers'][spec['sourceMachine']],spec['source'])
        key,user,project,release=(spec[k] for k in ('id','userId','project','release'))
        def read(action,**fields):
            for retry in range(4):
                if self.path(key,'.cancel').exists():raise InterruptedError()
                try:return client.call(action,**fields)
                except (OSError,http.client.HTTPException):
                    if retry==3:raise
                    time.sleep(min(4,2**retry))
        try:
            # A different completed copy may already have installed the same
            # fixed version. It is safe to reuse, never overwrite its dev tree.
            try:self.store.release(user,project,release)
            except Exception as error:
                if getattr(error,'code',None)!='not_found':raise
            else:return
            raw=bytearray()
            while len(raw)<spec['source']['manifestBytes']:
                part=base64.b64decode(read('manifest',offset=len(raw))['data'],validate=True)
                p.need(0<len(part)<=p.CHUNK and len(raw)+len(part)<=spec['source']['manifestBytes'],'Invalid portable manifest chunk')
                raw.extend(part)
            p.need(hashlib.sha256(raw).hexdigest()==spec['source']['manifestSha256'],'Portable manifest checksum differs')
            manifest=json.loads(raw);total=self.portable.validate_manifest(manifest,user,project,release)
            p.need(total==spec['source']['totalBytes'] and len(manifest['files'])+len(manifest['directories'])==spec['source']['entries'],'Portable manifest totals differ')
            self.store._space(total)
            parent=self.portable.folder(user,'imports');folder=parent/key
            p.need(not folder.exists() and not folder.is_symlink(),'Original import staging exists; inspect instead of overwriting')
            folder.mkdir(mode=0o700)
            for name in sorted(manifest['directories'],key=lambda path:len(Path(path).parts)):(folder/name).mkdir(mode=0o700)
            transferred,last=0,0
            for entry in manifest['files']:
                offset=0;checksum=hashlib.sha256()
                fd=os.open(folder/entry['path'],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                try:
                    while offset<entry['size']:
                        response=read('get',path=entry['path'],offset=offset)
                        part=base64.b64decode(response['data'],validate=True)
                        p.need(0<len(part)<=p.CHUNK and offset+len(part)<=entry['size']
                             and response.get('size')==entry['size'] and response.get('offset')==offset+len(part),'Invalid portable file chunk')
                        self.store._space(len(part))
                        with memoryview(part) as data:
                            while data:data=data[os.write(fd,data):]
                        checksum.update(part);offset+=len(part);transferred+=len(part)
                        if time.monotonic()-last>=1:
                            self.n.atomic_json(self.path(key,'.progress.json'),{'bytes':transferred,'path':entry['path']});last=time.monotonic()
                    os.fsync(fd)
                finally:os.close(fd)
                p.need(checksum.hexdigest()==entry['sha256'],'Portable received file checksum differs')
            if self.path(key,'.cancel').exists():raise InterruptedError()
            self.portable.import_bundle(user,project,release,folder,manifest)
            self.store._remove_stage(folder)  # Only this operation's temporary image/archive.
            self.n.atomic_json(self.path(key,'.progress.json'),{'bytes':total})
        finally:client.close()

    def process(self,operation,args):
        action=operation.removeprefix('projects.copy.')
        if action=='prepare':return self.prepare(args)
        if action=='start':return self.start(args)
        if action=='status':return self.status(args)
        if action=='cancel':return self.cancel(args)
        if action=='revoke':return self.revoke(args)
        if action=='release':return self.release(args)
        if action=='probe':return self.probe(args)
        raise ValueError('Unknown project copy operation')
