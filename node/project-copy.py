"""Current project transport: OCI environment, workspace and HOME; no releases."""
import json,os,shutil,time,uuid
from pathlib import Path


def runtime_folder(config,key):
    import importlib.util
    spec=importlib.util.spec_from_file_location('copy_store',Path(__file__).with_name('project-store.py'))
    store=importlib.util.module_from_spec(spec);spec.loader.exec_module(store)
    if str(uuid.UUID(key))!=key:raise ValueError('请使用原复制编号。')
    return store.private_dir(store.data().root(config,'workspacesRoot')/'.copies',create=True)/key


class ProjectCopy:
    def __init__(self,jobs):self.j,self.s,self.d=jobs,jobs.s,jobs.d

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
            with self.j.lock(row['id']):
                file=self.j.path(row['id'],'.source.json');row=self.s.read_json(file)
                if row['state']=='PREPARING':
                    row.update(state='FAILED',error='项目导出中断，请按原复制编号续传。');self.s.atomic_json(file,row)
        return row

    def prepare(self,args):
        key=args.get('key',args.get('id'));ref=args['source'];self.j.root(ref)
        with self.j.lock(key):
            file=self.j.path(key,'.source.json')
            row=self.s.read_json(file) if file.exists() else None
            if row and row['state'] not in ('FAILED',):return {k:row[k] for k in ('id','token','state')}
            exports=self.s.private_dir(self.d.root(self.j.config,'workspacesRoot')/'.copy-exports',create=True)
            folder=self.s.private_dir(exports/key,create=True)
            bundle=self.s.private_dir(folder/'bundle',create=True)
            row={**(row or {}),'id':key,'token':row['token'] if row else uuid.uuid4().hex,'request':{'source':ref},
                 'root':str(bundle),'state':'PREPARING','environment':True,'mode':row.get('mode','full') if row else args.get('mode','full')}
            self.s.atomic_json(file,row)
        try:
            self.j.e.run(['/usr/bin/systemd-run','--user','--collect','--unit=gpuq-project-export-'+key,
                '--property=KillMode=control-group','--property=MemoryMax=1G','--property=TasksMax=2048',
                '/usr/bin/python3',str(Path(__file__).with_name('node-executor.py')),'--project-copy-export-worker',key])
        except Exception as error:
            with self.j.lock(key):row.update(state='FAILED',error=str(error)[:400]);self.s.atomic_json(file,row)
            raise
        return {k:row[k] for k in ('id','token','state')}

    def export(self,key):
        # One worker owns this original operation. Never pause or replace the source.
        with self.j.lock(key):
            file=self.j.path(key,'.source.json');row=self.s.read_json(file)
            if row['state'] in ('READY','COMPLETE'):return 0
            ref=row['request']['source'];owner=ref.get('ownerId') or ref['userId'];project=ref['project']
            engine=self.j.e.projects().oci(owner);folder=Path(row['root']);tag='localhost/gpuq-copy:'+key
            try:
                paths=self.j.e.projects().store.dev_paths(owner,project)
                self.s.require_workspace_space(folder,needed=1)
                head=engine.workspace_container(project)
                writable,rootfs=map(int,engine.run('container','inspect','--size','--format={{.SizeRw}} {{.SizeRootFs}}',head['container']).split())
                workspace=sum(int(line.split()[0]) for line in engine.run('unshare','/usr/bin/du','-sb',*[str(path) for path in paths.values()]).splitlines())
                # Incremental export needs no commit layer or saved OCI image.
                needed=rootfs+workspace if row['mode']=='incremental' else writable+2*rootfs+workspace
                self.s.require_workspace_space(folder,needed=needed)
                if row['mode']=='incremental':engine.run('export','--output',str(folder/'rootfs.tar'),head['container'],timeout=3600)
                else:
                    engine.run('commit','--pause=false','--include-volumes=false',head['container'],tag,timeout=3600)
                    engine.run('save','--format=oci-archive','--output',str(folder/'image.tar'),tag,timeout=3600)
                engine.run('unshare','/usr/bin/tar','--create','--file',str(folder/'workspace.tar'),'--one-file-system',
                    '--format=pax','--exclude=code/.copy-backups',
                    '--transform=flags=rh;s,^code,workspace,','--transform=flags=rh;s,^home,home/gpuq,',
                    '-C',str(paths['code'].parent),'code','home',timeout=3600)
                self.s.atomic_json(folder/'manifest.json',{'image':tag,'rootfsBytes':rootfs})
                if row['mode']=='incremental':self.sync().index(folder,rootfs=True)
                row.update(state='READY');row.pop('error',None);self.s.atomic_json(file,row);return 0
            except Exception as error:
                row.update(state='FAILED',error=str(error)[:400]);self.s.atomic_json(file,row);return 1
            finally:
                if row['mode']=='full':
                    try:engine.run('rmi',tag)
                    except ValueError:pass

    def target(self,row):
        return self.s.private_dir(runtime_folder(self.j.config,row['id']),create=True)

    def sync(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location('project_sync',Path(__file__).with_name('project-sync.py'))
        result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result

    def destination(self,row):
        ref=row['target'];owner=ref.get('ownerId') or ref['userId']
        return self.j.e.projects().store.owner_path(owner,create=True)/self.d.name(ref['project'])

    def incremental_page(self,row,peer,offset):
        bundle=self.target(row)/'received';index=bundle/'index.jsonl';plan=bundle/'plan.jsonl'
        if not plan.exists():
            cursor=0
            with open(index.with_suffix('.tmp'),'w') as stream:
                while cursor is not None:
                    if self.j.status({'id':row['id']})['state']=='CANCELED':return {'entries':[],'nextOffset':None}
                    page=peer.call('list',offset=cursor)
                    if page.get('state')=='PREPARING':time.sleep(1);continue
                    if page.get('state')=='FAILED':raise ValueError(page['error'])
                    for entry in page['entries']:stream.write(json.dumps(entry)+'\n')
                    cursor=page['nextOffset']
            os.replace(index.with_suffix('.tmp'),index)
            target=row['target'];owner=target.get('ownerId') or target['userId'];engine=self.j.e.projects().oci(owner)
            paths=self.j.e.projects().store.dev_paths(owner,target['project'])
            with engine.locked(target['project']):engine.copy_files(target['project'],'plan',paths=paths,index=str(index),plan=str(plan))
        page=self.sync().page(plan,offset)
        page['entries']=[{**entry,'path':entry['body'],'remotePath':entry['archive'],'remoteOffset':entry['offset']} for entry in page['entries'] if entry['type']=='file']
        return page

    def install(self,row):
        key=row['id'];target=row['target'];owner=target.get('ownerId') or target['userId'];project=target['project']
        folder=self.target(row);destination=self.destination(row);existing=(destination/'project.json').exists()
        working=destination if existing else folder;bundle=folder/'received';incremental=target.get('mode')=='incremental'
        if not incremental:
            manifest=self.s.read_json(bundle/'manifest.json')
            # OCI extraction and storage blob cache coexist until load completes.
            self.s.require_workspace_space(folder,needed=2*(bundle/'image.tar').stat().st_size+manifest['rootfsBytes']+(bundle/'workspace.tar').stat().st_size)
            self.sync().index(bundle)
        paths={name:self.s.private_dir(working/name,create=True) for name in ('code','home')}
        engine=self.j.e.projects().oci(owner);engine.state_folder=working
        plan=bundle/'plan.jsonl'
        with engine.locked(project):
            head=engine.load(project)
            if not incremental and head.get('container') is None:
                engine.run('load','--input',str(bundle/'image.tar'),timeout=3600)
                container='gpuq-dev-'+uuid.uuid4().hex
                engine.run('create','--name',container,'--network=none','--entrypoint','/bin/sh',manifest['image'])
                self.s.atomic_json(working/'oci.json',{'image':manifest['image'],'container':container})
            elif not incremental:
                # A terminal/another copy may have initialized it during transport.
                # Merge the received image's files into that same container.
                self.s.require_workspace_space(folder,needed=manifest['rootfsBytes'])
                engine.run('load','--input',str(bundle/'image.tar'),timeout=3600)
                engine.copy_files(project,'image',paths=paths,image=manifest['image'],bundle=str(bundle))
                self.sync().index(bundle,rootfs=True)
                plan.unlink(missing_ok=True)
            if not plan.exists():engine.copy_files(project,'plan',paths=paths,index=str(bundle/'index.jsonl'),plan=str(plan))
            trash=self.sync().module('project-purge').Trash(self.j.config)
            current=self.s.read_json(self.j.path(key))
            if current.get('backupFor')!=str(working):
                try:trash.find(key)
                except FileNotFoundError:
                    result=engine.copy_files(project,'backup',paths=paths,plan=str(plan),key=key)
                    if result['files']:trash.delete(paths['code']/'.copy-backups'/(key+'.tar'),key,'output',row.get('actor'))
                with self.j.lock(key):
                    current=self.s.read_json(self.j.path(key));current['backupFor']=str(working);self.s.atomic_json(self.j.path(key),current)
            if self.j.status({'id':key})['state']=='CANCELED':return False
            engine.copy_files(project,'apply',paths=paths,plan=str(plan),bundle=str(bundle),incremental=incremental)
            with self.j.lock(key):
                current=self.s.read_json(self.j.path(key))
                if current['state']=='CANCELED':return False
                if not existing:
                    self.s.atomic_json(folder/'project.json',{'project':project,'ownerId':owner,'userId':owner,'environmentMode':'oci',
                                      'copyKey':key,'name':project,'archived':False,'group':'','repo':None,'createdAt':row['createdAt']})
                    try:os.rename(folder,destination)
                    except OSError:
                        (folder/'project.json').unlink(missing_ok=True);raise
                current['installed']=True;self.s.atomic_json(self.j.path(key),current)
        received=destination/'received' if not existing else bundle
        shutil.rmtree(received)
        return True

    def complete(self,key):
        with self.j.lock(key):
            file=self.j.path(key,'.source.json');row=self.s.read_json(file)
            # This directory contains only this operation's generated transport files.
            if row['state']=='READY':
                if Path(row['root']).exists():shutil.rmtree(self.s.private_dir(Path(row['root'])))
                row['state']='COMPLETE';self.s.atomic_json(file,row)
        return {'state':row['state']}
