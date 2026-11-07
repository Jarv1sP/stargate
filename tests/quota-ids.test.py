"""Project-ID registry and tagging against a simulated FS_IOC_FS[GS]ETXATTR kernel."""
import concurrent.futures,errno,fcntl,importlib.util,io,json,os,signal,socket,stat,struct,subprocess,sys,threading,unittest,uuid
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
s=importlib.util.spec_from_file_location('directory_fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
q=f.module('quota-ids')


class Kernel:
    """Per-inode xflags/projid; PROJINHERIT only sticks on directories, as on ext4/XFS."""
    def __init__(self,fail=None):self.attrs={};self.fail=fail or (lambda info:None);self.real=fcntl.ioctl

    def ioctl(self,fd,request,arg=0,*rest):
        if request not in (q.FS_IOC_FSGETXATTR,q.FS_IOC_FSSETXATTR):return self.real(fd,request,arg,*rest)
        info=os.fstat(fd);key=(info.st_dev,info.st_ino);flags,value=self.attrs.get(key,(0,0))
        if request==q.FS_IOC_FSGETXATTR:arg[:]=struct.pack(q.FSXATTR,flags,0,0,value,0);return 0
        error=self.fail(info)
        if error:raise OSError(error,os.strerror(error))
        flags,_,_,value,_=struct.unpack(q.FSXATTR,arg)
        if not stat.S_ISDIR(info.st_mode):flags&=~q.FS_XFLAG_PROJINHERIT
        self.attrs[key]=(flags,value);return 0

    def of(self,path):
        info=os.stat(path,follow_symlinks=False);flags,value=self.attrs.get((info.st_dev,info.st_ino),(0,0))
        return value,bool(flags&q.FS_XFLAG_PROJINHERIT)

    def forget(self,*paths):
        # A recreated directory may reuse a deleted inode number; a real new inode starts on ID 0.
        for path in paths:
            info=os.stat(path,follow_symlinks=False);self.attrs.pop((info.st_dev,info.st_ino),None)

    def __enter__(self):self.patch=patch.object(fcntl,'ioctl',self.ioctl);self.patch.start();return self
    def __exit__(self,*args):self.patch.stop()


class Registry(unittest.TestCase):
    setUp=f.DirectoryContract.setUp

    def test_ids_start_at_1000_are_stable_and_never_reused(self):
        folder=q.folder(self.config)
        self.assertEqual(q.allocate(folder,['p:a/x:files','d:images']),{'p:a/x:files':1000,'d:images':1001})
        self.assertEqual(q.allocate(folder,['d:images','i:a']),{'d:images':1001,'i:a':1002})
        value=json.loads((folder/'ids.json').read_text())
        self.assertEqual(value,{'next':1003,'ids':{'p:a/x:files':1000,'d:images':1001,'i:a':1002}})
        self.assertEqual(stat.S_IMODE((folder/'ids.json').stat().st_mode),0o600)
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode),0o700)
        self.assertEqual(q.read(folder),{'next':1003,'ids':value['ids']})

    def test_a_missing_registry_reads_empty(self):
        self.assertEqual(q.read(Path(self.config['root'])/'quota'),{'next':1000,'ids':{}})

    def test_key_names_cover_every_design_kind(self):
        self.assertEqual([q.describe(k) for k in (q.files_key('u','p'),q.outputs_key('u','p'),q.env_key('u','p:x'),q.images_key('u'),
                                                     q.dataset_key('d'),q.PLATFORM,q.UNASSIGNED,q.external_key('/data1/cyx'),'?')],
                         [('project','u','p','files'),('project','u','p','outputs'),('project','u','p:x','env'),('images','u'),
                          ('dataset','d'),('platform',),('unassignedOutputs',),('external','/data1/cyx'),None])


