"""Local read-only bridge: real project/dataset code paths, synthetic disks and quota samples.

gpu-1: SSD workspace disk with project-quota accounting (every item kind) and an
HDD dataset disk without it. gpu-2: workspace and datasets share one quota
filesystem whose datasets are newer than the sample (measured, one partly
unreadable). gpu-3: SSD below the 64 GiB floor without accounting (project
usage unknown) and an HDD dataset disk with accounting. Every quota disk's
items add up to its usedBytes.
"""
import contextlib,importlib.util,io,json,os,sys,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('storage_fixture',Path(__file__).parents[1]/'node-friction.test.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
GiB=1024**3
case=unittest.TestCase();f.DirectoryContract.setUp(case)
try:
    ssd,hdd=case.base/'ssd',case.base/'hdd'
    case.config.update(root=str(ssd/'state'),workspacesRoot=str(ssd/'workspaces'),datasetsRoot=str(hdd/'datasets'),dataMountPoints=[str(ssd),str(hdd)])
    for name in ('root','workspacesRoot','datasetsRoot'):Path(case.config[name]).mkdir(parents=True,mode=0o700)
    read_text=Path.read_text
    def mountinfo(path,*args,**kwargs):
        if str(path)=='/proc/self/mountinfo':
            return f'1 0 0:1 / / rw - ext4 root rw\n2 1 0:2 / {case.base} rw - ext4 data rw\n3 2 0:3 / {ssd} rw - ext4 ssd rw\n4 2 0:4 / {hdd} rw - xfs hdd rw\n'
        return read_text(path,*args,**kwargs)
    patch.object(Path,'read_text',mountinfo).start()
    ops=f.module('project-ops').ProjectOperations(SimpleNamespace(CONFIG=case.config,ROOT=Path(case.config['root'])))
    data=f.module('local-data');q=f.module('quota-ids')
    def load(name):
        if name=='local-data':return data
        loaded=f.module(name)
        if name=='storage-usage':loaded.module=load  # disk media comes from the patched local-data
        return loaded
    ops.process.__globals__['module']=load
    with contextlib.redirect_stderr(io.StringIO()):  # tagging needs a quota filesystem; the samples below stand in for it
        for owner,project in [('fixture-member','vision'),('builtin-admin','render')]:
            ops.store.create(owner,project);code=ops.store.dev_paths(owner,project)['code'];(code/'train.py').write_bytes(b'print("training")\n');(code/'partial').mkdir();(code/'partial'/'hidden').write_bytes(b'unknown bytes')
    records=Path(case.config['root'],'dataset-uploaders');records.mkdir()
    for name in ['images','motion']:
        (records/(name+'.json')).write_text(json.dumps({'userId':'fixture-member' if name=='images' else 'builtin-admin'}))
        folder=Path(case.config['datasetsRoot'],name);folder.mkdir();(folder/'sample.bin').write_bytes(b'abc');(folder/'partial').mkdir();(folder/'partial'/'hidden').write_bytes(b'unknown bytes')
    V,R=('fixture-member','vision'),('builtin-admin','render')
    usage={
        'gpu-1':{str(ssd):{q.files_key(*V):120,q.outputs_key(*V):300,q.env_key(*V):40,q.files_key(*R):60,q.outputs_key(*R):80,q.env_key(*R):25,
                           q.images_key('fixture-member'):35,q.images_key('builtin-admin'):18,q.dataset_key('images'):50,q.PLATFORM:6,
                           q.external_key('/fixture/data1/cyx'):655,q.UNASSIGNED:12,None:30,'overhead':3},str(hdd):None},
        'gpu-2':{str(ssd):{q.files_key(*V):200,q.outputs_key(*V):150,q.env_key(*V):30,q.files_key(*R):90,q.outputs_key(*R):60,q.env_key(*R):20,
                           q.images_key('fixture-member'):40,q.images_key('builtin-admin'):22,q.PLATFORM:5,q.UNASSIGNED:4,None:810,'overhead':3}},
        'gpu-3':{str(ssd):None,str(hdd):{q.dataset_key('images'):3000,q.dataset_key('motion'):2000,q.external_key('/fixture/data2/archive'):3000,None:190,'overhead':2}}}
    ids=q.allocate(q.folder(case.config),sorted({key for disks in usage.values() for rows in disks.values() if rows for key in rows if key not in (None,'overhead')}))
    def capacity_of(machine,path):
        workspace=machine=='gpu-2' or str(path).startswith(str(ssd))
        return dict(total=(2 if workspace else 16)*1024*GiB,available=(32 if machine=='gpu-3' and workspace else 614 if workspace else 8*1024)*GiB)
    def sample(machine):
        filesystems=[]
        for mount,rows in usage[machine].items():
            mounts=[str(ssd),str(hdd)] if machine=='gpu-2' else [mount]
            room=capacity_of(machine,mount);row={'mountPoints':mounts,'device':'/dev/fixture-'+Path(mount).name,'quota':rows is not None,'ids':{},
                 'totalBytes':room['total'],'usedBytes':room['total']-room['available'],'availableBytes':room['available']}
            if rows:
                row['ids']={str(0 if key is None else ids[key]):{'bytes':value*GiB,'inodes':1} for key,value in rows.items() if key!='overhead'}
                row['usedBytes']=sum(value['bytes'] for value in row['ids'].values())+rows['overhead']*GiB
                row['totalBytes']=row['usedBytes']+room['available']
            else:row.update(error='ESRCH')
            filesystems.append(row)
        samples=Path(case.config['root'],'samples');samples.mkdir(mode=0o700,exist_ok=True)
        (samples/'quota.json').write_text(json.dumps({'checkedAt':'2026-11-07T08:00:00+00:00','filesystems':filesystems}))
        (samples/'storage-usage.json').write_text(json.dumps({'checkedAt':'2026-11-07T07:30:00+00:00','outputs':{'fixture-member/vision':2,'builtin-admin/render':1},
            'trash':{str(ssd):{'size':3*GiB,'complete':True}}}))
    original_open=os.open;original_stat=os.stat
    for line in sys.stdin:
        request=json.loads(line);machine=request['machine'];operation=request['operation'];args=request['args']
        def opened(path,*a,**kw):
            if machine=='gpu-2' and Path(path).name=='partial':raise PermissionError(13,'Permission denied','partial')
            return original_open(path,*a,**kw)
        def device(path,*a,**kw):
            value=original_stat(path,*a,**kw)
            # gpu-1/gpu-3 keep datasets on a separate HDD; gpu-2 puts both on one filesystem.
            if machine!='gpu-2' and not isinstance(path,int) and (str(path)==str(hdd) or str(path).startswith(str(hdd)+'/')):
                value=os.stat_result([value.st_mode,value.st_ino,value.st_dev+7,value.st_nlink,value.st_uid,value.st_gid,value.st_size,value.st_atime,value.st_mtime,value.st_ctime])
            return value
        def capacity(path):
            room=capacity_of(machine,path)
            return SimpleNamespace(f_blocks=room['total'],f_frsize=1,f_bfree=room['available'],f_bavail=room['available'],f_fsid=1 if machine=='gpu-2' or str(path).startswith(str(ssd)) else 2)
        try:
            with patch('os.open',opened),patch('os.stat',device),patch('os.statvfs',capacity),\
                 patch.object(data,'disk_media',side_effect=lambda path:'hdd' if machine=='gpu-2' or str(path).startswith(str(hdd)) else 'ssd'):
                # Model the root sampler and the hourly collector before Portal reads its cache.
                if operation in ('projects.list','datasets.list'):sample(machine)
                if operation=='datasets.list':result=case.files.datasets(case.config)
                elif operation in ('files.list','files.get','files.stat'):result=case.files.process(case.config,operation,args)
                elif operation=='projects.status':result=ops.store.status(args.get('ownerId',args.get('userId')),args['project'])
                else:result=ops.process(operation,args)
            print(json.dumps({'id':request['id'],'result':result}),flush=True)
        except Exception as error:print(json.dumps({'id':request['id'],'error':str(error)}),flush=True)
finally:case.doCleanups()
