"""One shared seven-day trash for projects, datasets and task outputs."""
import contextlib,fcntl,importlib.util,os,shutil,sqlite3,time,uuid
from pathlib import Path


def module(name):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m


def finished_outputs(config):
    """Read local job ownership and scheduler state; unknown outputs stay put."""
    s=module('project-store');root=s.data().root(config,'root');rows=[];complete=True
    try:files=list((root/'jobs').iterdir())
    except FileNotFoundError:files=[]
    except OSError:return [],False
    try:outputs={p.name for p in (root/'outputs').iterdir() if s.JOB_ID.fullmatch(p.name)}
    except FileNotFoundError:outputs=set()
    except OSError:return [],False
    complete=not outputs.difference(file.stem for file in files if file.suffix=='.json' and s.JOB_ID.fullmatch(file.stem))
    for file in files:
        if file.suffix!='.json' or not s.JOB_ID.fullmatch(file.stem):continue
        try:
            job=s.read_json(file)
            owner=job.get('ownerId') or job.get('userId');project=job.get('project')
            if not project:continue
            s.data().name(owner);s.data().name(project)
            if file.stem in outputs:rows.append({'jobId':file.stem,'ownerId':owner,'project':project,'path':str(root/'outputs'/file.stem)})
        except (OSError,ValueError,AttributeError,TypeError,RecursionError):complete=False
    if not rows:return [],complete
    try:
        with contextlib.closing(sqlite3.connect('file:'+config['database']+'?mode=ro',uri=True)) as db:
            states=dict(db.execute('SELECT submit_key,state FROM jobs'))
    except (sqlite3.Error,KeyError):return [],False
    return [row for row in rows if states.get(row['jobId']) in ('SUCCEEDED','FAILED','CANCELED','LOST')],complete


