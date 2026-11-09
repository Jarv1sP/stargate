"""STOR-002b root boundary, grace, clamps, rollback and disk admission."""
import ctypes,errno,importlib.util,json,os,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
limits=f.module('quota-limits')
rounded=lambda value,block=1024:((value+block-1)//block)*block

class Kernel:
    def __init__(self,used=0,hard=0):self.row=SimpleNamespace(curspace=used,bhardlimit=hard,bsoftlimit=0)
    def get(self,*args):return self.row

class Limits(unittest.TestCase):
    setUp=f.DirectoryContract.setUp
    def apply(self,ids=None,desired=None,ledger=None,now=100,used=0,**kw):
        registry={'next':2000,'ids':ids or {'p:alice/demo:files':1001}}
        with patch.object(limits,'project_id',return_value=1001):
            return limits.apply(registry,desired or {},ledger if ledger is not None else {},'/workspace','/dev/test',Kernel(used),
                default=100_000,minimum=1000,maximum=1_000_000,headroom=10_000,now=now,**kw)
    def test_xfs_decimal_and_grace_limits_settle_at_filesystem_blocks(self):
        key='p:alice/demo:files';registry={'ids':{key:1001},'next':1002}
        class XFS(Kernel):
            def set(self,device,number,value):self.row.bhardlimit=rounded(value,4096)//1024
        for desired,used in ((100_000_000_000,0),(1_000_000_001,0),(50_000_000_000,0),(100_000_000_000,150_000_000_000)):
            kernel=XFS(used);ledger={}
            def apply():
                return limits.apply(registry,{key:desired},ledger,'/workspace','/dev/test',kernel,default=100_000_000_000,minimum=1,maximum=10**13,headroom=10_000_000_000,now=100,block_bytes=4096)
            with patch.object(limits,'project_id',return_value=1001):
                actions,status=apply()
                self.assertEqual(len(actions),1)
                for action in actions:kernel.set(*action)
                self.assertEqual(kernel.row.bhardlimit*1024,rounded(max(desired,used+10_000_000_000) if used>desired else desired,4096))
                self.assertEqual(apply()[0],[],(desired,used))
                self.assertEqual(status[key]['limitBlockBytes'],4096)

    def test_clear_includes_recorded_ids_now_denied_and_duplicate_project_names(self):
        key='p:alice/demo:files';ledger={'kinds':{'1001':key,'1002':key},'projects':{}}
        actions,_=limits.apply({'ids':{},'next':1000},{},ledger,'/workspace','/dev/test',Kernel(hard=100),default=100000,minimum=1,maximum=1000000,headroom=1,now=1,denied={0,1001,1002},clear=True)
        self.assertEqual(actions,[('/dev/test',1001,0),('/dev/test',1002,0)])
        self.assertEqual(ledger['kinds'],{'1001':key,'1002':key})

    def test_xfs_missing_zero_dquot_does_not_block_other_ids_or_repeated_clear(self):
        keys={'p:alice/demo:files':1001,'p:bob/demo:files':1002}
        class Missing(Kernel):
            def get(self,device,number):
                if number==1001:raise OSError(errno.ENOENT,'uninitialized dquot')
                return super().get(device,number)
        for clear in (False,True):
            ledger={'kinds':{str(number):key for key,number in keys.items()},'projects':{}}
            actions,status=limits.apply({'ids':keys,'next':1003},{},ledger,'/workspace','/dev/test',Missing(hard=200),default=100000,minimum=1,maximum=1000000,headroom=1,now=1,clear=clear)
            self.assertIn(('/dev/test',1002,0 if clear else rounded(100000)),actions)
            self.assertEqual(len(status),2)
            if clear:self.assertNotIn(('/dev/test',1001,0),actions)

    def test_bad_desired_rows_are_ignored_without_losing_valid_siblings(self):
        good={'ownerId':'alice','project':'demo','bytes':100000}
        bad=[{'ownerId':owner,'project':'demo','bytes':100} for owner in ('bad.owner','a'*65,'账号','/tmp')]
        bad += [None,{},dict(good,bytes=True),dict(good,project='bad.project')]
        self.assertEqual(limits.desired_limits({'limits':[*bad,good]}),{'p:alice/demo:files':100000})
        sync=f.module('project-storage-limits').sync
        for owner in ('bad.owner','a'*65,'账号'):
            with self.assertRaisesRegex(ValueError,'账号编号'):sync(self.config,{'actor':{'isAdmin':True},'limits':[dict(good,ownerId=owner)]})
        self.assertFalse((Path(self.config['root'])/'quota/limits.json').exists())

    def test_enospc_below_cap_reports_disk_full_and_uses_actual_failed_path(self):
        store=f.module('project-store')
        for used,limit,enforced in ((30_000_000_000,100_000_000_000,True),(None,100,True),(100,100,False)):
            with patch.object(store,'quota_usage',return_value=(used,limit,enforced)):
                message=store.storage_error(self.config,OSError(errno.ENOSPC,'full','/actual/datasets/file'),'/project/code')
            self.assertIn('数据盘空间不足',message);self.assertNotIn('调整上限',message);self.assertNotIn('/actual',message)
        with patch.object(store,'quota_usage',return_value=(0,0,True)) as usage:
            store.storage_error(self.config,OSError(errno.ENOSPC,'full','/actual/state/file'),'/project/code')
            usage.assert_called_once_with(self.config,'/actual/state/file')

    def test_disabled_never_reads_or_calls_kernel(self):
        with patch.object(limits,'Kernel',side_effect=AssertionError('kernel used')),patch.object(limits.s,'open_directory',side_effect=AssertionError('read')):
            self.assertEqual(limits.main(['--account','unused','--root','/no','--workspaces-root','/no','/data']),0)
    def test_only_project_files_and_never_id_zero_or_other_kinds(self):
        ids={'x:/docker':1000,'d:data':1002,'a:platform':1003,'p:alice/demo:env':1004,'p:alice/demo:outputs':1005,'p:alice/zero:files':0,'p:alice/demo:files':1001}
        actions,status=self.apply(ids);self.assertEqual(actions,[('/dev/test',1001,rounded(100_000))]);self.assertEqual(list(status),['p:alice/demo:files'])
    def test_root_ledger_prevents_relabel_and_external_id_is_never_accepted(self):
        ledger={};self.apply({'x:/docker':1001},ledger=ledger)
        self.assertEqual(self.apply(ledger=ledger)[0],[])
        self.assertEqual(self.apply(denied={1001})[0],[])
        with patch.object(limits,'project_id',return_value=1002):
            self.assertEqual(limits.apply({'next':2000,'ids':{'p:alice/demo:files':1001}}, {},{},'/x','/dev/test',Kernel(),default=100,minimum=1,maximum=1000,headroom=1,now=1)[0],[])
    def test_duplicates_are_excluded(self):
        self.assertEqual(self.apply({'p:alice/demo:files':1001,'d:data':1001})[0],[])
    def test_initial_overage_grace_is_fixed_then_tightens_and_never_deletes(self):
        ledger={};key='p:alice/demo:files';actions,status=self.apply(used=150_000,ledger=ledger)
        self.assertEqual(actions[0][-1],rounded(160_000));deadline=status[key]['graceUntil'];self.assertEqual(deadline,100+7*86400)
        self.assertEqual(self.apply(used=300_000,ledger=ledger,now=200)[0][0][-1],rounded(160_000))
        actions,status=self.apply(used=300_000,ledger=ledger,now=deadline)
        self.assertEqual(actions[0][-1],rounded(100_000));self.assertIsNone(status[key]['graceUntil'])
    def test_rollout_grace_is_not_granted_to_later_project_ids(self):
        ledger={};self.apply(ids={'a:platform':1000},ledger=ledger)
        actions,status=self.apply(used=150_000,ledger=ledger)
        self.assertEqual(actions,[('/dev/test',1001,rounded(100_000))])
        self.assertIsNone(status['p:alice/demo:files']['graceUntil'])

    def test_clamps_and_admin_lowering_and_clear(self):
        key='p:alice/demo:files'
        self.assertEqual(self.apply(desired={key:1})[0][0][-1],rounded(1000))
        self.assertEqual(self.apply(desired={key:10**20})[0][0][-1],rounded(1_000_000))
        self.assertEqual(self.apply(desired={key:50_000})[0][0][-1],rounded(50_000))
        self.assertEqual(self.apply(clear=True)[0],[]) # already zero
        ledger={'kinds':{'1001':key},'projects':{}}
        with patch.object(limits,'project_id',return_value=1001):
            actions,_=limits.apply({'ids':{},'next':1000},{},ledger,'/workspace','/dev/test',Kernel(hard=100),default=1000,minimum=1,maximum=10000,headroom=1,now=1,clear=True)
        self.assertEqual(actions,[('/dev/test',1001,0)])
    def test_kernel_sets_only_block_limit_and_repeats_quotaon(self):
        kernel=limits.Kernel();calls=[]
        def call(command,device,number=0,row=None):calls.append((command,number,row))
        kernel.call=call;kernel.set('/dev/test',1000,1001)
        command,number,row=calls[-1];self.assertEqual((command,number,row.bhardlimit,row.bsoftlimit,row.valid,row.ihardlimit),(limits.Q_SETQUOTA,1000,1,0,1,0))
        with self.assertRaises(ValueError):kernel.set('/dev/test',0,100)
        kernel.enable('/dev/test');kernel.enable('/dev/test');self.assertEqual(len(calls),3)
        for code in (errno.EBUSY,errno.EEXIST):
            kernel.call=lambda *args:(_ for _ in ()).throw(OSError(code,'on'))
            with patch.object(limits.s,'enforcement',return_value=True):kernel.enable('/dev/test')
            with patch.object(limits.s,'enforcement',return_value=False),self.assertRaises(OSError):kernel.enable('/dev/test')
    def test_service_input_links_and_nonregular_files_refused(self):
        root=Path(self.config['root']);quota=root/'quota';quota.mkdir();(quota/'ids.json').symlink_to(self.base/'outside')
        with self.assertRaises(OSError):limits.inputs(root)
        (quota/'ids.json').unlink();os.mkfifo(quota/'ids.json')
        with self.assertRaises(ValueError):limits.inputs(root)
    def test_enabled_unit_persists_grace_before_kernel_writes_and_repeats_quotaon(self):
        root=Path(self.config['root']);folder=root/'quota';folder.mkdir()
        (folder/'ids.json').write_text(json.dumps({'next':1002,'ids':{'p:alice/demo:files':1001}}))
        state=self.base/'root-ledger';state.mkdir(mode=0o700);workspace=Path(self.config['workspacesRoot'])
        number=f'{os.major(workspace.stat().st_dev)}:{os.minor(workspace.stat().st_dev)}'
        original_fstat=os.fstat;original_read=Path.read_text;events=[]
        def fstat(fd):
            info=original_fstat(fd)
            if info.st_ino==state.stat().st_ino:
                values=list(info);values[4]=0;return os.stat_result(values)
            return info
        def read(path,*args,**kwargs):
            if str(path)=='/proc/self/mountinfo':return f'1 0 {number} / {self.base} rw - ext4 /dev/test rw\n'
            return original_read(path,*args,**kwargs)
        kernel=Kernel(used=150_000)
        kernel.enable=lambda device:events.append('enable')
        def set_limit(device,number,amount):
            self.assertTrue((state/'state.json').exists());events.append(amount)
        kernel.set=set_limit
        args=['--enabled','--account','fixture','--root',str(root),'--workspaces-root',str(workspace),
              '--state-dir',str(state),'--default-bytes','100000','--min-bytes','1000','--max-bytes','1000000','--headroom-bytes','10000',str(self.base)]
        with patch.object(limits.os,'geteuid',return_value=0),patch.object(limits.os,'fstat',side_effect=fstat),patch.object(Path,'read_text',read),patch.object(limits,'Kernel',return_value=kernel),patch.object(limits.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=123,pw_gid=123)),patch.object(limits,'project_id',return_value=1001),patch.object(limits,'protected_ids',return_value={0}),patch.object(limits,'nonfiles_ids',return_value={0}),patch.object(limits.s,'publish') as publish,patch.object(limits.time,'time',return_value=100),patch.object(limits.os,'statvfs',return_value=SimpleNamespace(f_frsize=4096)):
            self.assertEqual(limits.main(args),0);self.assertEqual(limits.main(args),0)
            self.assertEqual(publish.call_args.kwargs,{'name':'quota-limits.json'})
        self.assertEqual(events,['enable',rounded(160000,4096),'enable',rounded(160000,4096)])
        value=json.loads((state/'state.json').read_text())
        self.assertEqual(value['roots'][str(root)]['projects']['1001']['graceUntil'],100+7*86400)

    def test_actual_external_and_platform_roots_override_forged_registry_labels(self):
        root=Path(self.config['root']);workspace=Path(self.config['workspacesRoot'])
        external=self.base/'external';external.write_text('untouched')
        outputs=root/'outputs';outputs.mkdir();job=outputs/'job';job.mkdir()
        images=workspace/'.oci';images.mkdir();engine=images/'alice';engine.mkdir()
        ids={external.stat().st_ino:1001,root.stat().st_ino:1000,engine.stat().st_ino:1002,job.stat().st_ino:1003}
        with patch.object(limits.q,'projid',side_effect=lambda fd:ids.get(os.fstat(fd).st_ino,0)):
            denied=limits.protected_ids([self.base],[root,workspace])|limits.nonfiles_ids(root,workspace)
        self.assertTrue({0,1000,1001,1002,1003}<=denied)
        self.assertEqual(self.apply(denied=denied)[0],[])

    def test_node_sync_admin_only_replaces_whole_list(self):
        sync=f.module('project-storage-limits').sync;args={'limits':[{'ownerId':'alice','project':'demo','bytes':5_000_000_000}]}
        with self.assertRaises(PermissionError):sync(self.config,args)
        sync(self.config,{**args,'actor':{'isAdmin':True},'enabled':True});file=Path(self.config['root'])/'quota/limits.json'
        self.assertEqual(json.loads(file.read_text()),args)
        sync(self.config,{'actor':{'isAdmin':True},'limits':[]});self.assertEqual(json.loads(file.read_text()),{'limits':[]})
    def test_disk_floor_uses_mount_and_project_headroom_has_no_floor(self):
        store=f.module('project-store');path=Path(self.config['workspacesRoot']);disk=os.open(self.base,os.O_RDONLY);self.addCleanup(os.close,disk)
        def vfs(fd):
            at=Path(os.readlink('/proc/self/fd/'+str(fd))) if Path('/proc/self/fd').exists() else None
            free=200*1024**3 if at==self.base else 10*1024**3
            return SimpleNamespace(f_bavail=free,f_frsize=1,f_blocks=free+90*1024**3,f_bfree=free)
        # Descriptor identity works on both Linux and macOS.
        def reading(fd):
            free=200*1024**3 if os.fstat(fd).st_ino==self.base.stat().st_ino else 10*1024**3
            return SimpleNamespace(f_bavail=free,f_frsize=1,f_blocks=free+90*1024**3,f_bfree=free)
        with patch('os.fstatvfs',side_effect=reading):
            self.assertEqual(store.require_workspace_space(path,needed=1024)['availableBytes'],200*1024**3)
            with self.assertRaisesRegex(ValueError,'已用.*上限'):store.require_workspace_space(path,needed=11*1024**3)
        with patch('os.fstatvfs',return_value=SimpleNamespace(f_bavail=63*1024**3,f_frsize=1)):
            with self.assertRaisesRegex(ValueError,'hard floor'):store.require_workspace_space(path,needed=1)
    def test_edquot_and_xfs_enospc_localized_without_host_path(self):
        store=f.module('project-store')
        for code in (errno.EDQUOT,errno.ENOSPC):
            with patch.object(store,'quota_usage',return_value=(100,100,True)):
                message=store.storage_error(self.config,OSError(code,'English','/secret/host'))
            self.assertIn('已用',message);self.assertIn('上限',message);self.assertNotIn('/secret',message)
    def test_upload_error_wrapper_keeps_timeout_and_only_localizes_quota(self):
        uploads=f.module('data-uploads').Uploads(self.config,'alice')
        with patch.object(uploads,'_process',side_effect=TimeoutError('lost reply')):
            with self.assertRaises(TimeoutError):uploads.process('chunk',{})
        with patch.object(uploads,'_process',side_effect=OSError(errno.EDQUOT,'Disk quota exceeded','/private/host')):
            with self.assertRaisesRegex(ValueError,'已用.*上限'):uploads.process('chunk',{})

    def test_node_wrapper_preserves_lost_reply_exception_type(self):
        spec=importlib.util.spec_from_file_location('security_fixture',Path(__file__).with_name('project-security.test.py'))
        security=importlib.util.module_from_spec(spec);spec.loader.exec_module(security)
        case=security.ProjectContract();case.setUp();self.addCleanup(case.doCleanups);node=case.node()
        with patch.object(node,'process_request',side_effect=TimeoutError('lost reply')):
            with self.assertRaises(TimeoutError):node.process('sync',{})
        with patch.object(node,'process_request',side_effect=OSError(errno.ENOSPC,'No space left on device','/host/private')):
            with self.assertRaisesRegex(ValueError,'空间不足'):node.process('data.upload.chunk',{})

    def test_diagnostics_current_floor_and_quota_errors(self):
        store=f.module('project-store');diag=f.module('job-diagnostics')
        error=store.ProjectError('workspace_quota',store.quota_message(100,100),{'usedBytes':100,'limitBytes':100})
        self.assertEqual(diag._runner_error(error,'WORKSPACE_ADMISSION')['reason'],'WORKSPACE_QUOTA')
        try:store.workspace_storage_check(63*1024**3,1)
        except ValueError as error:record=diag._runner_error(error,'WORKSPACE_ADMISSION')
        self.assertEqual((record['reason'],record['hardFloorBytes']),('WORKSPACE_RESERVE',64*1024**3))

if __name__=='__main__':unittest.main()
