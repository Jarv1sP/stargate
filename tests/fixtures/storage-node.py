"""Local read-only bridge: real project/dataset bytes, synthetic mounts/capacities."""
import importlib.util,json,os,sys,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('storage_fixture',Path(__file__).parents[1]/'node-friction.test.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
case=unittest.TestCase();f.DirectoryContract.setUp(case)
try:
    ops=f.module('project-ops').ProjectOperations(SimpleNamespace(CONFIG=case.config,ROOT=Path(case.config['root'])))
    for owner,project in [('fixture-member','vision'),('builtin-admin','render')]:
        ops.store.create(owner,project);code=ops.store.dev_paths(owner,project)['code'];(code/'train.py').write_bytes(b'print("training")\n');(code/'partial').mkdir();(code/'partial'/'hidden').write_bytes(b'unknown bytes')
    records=Path(case.config['root'],'dataset-uploaders');records.mkdir()
    for name in ['images','motion']:
        (records/(name+'.json')).write_text(json.dumps({'userId':'fixture-member' if name=='images' else 'builtin-admin'}))
        folder=Path(case.config['datasetsRoot'],name);folder.mkdir();(folder/'sample.bin').write_bytes(b'abc');(folder/'partial').mkdir();(folder/'partial'/'hidden').write_bytes(b'unknown bytes')
    original_open=os.open;GiB=1024**3
    for line in sys.stdin:
        request=json.loads(line);machine=request['machine'];operation=request['operation'];args=request['args']
        def opened(path,*a,**kw):
            if machine=='gpu-2' and Path(path).name=='partial':raise PermissionError(13,'Permission denied','partial')
            return original_open(path,*a,**kw)
        def capacity(path):
            workspace=machine=='gpu-2' or str(path)==case.config['workspacesRoot'];total=(2 if workspace else 16)*1024*GiB
            available=(32 if machine=='gpu-3' and workspace else 614 if workspace else 8*1024)*GiB
            return SimpleNamespace(f_blocks=total,f_frsize=1,f_bfree=available,f_bavail=available,f_fsid=1 if workspace else 2)
        try:
            with patch('os.open',opened),patch('os.statvfs',capacity):
                if operation=='datasets.list':result=case.files.datasets(case.config)
                elif operation in ('files.list','files.get','files.stat'):result=case.files.process(case.config,operation,args)
                elif operation=='projects.status':result=ops.store.status(args.get('ownerId',args.get('userId')),args['project'])
                else:result=ops.process(operation,args)
            print(json.dumps({'id':request['id'],'result':result}),flush=True)
        except Exception as error:print(json.dumps({'id':request['id'],'error':str(error)}),flush=True)
finally:case.doCleanups()