class Tagging(unittest.TestCase):
    setUp=f.DirectoryContract.setUp

    def tree(self):
        top=self.base/'tree';(top/'a'/'b').mkdir(parents=True);(top/'a'/'f').write_bytes(b'x');(top/'g').write_bytes(b'y')
        outside=self.base/'outside';outside.mkdir();(outside/'secret').write_bytes(b'z')
        (top/'link').symlink_to(outside,target_is_directory=True);(top/'filelink').symlink_to(outside/'secret')
        os.mkfifo(top/'fifo');return top,outside

    def test_directories_inherit_files_only_take_the_id_and_links_are_not_followed(self):
        top,outside=self.tree()
        with Kernel() as kernel:counts=q.tag_tree(top,1234)
        for path in (top,top/'a',top/'a'/'b'):self.assertEqual(kernel.of(path),(1234,True))
        for path in (top/'a'/'f',top/'g'):self.assertEqual(kernel.of(path),(1234,False))
        for path in (outside,outside/'secret',top/'fifo'):self.assertEqual(kernel.of(path),(0,False))
        self.assertEqual((counts['directories'],counts['files'],counts['errors']),(3,2,{}))

    def test_container_type_top_keeps_its_id_and_drops_inherit_and_pruned_directories_are_untouched(self):
        top,_=self.tree()
        with Kernel() as kernel:
            q.tag_dir(top,7,True);q.tag_tree(top,1234,top=False,prune={(os.stat(top/'a').st_dev,os.stat(top/'a').st_ino)})
        self.assertEqual(kernel.of(top),(7,False));self.assertEqual(kernel.of(top/'a'),(0,False));self.assertEqual(kernel.of(top/'g'),(1234,False))

    def test_hard_linked_inodes_that_already_have_an_id_stay_with_their_first_owner(self):
        dataset=self.base/'datasets'/'d';dataset.mkdir();(dataset/'shared').write_bytes(b'x')
        external=self.base/'external';external.mkdir();os.link(dataset/'shared',external/'shared');(external/'own').write_bytes(b'y')
        os.link(external/'own',external/'own2')
        with Kernel() as kernel:
            q.tag_tree(dataset,1001);counts=q.tag_tree(external,2001,linked=True)
        self.assertEqual(kernel.of(external/'shared'),(1001,False));self.assertEqual(kernel.of(external/'own'),(2001,False))
        self.assertEqual(counts['linked'],2)

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(),'Linux descriptor xattrs')
    def test_migration_rebuilds_symlinks_and_fifo_preserves_metadata_and_leaves_sockets(self):
        top,outside=self.tree();sock=socket.socket(socket.AF_UNIX);sock.bind(str(top/'socket'));self.addCleanup(sock.close)
        original={name:os.lstat(top/name) for name in ('link','filelink','fifo','socket')}
        os.chmod(top/'fifo',0o640);os.utime(top/'fifo',ns=(1234567890000000000,1234567891000000000))
        original['fifo']=os.lstat(top/'fifo')
        target_info=os.stat(outside/'secret')
        with Kernel() as kernel:counts=q.tag_tree(top,1234,rebuild=True)
        self.assertEqual((counts['symlinks'],counts['fifos'],counts['sockets'],counts['errors']),(2,1,1,{}))
        for name in ('link','filelink','fifo'):
            info=os.lstat(top/name);self.assertNotEqual(info.st_ino,original[name].st_ino)
            self.assertEqual((info.st_uid,info.st_gid,info.st_mtime_ns),(original[name].st_uid,original[name].st_gid,original[name].st_mtime_ns))
        self.assertEqual(os.lstat(top/'socket').st_ino,original['socket'].st_ino)
        self.assertEqual(os.readlink(top/'link'),str(outside))
        self.assertEqual(stat.S_IMODE(os.stat(top/'fifo').st_mode),0o640)
        self.assertEqual(os.stat(outside/'secret').st_mtime_ns,target_info.st_mtime_ns)
        self.assertEqual(list(top.glob('.quota-*')),[])

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(),'Linux descriptor xattrs')
    def test_special_rebuild_copies_every_xattr_and_keeps_original_on_failure(self):
        top,_=self.tree();fd=os.open(top,os.O_RDONLY|os.O_DIRECTORY);self.addCleanup(os.close,fd)
        attrs={'trusted.overlay.origin':b'origin','user.overlay.whiteout':b'y','user.note':b'n'}
        before=os.lstat(top/'filelink')
        with (
            patch.object(q.os,'listxattr',return_value=list(attrs)),patch.object(q.os,'getxattr',side_effect=lambda path,key,**kw:attrs[key]),
            patch.object(q.os,'setxattr') as copied,
        ):
            q.rebuild_special('filelink',fd,q.counter())
        self.assertEqual({call.args[1]:call.args[2] for call in copied.call_args_list},attrs)
        self.assertTrue(all(call.kwargs['follow_symlinks'] is False for call in copied.call_args_list))
        before=os.lstat(top/'filelink')
        with (
            patch.object(q.os,'listxattr',return_value=['user.note']),patch.object(q.os,'getxattr',return_value=b'n'),
            patch.object(q.os,'setxattr',side_effect=PermissionError(1,'denied')),self.assertRaises(PermissionError),
        ):
            q.rebuild_special('filelink',fd,q.counter())
        self.assertEqual(os.lstat(top/'filelink').st_ino,before.st_ino)
        self.assertEqual(list(top.glob('.quota-*')),[])

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(),'Linux descriptor xattrs')
    def test_whiteout_is_recreated_as_character_device_zero_with_its_xattrs(self):
        top,_=self.tree();source=top/'whiteout';source.touch();info=os.lstat(source)
        whiteout=SimpleNamespace(st_mode=stat.S_IFCHR|0o600,st_rdev=0,st_uid=info.st_uid,st_gid=info.st_gid,
                                 st_atime_ns=info.st_atime_ns,st_mtime_ns=info.st_mtime_ns,
                                 st_dev=info.st_dev,st_ino=info.st_ino,st_ctime_ns=info.st_ctime_ns)
        fd=os.open(top,os.O_RDONLY|os.O_DIRECTORY);self.addCleanup(os.close,fd);counts=q.counter()
        def create(name,mode,device,*,dir_fd):
            child=os.open(name,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600,dir_fd=dir_fd);os.close(child)
        with (
            patch.object(q.os,'stat',return_value=whiteout),patch.object(q.os,'listxattr',return_value=['trusted.overlay.whiteout']),
            patch.object(q.os,'getxattr',return_value=b'y'),patch.object(q.os,'setxattr') as xattr,patch.object(q.os,'mknod',side_effect=create) as mknod,
        ):
            q.rebuild_special('whiteout',fd,counts)
        self.assertEqual(mknod.call_args.args[1:],(stat.S_IFCHR|0o600,0))
        self.assertEqual(xattr.call_args.args[1:],('trusted.overlay.whiteout',b'y'));self.assertEqual(counts['whiteouts'],1)

    def test_each_directory_tags_its_regular_files_before_enabling_inheritance(self):
        top=self.base/'online';(top/'train').mkdir(parents=True);(top/'val').mkdir()
        for name in ('train/.upload-a','val/.upload-b'):(top/name).write_bytes(b'old')
        with Kernel() as kernel:
            original=q.setx;seen=[]
            def setx(fd,value,inherit=None):
                info=os.fstat(fd)
                if inherit is True:
                    for name in os.listdir(fd):
                        child=os.stat(name,dir_fd=fd,follow_symlinks=False)
                        if stat.S_ISREG(child.st_mode):
                            self.assertEqual(kernel.of(Path('/proc/self/fd')/str(fd)/name)[0] if Path('/proc').exists() else kernel.attrs[(child.st_dev,child.st_ino)][1],value)
                    if info.st_ino==os.stat(top/'train').st_ino:
                        self.assertEqual(kernel.of(top/'val'),(0,False))
                        seen.append('train')
                return original(fd,value,inherit)
            with patch.object(q,'setx',side_effect=setx):q.tag_tree(top,1001)
        self.assertEqual(seen,['train'])

    def test_second_pass_tags_a_file_created_before_directory_inheritance(self):
        top=self.base/'online';top.mkdir();(top/'old').write_text('x')
        with Kernel() as kernel:
            original=q.setx;injected=[]
            def setx(fd,value,inherit=None):
                if inherit is True and not injected:
                    (top/'late').write_text('late');injected.append(True)
                return original(fd,value,inherit)
            with patch.object(q,'setx',side_effect=setx):q.tag_tree(top,1001)
        self.assertEqual(kernel.of(top/'late'),(1001,False))

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(),'Linux descriptor xattrs')
    def test_special_rebuild_skips_a_concurrent_replacement(self):
        top,_=self.tree();fd=os.open(top,os.O_RDONLY|os.O_DIRECTORY);self.addCleanup(os.close,fd)
        counts=q.counter();original=q.os.utime
        def replace(*args,**kwargs):
            original(*args,**kwargs)
            replacement=top/'user-new';replacement.write_text('keep the user content');os.replace(replacement,top/'filelink')
        with patch.object(q.os,'utime',side_effect=replace):q.rebuild_special('filelink',fd,counts)
        self.assertEqual((top/'filelink').read_text(),'keep the user content')
        self.assertEqual((counts['changed'],counts['symlinks']),(1,0));self.assertEqual(list(top.glob('.quota-*')),[])

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(),'Linux descriptor xattrs')
    def test_interruption_cleans_temporary_inode_and_keeps_layer_root_plain(self):
        layer=self.layer();(layer/'symlink').symlink_to('diff')
        with Kernel() as kernel,patch.object(q.os,'utime',side_effect=SystemExit(143)),self.assertRaises(SystemExit):
            q.tag_layer(layer,1003,1002,rebuild=True,cleanup=True)
        self.assertEqual(kernel.of(layer),(1002,False));self.assertTrue((layer/'symlink').is_symlink())
        self.assertEqual(list(layer.glob('.quota-*')),[])

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(),'Linux descriptor xattrs')
    def test_layer_root_keeps_the_images_id_during_direct_special_rebuild(self):
        layer=self.layer();(layer/'symlink').symlink_to('diff');original=q.rebuild_special;observed=[]
        with Kernel() as kernel:
            def rebuilt(*args,**kwargs):
                self.assertEqual(kernel.of(layer),(1002,False));observed.append(True)
                return original(*args,**kwargs)
            with patch.object(q,'rebuild_special',side_effect=rebuilt):q.tag_layer(layer,1003,1002,rebuild=True,cleanup=True)
        self.assertEqual(observed,[True]);self.assertEqual(os.readlink(layer/'symlink'),'diff')

    def test_reserved_temporary_names_are_cleaned_without_following_links(self):
        top=self.base/'leftovers';top.mkdir();outside=self.base/'kept';outside.mkdir();(outside/'data').write_text('keep')
        (top/('.quota-'+'a'*32)).symlink_to(outside)
        staging=top/('.quota-'+'b'*32);staging.mkdir();(staging/'new').symlink_to(outside/'data')
        (top/'.quota-user-file').write_text('keep');counts=q.counter()
        fd=os.open(top,os.O_RDONLY|os.O_DIRECTORY)
        try:q.cleanup_temporary(fd,counts)
        finally:os.close(fd)
        self.assertEqual(counts['cleaned'],2);self.assertEqual((outside/'data').read_text(),'keep')
        self.assertEqual((top/'.quota-user-file').read_text(),'keep')

    def test_errors_are_counted_and_the_walk_continues(self):
        top,_=self.tree();blocked=os.stat(top/'a'/'f').st_ino
        with Kernel(fail=lambda info:errno.EPERM if info.st_ino==blocked else None) as kernel:counts=q.tag_tree(top,5)
        self.assertEqual(counts['errors'],{'EPERM':2});self.assertEqual(kernel.of(top/'g'),(5,False))

    def test_unsupported_filesystem_fails_at_the_top(self):
        top,_=self.tree()
        with Kernel(fail=lambda info:errno.EOPNOTSUPP),self.assertRaises(OSError) as caught:q.tag_tree(top,5)
        self.assertEqual(caught.exception.errno,errno.EOPNOTSUPP)

    def layer(self):
        layer=self.base/'graph'/'overlay'/'abc'
        for name in ('diff','work/work','merged'):(layer/name).mkdir(parents=True)
        (layer/'diff'/'etc').mkdir();(layer/'link').write_text('L');(layer/'lower').write_text('l:X')
        return layer

    def test_layer_directory_keeps_images_id_without_inherit_and_everything_below_is_one_env_id(self):
        layer=self.layer()
        with Kernel() as kernel:q.tag_dir(layer.parent,1002,True);counts=q.tag_layer(layer,1003,1002)
        self.assertEqual(kernel.of(layer),(1002,False))
        for name in ('diff','diff/etc','work','work/work','merged'):self.assertEqual(kernel.of(layer/name),(1003,True),name)
        for name in ('link','lower'):self.assertEqual(kernel.of(layer/name),(1003,False))
        self.assertEqual(counts['errors'],{})

    def test_partial_layer_failure_puts_children_back_on_the_images_id(self):
        layer=self.layer();blocked=os.stat(layer/'work'/'work').st_ino
        with Kernel(fail=lambda info:errno.EPERM if info.st_ino==blocked else None) as kernel:counts=q.tag_layer(layer,1003,1002)
        self.assertEqual(counts['errors'],{'EPERM':1})
        for name in ('diff','diff/etc','merged'):self.assertEqual(kernel.of(layer/name),(1002,True),name)

    def test_heal_retags_only_the_directory_that_lost_the_env_id(self):
        layer=self.layer()
        with Kernel() as kernel:
            q.tag_layer(layer,1003,1002);self.assertFalse(q.heal_layer(layer,1003))
            (layer/'work'/'work').rmdir();(layer/'work').rmdir();(layer/'work'/'work').mkdir(parents=True)
            kernel.forget(layer/'work',layer/'work'/'work')
            self.assertTrue(q.heal_layer(layer,1003))
            self.assertEqual(kernel.of(layer/'work'),(1003,True));self.assertEqual(kernel.of(layer/'work'/'work'),(1003,True))
            fresh=layer.parent/'fresh'
            for name in ('diff','work'):(fresh/name).mkdir(parents=True)
            kernel.forget(fresh/'diff',fresh/'work')
            self.assertFalse(q.heal_layer(fresh,1003))  # never tagged: leave it to the migration
            self.assertEqual(kernel.of(fresh/'diff'),(0,False))

    def test_assign_never_raises_and_leaves_one_diagnostic_line(self):
        top,_=self.tree();err=io.StringIO()
        with Kernel(fail=lambda info:errno.EOPNOTSUPP),redirect_stderr(err):
            self.assertIsNone(q.assign(self.config,'d:x',top))
        self.assertEqual(len(err.getvalue().splitlines()),1);self.assertIn('未登记',err.getvalue())
        self.assertIn('d:x',q.read(q.folder(self.config))['ids'])


