"""Current project transport: OCI environment, workspace and HOME; no releases."""
import contextlib,fcntl,json,os,shutil,time,uuid
from pathlib import Path


def runtime_folder(config,key):
    import importlib.util
    spec=importlib.util.spec_from_file_location('copy_store',Path(__file__).with_name('project-store.py'))
    store=importlib.util.module_from_spec(spec);spec.loader.exec_module(store)
    if str(uuid.UUID(key))!=key:raise ValueError('请使用原复制编号。')
    return store.private_dir(store.data().root(config,'workspacesRoot')/'.copies',create=True)/key


class ProjectCopy:
    def __init__(self,jobs):self.j,self.s,self.d=jobs,jobs.s,jobs.d

    @staticmethod
    def preparing(row):
        folder=Path(row['root']);total=0;found=False
        try:
            for name in ('image.tar',) if row.get('fullImage') and row.get('mode')=='incremental' else ('rootfs.tar','workspace.tar','image.tar'):
                try:total+=(folder/name).lstat().st_size;found=True
                except FileNotFoundError:pass
            phase='源端整理文件清单' if (folder/'index.jsonl').exists() and not row.get('fullImage') else '源端准备临时归档'
        except OSError:return '源端准备导出（暂时读不到归档大小）'
        return phase+(f'（已生成 {total:,} 字节）' if found else '')

    def mode(self,args):
        ref=args['target'];store=self.j.e.projects().store
        folder=store.owner_path(ref.get('ownerId') or ref['userId'],create=True)/self.d.name(ref['project'])
        try:head=self.s.read_json(folder/'oci.json')
        except FileNotFoundError:head={}
        return {'mode':'incremental' if head.get('container') else 'full'}

    def observe(self,row):
        if row['state']!='PREPARING':return row
        try:active=self.j.e.run(['/usr/bin/systemctl','--user','show','--property=ActiveState','--value','gpuq-project-export-'+row['id']+'.service']).strip()
        except (ValueError,OSError):return row
        if active in ('inactive','failed'):
            with self.j.lock(row['id'],source=True):
                file=self.j.path(row['id'],'.source.json');row=self.s.read_json(file)
                if row['state']=='PREPARING':
                    row.update(state='FAILED',error='项目导出中断，请按原复制编号续传。');self.s.atomic_json(file,row)
        return row

    def prepare(self,args):
        key=args.get('key',args.get('id'));ref=args['source'];self.j.root(ref)
        file=self.j.path(key,'.source.json')
        # The atomic source record is readable while its exporter owns the lock.
        # Repeating the original request must return its ticket, not wait for tar.
        row=self.s.read_json(file) if file.exists() else None
        if row and row['state'] not in ('FAILED','COMPLETE'):
            os.utime(file,None);return {k:row[k] for k in ('id','token','state')}
        with self.j.lock(key,source=True):
            row=self.s.read_json(file) if file.exists() else None
            if row and row['state'] not in ('FAILED','COMPLETE'):return {k:row[k] for k in ('id','token','state')}
            exports=self.s.private_dir(self.d.root(self.j.config,'workspacesRoot')/'.copy-exports',create=True)
            folder=self.s.private_dir(exports/key,create=True)
            bundle=self.s.private_dir(folder/'bundle',create=True)
            row={**(row or {}),'id':key,'token':row['token'] if row else uuid.uuid4().hex,'request':{'source':ref},
                 'root':str(bundle),'state':'PREPARING','environment':True,'fullImage':False,'mode':row.get('mode','full') if row else args.get('mode','full')}
            self.s.atomic_json(file,row)
        self.launch_export(key,row)
        return {k:row[k] for k in ('id','token','state')}

    def launch_export(self,key,row):
        try:
            self.j.e.run(['/usr/bin/systemd-run','--user','--collect','--unit=gpuq-project-export-'+key,
                '--property=KillMode=control-group','--property=MemoryMax=1G','--property=TasksMax=2048',
                '/usr/bin/python3',str(Path(__file__).with_name('node-executor.py')),'--project-copy-export-worker',key])
        except Exception as error:
            with self.j.lock(key,source=True):row.update(state='FAILED',error=str(error)[:400]);self.s.atomic_json(self.j.path(key,'.source.json'),row)
            raise

    def full(self,row):
        if not row.get('fullImage'):
            with self.j.lock(row['id'],source=True):
                file=self.j.path(row['id'],'.source.json');row=self.s.read_json(file)
                row.update(fullImage=True,state='PREPARING');self.s.atomic_json(file,row)
            self.launch_export(row['id'],row)
            return {'state':'PREPARING'}
        return {'state':'READY','entries':[entry for entry in self.j.entries(row)
                    if entry['path'] in ('image.tar','workspace.tar','manifest.json')],'nextOffset':None}

    def export(self,key):
        # Serialize exporters without blocking this same node's receiver/control.
        # Never pause or replace the source project.
        with self.j.lock(key,source=True):
            file=self.j.path(key,'.source.json');row=self.s.read_json(file)
            if row['state'] in ('READY','COMPLETE'):return 0
            ref=row['request']['source'];owner=ref.get('ownerId') or ref['userId'];project=ref['project']
            engine=self.j.e.projects().oci(owner);folder=Path(row['root']);tag='localhost/gpuq-copy:'+key
            image_only=row.get('fullImage') and row['mode']=='incremental'
            try:
                paths=self.j.e.projects().store.dev_paths(owner,project)
                self.s.require_workspace_space(folder,needed=1)
                head=engine.workspace_container(project)
                # Sizing walks the whole rootfs and workspace; it is as slow as the export itself.
                writable,rootfs=map(int,engine.run('container','inspect','--size','--format={{.SizeRw}} {{.SizeRootFs}}',head['container'],timeout=3600).split())
                workspace=0 if image_only else sum(int(line.split()[0]) for line in engine.run('unshare','/usr/bin/du','-sb',*[str(path) for path in paths.values()],timeout=3600).splitlines())
                # Incremental export needs no commit layer or saved OCI image.
                needed=writable+2*rootfs if image_only else rootfs+workspace if row['mode']=='incremental' else writable+2*rootfs+workspace
                self.s.require_workspace_space(folder,needed=needed)
                if row['mode']=='incremental' and not image_only:engine.run('export','--output',str(folder/'rootfs.tar'),head['container'],timeout=3600)
                else:
                    engine.run('commit','--pause=false','--include-volumes=false',head['container'],tag,timeout=3600)
                    engine.run('save','--format=oci-archive','--output',str(folder/'image.tar'),tag,timeout=3600)
                if not image_only:
                    engine.run('unshare','/usr/bin/tar','--create','--file',str(folder/'workspace.tar'),'--one-file-system',
                        '--format=pax','--exclude=code/.copy-backups',
                        '--transform=flags=rh;s,^code,workspace,','--transform=flags=rh;s,^home,home/gpuq,',
                        '-C',str(paths['code'].parent),'code','home',timeout=3600)
                self.s.atomic_json(folder/'manifest.json',{'image':tag,'rootfsBytes':rootfs})
                if row['mode']=='incremental' and not image_only:self.sync().index(folder,rootfs=True)
            except Exception as error:
                row.update(state='FAILED',error=str(error)[:400]);self.s.atomic_json(file,row);return 1
            finally:
                if row['mode']=='full' or image_only:
                    try:engine.run('rmi',tag)
                    except ValueError:pass
            # A same-node receiver loads this same tag; finish export cleanup
            # before allowing it to start importing the bundle.
            row.update(state='READY');row.pop('error',None);self.s.atomic_json(file,row);return 0

    def target(self,row):
        return self.s.private_dir(runtime_folder(self.j.config,row['id']),create=True)

    def sync(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location('project_sync',Path(__file__).with_name('project-sync.py'))
        result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result

    def destination(self,row):
        ref=row['target'];owner=ref.get('ownerId') or ref['userId']
        return self.j.e.projects().store.owner_path(owner,create=True)/self.d.name(ref['project'])

    @contextlib.contextmanager
    def serialized(self,row):
        target=row['target'];owner=target.get('ownerId') or target['userId']
        engine=self.j.e.projects().oci(owner)
        fd=os.open(engine.folder/('copy-'+self.d.name(target['project'])+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            try:fcntl.flock(fd,fcntl.LOCK_EX|(fcntl.LOCK_NB if target.get('jobId') else 0))
            except BlockingIOError:yield False
            else:yield True
        finally:os.close(fd)

    @contextlib.contextmanager
    def restartable(self,row):
        target=row['target'];owner=target.get('ownerId') or target['userId']
        engine=self.j.e.projects().oci(owner)
        fd=os.open(engine.folder/('use-'+self.d.name(target['project'])+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            try:fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
            except BlockingIOError:yield False
            else:yield True
        finally:os.close(fd)

    @contextlib.contextmanager
    def idle(self,row,engine):
        self.j.phase(row['id'],'等待目标项目的任务、终端或 Git 命令结束')
        project=self.d.name(row['target']['project'])
        def running(selector):
            args=('ps','--quiet','--filter',selector)
            # Refresh stale running records only when the cheap query finds one.
            containers=engine.run(*args,'--sync').split() if engine.run(*args) else []
            if not containers:return False
            try:pids=[int(value) for value in engine.run('container','inspect','--format','{{.State.Pid}}',*containers).split()]
            except (ValueError,OSError):return True
            if len(pids)!=len(containers):return True
            for pid in pids:
                if pid<=0:return True
                try:os.kill(pid,0)
                except ProcessLookupError:continue
                except PermissionError:pass
                return True
            return False
        fd=os.open(engine.folder/('use-'+project+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            while self.j.status({'id':row['id']})['state']!='CANCELED':
                try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:pass
                else:
                    # Include executions started before this node update, and
                    # workspace commands that previously had no project label.
                    busy=running('label=io.gpuq.project='+project)
                    if not busy:busy=running('volume='+str(self.destination(row)/'code'))
                    if not busy:yield True;return
                    fcntl.flock(fd,fcntl.LOCK_UN)
                if row['target'].get('jobId'):break
                time.sleep(.2)
            yield False
        finally:os.close(fd)

    def incremental_page(self,row,peer,offset):
        bundle=self.target(row)/'received';index=bundle/'index.jsonl';plan=bundle/'plan.jsonl'
        if not plan.exists():
            self.j.phase(row['id'],'等待源项目导出并读取文件清单')
            cursor=0
            with open(index.with_suffix('.tmp'),'w') as stream:
                while cursor is not None:
                    if self.j.status({'id':row['id']})['state']=='CANCELED':return {'entries':[],'nextOffset':None}
                    page=peer.call('list',offset=cursor)
                    if page.get('state')=='PREPARING':
                        self.j.phase(row['id'],page.get('phase') or '等待源项目导出并读取文件清单');time.sleep(1);continue
                    if page.get('state')=='FAILED':raise ValueError(page['error'])
                    for entry in page['entries']:stream.write(json.dumps(entry)+'\n')
                    cursor=page['nextOffset']
            os.replace(index.with_suffix('.tmp'),index)
            target=row['target'];owner=target.get('ownerId') or target['userId'];engine=self.j.e.projects().oci(owner)
            paths=self.j.e.projects().store.dev_paths(owner,target['project'])
            self.j.phase(row['id'],'比较目标项目文件')
            engine.copy_files(target['project'],'plan',paths=paths,index=str(index),plan=str(plan))
        page=self.sync().page(plan,offset)
        page['entries']=[{**entry,'path':entry['body'],'remotePath':entry['archive'],'remoteOffset':entry['offset']} for entry in page['entries'] if entry['type']=='file']
        return page

    def install(self,row,receive=None,receive_full=None):
        self.j.phase(row['id'],'准备合并项目文件')
        key=row['id'];target=row['target'];owner=target.get('ownerId') or target['userId'];project=target['project']
        folder=self.target(row);destination=self.destination(row);bundle=folder/'received';incremental=target.get('mode')=='incremental'
        engine=self.j.e.projects().oci(owner)
        if not incremental:
            manifest=self.s.read_json(bundle/'manifest.json')
            # OCI extraction and storage blob cache coexist until load completes.
            self.s.require_workspace_space(folder,needed=2*(bundle/'image.tar').stat().st_size+manifest['rootfsBytes']+(bundle/'workspace.tar').stat().st_size)
            self.sync().index(bundle)
            engine.run('load','--input',str(bundle/'image.tar'),timeout=3600)
        plan=bundle/'plan.jsonl'
        existing=(destination/'project.json').exists();working=destination if existing else folder
        paths={name:self.s.private_dir(working/name,create=True) for name in ('code','home')}
        engine.state_folder=working
        with engine.locked(project):
            head=engine.load(project)
            if not incremental and head.get('container') is None:
                container='gpuq-dev-'+uuid.uuid4().hex
                engine.run('create','--name',container,'--network=none','--entrypoint','/bin/sh',manifest['image'])
                self.s.atomic_json(working/'oci.json',{'image':manifest['image'],'container':container})
        if not incremental and head.get('container') is not None:
            # A terminal/another copy may have initialized it during transport.
            self.s.require_workspace_space(folder,needed=manifest['rootfsBytes'])
            engine.copy_files(project,'image',paths=paths,image=manifest['image'],bundle=str(bundle))
            self.sync().index(bundle,rootfs=True)
        # Receive late changes before holding the execution lease. The lease
        # covers only local backup/apply; unchanged projects need no exclusion.
        engine.copy_files(project,'plan',paths=paths,index=str(bundle/'index.jsonl'),plan=str(plan))
        if incremental and receive is not None:
            with self.sync().module('copy-batches').CopyBatches(bundle) as batches:
                entries=({**entry,'path':entry['body'],'remotePath':entry['archive'],'remoteOffset':entry['offset']}
                         for entry in self.sync().entries(plan) if entry['type']=='file' and not (bundle/entry['body']).exists() and batches.size(entry['body'])!=entry['size'])
                if receive(entries) is None:return False
        changed=bool(plan.stat().st_size)
        with self.idle(row,engine) if changed and existing else contextlib.nullcontext(True) as ready:
            if ready and changed:
                self.j.phase(key,'备份目标项目中将被覆盖的文件')
                engine.copy_files(project,'backup',paths=paths,plan=str(plan),key=key)
                if self.j.status({'id':key})['state']=='CANCELED':return False
                self.j.phase(key,'合并项目文件')
                engine.copy_files(project,'apply',paths=paths,plan=str(plan),bundle=str(bundle),incremental=incremental)
            if ready:
                with self.j.lock(key):
                    current=self.s.read_json(self.j.path(key))
                    if current['state']=='CANCELED':return False
                    if not existing:
                        self.s.atomic_json(folder/'project.json',{'project':project,'ownerId':owner,'userId':owner,'environmentMode':'oci',
                                          'copyKey':key,'name':project,'archived':False,'group':'','repo':None,'createdAt':row['createdAt']})
                        try:os.rename(folder,destination)
                        except OSError:
                            (folder/'project.json').unlink(missing_ok=True);raise
                    current.update(installed=True,createdProject=not existing);self.s.atomic_json(self.j.path(key),current)
        if not ready:
            if self.j.status({'id':key})['state']=='CANCELED':return False
            if incremental and receive_full() is None:return False
            return self.install_runtime(row)
        self.cleanup(self.s.read_json(self.j.path(key)))
        return True

    def install_runtime(self,row):
        # The original task-copy installer: keep a busy project's files untouched.
        self.j.phase(row['id'],'准备独立任务副本并安装项目文件')
        key=row['id'];target=row['target'];owner=target.get('ownerId') or target['userId'];project=target['project']
        folder=self.target(row);bundle=folder/'received';manifest=self.s.read_json(bundle/'manifest.json')
        self.s.require_workspace_space(folder,needed=2*(bundle/'image.tar').stat().st_size+manifest['rootfsBytes']+(bundle/'workspace.tar').stat().st_size)
        paths={name:self.s.private_dir(folder/name,create=True) for name in ('code','home')}
        engine=self.j.e.projects().oci(owner);engine.state_folder=folder
        with engine.locked(project):
            head=engine.load(project)
            if head.get('container') is None:
                engine.run('load','--input',str(bundle/'image.tar'),timeout=3600)
                container='gpuq-dev-'+uuid.uuid4().hex
                engine.run('create','--name',container,'--network=none','--entrypoint','/bin/sh',manifest['image'])
                self.s.atomic_json(folder/'oci.json',{'image':manifest['image'],'container':container})
        engine.workspace_command(owner,'copy-'+key,['tar','--extract','--file','/run/gpuq/project-copy.tar','--directory','/'],
                                 paths=paths,archive=bundle/'workspace.tar',timeout=3600)
        with self.j.lock(key):
            current=self.s.read_json(self.j.path(key))
            if current['state']=='CANCELED':return False
            self.s.atomic_json(folder/'project.json',{'project':project,'ownerId':owner,'userId':owner,'environmentMode':'oci',
                              'copyKey':key,'name':project,'archived':False,'group':'','repo':None,'createdAt':row['createdAt']})
            current.update(runtime=True);self.s.atomic_json(self.j.path(key),current)
        self.j.cleanup_uploads(row,[bundle]);shutil.rmtree(bundle)
        return True

    def cleanup(self,row):
        key=row['id'];target=row['target'];owner=target.get('ownerId') or target['userId'];project=target['project']
        destination=self.destination(row);folder=runtime_folder(self.j.config,key)
        self.j.cleanup_uploads(row,[folder/'received',*([destination/'received'] if row.get('createdProject') else [])])
        backup=destination/'code'/'.copy-backups'/(key+'.tar')
        if backup.exists():self.sync().module('project-purge').Trash(self.j.config).delete(backup,row.get('backupKey',key),'output',row.get('actor'))
        engine=self.j.e.projects().oci(owner);engine.state_folder=destination;head=engine.load(project)
        try:staged=self.s.read_json(folder/'oci.json')
        except FileNotFoundError:staged={}
        if staged.get('container') and staged['container']!=head.get('container'):engine.run('rm','--ignore',staged['container'])
        image='localhost/gpuq-copy:'+key
        if head.get('image')!=image:
            if engine.run('images','--quiet','--filter','reference='+image):engine.run('rmi',image)
        if folder.exists():engine.run('unshare','/usr/bin/rm','-rf','--',str(self.s.private_dir(folder)),timeout=3600)
        received=destination/'received'
        if row.get('createdProject') and received.exists():engine.run('unshare','/usr/bin/rm','-rf','--',str(self.s.private_dir(received)),timeout=3600)

    def complete(self,key,*,expired_before=None):
        file=self.j.path(key,'.source.json');row=self.s.read_json(file)
        if expired_before is not None and row['state'] not in ('COMPLETE','FAILED') and file.stat().st_mtime>expired_before:return {'state':row['state']}
        if row['state']=='PREPARING':
            # Cancel only this operation's exporter before removing its staging.
            try:self.j.e.run(['/usr/bin/systemctl','--user','stop','gpuq-project-export-'+key+'.service'])
            except ValueError:pass
        with self.j.lock(key,source=True):
            row=self.s.read_json(file)
            if expired_before is not None and row['state'] not in ('COMPLETE','FAILED') and file.stat().st_mtime>expired_before:return {'state':row['state']}
            # This directory contains only this operation's generated transport files.
            if row['state'] in ('PREPARING','FAILED'):
                ref=row['request']['source'];engine=self.j.e.projects().oci(ref.get('ownerId') or ref['userId'])
                try:engine.run('rmi','--ignore','localhost/gpuq-copy:'+key)
                except ValueError:pass
            folder=Path(row['root']).parent
            if folder.exists():shutil.rmtree(self.s.private_dir(folder))
            if expired_before is None:row['state']='COMPLETE'
            elif row['state'] not in ('COMPLETE','FAILED'):row.update(state='FAILED',error='复制已过期，请重新发起复制')
            self.s.atomic_json(file,row)
        return {'state':row['state']}

    def collect(self):
        results=[];cutoff=time.time()-86400
        for file in self.j.folder.glob('*.source.json'):
            try:
                row=self.s.read_json(file)
                if not row.get('environment'):continue
                folder=Path(row['root']).parent
                if row['state'] in ('COMPLETE','FAILED'):
                    if folder.exists():
                        result=self.complete(row['id'],expired_before=cutoff)
                        if result['state'] in ('COMPLETE','FAILED'):results.append({'id':row['id'],'kind':'copy-export',**result})
                elif file.stat().st_mtime<=cutoff:
                    result=self.complete(row['id'],expired_before=cutoff)
                    if result['state']=='FAILED':results.append({'id':row['id'],'kind':'copy-export',**result})
            except (OSError,ValueError) as error:
                results.append({'id':file.name.removesuffix('.source.json'),'kind':'copy-export','state':'UNKNOWN','error':str(error)[:400]})
        return results