class Trash:
    def __init__(self,config):
        self.config=config;self.d=module('local-data');self.s=module('project-store')
        self.roots=[self.d.root(config,k) for k in ('datasetsRoot','workspacesRoot','root')]

    def base(self,path):
        path=Path(path)
        matches=[r for r in self.roots if path!=r and r in path.parents]
        if not matches:raise ValueError('删除对象必须在数据目录内。')
        return max(matches,key=lambda p:len(p.parts))

    def folders(self,base,create=False):
        folder=base/'.trash'
        if create:self.s.private_dir(folder,create=True)
        return folder

    def key(self,key):
        if not isinstance(key,str) or str(uuid.UUID(key))!=key:raise ValueError('请使用原删除UUID。')
        return key

    @contextlib.contextmanager
    def locked(self,folder,key):
        fd=os.open(folder/(self.key(key)+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:self.s.wait_project_lock(fd,fcntl.LOCK_EX,'回收站忙，请沿原编号稍后重试。');yield
        finally:os.close(fd)

    def move(self,folder,row):
        source=Path(row['originalPath']);base=folder.parent;relative=str(source.relative_to(base))
        payload=folder/(row['key']+'.data')
        if not payload.exists():
            with self.d.parent(base,relative) as (fd,name):
                trashfd=self.d.open_directory(folder)
                try:os.rename(name,payload.name,src_dir_fd=fd,dst_dir_fd=trashfd);os.fsync(fd);os.fsync(trashfd)
                finally:os.close(trashfd)
        row['state']='TRASHED';self.s.atomic_json(folder/(row['key']+'.json'),row)
        return row

    def delete(self,source,key,kind,actor,**metadata):
        key=self.key(key);path=Path(source);base=self.base(path);folder=self.folders(base,create=True)
        request={'path':str(path),'kind':kind}
        with self.locked(folder,key):
            record=folder/(key+'.json')
            if record.exists():
                row=self.s.read_json(record)
                if row['request']!=request:raise ValueError('原删除编号已用于不同对象。')
                if row['state']=='MOVING':row=self.move(folder,row)
            else:
                # Walk parents without following links; the final symlink is never traversed.
                with self.d.parent(base,str(path.relative_to(base))) as (fd,name):
                    info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                    if not (__import__('stat').S_ISDIR(info.st_mode) or __import__('stat').S_ISREG(info.st_mode)) or __import__('stat').S_ISLNK(info.st_mode):raise ValueError('请选择数据目录或普通文件。')
                row={**metadata,'key':key,'retirementId':key,'kind':kind,'request':request,
                     'state':'MOVING','originalPath':str(path),'actor':actor,'deletedAt':time.time(),
                     'retainUntil':metadata.get('retainUntil',time.time()+7*86400)}
                self.s.atomic_json(record,row);row=self.move(folder,row)
            self.trash_outputs(row)
            return row

    def delete_project(self,store,user,project,key,actor):
        path=store.path/self.d.name(user)/self.d.name(project);key=self.key(key);metadata={}
        if not (self.folders(self.base(path))/(key+'.json')).exists():
            store._project(user,project)
            rows,complete=finished_outputs(self.config)
            metadata={'outputJobs':[r['jobId'] for r in rows if (r['ownerId'],r['project'])==(user,project)],'outputsComplete':complete}
        return self.delete(path,key,'project',actor,project=project,userId=user,**metadata)

    def output_key(self,key,job):return str(uuid.uuid5(uuid.UUID(key),'output:'+job))

    def trash_outputs(self,row):
        if row['kind']!='project' or row['state']!='TRASHED':return
        root=self.d.root(self.config,'root')
        for job in row.get('outputJobs',[]):
            try:self.delete(root/'outputs'/job,self.output_key(row['key'],job),'output',row['actor'],
                            jobId=job,project=row['project'],userId=row['userId'],projectTrashKey=row['key'],retainUntil=row['retainUntil'])
            except FileNotFoundError:pass  # An output already removed separately has nothing left to move.

    def related_outputs(self,row):
        return [self.output_key(row['key'],job) for job in row.get('outputJobs',[])] if row['kind']=='project' else []

    def find(self,key):
        key=self.key(key)
        for base in self.roots:
            folder=self.folders(base)
            try:
                row=self.s.read_json(folder/(key+'.json'));row['key']=key;return folder,row
            except FileNotFoundError:continue
        raise FileNotFoundError('回收站条目不存在。')

    def listing(self,args=None):
        rows=[]
        for base in self.roots:
            folder=self.folders(base)
            if not folder.exists():continue
            for file in sorted(folder.glob('*.json')):
                try:row=self.s.read_json(file)
                except (ValueError,OSError):continue
                try:row['key']=self.key(file.stem)
                except ValueError:continue
                if row['state']=='MOVING':
                    with self.locked(folder,row['key']):row=self.move(folder,row)
                if row['state']=='TRASHED':rows.append(row)
        return {'items':rows}

    def restore(self,args):
        folder,row=self.find(args['key'])
        with self.locked(folder,row['key']):
            key=row['key'];row=self.s.read_json(folder/(key+'.json'));row['key']=key
            if row['state']!='RESTORED':
                if time.time()>row['retainUntil']:raise ValueError('已超过7天恢复期。')
                if row['state']=='MOVING':row=self.move(folder,row)
                self.trash_outputs(row)
                path=Path(row['originalPath']);self.base(path)
                with self.d.parent(folder.parent,str(path.relative_to(folder.parent)),create=True) as (fd,name):
                    try:os.stat(name,dir_fd=fd,follow_symlinks=False)
                    except FileNotFoundError:pass
                    else:raise ValueError('原位置已有同名内容，请先改名再恢复。')
                    source=self.d.open_directory(folder)
                    try:os.rename(row['key']+'.data',name,src_dir_fd=source,dst_dir_fd=fd);os.fsync(fd);os.fsync(source)
                    finally:os.close(source)
                row.update(state='RESTORED',restoredBy=args.get('actor'),restoredAt=time.time())
                self.s.atomic_json(folder/(row['key']+'.json'),row)
            for key in self.related_outputs(row):
                try:self.restore({**args,'key':key})
                except FileNotFoundError:pass
            return row

    def purge(self,args,automatic=False):
        if not automatic and not args.get('actor',{}).get('isAdmin'):raise ValueError('只有管理员可以立即清空回收站。')
        folder,row=self.find(args['key'])
        with self.locked(folder,row['key']):
            key=row['key'];row=self.s.read_json(folder/(key+'.json'));row['key']=key
            if row['state']=='RESTORED':return row
            if automatic and time.time()<row['retainUntil']:return row
            if row['state']=='MOVING':row=self.move(folder,row)
            self.trash_outputs(row)
            fd=self.d.open_directory(folder)
            try:
                name=row['key']+'.data'
                try:info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                except FileNotFoundError:info=None
                if info is not None:
                    if row['kind']=='project':
                        try:head=self.s.read_json(folder/name/'oci.json')
                        except FileNotFoundError:head={}
                        if head.get('container'):
                            owner=Path(row['originalPath']).parent.name
                            engine=module('personal-oci').PersonalOCI(self.config,owner)
                            # Remove the actual private container, not only its workspace files.
                            engine.run('rm','--force',head['container'])
                    # Python 3.10: anchor the symlink-safe traversal at the held data-directory FD.
                    if __import__('stat').S_ISDIR(info.st_mode):shutil.rmtree('/proc/self/fd/'+str(fd)+'/'+name)
                    else:os.unlink(name,dir_fd=fd)
                os.fsync(fd)
            finally:os.close(fd)
            row.update(state='PURGED',purgedBy=args.get('actor'),purgedAt=time.time())
            self.s.atomic_json(folder/(row['key']+'.json'),row)
            for key in self.related_outputs(row):
                try:self.purge({**args,'key':key},automatic=automatic)
                except FileNotFoundError:pass
            return row

    def collect(self):
        return [self.purge({'key':r['key']},automatic=True) for r in self.listing()['items'] if time.time()>=r['retainUntil']]


def orphan_outputs(ops,key):
    """One-time local command: preview first; never infer absence from partial lists."""
    trash=Trash(ops.config);key=trash.key(key);rows,complete=finished_outputs(ops.config)
    try:
        projects=ops.store.list(include_usage=True)
        present={(r.get('ownerId') or r.get('userId'),r['project']) for r in projects['projects']}
        complete=complete and projects['complete']
    except (OSError,ValueError,TypeError,KeyError,RecursionError):complete=False;present=set()
    items=[]
    if complete:
        for row in rows:
            if (row['ownerId'],row['project']) not in present:
                items.append({**row,'key':trash.output_key(key,row['jobId']),**trash.d.size(row['path'],partial=True)})
    result={'key':key,'complete':complete,'items':items,'state':'PREVIEW' if complete else 'SKIPPED'}
    if not complete:result['error']='任务记录或项目列表读取不完整，本次未移动任何输出；请修复读取问题后重试。'
    return result


def trash_orphan_outputs(config,preview,actor):
    if not preview['complete']:return preview
    trash=Trash(config)
    for row in preview['items']:
        trash.delete(row['path'],row['key'],'output',actor,jobId=row['jobId'],project=row['project'],userId=row['ownerId'])
    return {**preview,'state':'TRASHED'}
