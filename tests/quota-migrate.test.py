"""Maintenance migration: plan, every tagging phase, hard links, idempotent rerun."""
import copy,importlib.util,json,os,shutil,tempfile,unittest,uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('quota_fixture',Path(__file__).with_name('quota-ids.test.py'))
fixture=importlib.util.module_from_spec(s);s.loader.exec_module(fixture)
s=importlib.util.spec_from_file_location('quota_migrate',ROOT/'deploy/node/quota-migrate.py')
migrate=importlib.util.module_from_spec(s);s.loader.exec_module(migrate)


class Migration(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.mount=Path(temporary.name).resolve();base=self.mount/'stargate'
        self.paths={k:base/v for k,v in dict(root='state',workspacesRoot='workspaces',datasetsRoot='datasets').items()}
        profile={k:str(v) for k,v in self.paths.items()}
        self.config=dict(account='nodeops',releaseRoot=str(base/'releases'),dataMountPoints=[str(self.mount)],
                         gpuq=dict(root=str(base/'scheduler'),db_path=str(base/'scheduler/state/gpuq.db'),log_dir=str(base/'scheduler/logs'),
                                   control_dir=str(base/'control')),profiles={'7IM':profile,'R6t':dict(profile)})
        for path in (*self.paths.values(),base/'releases',base/'scheduler/state',base/'scheduler/logs',base/'control'):path.mkdir(parents=True)
        (base/'scheduler/state/gpuq.db').touch()
        root,ws,ds=self.paths['root'],self.paths['workspacesRoot'],self.paths['datasetsRoot']
        for name in ('jobs','samples','uploads'):(root/name).mkdir()
        project=ws/'alice'/'demo';(project/'code').mkdir(parents=True);(project/'project.json').write_text('{}')
        (project/'oci.json').write_text(json.dumps({'container':'gpuq-dev-1'}));(project/'code'/'train.py').write_text('x')
        (ws/'alice'/'loose').mkdir();(ws/'alice'/'loose'/'big').write_bytes(b'x'*8192)
        self.layer=ws/'.oci'/'alice'/'graph'/'overlay'/'L1'
        for name in ('diff/etc','work/work'):(self.layer/name).mkdir(parents=True)
        (ws/'.oci'/'alice'/'graph'/'overlay'/'image1'/'diff').mkdir(parents=True)
        self.job,self.orphan=str(uuid.uuid4()),str(uuid.uuid4())
        for job in (self.job,self.orphan):(root/'outputs'/job).mkdir(parents=True);(root/'outputs'/job/'r').write_text('r')
        (root/'jobs'/(self.job+'.json')).write_text(json.dumps({'ownerId':'alice','userId':'bob','project':'demo'}))
        self.copy,self.export=str(uuid.uuid4()),str(uuid.uuid4())
        (ws/'.copies'/self.copy).mkdir(parents=True);(ws/'.copies'/self.copy/'project.json').write_text(json.dumps({'ownerId':'carol','project':'p2'}))
        (ws/'.copy-exports'/self.export).mkdir(parents=True);(root/'transfers').mkdir()
        (root/'transfers'/(self.export+'.source.json')).write_text(json.dumps({'request':{'source':{'userId':'dave','project':'p3'}}}))
        (ds/'images').mkdir();(ds/'images'/'shared.bin').write_bytes(b'd'*100)
        self.trash={}
        for base_dir,kind,original,extra in [(ws,'project',ws/'alice'/'old','{}'),(root,'output',root/'outputs'/self.job/'x',''),
                                             (ds,'dataset',ds/'gone'/'f',''),(root,'output',self.mount/'nowhere','')]:
            key=str(uuid.uuid4());(base_dir/'.trash').mkdir(exist_ok=True);(base_dir/'.trash'/(key+'.data')).mkdir()
            row={'kind':kind,'state':'TRASHED','originalPath':str(original)}
            if kind=='output' and original.name=='x':row['jobId']=self.job
            (base_dir/'.trash'/(key+'.json')).write_text(json.dumps(row));self.trash[(kind,original.name)]=base_dir/'.trash'/(key+'.data')
        (self.mount/'cyx').mkdir();os.link(ds/'images'/'shared.bin',self.mount/'cyx'/'shared.bin');(self.mount/'cyx'/'own').write_text('o')
        (self.mount/'lost+found').mkdir();(self.mount/'dyx').symlink_to(self.mount/'cyx');(self.mount/'top.tar').write_bytes(b't')
        (base/'oldstuff').mkdir()
        self.out=[]

    def run_migration(self,dry_run,only=None,before_run=None):
        account=SimpleNamespace(pw_name='nodeops',pw_uid=os.getuid(),pw_gid=os.getgid(),pw_dir='/home/nodeops')
        with patch.object(migrate.pwd,'getpwnam',return_value=account),patch.object(migrate.os,'chown'):
            tool=migrate.Migration(self.config,ROOT/'node',out=self.out.append,only=only)
            with patch.object(tool,'containers',return_value=[{'name':'gpuq-dev-1','labels':{},'upper':str(self.layer/'diff')}]),\
                 patch.object(tool.sampler,'filesystems',return_value=[{'mountPoints':[str(self.mount)],'quota':True,'usedBytes':1,'ids':{'0':{'bytes':1}}}]):
                if before_run:before_run(tool)
                return tool.run(dry_run)

    def ids(self):return tool_ids(self.paths['root'])

    def test_dry_run_prints_the_plan_and_changes_nothing(self):
        with fixture.Kernel() as kernel:self.assertEqual(self.run_migration(True),0)
        self.assertEqual(kernel.attrs,{});self.assertFalse((self.paths['root']/'quota'/'ids.json').exists())
        text='\n'.join(self.out)
        for expected in ('仅打印计划','9 外部目录',str(self.mount/'cyx'),str(self.mount/'stargate'/'oldstuff'),'回收站条目无法判断归属'):
            self.assertIn(expected,text)
        for absent in ('lost+found',str(self.mount/'dyx')+' ->'):self.assertNotIn(absent,text)

    def test_full_run_tags_every_phase_and_keeps_container_type_folders_plain(self):
        root,ws,ds=self.paths['root'],self.paths['workspacesRoot'],self.paths['datasetsRoot'];q=fixture.q
        with fixture.Kernel() as kernel:
            self.run_migration(False);ids=q.read(root/'quota')['ids']
            def expect(path,key,inherit=True):self.assertEqual(kernel.of(path),(ids[key],inherit),str(path))
            expect(root/'jobs',q.PLATFORM);expect(root/'quota',q.PLATFORM);expect(Path(self.config['releaseRoot']),q.PLATFORM)
            expect(Path(self.config['gpuq']['log_dir']),q.PLATFORM)
            expect(ws/'.oci'/'alice',q.images_key('alice'));expect(ws/'.oci'/'alice'/'graph'/'overlay'/'image1'/'diff',q.images_key('alice'))
            expect(self.layer,q.images_key('alice'),False);expect(self.layer/'diff'/'etc',q.env_key('alice','demo'))
            expect(self.layer/'work'/'work',q.env_key('alice','demo'))
            expect(ws/'alice'/'demo',q.files_key('alice','demo'));expect(ws/'alice'/'demo'/'code'/'train.py',q.files_key('alice','demo'),False)
            expect(root/'outputs'/self.job,q.outputs_key('alice','demo'));expect(root/'outputs'/self.orphan,q.UNASSIGNED)
            expect(ws/'.copies'/self.copy,q.files_key('carol','p2'));expect(ws/'.copy-exports'/self.export,q.files_key('dave','p3'))
            expect(ds/'images',q.dataset_key('images'));expect(ds/'images'/'shared.bin',q.dataset_key('images'),False)
            expect(self.trash[('project','old')],q.files_key('alice','old'));expect(self.trash[('output','x')],q.outputs_key('alice','demo'))
            expect(self.trash[('dataset','f')],q.dataset_key('gone'));self.assertEqual(kernel.of(self.trash[('output','nowhere')]),(0,False))
            cyx=q.external_key(self.mount/'cyx');expect(self.mount/'cyx',cyx,False);expect(self.mount/'cyx'/'own',cyx,False)
            expect(self.mount/'stargate'/'oldstuff',q.external_key(self.mount/'stargate'/'oldstuff'),False)
            expect(self.mount/'top.tar',q.external_key(self.mount/'top.tar'),False)
            self.assertEqual(kernel.of(self.mount/'cyx'/'shared.bin'),(ids[q.dataset_key('images')],False),'hard link stays with the dataset')
            for path in (self.mount,self.mount/'stargate',root,root/'outputs',ws,ws/'alice',ws/'.oci',ws/'.copies',ws/'.copy-exports',
                         ws/'.trash',root/'.trash',ds,ds/'.trash',self.mount/'lost+found'):
                self.assertFalse(kernel.of(path)[1],f'{path} must never inherit')
            self.assertEqual(kernel.of(self.mount/'lost+found'),(0,False))
            text='\n'.join(self.out);self.assertIn('硬链接且已有编号而跳过 1',text);self.assertIn(str(ws/'alice'/'loose'),text)
            before=dict(ids);self.out.clear();self.run_migration(False)
            self.assertEqual(q.read(root/'quota')['ids'],before,'a rerun reuses every ID')
            self.assertTrue((root/'quota'/'migrated.json').is_file())

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(),'Linux descriptor xattrs')
    def test_special_inodes_are_rebuilt_in_every_migrated_tree(self):
        roots=[self.paths['workspacesRoot']/'alice'/'demo',self.paths['root']/'outputs'/self.job,
               self.layer/'diff',self.paths['datasetsRoot']/'images',self.trash[('project','old')]]
        before={}
        for root in roots:
            (root/'old-link').symlink_to('missing');os.mkfifo(root/'old-fifo')
            before[root]=(os.lstat(root/'old-link').st_ino,os.lstat(root/'old-fifo').st_ino)
        with fixture.Kernel():self.run_migration(False)
        for root in roots:
            self.assertNotEqual(os.lstat(root/'old-link').st_ino,before[root][0])
            self.assertNotEqual(os.lstat(root/'old-fifo').st_ino,before[root][1])
            self.assertEqual(os.readlink(root/'old-link'),'missing')
        self.assertIn('错误 0','\n'.join(self.out))

    def test_each_group_only_tags_its_scope_and_platform_marks_migration(self):
        for group in ('datasets','external','platform'):
            with self.subTest(group=group),fixture.Kernel() as kernel:
                self.run_migration(False,only=group)
                ids=self.ids()
                expected={'datasets':lambda key:key.startswith('d:'),'external':lambda key:key.startswith('x:'),
                          'platform':lambda key:not key.startswith(('d:','x:'))}[group]
                # Earlier groups keep their stable registrations; only this group is walked.
                if group=='datasets':self.assertTrue(all(expected(key) for key in ids))
                if group=='external':
                    self.assertFalse(kernel.of(self.mount/'cyx')[1])
                    self.assertEqual(kernel.of(self.paths['workspacesRoot']/'alice'/'demo'),(0,False))
                marker=self.paths['root']/'quota'/'migrated.json'
                self.assertEqual(marker.exists(),group=='platform')

    def test_symlinked_config_is_resolved_and_protected_roots_are_refused(self):
        alias=self.mount/'alias';alias.symlink_to(self.mount/'stargate',target_is_directory=True)
        for profile in self.config['profiles'].values():
            for field,path in self.paths.items():profile[field]=str(alias/path.name)
        self.config['releaseRoot']=str(alias/'releases')
        with fixture.Kernel() as kernel:self.run_migration(False)
        self.assertFalse(kernel.of(self.paths['workspacesRoot'])[1])
        self.config['releaseRoot']=str(alias/'datasets')
        with fixture.Kernel(),self.assertRaisesRegex(SystemExit,'受保护'):
            self.run_migration(False)

    def test_dataset_hardlinks_keep_the_first_nonzero_id_and_external_inheritance_is_cleared(self):
        ds=self.paths['datasetsRoot'];(ds/'second').mkdir();os.link(ds/'images'/'shared.bin',ds/'second'/'shared')
        (self.mount/'cyx'/'nested').mkdir()
        with fixture.Kernel() as kernel:
            fixture.q.tag_tree(self.mount/'cyx',42)
            self.run_migration(False)
            self.assertEqual(kernel.of(ds/'images'/'shared.bin'),(42,False))
            self.assertFalse(kernel.of(self.mount/'cyx')[1]);self.assertFalse(kernel.of(self.mount/'cyx'/'nested')[1])
        self.assertIn('硬链接且已有编号而跳过','\n'.join(self.out))

    def test_layer_disappearing_after_inventory_is_skipped_without_aborting_other_rows(self):
        def remove_layer(tool):
            report=tool.report_plan
            def after_report():report();shutil.rmtree(self.layer)
            tool.report_plan=after_report
        with fixture.Kernel() as kernel:
            self.run_migration(False,before_run=remove_layer)
            self.assertNotEqual(kernel.of(self.paths['workspacesRoot']/'alice'/'demo')[0],0)
        self.assertIn('容器层已消失，跳过','\n'.join(self.out))
        self.assertIn('跳过 1','\n'.join(self.out))

    def test_registry_chown_does_not_follow_a_link(self):
        account=SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())
        with patch.object(migrate.pwd,'getpwnam',return_value=account),patch.object(migrate.os,'chown') as chown:
            tool=migrate.Migration(self.config,ROOT/'node');tool.ensure_registry()
        self.assertFalse(chown.call_args.kwargs['follow_symlinks'])


def tool_ids(root):return fixture.q.read(Path(root)/'quota')['ids']


class Refusals(unittest.TestCase):
    def test_root_is_required_and_profiles_must_share_paths(self):
        with patch.object(migrate.os,'geteuid',return_value=1000),self.assertRaisesRegex(SystemExit,'root'):
            migrate.main(['--config','/nonexistent'])
        config=dict(account='nodeops',releaseRoot='/r',dataMountPoints=['/'],profiles={'a':dict(root=str(ROOT),workspacesRoot=str(ROOT),datasetsRoot=str(ROOT)),
                    'b':dict(root=str(ROOT/'node'),workspacesRoot=str(ROOT),datasetsRoot=str(ROOT))})
        with patch.object(migrate.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=1,pw_gid=1)),self.assertRaisesRegex(SystemExit,'不一致'):
            migrate.Migration(config,ROOT/'node')


if __name__=='__main__':unittest.main()