class RuntimeEntries(unittest.TestCase):
    """Every platform path that creates a project, output, dataset, copy staging, engine or layer tags it."""
    setUp=f.DirectoryContract.setUp

    def ids(self):return q.read(Path(self.config['root'])/'quota')['ids']

    def ops(self):
        return f.module('project-ops').ProjectOperations(SimpleNamespace(CONFIG=self.config,ROOT=Path(self.config['root'])))

    def assert_container_type(self,kernel,*paths):
        for path in paths:self.assertFalse(kernel.of(path)[1],f'{path} must never inherit')

    def test_project_create_and_task_output_use_the_project_owner(self):
        ops=self.ops()
        with Kernel() as kernel:
            ops.store.create('alice','demo');job=str(uuid.uuid4())
            paths=ops.store.runtime_paths({'userId':'bob','ownerId':'alice','project':'demo'},job)
            ops.store.runtime_paths({'userId':'bob','ownerId':'alice','project':'demo'},job)
        ids=self.ids();project=ops.store.path/'alice'/'demo'
        for path in (project,project/'code',project/'home'):self.assertEqual(kernel.of(path),(ids[q.files_key('alice','demo')],True))
        self.assertEqual(kernel.of(paths['output']),(ids[q.outputs_key('alice','demo')],True))
        self.assertNotIn(q.outputs_key('bob','demo'),ids)
        self.assert_container_type(kernel,ops.store.path,ops.store.path/'alice',ops.store.root,ops.store.root/'outputs')

    def test_new_dataset_folder_is_tagged_once_for_every_creation_path(self):
        data=f.module('local-data')
        with Kernel() as kernel:
            root=data.dataset_root(self.config,'images',create=True);(root/'sub').mkdir()
            kernel.attrs.clear();data.dataset_root(self.config,'images',create=True)
        self.assertEqual(kernel.of(root),(0,False),'an existing dataset is left to the migration')
        with Kernel() as kernel:
            self.upload('a.txt',b'abc')
        self.assertEqual(kernel.of(Path(self.config['datasetsRoot'])/'shared'),(self.ids()[q.dataset_key('shared')],True))
        self.assert_container_type(kernel,Path(self.config['datasetsRoot']))

    def test_concurrent_dataset_creation_publishes_only_after_tagging(self):
        data=f.module('local-data');tagged=threading.Event();release=threading.Event();seen=[]
        qmod=SimpleNamespace(dataset_key=q.dataset_key)
        def assign(config,key,path):
            seen.append(path);tagged.set()
            self.assertFalse((Path(config['datasetsRoot'])/'race').exists())
            self.assertTrue(release.wait(5))
        qmod.assign=assign
        original=data.module
        with patch.object(data,'module',side_effect=lambda name:qmod if name=='quota-ids' else original(name)),concurrent.futures.ThreadPoolExecutor(2) as pool:
            first=pool.submit(data.dataset_root,self.config,'race',True);self.assertTrue(tagged.wait(5))
            second=pool.submit(data.dataset_root,self.config,'race',True)
            release.set();one=first.result(5);two=second.result(5)
        self.assertEqual(one,two);self.assertEqual(len(seen),1)
        self.assertTrue(seen[0].name.startswith('.dataset-'));self.assertFalse(seen[0].exists())

    def test_dataset_root_flock_held_by_another_process_does_not_block_publication(self):
        data=f.module('local-data');base=Path(self.config['datasetsRoot'])
        program="import fcntl,os,sys; fd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY); fcntl.flock(fd,fcntl.LOCK_EX); print('ready',flush=True); sys.stdin.read()"
        process=subprocess.Popen([sys.executable,'-c',program,str(base)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
        pool=concurrent.futures.ThreadPoolExecutor(1)
        try:
            self.assertEqual(process.stdout.readline().strip(),'ready')
            with Kernel():result=pool.submit(data.dataset_root,self.config,'unblocked',True).result(timeout=1)
            self.assertEqual(result,base/'unblocked')
        finally:
            process.stdin.close();process.wait(5);process.stdout.close();pool.shutdown(wait=True)

    def test_existing_dataset_does_not_open_or_wait_for_a_publication_lock(self):
        data=f.module('local-data');base=Path(self.config['datasetsRoot']);(base/'existing').mkdir()
        with patch.object(data,'module',side_effect=AssertionError('existing datasets must not lock')):
            self.assertEqual(data.dataset_root(self.config,'existing',True),base/'existing')

    def test_private_publication_lock_uses_the_existing_bounded_wait(self):
        data=f.module('local-data');store=f.module('project-store');original=data.module
        quota=store.private_dir(Path(self.config['root'])/'quota',create=True)
        held=os.open(quota/'datasets.lock',os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(held,fcntl.LOCK_EX)
        try:
            with patch.object(store,'PROJECT_LOCK_WAIT_SECONDS',0.05),patch.object(data,'module',side_effect=lambda name:store if name=='project-store' else original(name)),self.assertRaisesRegex(ValueError,'数据集正在创建，请稍后重试'):
                data.dataset_root(self.config,'busy',True)
        finally:os.close(held)

    upload=f.DirectoryContract.upload
    key=f.DirectoryContract.key

    def test_copy_staging_starts_on_the_target_and_export_on_the_source_files_id(self):
        copy=f.module('project-copy');store=f.module('project-store')
        jobs=SimpleNamespace(s=store,d=f.module('local-data'),config=self.config)
        with Kernel() as kernel:
            staging=copy.ProjectCopy(jobs).target({'id':str(uuid.uuid4()),'target':{'userId':'bob','ownerId':'carol','project':'demo'}})
        self.assertEqual(kernel.of(staging),(self.ids()[q.files_key('carol','demo')],True))
        self.assert_container_type(kernel,staging.parent)

    def test_engine_folder_and_container_layer(self):
        oci=f.module('personal-oci');engine=oci.PersonalOCI.__new__(oci.PersonalOCI)
        engine.config=self.config;engine.owner='alice';engine.s=f.module('project-store');engine.d=f.module('local-data')
        folder=Path(self.config['workspacesRoot'])/'.oci'/'alice';layer=folder/'graph'/'overlay'/'L1';commands=[]
        def run(*args,**kwargs):
            commands.append(args)
            if args[0]=='create':
                for name in ('diff','work','merged'):(layer/name).mkdir(parents=True)
            return str(layer/'diff') if args[0]=='container' else ''
        engine.run=run
        with Kernel() as kernel:
            folder.parent.mkdir(mode=0o700);folder.mkdir(mode=0o700)
            q.tag_dir(folder,q.allocate(q.folder(self.config),[q.images_key('alice')])[q.images_key('alice')])
            self.assertEqual(engine.create_container('gpuq-dev-x','image','demo'),{'layer':str(layer)})
            ids=self.ids();self.assertEqual(kernel.of(layer),(ids[q.images_key('alice')],False))
            for name in ('diff','work','merged'):self.assertEqual(kernel.of(layer/name),(ids[q.env_key('alice','demo')],True))
            (layer/'work').rmdir();(layer/'work').mkdir();kernel.forget(layer/'work')
            engine.heal_layer({'container':'gpuq-dev-x','layer':str(layer)},'demo')
            self.assertEqual(kernel.of(layer/'work'),(ids[q.env_key('alice','demo')],True))
        self.assertEqual(commands[0][0],'create');self.assertEqual(sum(c[0]=='container' for c in commands),1)
        self.assert_container_type(kernel,Path(self.config['workspacesRoot'])/'.oci')

    def test_failed_tagging_never_blocks_project_creation(self):
        ops=self.ops()
        with Kernel(fail=lambda info:errno.EOPNOTSUPP),redirect_stderr(io.StringIO()):
            self.assertEqual(ops.store.create('alice','demo')['project'],'demo')


if __name__=='__main__':unittest.main()
