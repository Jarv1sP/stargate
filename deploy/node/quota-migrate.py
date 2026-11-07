#!/usr/bin/env python3
"""One-off project-ID migration, run by the maintainer as root after the data
disks have project quota enabled. Idempotent: rerunning reuses every ID.

    quota-migrate.py --config /etc/gpuq-console/node-install.json [--dry-run]

Order (design STOR-001 2.6): registry, platform, images + container layers,
projects, outputs, copy staging, datasets, trash entries, external
directories (last, skipping hard-linked inodes that already carry an ID).
Run it while no task, terminal or Git command is active: a directory tree that
is half tagged can refuse renames until it is finished. Paths all come from
the installer config. Reads that need the service account (podman) go through
runuser. It never sets a limit, moves data or deletes anything.
"""
import argparse,errno,importlib.util,json,os,pwd,stat,subprocess,sys
from pathlib import Path
CONTAINER_TYPE=('.trash','.copies','.copy-exports','.oci')
INSPECT=r'''
import importlib.util,json,subprocess,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('oci',sys.argv[1]);oci=importlib.util.module_from_spec(spec);spec.loader.exec_module(oci)
folder=Path(sys.argv[2]);env=oci.engine_environment(folder)
def run(*args):
    return subprocess.run(oci.engine_command({},folder,*args),env=env,capture_output=True,text=True,timeout=120,check=True).stdout
ids=run('ps','--all','--quiet','--no-trunc').split()
rows=json.loads(run('container','inspect',*ids)) if ids else []
print(json.dumps([{'name':(r.get('Name') or '').lstrip('/'),'labels':(r.get('Config') or {}).get('Labels') or {},
                   'upper':((r.get('GraphDriver') or {}).get('Data') or {}).get('UpperDir')} for r in rows]))
'''


def load(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


def record(path):
    """Platform JSON records read as root, never following a link."""
    try:fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except OSError:return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):return None
        with os.fdopen(os.dup(fd),'rb') as stream:value=json.load(stream)
        return value if isinstance(value,dict) else None
    except (OSError,ValueError):return None
    finally:os.close(fd)


def children(path,*,directories=True):
    """Real entries directly under `path` on the same device; never links."""
    try:device=os.stat(path).st_dev;names=sorted(os.listdir(path))
    except OSError:return []
    result=[]
    for name in names:
        try:info=os.lstat(Path(path)/name)
        except OSError:continue
        if info.st_dev!=device or stat.S_ISLNK(info.st_mode):continue
        if stat.S_ISDIR(info.st_mode) if directories else stat.S_ISREG(info.st_mode):result.append(Path(path)/name)
    return result


def identity(path):
    info=os.stat(path,follow_symlinks=False);return info.st_dev,info.st_ino


