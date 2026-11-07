"""Disk usage comes from the root quota sample; project requests never scan."""
import importlib.util,json,os,shutil,subprocess,tempfile,unittest,uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
s=importlib.util.spec_from_file_location('directory_fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)

class StorageUsage(unittest.TestCase):
    setUp=f.DirectoryContract.setUp

    def ops(self):
        return f.module('project-ops').ProjectOperations(SimpleNamespace(CONFIG=self.config,ROOT=Path(self.config['root'])))

    def refresh(self,ops):return f.module('storage-usage').refresh(ops)

    def deny(self,name):
        original=os.open
        def opened(path,*args,**kwargs):
            if Path(path).name==name:raise PermissionError(13,'Permission denied',name)
            return original(path,*args,**kwargs)
        return patch('os.open',opened)

    def test_quota_reads_shared_filesystem_once_per_root_without_directory_scans(self):
        ops=self.ops();v=SimpleNamespace(f_blocks=1000,f_bfree=400,f_bavail=350,f_frsize=4096,f_fsid=2**63+7)
        with patch('os.statvfs',return_value=v) as read,patch('os.scandir',side_effect=AssertionError('quota scanned files')):
            result=ops.process('projects.quota',{'userId':'alice'})
        self.assertEqual([str(c.args[0]) for c in read.call_args_list],[self.config['workspacesRoot'],self.config['datasetsRoot']])
        self.assertEqual(result,{'volumes':[{'kind':'shared','fs':str(v.f_fsid),'totalBytes':4096000,'usedBytes':2457600,'availableBytes':1433600,'media':self.data.disk_media(self.config['workspacesRoot'])}]})

    def test_equal_capacity_disks_keep_distinct_filesystem_ids(self):
        ops=self.ops();disks=[SimpleNamespace(f_blocks=100,f_bfree=50,f_bavail=40,f_frsize=4096,f_fsid=fs) for fs in (11,12)]
        with patch('os.statvfs',side_effect=disks):result=ops.process('projects.quota',{'userId':'alice'})
        self.assertEqual([row['fs'] for row in result['volumes']],['11','12'])
        self.assertEqual(result['volumes'][0]['totalBytes'],result['volumes'][1]['totalBytes'])

    def test_real_filesystem_id_is_stable_across_roots_and_queries(self):
        ops=self.ops();expected=str(os.statvfs(self.config['workspacesRoot']).f_fsid)
        for _ in range(2):
            result=ops.process('projects.quota',{'userId':'alice'})
            self.assertEqual([row['fs'] for row in result['volumes']],[expected])
            self.assertEqual(result['volumes'][0]['kind'],'shared')

    def test_zero_filesystem_id_is_known_but_failed_readings_are_not_merged(self):
        ops=self.ops();v=SimpleNamespace(f_blocks=100,f_bfree=50,f_bavail=40,f_frsize=4096,f_fsid=0)
        with patch('os.statvfs',return_value=v):result=ops.process('projects.quota',{'userId':'alice'})
        self.assertEqual([(row['kind'],row['fs']) for row in result['volumes']],[('shared','0')])
        with patch('os.statvfs',side_effect=OSError('offline')):result=ops.process('projects.quota',{'userId':'alice'})
        self.assertEqual(result['volumes'],[{'kind':kind,'fs':None,'totalBytes':None,'usedBytes':None,'availableBytes':None,'media':self.data.disk_media(self.config[field])} for kind,field in (('workspace','workspacesRoot'),('datasets','datasetsRoot'))])

    def test_quota_carries_measured_media_for_separate_and_shared_volumes(self):
        ops=self.ops();data=f.module('local-data');original=ops.process.__globals__['module']
        with patch.dict(ops.process.__globals__,module=lambda name:data if name=='local-data' else original(name)),patch.object(data,'disk_media',side_effect=['ssd','hdd']):
            with patch('os.statvfs',side_effect=[SimpleNamespace(f_blocks=100,f_bfree=50,f_bavail=40,f_frsize=4096,f_fsid=fs) for fs in (11,12)]):
                self.assertEqual([row['media'] for row in ops.process('projects.quota',{})['volumes']],['ssd','hdd'])
            with patch.object(data,'disk_media',return_value='hdd'):
                self.assertEqual(ops.process('projects.quota',{})['volumes'][0]['media'],'hdd')

    def test_one_unavailable_disk_keeps_the_other_reading(self):
        ops=self.ops();v=SimpleNamespace(f_blocks=100,f_bfree=50,f_bavail=40,f_frsize=4096,f_fsid=12)
        with patch('os.statvfs',side_effect=[OSError('offline'),v]):result=ops.process('projects.quota',{'userId':'alice'})
        self.assertIsNone(result['volumes'][0]['usedBytes']);self.assertEqual(result['volumes'][1]['availableBytes'],40*4096)
        self.assertEqual([row['fs'] for row in result['volumes']],[None,'12'])

    def test_quota_returns_disk_volumes_only_without_measuring_the_project(self):
        ops=self.ops();ops.store.create('alice','demo')
        with patch('os.scandir',side_effect=AssertionError('quota measured project files')):
            result=ops.process('projects.quota',{'userId':'alice','project':'demo'})
        self.assertEqual(set(result),{'volumes'})
        self.assertTrue(all(row['totalBytes'] is not None for row in result['volumes']))

    def test_missing_project_status_explains_next_step_instead_of_errno(self):
        for operation in ('projects.status','projects.workspace'):
            with self.assertRaisesRegex(ValueError,'这台服务器上没有项目 absent.*project create absent') as caught:
                self.ops().process(operation,{'userId':'nobody-yet','project':'absent'})
            self.assertNotIn('Errno',str(caught.exception))

    def test_size_preserves_lower_bound_unknown_empty_and_link_boundary(self):
        root=Path(self.config['datasetsRoot']);healthy=root/'images';healthy.mkdir();(healthy/'ok.bin').write_bytes(b'abc')
        partial=healthy/'partial';partial.mkdir();(partial/'hidden.bin').write_bytes(b'hidden');partial.chmod(0)
        self.addCleanup(partial.chmod,0o700)
        (healthy/'escape').symlink_to('/etc',target_is_directory=True)
        empty=root/'empty';empty.mkdir()
        with self.deny('partial'):
            self.assertEqual(self.data.size(healthy,partial=True),{'size':3,'complete':False})
            self.assertEqual(self.data.size(partial,partial=True),{'size':None,'complete':False})
            with self.assertRaises(PermissionError):self.data.size(healthy)
        self.assertEqual(self.data.size(empty,partial=True),{'size':0,'complete':True})

    def test_bad_dataset_keeps_healthy_siblings_and_metadata(self):
        root=Path(self.config['datasetsRoot']);a=root/'images';a.mkdir();(a/'ok').write_bytes(b'abc');(a/'partial').mkdir()
        b=root/'motion';b.mkdir();(b/'ok').write_bytes(b'abcd')
        with self.deny('partial'):rows=self.files.datasets(self.config)['datasets']
        self.assertEqual([(r['dataset'],r['size'],r['complete']) for r in rows],[('images',3,False),('motion',4,True)])
        self.assertTrue(all('uploadedBy' in r and 'modifiedAt' in r for r in rows))

    def test_unreadable_list_root_is_unknown_instead_of_an_empty_success(self):
        original=Path.iterdir
        def listed(path):
            if str(path)==self.config['datasetsRoot']:raise PermissionError('unreadable root')
            return original(path)
        with patch.object(Path,'iterdir',listed):
            with self.assertRaises(PermissionError):self.files.datasets(self.config)

    def write_sample(self,ops,filesystems,keys=(),checked='2026-11-07T00:00:00+00:00'):
        """The root sampler's file plus registry keys allocated in order (IDs from 1000)."""
        q=f.module('quota-ids');folder=q.folder(self.config)
        if keys:q.allocate(folder,list(keys))
        samples=ops.store.root/'samples';samples.mkdir(mode=0o700,exist_ok=True)
        (samples/'quota.json').write_text(json.dumps({'checkedAt':checked,'filesystems':filesystems}))
        return q.read(folder)['ids']

    def fs(self,ids,used,mounts=None,quota=True):
        return {'mountPoints':mounts or [str(self.base)],'device':'/dev/fixture','quota':quota,'ids':ids if quota else {},
                'totalBytes':10**6,'usedBytes':used,'availableBytes':10**6-used}

    def test_projects_read_the_quota_sample_and_registry_without_scanning(self):
        ops=self.ops();q=f.module('quota-ids')
        for owner in ('alice','bob'):ops.store.create(owner,'demo')
        keys=[q.outputs_key('alice','demo'),q.env_key('alice','demo'),q.images_key('alice'),q.dataset_key('images'),
              q.PLATFORM,q.external_key('/data1/cyx'),q.UNASSIGNED]
        ids=self.write_sample(ops,[],keys)
        usage={ids[q.files_key('alice','demo')]:100,ids[q.outputs_key('alice','demo')]:30,ids[q.env_key('alice','demo')]:50,
               ids[q.files_key('bob','demo')]:5,ids[q.images_key('alice')]:400,ids[q.dataset_key('images')]:1000,ids[q.PLATFORM]:20,
               ids[q.external_key('/data1/cyx')]:9,ids[q.UNASSIGNED]:3,0:7,99999:11}
        used=sum(usage.values())+25
        self.write_sample(ops,[self.fs({str(k):{'bytes':v,'inodes':1} for k,v in usage.items()},used)])
        with patch('os.scandir',side_effect=AssertionError('usage scanned files')),patch('subprocess.run',side_effect=AssertionError('usage ran a command')):
            result=ops.process('projects.list',{'includeUsage':True})
        self.assertEqual(result['checkedAt'],'2026-11-07T00:00:00+00:00');self.assertNotIn('areas',result)
        rows={row['ownerId']:row for row in result['projects']}
        self.assertEqual({k:rows['alice'][k] for k in ('size','complete','outputs','environment')},
                         {'size':100,'complete':True,'outputs':{'size':30,'complete':True,'count':None},'environment':{'size':50,'complete':True}})
        self.assertEqual((rows['bob']['size'],rows['bob']['outputs']['size'],rows['bob']['environment']),(5,0,{'size':0,'complete':True}))
        [disk]=result['disks']
        self.assertEqual({k:disk[k] for k in ('mountPoint','totalBytes','usedBytes','availableBytes','roles','accounting','trashBytes')},
                         {'mountPoint':str(self.base),'totalBytes':10**6,'usedBytes':used,'availableBytes':10**6-used,
                          'roles':['workspace','datasets'],'accounting':'quota','trashBytes':None})
        self.assertEqual(disk['items'],[
            {'kind':'project','ownerId':'alice','project':'demo','files':100,'outputs':30,'environment':50},
            {'kind':'project','ownerId':'bob','project':'demo','files':5,'outputs':0,'environment':0},
            {'kind':'images','ownerId':'alice','bytes':400},{'kind':'dataset','name':'images','bytes':1000},
            {'kind':'platform','bytes':20},{'kind':'external','path':'/data1/cyx','bytes':9},
            {'kind':'unassignedOutputs','bytes':3},{'kind':'untracked','bytes':18},{'kind':'filesystem','bytes':25}])
        total=sum(row.get('bytes',0)+row.get('files',0)+row.get('outputs',0)+row.get('environment',0) for row in disk['items'])
        self.assertEqual(total,used)

    def test_unavailable_or_missing_quota_is_unknown_not_zero(self):
        ops=self.ops();ops.store.create('alice','demo')
        for sample in (None,[self.fs({},500,quota=False)]):
            with self.subTest(sample=sample):
                if sample is not None:self.write_sample(ops,sample)
                result=ops.process('projects.list',{'includeUsage':True})
                row=result['projects'][0];[disk]=result['disks']
                self.assertEqual((row['size'],row['complete']),(None,False))
                self.assertEqual(row['outputs'],{'size':None,'complete':False,'count':None})
                self.assertEqual(row['environment'],{'size':None,'complete':False})
                self.assertEqual((disk['accounting'],disk['items']),('unavailable',[]))
                self.assertIsNotNone(disk['totalBytes'])
                self.assertEqual(result['checkedAt'],None if sample is None else '2026-11-07T00:00:00+00:00')

    def test_bind_alias_mount_points_are_one_disk_listed_under_the_first(self):
        alias=self.base/'alias';alias.mkdir();self.config['dataMountPoints']=[str(self.base),str(alias)]
        ops=self.ops();self.write_sample(ops,[self.fs({'0':{'bytes':10,'inodes':1}},10,mounts=[str(self.base),str(alias)])])
        disks=ops.process('projects.list',{'includeUsage':True})['disks']
        self.assertEqual([d['mountPoint'] for d in disks],[str(self.base)])
        self.assertEqual(disks[0]['items'],[{'kind':'untracked','bytes':10},{'kind':'filesystem','bytes':0}])

    def test_unregistered_project_files_are_unknown_and_filesystem_overhead_may_be_negative(self):
        ops=self.ops();q=f.module('quota-ids');ops.store.create('alice','demo')
        registry=ops.store.root/'quota'/'ids.json';registry.unlink()
        self.write_sample(ops,[self.fs({'0':{'bytes':30,'inodes':1}},28)])
        result=ops.process('projects.list',{'includeUsage':True});row=result['projects'][0]
        self.assertEqual((row['size'],row['complete']),(None,False))
        self.assertEqual(row['outputs']['size'],0);self.assertEqual(row['environment'],{'size':0,'complete':True})
        self.assertEqual(result['disks'][0]['items'][-1],{'kind':'filesystem','bytes':-2})

    def test_hourly_collect_measures_trash_and_counts_outputs_but_never_sizes_projects(self):
        ops=self.ops();ops.store.create('alice','demo');jobs=ops.store.root/'jobs';jobs.mkdir()
        (ops.store.dev_paths('alice','demo')['code']/'big').write_bytes(b'x'*4096)
        for owner in ('alice','alice',None):
            key=str(uuid.uuid4());folder=ops.store.root/'outputs'/key;folder.mkdir(parents=True);(folder/'out').write_bytes(b'y'*999)
            if owner:(jobs/(key+'.json')).write_text(json.dumps({'ownerId':owner,'userId':'bob','project':'demo'}))
        for base in (ops.store.root,ops.store.path):(base/'.trash').mkdir();(base/'.trash'/'payload').write_bytes(b'zz')
        old=ops.store.root/'samples'/'storage-areas.json';old.parent.mkdir(mode=0o700,exist_ok=True);old.write_text('{}')
        saved=self.refresh(ops)
        self.assertEqual(saved['trash'],{str(self.base):{'size':4,'complete':True}})
        self.assertEqual(saved['outputs'],{'alice/demo':2});self.assertFalse(old.exists())
        self.write_sample(ops,[self.fs({},0)])
        result=ops.process('projects.list',{'includeUsage':True})
        self.assertEqual(result['projects'][0]['outputs']['count'],2);self.assertEqual(result['disks'][0]['trashBytes'],4)

    def test_tagged_datasets_read_the_sample_and_untagged_ones_are_measured(self):
        ops=self.ops();q=f.module('quota-ids');root=Path(self.config['datasetsRoot'])
        for name in ('tagged','plain'):(root/name).mkdir();(root/name/'f').write_bytes(b'abc')
        ids=self.write_sample(ops,[],[q.dataset_key('tagged')])
        self.write_sample(ops,[self.fs({str(ids[q.dataset_key('tagged')]):{'bytes':12345,'inodes':2}},12345)])
        rows={row['dataset']:row for row in self.files.datasets(self.config)['datasets']}
        self.assertEqual((rows['tagged']['size'],rows['tagged']['complete']),(12345,True))
        self.assertEqual((rows['plain']['size'],rows['plain']['complete']),(3,True))

    def test_expired_trash_with_container_user_files_is_removed_in_the_rootless_namespace(self):
        purge=f.module('project-purge');trash=purge.Trash(self.config);calls=[];original=purge.module;rmtree=shutil.rmtree
        class Engine:
            def __init__(self,config,owner):calls.append(('engine',owner))
            def run(self,*args,timeout=30):
                calls.append(args)
                if rows[1]['key'] in args[-1]:raise ValueError('rm failed')
                rmtree(args[-1])
        rows=[]
        for name in ('subuid','blocked','plain'):
            folder=Path(self.config['datasetsRoot'])/name;(folder/'inner').mkdir(parents=True);(folder/'inner'/'f').write_bytes(b'x')
            rows.append(trash.delete(folder,str(uuid.uuid4()),'dataset',{'userId':'alice'},dataset=name,retainUntil=0))
        def denied(path,*args,**kwargs):
            if not str(path).endswith(rows[2]['key']+'.data'):raise PermissionError(13,'Permission denied')
            # The real call is anchored at /proc/self/fd (Linux); remove the same entry by name here.
            return rmtree(Path(self.config['datasetsRoot'])/'.trash'/Path(path).name,*args,**kwargs)
        with patch.object(purge,'module',side_effect=lambda name:SimpleNamespace(PersonalOCI=Engine) if name=='personal-oci' else original(name)),\
             patch.object(purge.shutil,'rmtree',side_effect=denied),patch.object(trash,'namespace_owner',return_value='alice'):
            result={row['key']:row for row in trash.collect()}
        self.assertEqual(result[rows[0]['key']]['state'],'PURGED');self.assertEqual(result[rows[2]['key']]['state'],'PURGED')
        self.assertEqual((result[rows[1]['key']]['state'],result[rows[1]['key']]['error']),('UNKNOWN','rm failed'))
        unshare=[c for c in calls if c[0]=='unshare']
        self.assertEqual([c[:4] for c in unshare],[('unshare','/usr/bin/rm','-rf','--')]*2)
        self.assertFalse((Path(self.config['datasetsRoot'])/'.trash'/(rows[0]['key']+'.data')).exists())

    def test_namespace_owner_reuses_an_existing_engine_without_creating_one(self):
        trash=f.module('project-purge').Trash(self.config);oci=Path(self.config['workspacesRoot'])/'.oci'
        row={'kind':'dataset','originalPath':str(Path(self.config['datasetsRoot'])/'d')}
        self.assertIsNone(trash.namespace_owner(row))
        (oci/'bob').mkdir(parents=True);self.assertEqual(trash.namespace_owner(row),'bob')
        (oci/'alice').mkdir();self.assertEqual(trash.namespace_owner({**row,'kind':'project','originalPath':str(Path(self.config['workspacesRoot'])/'alice'/'p')}),'alice')

    def test_storage_collect_still_samples_when_trash_cleanup_fails(self):
        spec=importlib.util.spec_from_file_location('security_fixture',Path(__file__).with_name('project-security.test.py'))
        security=importlib.util.module_from_spec(spec);spec.loader.exec_module(security);node=security.ProjectContract.node(self)
        broken=SimpleNamespace(Trash=lambda config:SimpleNamespace(collect=Mock(side_effect=OSError('trash unreadable'))))
        original=node.module
        with patch.object(node,'module',side_effect=lambda name:broken if name=='project-purge' else original(name)),\
             patch.object(node,'transfers',return_value=SimpleNamespace(collect=Mock(return_value=[]))),patch.object(node,'low_priority_scan'):
            result=node.storage_collect()
        self.assertEqual(result,[{'kind':'trash','state':'UNKNOWN','error':'trash unreadable'}])
        self.assertTrue((Path(self.config['root'])/'samples'/'storage-usage.json').is_file())
    def test_installed_collect_service_calls_the_common_collector(self):
        spec=importlib.util.spec_from_file_location('security_fixture',Path(__file__).with_name('project-security.test.py'))
        security=importlib.util.module_from_spec(spec);spec.loader.exec_module(security);node=security.ProjectContract.node(self)
        service=f.module('core-service');runtime=SimpleNamespace(activate=Mock(),check_directories=Mock())
        transfers=SimpleNamespace(collect=Mock(return_value=[{'kind':'copy-export','state':'COMPLETE'}]))
        with patch.object(service,'load',side_effect=lambda name,file:runtime if file=='runtime-profile.py' else node),patch.object(node,'transfers',return_value=transfers),patch.object(node.os,'setpriority') as nice,patch.object(node.subprocess,'run') as io:
            result=service.main(['core-service.py','--profile','7IM','--storage-collect'])
        self.assertEqual(result,[{'kind':'copy-export','state':'COMPLETE'}]);transfers.collect.assert_called_once()
        nice.assert_called_once_with(os.PRIO_PROCESS,0,19);self.assertEqual(io.call_args.args[0][:2],['/usr/bin/ionice','-c3'])
        self.assertTrue(json.loads((Path(self.config['root'])/'samples'/'storage-usage.json').read_text())['checkedAt'])

    def test_collect_and_dataset_scan_use_idle_io_but_cached_project_requests_do_not(self):
        import json,subprocess,sys
        program=r'''
import importlib.util,json,os,runpy,subprocess,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('priority_fixture',Path(sys.argv[1])/'tests/project-security.test.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
case=f.ProjectContract();case.setUp()
try:
    node=case.node();sys.argv=[str(node.HERE/'node-executor.py')]+(['--storage-collect'] if sys.argv[2]=='collect' else [])
    try:runpy.run_path(sys.argv[0],run_name='__main__')
    except SystemExit as error:
        if error.code:raise
    print(json.dumps({'nice':os.getpriority(os.PRIO_PROCESS,0),'io':subprocess.run(['/usr/bin/ionice','-p',str(os.getpid())],capture_output=True,text=True,check=True).stdout.strip(),
                      'sample':(node.ROOT/'samples'/'storage-usage.json').exists()}))
finally:case.doCleanups()
'''
        for operation,args,scan in [('datasets.list',{},True),('projects.list',{'includeUsage':True},False),('projects.list',{},False),('collect',{},True)]:
            result=subprocess.run([sys.executable,'-c',program,str(Path(__file__).parents[1]),operation],input=json.dumps({'operation':operation,'args':args}),capture_output=True,text=True,check=True)
            reply,priority=map(json.loads,result.stdout.splitlines())
            if operation=='collect':self.assertIsInstance(reply,list);self.assertTrue(priority['sample'])
            else:self.assertTrue(reply['ok'],reply)
            self.assertEqual(priority['nice'],19 if scan else os.getpriority(os.PRIO_PROCESS,0))
            if scan:self.assertEqual(priority['io'],'idle')

class DiskMedia(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=Path(self.tmp.name)
        self.data=f.module('local-data');self.sys=self.base/'sys/dev/block';self.sys.mkdir(parents=True)
        self.data.SYS_DEV_BLOCK=self.sys
        device=os.stat(self.base).st_dev;self.link=self.sys/f'{os.major(device)}:{os.minor(device)}'

    def disk(self,name,rotational):
        disk=self.base/'sys/devices'/name;(disk/'slaves').mkdir(parents=True);(disk/'queue').mkdir()
        (disk/'queue/rotational').write_text(str(rotational));return disk

    def mounted(self,disk):
        self.link.unlink(missing_ok=True);self.link.symlink_to(disk,target_is_directory=True)
        return self.data.disk_usage(self.base)['media']

    def test_sata_nvme_and_partition_use_physical_rotation(self):
        for name,rotation,media in [('sda',1,'hdd'),('nvme0n1',0,'ssd')]:
            with self.subTest(name=name):
                disk=self.disk(name,rotation);self.assertEqual(self.mounted(disk),media)
                partition=disk/(name+'p1');partition.mkdir();(partition/'partition').write_text('1')
                self.assertEqual(self.mounted(partition),media)

    def test_lvm_and_md_follow_all_slaves_and_report_mixed_media(self):
        a=self.disk('sda',0);b=self.disk('sdb',0);md=self.disk('md0',0);lvm=self.disk('dm-0',0)
        (md/'slaves/sda1').symlink_to(a);(md/'slaves/sdb1').symlink_to(b);(lvm/'slaves/md0').symlink_to(md)
        self.assertEqual(self.mounted(lvm),'ssd')
        (b/'queue/rotational').write_text('1');self.assertEqual(self.mounted(lvm),'mixed')
        (a/'queue/rotational').write_text('1');self.assertEqual(self.mounted(lvm),'hdd')
        (b/'queue/rotational').unlink();self.assertIsNone(self.mounted(lvm))

    def test_unavailable_device_or_rotation_stays_unknown(self):
        self.assertIsNone(self.data.disk_usage(self.base)['media'])
        disk=self.disk('unknown','?');self.assertIsNone(self.mounted(disk))
        (disk/'queue/rotational').unlink();self.assertIsNone(self.mounted(disk))

    def test_samples_assign_roles_to_configured_mounts_without_path_name_guesses(self):
        workspace=self.base/'hdd-named';dataset=self.base/'ssd-named';other=self.base/'other'
        for mount in (workspace,dataset,other):mount.mkdir()
        self.mounted(self.disk('sda',1))
        config={'dataMountPoints':[str(self.base),str(workspace),str(dataset),str(other)],'workspacesRoot':str(workspace/'projects'),'datasetsRoot':str(dataset/'data')}
        with patch.object(self.data,'require_data_path',side_effect=lambda _,path:path):
            samples=self.data.disk_samples(config)
            self.assertEqual([row['roles'] for row in samples],[[],['workspace'],['datasets'],[]])
            self.assertTrue(all(row['media']=='hdd' for row in samples))
            config['datasetsRoot']=str(workspace/'data')
            self.assertEqual(self.data.disk_samples(config)[1]['roles'],['workspace','datasets'])
            with patch('os.statvfs',side_effect=OSError('offline')):
                self.assertTrue(all(row['availableBytes'] is None for row in self.data.disk_samples(config)))

if __name__=='__main__':unittest.main()
