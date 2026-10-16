"""Current project transport: OCI environment, workspace and HOME; no releases."""
import os,shutil,uuid
from pathlib import Path


def runtime_folder(config,key):
    import importlib.util
    spec=importlib.util.spec_from_file_location('copy_store',Path(__file__).with_name('project-store.py'))
    store=importlib.util.module_from_spec(spec);spec.loader.exec_module(store)
    if str(uuid.UUID(key))!=key:raise ValueError('请使用原复制编号。')
    return store.private_dir(store.data().root(config,'workspacesRoot')/'.copies',create=True)/key


class ProjectCopy:
    def __init__(self,jobs):self.j,self.s,self.d=jobs,jobs.s,jobs.d

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
                 'root':str(bundle),'state':'PREPARING','environment':True}
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
                # Commit layer, OCI staging directory and final archive coexist.
                self.s.require_workspace_space(folder,needed=writable+2*rootfs+workspace)
                engine.run('commit','--pause=false','--include-volumes=false',head['container'],tag,timeout=3600)
                engine.run('save','--format=oci-archive','--output',str(folder/'image.tar'),tag,timeout=3600)
                engine.run('unshare','/usr/bin/tar','--create','--file',str(folder/'workspace.tar'),'--one-file-system',
                    '--transform=flags=rh;s,^code,workspace,','--transform=flags=rh;s,^home,home/gpuq,',
                    '-C',str(paths['code'].parent),'code','home',timeout=3600)
                self.s.atomic_json(folder/'manifest.json',{'image':tag,'rootfsBytes':rootfs})
                row.update(state='READY');row.pop('error',None);self.s.atomic_json(file,row);return 0
            except Exception as error:
                row.update(state='FAILED',error=str(error)[:400]);self.s.atomic_json(file,row);return 1
            finally:
                try:engine.run('rmi',tag)
                except ValueError:pass

    def target(self,row):
        return self.s.private_dir(runtime_folder(self.j.config,row['id']),create=True)

    def install(self,row):
        key=row['id'];target=row['target'];owner=target.get('ownerId') or target['userId'];project=target['project']
        folder=self.target(row);store=self.j.e.projects().store
        destination=folder if target.get('jobId') else store.owner_path(owner,create=True)/self.d.name(project)
        if (destination/'project.json').exists():
            if self.s.read_json(destination/'project.json').get('copyKey')==key:return
            raise ValueError('目标项目已存在，原环境和文件已保留；请用 --name 指定新项目名。')
        bundle=folder/'received';manifest=self.s.read_json(bundle/'manifest.json')
        # OCI extraction and storage blob cache coexist until load completes.
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
        engine.workspace_command(owner,project,['tar','--extract','--file','/run/gpuq/project-copy.tar','--directory','/'],
                                 paths=paths,archive=bundle/'workspace.tar',timeout=3600)
        with self.j.lock(key):
            if self.j.s.read_json(self.j.path(key))['state']=='CANCELED':return False
            self.s.atomic_json(folder/'project.json',{'project':project,'ownerId':owner,'userId':owner,'environmentMode':'oci',
                              'copyKey':key,'name':project,'archived':False,'group':'','repo':None,'createdAt':row['createdAt']})
            if destination!=folder:
                try:os.rename(folder,destination)
                except OSError:
                    # A target created meanwhile remains intact. Retain this copy to resume.
                    (folder/'project.json').unlink(missing_ok=True)
                    raise
        shutil.rmtree(destination/'received')
        return True

    def complete(self,key):
        with self.j.lock(key):
            file=self.j.path(key,'.source.json');row=self.s.read_json(file)
            # This directory contains only this operation's generated transport files.
            if row['state']=='READY':
                if Path(row['root']).exists():shutil.rmtree(self.s.private_dir(Path(row['root'])))
                row['state']='COMPLETE';self.s.atomic_json(file,row)
        return {'state':row['state']}