class Migration:
    def __init__(self,config,node_dir,out=print):
        self.config=config;self.out=out;self.q=load(Path(node_dir)/'quota-ids.py','quota_ids')
        self.sampler=load(Path(node_dir)/'quota-sample.py','quota_sample')
        self.account=pwd.getpwnam(config['account']);self.owner=(self.account.pw_uid,self.account.pw_gid)
        triples={tuple(profile[k] for k in ('root','workspacesRoot','datasetsRoot')) for profile in config['profiles'].values()}
        if len(triples)!=1:raise SystemExit('各 profile 的 root/workspacesRoot/datasetsRoot 不一致，本工具只处理相同路径。')
        root,workspaces,datasets=next(iter(triples))
        self.root,self.workspaces,self.datasets=Path(root),Path(workspaces),Path(datasets)
        self.release=Path(config['releaseRoot']);gpuq=config.get('gpuq') or {}
        self.platform_extra=[Path(gpuq[k]) for k in ('root','log_dir','control_dir') if gpuq.get(k)]
        if gpuq.get('db_path'):self.platform_extra.append(Path(gpuq['db_path']).parent)
        self.mounts=[];seen=set()
        for mount in config['dataMountPoints']:
            try:device=os.stat(mount).st_dev
            except OSError:continue
            if device not in seen:seen.add(device);self.mounts.append(Path(mount))
        self.plan=[];self.keys={};self.notes=[];self.totals={}

    # -- inventory (read-only) -------------------------------------------------
    def add(self,phase,key,path,kind='tree',**extra):
        self.plan.append(dict(phase=phase,key=key,path=Path(path),kind=kind,**extra))

    def protected(self):
        """Container-type roots and every ancestor up to a data mount: never inherit."""
        result=set();platform=[self.release,*self.platform_extra]
        inside=lambda item:any(item==p or p in item.parents for p in platform)
        for path in (self.root,self.workspaces,self.datasets,*platform,*self.mounts):
            for item in (path,*path.parents):
                # Release and scheduler folders are platform data (a:platform), only their ancestors are containers.
                if item not in self.mounts and path in platform and inside(item):continue
                try:result.add(identity(item))
                except OSError:pass
                if item in self.mounts:break
        for base in (self.root,self.workspaces,self.datasets):
            for name in ('.trash','outputs') if base==self.root else ('.trash',) if base==self.datasets else CONTAINER_TYPE:
                try:result.add(identity(base/name))
                except OSError:pass
        for owner in children(self.workspaces):
            if not owner.name.startswith('.'):result.add(identity(owner))
        return result

    def job_owner(self,job):
        row=record(self.root/'jobs'/(job+'.json'))
        if row and isinstance(row.get('project'),str) and (row.get('ownerId') or row.get('userId')):
            return row.get('ownerId') or row.get('userId'),row['project']
        return None

    def inventory(self):
        q=self.q;self.protect=self.protected()
        self.add('2 平台运行数据',q.PLATFORM,self.root/'quota')
        for path in children(self.root):
            if path.name not in ('outputs','.trash','quota') and identity(path) not in self.protect:self.add('2 平台运行数据',q.PLATFORM,path)
        for path in children(self.root,directories=False):self.add('2 平台运行数据',q.PLATFORM,path,'file')
        for path in (self.release,*self.platform_extra):
            if path.is_dir() and not path.is_symlink():self.add('2 平台运行数据',q.PLATFORM,path)
        projects=[]
        for owner in children(self.workspaces):
            if owner.name.startswith('.'):continue
            for project in children(owner):
                if not project.name.startswith('.') and (project/'project.json').is_file():projects.append((owner.name,project.name,project))
        layers={}
        for engine in children(self.workspaces/'.oci'):
            if engine.name.startswith('.'):continue
            self.add('3 镜像与容器引擎',q.images_key(engine.name),engine)
            for container in self.containers(engine):
                project=self.container_project(engine.name,container,projects)
                upper=container.get('upper')
                if project and upper and Path(upper).parent.parent.parent==engine/'graph':
                    layers[str(Path(upper).parent)]=(engine.name,project)
        for layer,(owner,project) in sorted(layers.items()):
            self.add('3 容器层',q.env_key(owner,project),layer,'layer',images=q.images_key(owner))
        for owner,project,path in projects:self.add('4 项目文件',q.files_key(owner,project),path)
        for path in children(self.root/'outputs'):
            found=self.job_owner(path.name)
            self.add('5 任务输出',q.outputs_key(*found) if found else q.UNASSIGNED,path)
        for path in children(self.workspaces/'.copies'):
            row=record(path/'project.json') or (record(self.root/'transfers'/(path.name+'.json')) or {}).get('target') or {}
            self.add('6 复制暂存',self.project_key(row),path)
        for path in children(self.workspaces/'.copy-exports'):
            row=((record(self.root/'transfers'/(path.name+'.source.json')) or {}).get('request') or {}).get('source') or {}
            self.add('6 复制暂存',self.project_key(row),path)
        for path in children(self.datasets):
            if not path.name.startswith('.'):self.add('7 数据集',q.dataset_key(path.name),path)
        for base in (self.datasets,self.workspaces,self.root):
            for file in sorted((base/'.trash').glob('*.json')) if (base/'.trash').is_dir() else []:
                row=record(file);payload=base/'.trash'/(file.stem+'.data')
                if not row or not os.path.lexists(payload) or row.get('state')!='TRASHED':continue
                key=self.trash_key(row)
                if key is None:self.notes.append(f'回收站条目无法判断归属，保持编号 0：{payload}（{row.get("originalPath")}）');continue
                self.add('8 回收站',key,payload,'tree' if payload.is_dir() and not payload.is_symlink() else 'file')
        self.external()

    def project_key(self,row):
        owner=row.get('ownerId') or row.get('userId');project=row.get('project')
        return self.q.files_key(owner,project) if isinstance(owner,str) and isinstance(project,str) else self.q.PLATFORM

    def trash_key(self,row):
        q=self.q;path=Path(row.get('originalPath') or '/')
        if row.get('kind')=='output' and row.get('jobId'):
            found=self.job_owner(row['jobId'])
            if found:return q.outputs_key(*found)
            if row.get('userId') and row.get('project'):return q.outputs_key(row['userId'],row['project'])
            return q.UNASSIGNED
        for base,make in ((self.workspaces,lambda p:q.files_key(p[0],p[1]) if len(p)>=2 and not p[0].startswith('.') else None),
                          (self.datasets,lambda p:q.dataset_key(p[0]) if p and not p[0].startswith('.') else None),
                          (self.root/'outputs',lambda p:(q.outputs_key(*self.job_owner(p[0])) if self.job_owner(p[0]) else q.UNASSIGNED) if p else None)):
            if base in path.parents:return make(path.relative_to(base).parts)
        return None

    def containers(self,engine):
        if not (engine/'graph').is_dir():return []
        program=self.release/'current'/'node'/'personal-oci.py'
        command=['/usr/sbin/runuser','-u',self.account.pw_name,'--','/usr/bin/env','HOME='+self.account.pw_dir,
                 'XDG_RUNTIME_DIR=/run/user/'+str(self.owner[0]),'PATH=/usr/bin:/bin',
                 '/usr/bin/python3','-I','-B','-c',INSPECT,str(program),str(engine)]
        try:
            result=subprocess.run(command,capture_output=True,text=True,timeout=300)
            if result.returncode:raise OSError(result.stderr.strip()[-300:])
            return json.loads(result.stdout)
        except (OSError,ValueError,subprocess.TimeoutExpired) as error:
            self.notes.append(f'读不到 {engine.name} 的容器列表，容器层暂记在镜像：{error}');return []

    def container_project(self,owner,container,projects):
        label=(container.get('labels') or {}).get('io.gpuq.project')
        names={(record(path/'oci.json') or {}).get('container'):project for o,project,path in projects if o==owner}
        if container.get('name') in names:return names[container['name']]
        if isinstance(label,str) and label.startswith('copy-'):
            return (record(self.workspaces/'.copies'/label.removeprefix('copy-')/'project.json') or {}).get('project')
        if label in {project for o,project,_ in projects if o==owner}:return label
        return None

    def external(self):
        """Data-disk directories outside every platform root, from the config only."""
        roots=set()
        for path in (self.root,self.workspaces,self.datasets,self.release,*self.platform_extra):
            try:roots.add(identity(path))
            except OSError:pass
        ancestors=set()
        for path in (self.root,self.workspaces,self.datasets,self.release,*self.platform_extra):
            for item in path.parents:
                try:ancestors.add(identity(item))
                except OSError:pass
        pending=list(self.mounts)
        while pending:
            folder=pending.pop(0)
            for path in [*children(folder),*children(folder,directories=False)]:
                if path.name=='lost+found' and folder in self.mounts:continue
                key=identity(path)
                if key in roots:continue
                if key in ancestors:pending.append(path);continue
                self.add('9 外部目录',self.q.external_key(path),path,'tree' if path.is_dir() else 'file',linked=True)

    # -- report and execution ----------------------------------------------------
    def report_plan(self):
        registry=self.q.read(self.root/'quota')['ids'];new=sorted({row['key'] for row in self.plan}-set(registry))
        phases={}
        for row in self.plan:phases.setdefault(row['phase'],[]).append(row)
        self.out(f'登记表 {self.root/"quota"/"ids.json"}：已有 {len(registry)} 个编号，本次新增 {len(new)} 个')
        for phase in sorted(phases):
            rows=phases[phase];self.out(f'{phase}：{len(rows)} 处，{len({r["key"] for r in rows})} 个编号')
            if phase.startswith(('9','6','8')) or len(rows)<=12:
                for row in rows:self.out(f'    {row["path"]} -> {row["key"]}')
        for line in self.notes:self.out('  注意：'+line)
        self.usage('当前')

    def usage(self,label):
        try:info=Path('/proc/self/mountinfo').read_text()
        except OSError:info=''
        rows=self.sampler.filesystems([str(m) for m in self.mounts],info)
        for row in rows:
            if not row.get('quota'):
                self.out(f'{label} {row["mountPoints"][0]}：未开启项目配额（{row.get("error")}），用量未知');continue
            untracked=row['ids'].get('0',{}).get('bytes',0)
            self.out(f'{label} {row["mountPoints"][0]}：已用 {row["usedBytes"]:,} 字节，未登记（编号 0）{untracked:,} 字节，编号 {len(row["ids"])} 个')

    def ensure_registry(self):
        folder=self.root/'quota'
        try:
            os.mkdir(folder,0o700);os.chown(folder,*self.owner)
        except FileExistsError:pass
        return folder

    def run(self,dry_run):
        self.inventory();self.report_plan()
        if dry_run:self.out('仅打印计划（--dry-run），未改动。');return 0
        try:os.nice(19);subprocess.run(['/usr/bin/ionice','-c3','-p',str(os.getpid())],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        except OSError:pass
        folder=self.ensure_registry()
        ids=self.q.allocate(folder,[row['key'] for row in self.plan]+[row['images'] for row in self.plan if row['kind']=='layer'])
        protected=self.protect;layers={identity(row['path']) for row in self.plan if row['kind']=='layer'}
        counts={}
        for row in self.plan:
            total=counts.setdefault(row['phase'],self.q.counter())
            try:
                if row['kind']=='layer':self.merge(total,self.q.tag_layer(row['path'],ids[row['key']],ids[row['images']]))
                elif row['kind']=='file':self.tag_file(row['path'],ids[row['key']],total,linked=row.get('linked'))
                else:
                    if identity(row['path']) in protected:
                        self.q.tag_tree(row['path'],ids[row['key']],top=False,prune=protected|layers,linked=row.get('linked',False),counts=total)
                    else:self.q.tag_tree(row['path'],ids[row['key']],prune=protected|layers,linked=row.get('linked',False),counts=total)
            except OSError as error:self.q.failed(total,error);self.notes.append(f'{row["path"]}：{error}')
        for phase in sorted(counts):
            c=counts[phase]
            self.out(f'{phase}：目录 {c["directories"]}，文件 {c["files"]}，跳过 {c["skipped"]}，'
                     f'硬链接且已有编号而跳过 {c["linked"]}，错误 {sum(c["errors"].values())} {c["errors"] or ""}')
        for line in self.notes:self.out('  注意：'+line)
        self.usage('完成后')
        self.leftovers(protected)
        return 0

    @staticmethod
    def merge(total,counts):
        for key in ('directories','files','skipped','linked'):total[key]+=counts[key]
        for key,value in counts['errors'].items():total['errors'][key]=total['errors'].get(key,0)+value

    def tag_file(self,path,value,total,linked=False):
        fd=os.open(path,self.q.FILE_FLAGS)
        try:
            if linked and os.fstat(fd).st_nlink>1 and self.q.projid(fd) not in (0,value):total['linked']+=1
            else:self.q.setx(fd,value);total['files']+=1
        finally:os.close(fd)

    def leftovers(self,protected,limit=20):
        """Largest directory trees still on ID 0; container-type folders are walked, not listed."""
        sizes={}
        for mount in self.mounts:
            device=os.stat(mount).st_dev;roots={}
            for top,dirs,files,fd in os.fwalk(mount,follow_symlinks=False):
                info=os.fstat(fd)
                try:value=self.q.projid(fd)
                except OSError:value=0
                if (info.st_dev,info.st_ino) in protected:root=None
                elif value:dirs[:]=[];continue
                else:root=roots.get(os.path.dirname(top)) or top
                roots[top]=root;kept=[]
                for name in dirs:
                    try:
                        if os.stat(name,dir_fd=fd,follow_symlinks=False).st_dev==device:kept.append(name)
                    except OSError:pass
                dirs[:]=kept
                if root is None:continue
                for name in files:
                    try:child=os.stat(name,dir_fd=fd,follow_symlinks=False)
                    except OSError:continue
                    if stat.S_ISREG(child.st_mode):sizes[root]=sizes.get(root,0)+child.st_blocks*512
        rows=sorted(sizes.items(),key=lambda row:-row[1])[:limit]
        self.out(f'仍为编号 0 的最大目录（前 {limit}，按块计）：' if rows else '没有仍为编号 0 的目录。')
        for path,size in rows:self.out(f'    {size:>18,}  {path}')


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--config',required=True,type=Path,help='node-install.json written for deploy/node/install.py')
    parser.add_argument('--dry-run',action='store_true',help='print the plan and current usage only')
    parser.add_argument('--node-dir',type=Path,default=Path('/usr/local/libexec/stargate'),
                        help='root-owned quota-ids.py / quota-sample.py (installed by the node installer)')
    args=parser.parse_args(argv)
    if os.geteuid()!=0:raise SystemExit('请用 root 运行：打标需要改动容器用户的文件。')
    os.umask(0o077)
    return Migration(json.loads(args.config.read_text()),args.node_dir).run(args.dry_run)


if __name__=='__main__':
    raise SystemExit(main())
