"""Projects are mutable OCI workspaces. Code is managed by git in the container."""
import importlib.util,json,time,uuid
from pathlib import Path


def module(name):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m


class ProjectOperations:
    def __init__(self,executor):
        self.executor=executor;self.config=executor.CONFIG
        self.store=module('project-store').ProjectStore(executor.ROOT,config=self.config)

    def oci(self,user):return module('personal-oci').PersonalOCI(self.config,user)

    def status(self,user,slug):
        value=self.store.status(user,slug);engine=self.oci(user)
        if value.get('cloneState') in ('PENDING','RUNNING'):return value
        if hasattr(engine,'load') and engine.load(slug).get('container') is None:return value
        for key,argv in (('url',['config','--get','remote.origin.url']),('branch',['branch','--show-current']),('commit',['rev-parse','HEAD'])):
            try:value['git'][key]=engine.git(user,slug,argv) or None
            except ValueError:pass  # A new workspace can have no repository/commit yet.
        return value

    def initialize(self,user,slug):
        path,value=self.store._project(user,slug)
        if value.get('cloneComplete'):return 0
        try:
            value['cloneState']='RUNNING';module('project-store').atomic_json(path/'project.json',value)
            self.oci(user).git(user,slug,['clone','--',value['repo'],'.'])
            value.update(cloneState='COMPLETE',cloneComplete=True)
            module('project-store').atomic_json(path/'project.json',value);return 0
        except Exception as error:
            value.update(cloneState='FAILED',cloneError=str(error)[:400]);module('project-store').atomic_json(path/'project.json',value);return 1

    def process(self,operation,args):
        user=args.get('ownerId',args.get('userId'));slug=args.get('project')
        if operation=='projects.list':
            return module('storage-usage').cached(self,self.store.list(include_usage=True)) if args.get('includeUsage') is True else {'projects':self.store.list()}
        if operation=='projects.create':
            value=self.store.create(user,slug,args.get('repo'))
            path,_=self.store._project(user,slug)
            if args.get('repo') and not value.get('cloneKey'):
                value.update(cloneKey=str(uuid.uuid4()),cloneState='PENDING')
                module('project-store').atomic_json(path/'project.json',value)
                try:self.executor.run(['/usr/bin/systemd-run','--user','--collect','--unit=gpuq-clone-'+value['cloneKey'],
                    '--property=KillMode=control-group','--property=MemoryMax=2G','--property=TasksMax=2048',
                    '/usr/bin/python3',str(Path(__file__).with_name('node-executor.py')),'--project-init-worker',user,slug])
                except Exception:value.update(cloneState='UNKNOWN');module('project-store').atomic_json(path/'project.json',value)
            return self.status(user,slug)
        if operation in ('projects.status','projects.workspace'):
            try:value=self.status(user,slug)
            except FileNotFoundError:
                raise ValueError(f'这台服务器上没有项目 {slug}。请先用 gpuctl project list 确认服务器和项目名；确实没有就用 gpuctl project create {slug} 新建。') from None
            if args.get('diagnoseNetwork') is True:
                try:value['network']=self.oci(user).network(user,slug)
                except (ValueError,OSError):value['network']={'state':'UNKNOWN','error':'容器网络暂未响应，请稍后重试。'}
            return value
        if operation in ('projects.metadata','projects.update','projects.display.set'):
            return self.store.update(user,slug,args)
        if operation in ('projects.archive','projects.unarchive'):
            return self.store.update(user,slug,{'archived':operation=='projects.archive'})
        if operation=='projects.quota':
            d=module('local-data');result={'volumes':[]}
            for kind,field in (('workspace','workspacesRoot'),('datasets','datasetsRoot')):
                row={'kind':kind,'fs':None,'usedBytes':None,'availableBytes':None,'totalBytes':None,'media':None}
                try:row.update(d.disk_usage(d.root(self.config,field)))
                except (OSError,ValueError):pass
                shared=next((volume for volume in result['volumes'] if row['fs'] is not None and volume['fs']==row['fs']),None)
                if shared is None:result['volumes'].append(row)
                else:shared['kind']='shared'
            if slug:
                usage={'project':slug,'ownerId':user,'size':None,'complete':False}
                try:usage.update(d.size(self.store._project(user,slug)[0],partial=True))
                except OSError:pass
                result['projectUsage']=usage
            return result
        trash=module('project-purge').Trash(self.config)
        if operation=='projects.retire.list':return trash.listing(args)
        if operation=='projects.retire.status':
            try:return trash.find(args['key'])[1]
            except FileNotFoundError:return {'key':args['key'],'state':'UNKNOWN','error':'未知，请按原编号查询。'}
        if operation=='projects.retire.restore':return trash.restore(args)
        if operation=='projects.retire.purge':return trash.purge(args)
        if operation=='projects.retire.empty':return {'items':[trash.purge({**args,'key':r['key']}) for r in trash.listing()['items']]}
        if operation in ('projects.retire','projects.delete'):
            return trash.delete_project(self.store,user,slug,args['key'],args.get('actor',{'userId':args['userId']}))
        if operation in ('files.list','files.get','files.stat'):
            root=self.store.dev_paths(user,slug)['code']
            return module('dataset-files').process(self.config,operation,args,root=root)
        raise ValueError('此项目操作不存在。')
