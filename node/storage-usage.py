"""Disk usage from the root quota sample and the ID registry; requests never scan.

stargate-quota-sample.timer (root) writes samples/quota.json every minute.
The hourly collector only measures .trash and counts output folders.
"""
import importlib.util,os
from datetime import datetime,timezone
from pathlib import Path
ORDER=('project','images','dataset','platform','external','unassignedOutputs')


def module(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


def saved(path):
    try:return module('project-store').read_json(path)
    except (OSError,ValueError,TypeError,AttributeError,RecursionError):return None


class Sample:
    """One reading of samples/quota.json mapped through the registry."""
    def __init__(self,config):
        self.config=config;self.d=module('local-data');root=self.d.root(config,'root')
        self.quota=saved(root/'samples'/'quota.json')
        try:self.names={value:key for key,value in module('quota-ids').read(root/'quota')['ids'].items()}
        except (OSError,ValueError,TypeError,AttributeError):self.names={}
        self.disks=[];seen={}
        for mount in config.get('dataMountPoints') or []:
            try:device=os.stat(mount).st_dev
            except OSError:device=('missing',mount)
            if device in seen:continue
            seen[device]=mount;self.disks.append((str(mount),device))
        filesystems=(self.quota or {}).get('filesystems') if isinstance(self.quota,dict) else None
        self.filesystems={}
        for mount,_ in self.disks:
            row=next((fs for fs in filesystems or [] if isinstance(fs,dict) and mount in (fs.get('mountPoints') or [])),None)
            if row is not None and row.get('quota') is True and isinstance(row.get('ids'),dict):self.filesystems[mount]=row

    @property
    def checked(self):return self.quota.get('checkedAt') if isinstance(self.quota,dict) else None

    def mount(self,path):
        try:device=os.stat(path).st_dev
        except OSError:return None
        return next((mount for mount,value in self.disks if value==device),None)

    def bytes(self,mount):
        totals={}
        for raw,row in self.filesystems[mount]['ids'].items():
            if not str(raw).isdigit() or not isinstance(row,dict):continue
            key=self.names.get(int(raw)) if int(raw) else None
            totals[key]=totals.get(key,0)+int(row.get('bytes') or 0)
        return totals

    def size(self,key,path):
        """{'size','complete'} for one key on the disk holding `path`; None when quota does not cover it."""
        mount=self.mount(path)
        if mount not in self.filesystems:return None
        return {'size':self.bytes(mount).get(key,0),'complete':True}

    def items(self,mount,used):
        q=module('quota-ids');projects={};rows=[];untracked=0
        totals=self.bytes(mount)
        for key,value in totals.items():
            kind=q.describe(key) if key else None
            if kind is None:untracked+=value;continue
            if kind[0]=='project':
                row=projects.setdefault(kind[1:3],{'kind':'project','ownerId':kind[1],'project':kind[2],'files':0,'outputs':0,'environment':0})
                row[{'files':'files','outputs':'outputs','env':'environment'}[kind[3]]]+=value
            elif kind[0]=='images':rows.append({'kind':'images','ownerId':kind[1],'bytes':value})
            elif kind[0]=='dataset':rows.append({'kind':'dataset','name':kind[1],'bytes':value})
            elif kind[0]=='external':rows.append({'kind':'external','path':kind[1],'bytes':value})
            else:rows.append({'kind':kind[0],'bytes':value})
        rows+=[row for row in projects.values() if row['files'] or row['outputs'] or row['environment']]
        rows=[row for row in rows if row['kind']=='project' or row['bytes']]
        size=lambda row:row['files']+row['outputs']+row['environment'] if row['kind']=='project' else row['bytes']
        rows.sort(key=lambda row:(ORDER.index(row['kind']),-size(row)))
        return rows+[{'kind':'untracked','bytes':untracked},{'kind':'filesystem','bytes':used-sum(totals.values())}]


def roles(config,sample):
    result={}
    for role,field in (('workspace','workspacesRoot'),('datasets','datasetsRoot')):
        if config.get(field):
            mount=sample.mount(config[field])
            if mount is not None:result.setdefault(mount,[]).append(role)
    return result


def disks(config,sample,collected):
    d=module('local-data');result=[];assigned=roles(config,sample);trash=(collected or {}).get('trash') or {}
    for mount,_ in sample.disks:
        row={'mountPoint':mount,'totalBytes':None,'usedBytes':None,'availableBytes':None,'media':None,
             'roles':assigned.get(mount,[]),'accounting':'unavailable','items':[],'trashBytes':(trash.get(mount) or {}).get('size')}
        fs=sample.filesystems.get(mount)
        if fs is not None and all(type(fs.get(k)) is int for k in ('totalBytes','usedBytes','availableBytes')):
            row.update({k:fs[k] for k in ('totalBytes','usedBytes','availableBytes')},media=d.disk_media(mount),accounting='quota')
            row['items']=sample.items(mount,fs['usedBytes'])
        else:
            try:row.update({k:v for k,v in d.disk_usage(d.require_data_path(config,mount)).items() if k!='fs'})
            except (OSError,ValueError):pass
        result.append(row)
    return result


def cached(ops,result):
    """projects.list {includeUsage:true}: read the samples, O(IDs), no file walk."""
    q=module('quota-ids');sample=Sample(ops.config);collected=saved(ops.store.root/'samples'/'storage-usage.json')
    counts=(collected or {}).get('outputs') if isinstance(collected,dict) else None
    registered=set(sample.names.values())
    for row in result['projects']:
        owner=row.get('ownerId') or row.get('userId');project=row['project']
        # Unregistered files mean the project was never tagged: unknown, not zero.
        files=sample.size(q.files_key(owner,project),ops.store.path) if q.files_key(owner,project) in registered else None
        outputs=sample.size(q.outputs_key(owner,project),ops.store.root)
        environment=sample.size(q.env_key(owner,project),ops.store.path)
        row.update(files or {'size':None,'complete':False})
        count=counts.get(owner+'/'+project,0) if isinstance(counts,dict) else None
        row['outputs']={**(outputs or {'size':None,'complete':False}),'count':count}
        row['environment']=environment or {'size':None,'complete':False}
    return {**result,'disks':disks(ops.config,sample,collected),'checkedAt':sample.checked}


def output_counts(ops):
    """Finished-or-not output folders per project, from job records; never sizes."""
    s=module('project-store');root=ops.store.root;owners={};counts={}
    try:
        for file in (root/'jobs').iterdir():
            if file.suffix!='.json' or not s.JOB_ID.fullmatch(file.stem):continue
            try:job=s.read_json(file);owners[file.stem]=(job.get('ownerId') or job.get('userId'))+'/'+job['project']
            except (OSError,ValueError,TypeError,KeyError,AttributeError,RecursionError):continue
    except FileNotFoundError:pass
    try:
        with s.directory(root/'outputs') as fd,os.scandir(fd) as entries:
            for entry in entries:
                if entry.name in owners and entry.is_dir(follow_symlinks=False):counts[owners[entry.name]]=counts.get(owners[entry.name],0)+1
    except FileNotFoundError:pass
    return counts


def refresh(ops):
    """Hourly: .trash sizes per disk and output counts, written atomically."""
    s=module('project-store');data=s.data();sample=Sample(ops.config);trash={}
    roots=[ops.store.root,ops.store.path]
    try:roots.append(data.root(ops.config,'datasetsRoot'))
    except (OSError,ValueError):pass
    for base in roots:
        mount=sample.mount(base)
        if mount is None:continue
        try:(base/'.trash').lstat();value=data.size(base/'.trash',partial=True)
        except FileNotFoundError:value={'size':0,'complete':True}
        except OSError:value={'size':None,'complete':False}
        old=trash.get(mount,{'size':0,'complete':True})
        trash[mount]={'size':None if old['size'] is None or value['size'] is None else old['size']+value['size'],
                      'complete':old['complete'] and value['complete']}
    try:outputs=output_counts(ops)
    except OSError:outputs=None
    value={'checkedAt':datetime.now(timezone.utc).isoformat(),'trash':trash,'outputs':outputs}
    folder=s.private_dir(ops.store.root/'samples',create=True)
    s.atomic_json(folder/'storage-usage.json',value)
    (folder/'storage-areas.json').unlink(missing_ok=True)
    return value
