#!/usr/bin/env python3
"""One-off project-ID migration, run by the maintainer as root after the data
disks have project quota enabled. Idempotent: rerunning reuses every ID.

    quota-migrate.py --config /etc/gpuq-console/node-install.json [--dry-run] [--only platform|datasets|external]

Platform migration runs without tasks, terminals or Git commands. It scans live
overlays once, prunes mounted layers, and withholds the completion marker until
all platform rows finish. Datasets and their trash entries may run online; each
row is registered just before tagging. External trees get IDs without inheritance.
Datasets may reclaim hardlinked inodes from external IDs, preserving other owners.
All paths come from installer config; podman reads run as the service account.
No limits or data relocation; special inodes are rebuilt in place, and abandoned
special temporaries / root-owned staging are cleaned only in platform/dataset trees.
"""
import argparse,contextlib,errno,importlib.util,json,os,pwd,re,signal,stat,subprocess,sys,uuid
from datetime import datetime,timezone
from pathlib import Path
CONTAINER_TYPE=('.trash','.copies','.copy-exports','.oci')
INSPECT=r'''
import importlib.util,json,subprocess,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('oci',sys.argv[1]);oci=importlib.util.module_from_spec(spec);spec.loader.exec_module(oci)
folder=Path(sys.argv[2]);env=oci.engine_environment(folder)
# Same reboot cleanup the platform does on next use; skipped by --dry-run.
if sys.argv[3]=='heal':oci.recover_runtime(folder)
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
    def __init__(self,config,node_dir,out=print,only=None):
        self.config=config;self.out=out;self.only=only;self.dry_run=True;self.list_failures=0;self.q=load(Path(node_dir).resolve(strict=True)/'quota-ids.py','quota_ids')
        self.sampler=load(Path(node_dir).resolve(strict=True)/'quota-sample.py','quota_sample')
        self.account=pwd.getpwnam(config['account']);self.owner=(self.account.pw_uid,self.account.pw_gid)
        triples={tuple(str(Path(profile[k]).resolve(strict=True)) for k in ('root','workspacesRoot','datasetsRoot')) for profile in config['profiles'].values()}
        if len(triples)!=1:raise SystemExit('各 profile 的 root/workspacesRoot/datasetsRoot 不一致，本工具只处理相同路径。')
        root,workspaces,datasets=next(iter(triples))
        self.root,self.workspaces,self.datasets=Path(root),Path(workspaces),Path(datasets)
        self.release=Path(config['releaseRoot']).resolve(strict=True);gpuq=config.get('gpuq') or {}
        self.platform_extra=[Path(gpuq[k]).resolve(strict=True) for k in ('root','log_dir','control_dir') if gpuq.get(k)]
        if gpuq.get('db_path'):self.platform_extra.append(Path(gpuq['db_path']).resolve(strict=True).parent)
        self.mounts=[];seen=set()
        for mount in config['dataMountPoints']:
            mount=Path(mount).resolve(strict=True)
            device=os.stat(mount).st_dev
            if device not in seen:seen.add(device);self.mounts.append(Path(mount))
        self.plan=[];self.keys={};self.notes=[];self.totals={};self.proc=Path('/proc')

    # -- inventory (read-only) -------------------------------------------------
    def add(self,phase,key,path,kind='tree',group=None,**extra):
        group=group or ('datasets' if phase.startswith('7') else 'external' if phase.startswith('9') else 'platform')
        if key.startswith('d:'):group='datasets';extra['linked']=True
        if self.only is not None and group!=self.only:return
        self.plan.append(dict(group=group,phase=phase,key=key,path=Path(path),kind=kind,**extra))

    def protected(self):
        """Container-type roots and every ancestor up to a data mount: never inherit."""
        result=set();platform=(self.release,*self.platform_extra)
        for path in (self.root,self.workspaces,self.datasets,*self.mounts):
            for item in (path,*path.parents):
                try:result.add(identity(item))
                except OSError:pass
                if item in self.mounts:break
        for path in platform:
            for item in path.parents:
                if not any(item==p or p in item.parents for p in platform):
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
        for engine in children(self.workspaces/'.oci') if self.only in (None,'platform') else []:
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
            if not path.name.startswith('.'):self.add('7 数据集',q.dataset_key(path.name),path,linked=True)
        for base in (self.datasets,self.workspaces,self.root):
            for file in sorted((base/'.trash').glob('*.json')) if (base/'.trash').is_dir() else []:
                row=record(file);payload=base/'.trash'/(file.stem+'.data')
                if not row or not os.path.lexists(payload) or row.get('state')!='TRASHED':continue
                key=self.trash_key(row)
                if key is None:self.notes.append(f'回收站条目无法判断归属，保持编号 0：{payload}（{row.get("originalPath")}）');continue
                self.add('8 回收站',key,payload,'tree' if payload.is_dir() and not payload.is_symlink() else 'file',
                         group='datasets' if base==self.datasets else 'platform',linked=base==self.datasets)
        self.external()
        for row in self.plan:
            if row['kind']=='tree' and row['group']!='external' and row['path'].exists() and identity(row['path']) in self.protect:
                raise SystemExit(f'迁移计划会给受保护的根目录设置继承：{row["path"]}。请调整安装配置后重试。')

    def project_key(self,row):
        owner=row.get('ownerId') or row.get('userId');project=row.get('project')
        return self.q.files_key(owner,project) if isinstance(owner,str) and isinstance(project,str) else self.q.PLATFORM

    def trash_key(self,row):
        q=self.q;raw=row.get('originalPath') or '/'
        try:path=Path(raw).resolve()
        except (OSError,RuntimeError):path=Path(os.path.normpath(raw))  # a user's link loop at the old path
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
                 '/usr/bin/python3','-I','-B','-c',INSPECT,str(program),str(engine),'read' if self.dry_run else 'heal']
        try:
            result=subprocess.run(command,capture_output=True,text=True,timeout=300)
            if result.returncode:raise OSError(result.stderr.strip()[-300:])
            return json.loads(result.stdout)
        except (OSError,ValueError,subprocess.TimeoutExpired) as error:
            self.list_failures+=1
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

    def active_overlays(self):
        """Read each service-account mount namespace once, excluding init's."""
        init=os.stat(self.proc/'1/ns/mnt').st_ino;seen={init};overlays=[]
        def decode(value):return re.sub(r'\\([0-7]{3})',lambda match:chr(int(match[1],8)),value)
        for process in self.proc.iterdir():
            if not process.name.isdigit():continue
            try:
                uid=next((line.split()[1] for line in (process/'status').read_text().splitlines() if line.startswith('Uid:')),None)
                if uid is None or int(uid)!=self.owner[0]:continue
                namespace=os.stat(process/'ns/mnt').st_ino
                if namespace in seen:continue
                text=(process/'mountinfo').read_text();seen.add(namespace)
            except OSError as error:
                if error.errno in (errno.ENOENT,errno.ESRCH,errno.EINVAL):continue
                raise
            for line in text.splitlines():
                head,_,tail=line.partition(' - ');fields=tail.split();mount=head.split()
                if len(fields)<3 or len(mount)<5 or fields[0]!='overlay':continue
                upper=next((decode(option[9:]) for option in fields[2].split(',') if option.startswith('upperdir=')),None)
                overlays.append((upper,decode(mount[4])))
        return overlays

    @staticmethod
    def layer_mounted(layer,overlays):
        layer=Path(layer)
        for upper,mount in overlays:
            if os.path.normpath(mount)==str(layer/'merged'):return True
            if upper is not None:
                path=Path(upper)
                if not path.is_absolute():path=layer.parent/path
                if os.path.normpath(path)==str(layer/'diff'):return True
        return False

    def mounted_layers(self):
        overlays=self.active_overlays();candidates={row['path'] for row in self.plan if row['kind']=='layer'}
        for row in self.plan:
            if row['phase']=='3 镜像与容器引擎':candidates.update(children(row['path']/'graph'/'overlay'))
        return {path for path in candidates if self.layer_mounted(path,overlays)}

    def cleanup_trash(self,counts):
        for group,bases in (('platform',(self.root,self.workspaces)),('datasets',(self.datasets,))):
            if self.only is not None and group!=self.only:continue
            for base in bases:
                try:fd=os.open(base/'.trash',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                except FileNotFoundError:continue
                except OSError as error:
                    self.q.failed(counts.setdefault((group,'1 中断残留'),self.q.counter()),error);continue
                try:
                    total=self.q.counter();self.q.cleanup_temporary(fd,total,staging=True)
                    if total['cleaned'] or total['errors']:
                        self.merge(counts.setdefault((group,'1 中断残留'),self.q.counter()),total)
                finally:os.close(fd)

    # -- report and execution ----------------------------------------------------
    def report_plan(self):
        registry=self.q.read(self.root/'quota')['ids'];new=sorted({row['key'] for row in self.plan}-set(registry))
        phases={}
        for row in self.plan:phases.setdefault((row['group'],row['phase']),[]).append(row)
        self.out(f'登记表 {self.root/"quota"/"ids.json"}：已有 {len(registry)} 个编号，本次新增 {len(new)} 个')
        for group,phase in sorted(phases,key=lambda key:(('platform','datasets','external').index(key[0]),key[1])):
            rows=phases[group,phase];self.out(f'[{rows[0]["group"]}] {phase}：{len(rows)} 处，{len({r["key"] for r in rows})} 个编号')
            if phase.startswith(('9','6','8')) or len(rows)<=12:
                for row in rows:self.out(f'    {row["path"]} -> {row["key"]}')
        if any(r['group']=='external' for r in self.plan):self.out('外部目录整棵树只设编号、不设继承；之后新建的文件计入未登记。')
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
            os.mkdir(folder,0o700);os.chown(folder,*self.owner,follow_symlinks=False)
        except FileExistsError:pass
        return folder

    def run(self,dry_run):
        self.dry_run=dry_run
        self.inventory();self.report_plan()
        for group in ((self.only,) if self.only else ('platform','datasets','external')):
            if not any(row['group']==group for row in self.plan):self.out(f'[{group}] 无条目')
        if dry_run:self.out('仅打印计划（--dry-run），未改动。');return 0
        try:os.nice(19);subprocess.run(['/usr/bin/ionice','-c3','-p',str(os.getpid())],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        except OSError:pass
        folder=self.ensure_registry()
        ids=self.q.allocate(folder,[row['key'] for row in self.plan if row['group']=='platform']+
                            [row['images'] for row in self.plan if row['kind']=='layer'])
        protected=self.protect;layers=set();counts={}
        self.cleanup_trash(counts)
        mounted=set();scan_failed=False
        if self.only in (None,'platform'):
            try:mounted=self.mounted_layers()
            except OSError as error:
                scan_failed=True;self.q.failed(counts.setdefault(('platform','3 容器层'),self.q.counter()),error)
                self.notes.append(f'读不到活 overlay 挂载，暂不处理引擎与容器层：{error}')
            if mounted:counts.setdefault(('platform','3 容器层'),self.q.counter())['mounted']=len(mounted)
            for path in sorted(mounted):
                self.notes.append(f'容器层仍有活 overlay，跳过；请停止服务账户的 podman 后重跑：{path}')
                try:layers.add(identity(path))
                except FileNotFoundError:pass
        for row in self.plan:
            if row['kind']!='layer':continue
            try:layers.add(identity(row['path']))
            except FileNotFoundError:
                row['missing']=True
                counts.setdefault((row['group'],row['phase']),self.q.counter())['skipped']+=1
                self.notes.append(f'容器层已消失，跳过：{row["path"]}')
        for row in self.plan:
            if row.get('missing') or row['path'] in mounted:continue
            if scan_failed and (row['kind']=='layer' or row['phase']=='3 镜像与容器引擎'):continue
            total=counts.setdefault((row['group'],row['phase']),self.q.counter())
            try:
                if row['group']!='platform':ids.update(self.q.allocate(folder,[row['key']]))
                linked=row.get('linked',False)
                reclaim={value for key,value in self.q.read(folder)['ids'].items() if key.startswith('x:')} if row['group']=='datasets' else set()
                moved=total['moved']
                if row['kind']=='layer':
                    self.merge(total,self.q.tag_layer(row['path'],ids[row['key']],ids[row['images']],rebuild=True,cleanup=True))
                elif row['kind']=='file':self.tag_file(row['path'],ids[row['key']],total,linked=linked,reclaim=reclaim)
                else:
                    self.q.tag_tree(row['path'],ids[row['key']],prune=protected|layers,
                                    linked=linked,reclaim=reclaim,counts=total,
                                    inherit=row['group']!='external',rebuild=row['group']!='external',cleanup=row['group']!='external')
                if total['moved']>moved:
                    self.notes.append(f'目录在打标时被改名或移走（也可能已删除），需重跑 --only {row["group"]}：{row["path"]}')
            except OSError as error:
                if row['kind']=='layer' and error.errno==errno.ENOENT:total['skipped']+=1
                else:self.q.failed(total,error)
                self.notes.append(f'{row["path"]}：{error}')
        if self.list_failures:  # environments would read as complete zeros: withhold the marker, rerun later
            counts.setdefault(('platform','3 容器层'),self.q.counter())['errors']['LIST']=self.list_failures
        for group,phase in sorted(counts,key=lambda key:(('platform','datasets','external').index(key[0]),key[1])):
            c=counts[group,phase]
            self.out(f'[{group}] {phase}：目录 {c["directories"]}，文件 {c["files"]}，跳过 {c["skipped"]}，'
                     f'重建符号链接 {c["symlinks"]}，whiteout {c["whiteouts"]}，FIFO {c["fifos"]}，socket 保留 {c["sockets"]}，'
                     f'目录改名/移走待重跑 {c["moved"]}，清理中断残留 {c["cleaned"]}，活 overlay 层跳过 {c["mounted"]}，原项已变化而跳过 {c["changed"]}，硬链接跳过 {c["linked"]}，错误 {sum(c["errors"].values())} {c["errors"] or ""}')
        for line in self.notes:self.out('  注意：'+line)
        if self.only in (None,'platform') and not any(c['errors'] or c['mounted'] or c['changed'] or c['moved'] for (group,phase),c in counts.items() if group=='platform'):
            self.mark_migrated(folder)
        self.usage('完成后')
        self.leftovers(protected)
        return 0

    @staticmethod
    def merge(total,counts):
        for key in ('directories','files','skipped','linked','symlinks','whiteouts','fifos','sockets','changed','cleaned','mounted','moved'):total[key]+=counts[key]
        for key,value in counts['errors'].items():total['errors'][key]=total['errors'].get(key,0)+value

    def tag_file(self,path,value,total,linked=False,reclaim=()):
        info=os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            if stat.S_ISSOCK(info.st_mode):total['sockets']+=1;return
            parent=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:self.q.rebuild_staged(path.name,parent,value,total)
            finally:os.close(parent)
            return
        fd=os.open(path,self.q.FILE_FLAGS)
        try:
            if linked and os.fstat(fd).st_nlink>1 and self.q.projid(fd) not in {0,*reclaim}:total['linked']+=1
            else:self.q.setx(fd,value);total['files']+=1
        finally:os.close(fd)

    def mark_migrated(self,folder):
        # Same descriptor-relative, service-owned atomic publication as the registry.
        fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        temporary='.migrated-'+uuid.uuid4().hex
        try:
            child=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
            try:
                os.fchown(child,*self.owner)
                os.write(child,json.dumps({'checkedAt':datetime.now(timezone.utc).isoformat()}).encode());os.fsync(child)
            finally:os.close(child)
            os.replace(temporary,'migrated.json',src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd)
        finally:
            with contextlib.suppress(FileNotFoundError):os.unlink(temporary,dir_fd=fd)
            os.close(fd)

    def leftovers(self,protected,limit=20):
        """Largest ID-0 trees and registered project/dataset trees without inherit."""
        registry=self.q.read(self.root/'quota')['ids']
        inheriting={value:key for key,value in registry.items() if key.startswith(('d:','p:'))}
        sizes={};incomplete={}
        for mount in self.mounts:
            device=os.stat(mount).st_dev;roots={}
            rootfd=os.open(mount,self.q.DIR_FLAGS)
            walker=self.q.walk_dirs(rootfd,str(mount),onerror=lambda error:self.out(f'余留目录诊断跳过无法读取的目录：{error}'))
            try:
                for top,dirs,files,fd in walker:
                    info=os.fstat(fd)
                    try:flags,_,_,value,_=self.q.getx(fd)
                    except OSError:flags=value=0
                    if (info.st_dev,info.st_ino) in protected:root=None
                    elif value in inheriting:
                        # Traverse tagged ancestors too: a pending child can have moved here.
                        root=None if flags&self.q.FS_XFLAG_PROJINHERIT else top
                        if root is not None:incomplete[root]=inheriting[value];sizes.setdefault(root,0)
                    elif value:dirs.clear();continue
                    else:root=roots.get(os.path.dirname(top)) or top
                    roots[top]=root;kept={}
                    for name in dirs:
                        try:
                            if os.stat(name,dir_fd=fd,follow_symlinks=False).st_dev==device:kept[name]=dirs[name]
                        except OSError:pass
                    dirs.clear();dirs.update(kept)
                    if root is None:continue
                    for name in files:
                        try:child=os.stat(name,dir_fd=fd,follow_symlinks=False)
                        except OSError:continue
                        if stat.S_ISREG(child.st_mode):sizes[root]=sizes.get(root,0)+child.st_blocks*512
            finally:
                try:walker.close()
                finally:os.close(rootfd)
        rows=sorted(sizes.items(),key=lambda row:-row[1])[:limit]
        self.out(f'仍为编号 0 或未完成继承的最大目录（前 {limit}，按块计）：' if rows else '没有仍为编号 0 或未完成继承的目录。')
        for path,size in rows:
            key=incomplete.get(path);group='datasets' if key and key.startswith('d:') else 'platform'
            note=f'（未完成继承，需重跑 --only {group}）' if key else ''
            self.out(f'    {size:>18,}  {path}{note}')


def terminate(signum,frame):raise SystemExit(128+signum)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--config',required=True,type=Path,help='node-install.json written for deploy/node/install.py')
    parser.add_argument('--only',choices=('platform','datasets','external'),help='migrate one group; default: all groups')
    parser.add_argument('--dry-run',action='store_true',help='print the plan and current usage only')
    parser.add_argument('--node-dir',type=Path,default=Path('/usr/local/libexec/stargate'),
                        help='root-owned quota-ids.py / quota-sample.py (installed by the node installer)')
    args=parser.parse_args(argv)
    if os.geteuid()!=0:raise SystemExit('请用 root 运行：打标需要改动容器用户的文件。')
    os.umask(0o077)
    for signum in (signal.SIGTERM,signal.SIGHUP):signal.signal(signum,terminate)
    return Migration(json.loads(args.config.resolve(strict=True).read_text()),args.node_dir,only=args.only).run(args.dry_run)


if __name__=='__main__':
    raise SystemExit(main())
