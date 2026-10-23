"""Disk readings are independent of partial directory-size observations."""
import importlib.util,json,os,subprocess,tempfile,unittest,uuid
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

    def test_unreadable_project_keeps_disk_readings_and_an_unknown_project_size(self):
        ops=self.ops()
        with patch.object(ops.store,'_project',side_effect=PermissionError('project unavailable')):
            result=ops.process('projects.quota',{'userId':'alice','project':'demo'})
        self.assertEqual(result['projectUsage'],{'project':'demo','ownerId':'alice','size':None,'complete':False})
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

    def test_projects_read_cached_usage_without_scanning_even_when_files_change(self):
        ops=self.ops();ops.store.create('alice','demo');ops.store.create('bob','demo')
        path=ops.store._project('alice','demo')[0];(path/'code'/'ok').write_bytes(b'abc');(path/'code'/'partial').mkdir()
        engine=ops.store.path/'.oci';engine.mkdir();(engine/'partial').mkdir()
        with patch('os.scandir',side_effect=AssertionError('ordinary project list scanned bytes')):
            rows=ops.process('projects.list',{'userId':'alice'})['projects']
        self.assertEqual(len(rows),2);self.assertTrue(all('size' not in row for row in rows))
        with self.deny('partial'):
            self.refresh(ops)
            quota=ops.process('projects.quota',{'userId':'alice','project':'demo'})
        (path/'code'/'later').write_bytes(b'later bytes')
        with patch('os.scandir',side_effect=AssertionError('cached project list scanned bytes')),patch('subprocess.run',side_effect=AssertionError('cached project list launched du')):
            result=ops.process('projects.list',{'userId':'alice','includeUsage':True})
        rows={r['ownerId']:r for r in result['projects']}
        self.assertFalse(rows['alice']['complete']);self.assertGreaterEqual(rows['alice']['size'],3);self.assertTrue(rows['bob']['complete'])
        self.assertEqual(quota['projectUsage'],{'project':'demo','ownerId':'alice','size':rows['alice']['size'],'complete':False})
        self.assertTrue(all(r['usedBytes'] is not None for r in quota['volumes']))

    def test_unreadable_list_root_is_unknown_instead_of_an_empty_success(self):
        original=Path.iterdir
        def listed(path):
            if str(path)==self.config['datasetsRoot']:raise PermissionError('unreadable root')
            return original(path)
        with patch.object(Path,'iterdir',listed):
            with self.assertRaises(PermissionError):self.files.datasets(self.config)

    def test_unreadable_container_remains_in_project_list_with_unknown_size(self):
        ops=self.ops();ops.store.create('alice','unreadable');ops.store.create('bob','healthy')
        (ops.store.dev_paths('bob','healthy')['code']/'file').write_bytes(b'abc')
        with self.deny('unreadable'):
            self.refresh(ops);result=ops.process('projects.list',{'userId':'alice','includeUsage':True})
        rows={row['project']:row for row in result['projects']}
        self.assertEqual(rows['unreadable'],{'project':'unreadable','ownerId':'alice','size':None,'complete':False,'outputs':{'size':0,'complete':True,'count':0}})
        self.assertFalse(result['complete']);self.assertGreaterEqual(rows['healthy']['size'],3)

    def test_scan_accounts_for_project_outputs_orphans_environments_trash_and_copy_staging(self):
        ops=self.ops();ops.store.create('alice','demo');ops.store.create('bob','demo')
        root=ops.store.root;records=root/'jobs';records.mkdir()
        for owner,actor,size in [('alice','bob',3),('bob','alice',5),(None,None,7)]:
            key=str(uuid.uuid4());folder=root/'outputs'/key;folder.mkdir(parents=True);(folder/'out').write_bytes(b'x'*size)
            if owner:(records/(key+'.json')).write_text(json.dumps({'ownerId':owner,'userId':actor,'project':'demo'}))
        engines=[]
        for owner in ('alice','bob'):(ops.store.path/'.oci'/owner/'graph').mkdir(parents=True)
        def unshare(argv,**kwargs):
            owner=Path(argv[-1]).name;engines.append((owner,argv,kwargs))
            return subprocess.CompletedProcess(argv,0,str({'alice':11,'bob':13}[owner])+'\tgraph','')
        for base in (root,ops.store.path):
            (base/'.trash').mkdir();(base/'.trash'/'payload').write_bytes(b'xx')
        for name in ('.copies','.copy-exports'):
            (ops.store.path/name).mkdir();(ops.store.path/name/'payload').write_bytes(b'xxx')
        with patch.object(ops,'oci',side_effect=AssertionError('usage must not initialize OCI')),patch('subprocess.run',unshare):
            self.refresh(ops)
        with patch('os.scandir',side_effect=AssertionError('cached query must not scan outputs')),patch('subprocess.run',side_effect=AssertionError('cached query must not run podman')):
            result=ops.process('projects.list',{'includeUsage':True})
        self.assertEqual(result['areas'],{name:{'size':size,'complete':True} for name,size in [('outputs',15),('environments',24),('trash',4),('temporary',6)]})
        self.assertEqual({row['ownerId']:row['outputs'] for row in result['projects']},
                         {owner:{'size':size,'complete':True,'count':1} for owner,size in [('alice',3),('bob',5)]})
        self.assertEqual(len(engines),2)
        for owner,args,kwargs in engines:
            self.assertEqual(args[-5:],['unshare','/usr/bin/du','-sb','--one-file-system',str(ops.store.path/'.oci'/owner)])
            self.assertIn('--root='+str(ops.store.path/'.oci'/owner/'graph'),args)
            self.assertEqual(kwargs['timeout'],3600)
            self.assertEqual(kwargs['env']['HOME'],str(ops.store.path/'.oci'/owner/'home'))
            self.assertEqual([path.name for path in (ops.store.path/'.oci'/owner).iterdir()],['graph'])

    def test_partial_areas_and_project_outputs_preserve_known_bytes(self):
        ops=self.ops();ops.store.create('alice','demo');key=str(uuid.uuid4())
        jobs=ops.store.root/'jobs';jobs.mkdir();(jobs/(key+'.json')).write_text(json.dumps({'userId':'alice','project':'demo'}))
        output=ops.store.root/'outputs'/key;output.mkdir(parents=True);(output/'hidden').mkdir()
        (output/'known').write_bytes(b'abc')
        (ops.store.path/'.oci'/'alice'/'graph').mkdir(parents=True)
        with self.deny('hidden'),patch('subprocess.run',side_effect=OSError('unshare unavailable')):
            self.refresh(ops)
        result=ops.process('projects.list',{'includeUsage':True})
        self.assertEqual(result['areas']['outputs'],{'size':3,'complete':False})
        self.assertEqual(result['areas']['environments'],{'size':None,'complete':False})
        self.assertEqual(result['projects'][0]['outputs'],{'size':3,'complete':False,'count':1})

    def test_trash_on_a_separate_dataset_disk_is_not_counted_on_the_workspace_disk(self):
        ops=self.ops();dataset=Path(self.config['datasetsRoot']);(dataset/'.trash').mkdir();(dataset/'.trash'/'data').write_bytes(b'data')
        original=Path.stat
        def separate(path,*args,**kwargs):
            value=original(path,*args,**kwargs)
            if path==dataset:value=os.stat_result([value.st_mode,value.st_ino,value.st_dev+2,value.st_nlink,value.st_uid,value.st_gid,value.st_size,value.st_atime,value.st_mtime,value.st_ctime])
            return value
        with patch.object(Path,'stat',separate):self.refresh(ops)
        result=ops.process('projects.list',{'includeUsage':True})
        self.assertEqual(result['areas']['trash'],{'size':0,'complete':True})

    def test_unreadable_output_root_does_not_invent_zero_bytes_or_zero_jobs(self):
        ops=self.ops();ops.store.create('alice','demo');(ops.store.root/'outputs').mkdir()
        with self.deny('outputs'):self.refresh(ops)
        result=ops.process('projects.list',{'includeUsage':True})
        self.assertEqual(result['projects'][0]['outputs'],{'size':None,'complete':False,'count':None})
        self.assertEqual(result['areas']['outputs'],{'size':None,'complete':False})

    def test_missing_or_corrupt_samples_keep_project_metadata_and_unknown_usage(self):
        ops=self.ops();ops.store.create('alice','demo')
        for saved in (None,'not json','[]','{"areas":{"outputs":null}}'):
            file=ops.store.root/'samples'/'storage-areas.json'
            if saved is not None:
                file.parent.mkdir(mode=0o700,exist_ok=True);file.write_text(saved)
            with patch('os.scandir',side_effect=AssertionError('missing cache triggered a scan')),patch('subprocess.run',side_effect=AssertionError('missing cache triggered a worker')):
                result=ops.process('projects.list',{'includeUsage':True})
            self.assertEqual(result['projects'][0]['project'],'demo');self.assertTrue(result['complete'])
            self.assertIsNone(result['projects'][0]['size']);self.assertFalse(result['projects'][0]['complete'])
            self.assertEqual(result['projects'][0]['outputs'],{'size':None,'complete':False,'count':None})
            self.assertEqual(result['areas'],{name:{'size':None,'complete':False} for name in ('outputs','environments','trash','temporary')})
            self.assertIsNone(result['areasCheckedAt'])

    def test_sample_is_atomic_and_reads_keep_the_actual_sample_time(self):
        ops=self.ops();ops.store.create('alice','demo');old=self.refresh(ops)
        file=ops.store.root/'samples'/'storage-areas.json';usage=f.module('storage-usage');replace=os.replace;observed=[]
        def replacing(source,target,*args,**kwargs):
            if target==file:observed.append(json.loads(file.read_text()))
            return replace(source,target,*args,**kwargs)
        (ops.store.dev_paths('alice','demo')['code']/'new').write_bytes(b'new')
        with patch('os.replace',replacing):new=usage.refresh(ops)
        self.assertEqual(observed,[old]);self.assertEqual(json.loads(file.read_text()),new)
        result=ops.process('projects.list',{'includeUsage':True})
        self.assertEqual(result['areasCheckedAt'],new['checkedAt']);self.assertEqual(result['projects'][0]['size'],new['projects'][0]['size'])

    def test_partial_du_output_and_readable_users_survive_other_user_errors(self):
        ops=self.ops()
        for owner in ('alice','bob','carol'):(ops.store.path/'.oci'/owner/'graph').mkdir(parents=True)
        def du(argv,**kwargs):
            owner=Path(argv[-1]).name
            if owner=='carol':raise OSError('unshare failed')
            return subprocess.CompletedProcess(argv,0 if owner=='alice' else 1,'7 graph' if owner=='alice' else '11 graph','unreadable child')
        with patch('subprocess.run',du):self.refresh(ops)
        self.assertEqual(ops.process('projects.list',{'includeUsage':True})['areas']['environments'],{'size':18,'complete':False})

    def test_readable_output_siblings_survive_an_unreadable_output_and_bad_job_record(self):
        ops=self.ops();ops.store.create('alice','demo');jobs=ops.store.root/'jobs';jobs.mkdir()
        for name,raw in [('good',b'good'),('blocked',b'hidden')]:
            key=str(uuid.uuid4());path=ops.store.root/'outputs'/key;path.mkdir(parents=True)
            if name=='blocked':(path/name).mkdir();(path/name/'bytes').write_bytes(raw)
            else:(path/name).write_bytes(raw)
            (jobs/(key+'.json')).write_text(json.dumps({'ownerId':'alice','project':'demo'}))
        (jobs/(str(uuid.uuid4())+'.json')).write_text('bad json')
        with self.deny('blocked'):self.refresh(ops)
        result=ops.process('projects.list',{'includeUsage':True})
        self.assertEqual(result['areas']['outputs'],{'size':4,'complete':False})
        self.assertEqual(result['projects'][0]['outputs'],{'size':4,'complete':False,'count':2})

    def test_installed_collect_service_calls_the_common_collector(self):
        spec=importlib.util.spec_from_file_location('security_fixture',Path(__file__).with_name('project-security.test.py'))
        security=importlib.util.module_from_spec(spec);spec.loader.exec_module(security);node=security.ProjectContract.node(self)
        service=f.module('core-service');runtime=SimpleNamespace(activate=Mock(),check_directories=Mock())
        transfers=SimpleNamespace(collect=Mock(return_value=[{'kind':'copy-export','state':'COMPLETE'}]))
        with patch.object(service,'load',side_effect=lambda name,file:runtime if file=='runtime-profile.py' else node),patch.object(node,'transfers',return_value=transfers),patch.object(node.os,'setpriority') as nice,patch.object(node.subprocess,'run') as io:
            result=service.main(['core-service.py','--profile','7IM','--storage-collect'])
        self.assertEqual(result,[{'kind':'copy-export','state':'COMPLETE'}]);transfers.collect.assert_called_once()
        nice.assert_called_once_with(os.PRIO_PROCESS,0,19);self.assertEqual(io.call_args.args[0][:2],['/usr/bin/ionice','-c3'])
        self.assertTrue(json.loads((Path(self.config['root'])/'samples'/'storage-areas.json').read_text())['checkedAt'])

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
                      'sample':(node.ROOT/'samples'/'storage-areas.json').exists()}))
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
