"""Disk-area accounting for the existing low-priority project usage scan."""
import importlib.util,os,stat,subprocess
from pathlib import Path


def module(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


def total(rows):
    rows=list(rows);complete=all(row['complete'] for row in rows)
    return {'size':sum(row['size'] for row in rows) if complete else None,'complete':complete}


def measured(data,path):
    try:path.lstat()
    except FileNotFoundError:return {'size':0,'complete':True}
    except OSError:return {'size':None,'complete':False}
    row=data.size(path,partial=True)
    return row if row['complete'] else {'size':None,'complete':False}


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
        project['outputs']={**(total(rows) if records_complete else {'size':None,'complete':False}),'count':len(rows) if records_complete else None}
    environments=[]
    try:
        for owner in (store.path/'.oci').iterdir():
            try:
                if owner.is_symlink() or not owner.is_dir():continue
                try:(owner/'graph').stat()
                except FileNotFoundError:continue
                size=module('personal-oci').storage_size(ops.config,owner)
                environments.append({'size':size,'complete':True})
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
