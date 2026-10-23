"""Hourly disk accounting; project requests only read the atomic sample."""
import importlib.util,os,stat,subprocess
from datetime import datetime,timezone
from pathlib import Path
AREAS=('outputs','environments','trash','temporary')


def module(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


def total(rows):
    rows=list(rows);sizes=[row['size'] for row in rows if row['size'] is not None]
    return {'size':sum(sizes) if sizes or not rows else None,'complete':all(row['complete'] for row in rows)}


def measured(data,path):
    try:path.lstat()
    except FileNotFoundError:return {'size':0,'complete':True}
    except OSError:return {'size':None,'complete':False}
    return data.size(path,partial=True)


def cached(ops,result):
    try:
        saved=module('project-store').read_json(ops.store.root/'samples'/'storage-areas.json')
        areas={name:dict(saved['areas'][name]) for name in AREAS};checked=saved['checkedAt']
        projects={(row['ownerId'],row['project']):row for row in saved['projects']}
    except (OSError,ValueError,TypeError,KeyError,AttributeError,RecursionError):
        areas={name:{'size':None,'complete':False} for name in AREAS};checked=None;projects={}
    for row in result['projects']:
        sample=projects.get((row.get('ownerId') or row.get('userId'),row['project']),{})
        row.update(size=sample.get('size'),complete=sample.get('complete',False),
                   outputs=sample.get('outputs',{'size':None,'complete':False,'count':None}))
    return {**result,'areas':areas,'areasCheckedAt':checked}


def refresh(ops):
    result=ops.store.list(include_usage=True);s=module('project-store');data=s.data()
    for row in result['projects']:
        row.update(data.size(ops.store.path/(row.get('ownerId') or row['userId'])/row['project'],partial=True))
    result=scan(ops,result)
    saved={'checkedAt':datetime.now(timezone.utc).isoformat(),'areas':result['areas'],
           'projects':[{key:row.get(key) for key in ('ownerId','project','size','complete','outputs')} for row in result['projects']]}
    folder=s.private_dir(ops.store.root/'samples',create=True)
    s.atomic_json(folder/'storage-areas.json',saved)
    return saved


def scan(ops,result):
    store=ops.store;s=module('project-store');data=s.data();root=store.root
    outputs={};records_complete=True
    try:
        for file in (root/'jobs').iterdir():
            if file.suffix!='.json' or not s.JOB_ID.fullmatch(file.stem):continue
            try:
                job=s.read_json(file)
                outputs[file.stem]=(job.get('ownerId') or job.get('userId'),job.get('project'))
            except (OSError,ValueError,AttributeError,RecursionError):records_complete=False
    except FileNotFoundError:pass
    except OSError:records_complete=False
    by_project={};all_outputs=[]
    try:
        with s.directory(root/'outputs') as fd,os.scandir(fd) as entries:
            for entry in entries:
                try:
                    info=entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):row=measured(data,root/'outputs'/entry.name)
                    elif stat.S_ISREG(info.st_mode):row={'size':info.st_size,'complete':True}
                    else:continue
                except OSError:row={'size':None,'complete':False}
                all_outputs.append(row)
                if entry.name in outputs:by_project.setdefault(outputs[entry.name],[]).append(row)
    except FileNotFoundError:pass
    except OSError:all_outputs.append({'size':None,'complete':False});records_complete=False
    for project in result['projects']:
        rows=by_project.get((project.get('ownerId') or project.get('userId'),project['project']),[])
        usage=total(rows)
        if not records_complete:
            usage['complete']=False
            if not rows:usage['size']=None
        project['outputs']={**usage,'count':len(rows) if records_complete or rows else None}
    environments=[]
    try:
        for owner in (store.path/'.oci').iterdir():
            try:
                if owner.is_symlink() or not owner.is_dir():continue
                try:(owner/'graph').stat()
                except FileNotFoundError:continue
                environments.append(module('personal-oci').storage_size(ops.config,owner))
            except (OSError,ValueError,IndexError,subprocess.TimeoutExpired):environments.append({'size':None,'complete':False})
    except FileNotFoundError:pass
    except OSError:environments.append({'size':None,'complete':False})
    trash=[];temporary=[]
    workspace_device=store.path.stat().st_dev
    roots={root,store.path}
    try:roots.add(data.root(ops.config,'datasetsRoot'))
    except (OSError,ValueError):trash.append({'size':None,'complete':False})
    for base in roots:
        try:
            if base.stat().st_dev==workspace_device:trash.append(measured(data,base/'.trash'))
        except OSError:trash.append({'size':None,'complete':False})
    for name in ('.copy-exports','.copies'):temporary.append(measured(data,store.path/name))
    result['areas']={'outputs':total(all_outputs),'environments':total(environments),
                     'trash':total(trash),'temporary':total(temporary)}
    return result
