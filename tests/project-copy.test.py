"""Project transport preserves workspace, HOME and the OCI environment."""
import contextlib,importlib.util,json,os,subprocess,tarfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('copy_fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)

class ProjectCopy(unittest.TestCase):
    setUp=f.DirectoryContract.setUp
    key=f.DirectoryContract.key

    def transport(self,interrupt=True,mode='full'):
        """Replace the external OCI engine only; archives, offsets and files are real."""
        store=f.module('project-store').ProjectStore(Path(self.config['root']),config=self.config)
        store.create('alice','demo');paths=store.dev_paths('alice','demo')
        (paths['code']/'train.py').write_bytes(b'x'*(1024**2)+b'original')
        (paths['code']/'run.sh').write_text('#!/bin/sh\nexit 0\n');(paths['code']/'run.sh').chmod(0o755)
        (paths['code']/'entry').symlink_to('run.sh');(paths['code']/'empty').mkdir()
        (paths['home']/'settings').write_text('original-home')
        rootfs=self.base/'source-rootfs';rootfs.mkdir();(rootfs/'installed-dependency').write_text('dependency-v1')
        native=[];container_roots={};outer=self;oci=f.module('personal-oci')
        class OCI(oci.PersonalOCI):
            def __init__(self,config):
                self.config=config;self.root=Path(config['root']);self.state_folder=None;self.owner='alice';self.s=f.module('project-store');self.d=f.module('local-data')
                self.folder=self.s.private_dir(Path(config['root'])/'.fixture-engine',create=True)
                self.s.private_dir(self.folder/'tmp',create=True);self.env={};self.proxy={}
            def workspace_container(self,project):return {'container':'source-dev','image':'source-image'}
            def load(self,project):
                path=(self.state_folder or Path(self.config['workspacesRoot'])/'alice'/project)/'oci.json'
                return json.loads(path.read_text()) if path.exists() else {'container':None}
            def run(self,*args,**kwargs):
                native.append(args)
                if args[0] in ('commit','rmi','rm','ps'):return ''
                if args[0]=='images':return 'fixture-copy-image'
                if args[0]=='create':
                    container=args[args.index('--name')+1];root=outer.base/'loaded-rootfs'
                    if root.exists():root=outer.base/container
                    __import__('shutil').copytree(outer.base/'loaded-image',root,dirs_exist_ok=True)
                    container_roots[container]=root;return 'new-container'
                if args[0]=='container':return '100 100'
                if args[:2]==('unshare','/usr/bin/du'):return '1 code\n1 home'
                if args[0] in ('save','export'):
                    with tarfile.open(args[args.index('--output')+1],'w') as archive:archive.add(rootfs/'installed-dependency',arcname='installed-dependency')
                    return ''
                if args[0]=='load':
                    loaded=outer.base/'loaded-image';loaded.mkdir(exist_ok=True)
                    with tarfile.open(args[args.index('--input')+1]) as archive:archive.extractall(loaded)
                    return ''
                if args[:2]==('unshare','/usr/bin/tar'):
                    subprocess.run(args[1:],check=True);return ''
                raise AssertionError(args)
            def copy_files(self,project,action,*,paths,**kwargs):
                root=outer.base/'loaded-image' if action=='image' else container_roots.get(self.load(project).get('container'),outer.base/'loaded-rootfs')
                return f.module('project-sync').execute({'action':action,'paths':{k:str(v) for k,v in paths.items()},**kwargs},root)
            def workspace_command(self,owner,project,argv,*,paths=None,archive=None,timeout=300,**kwargs):
                if archive is None:return super().workspace_command(owner,project,argv,paths=paths,timeout=timeout,**kwargs)
                unpack=outer.base/'unpacked';unpack.mkdir(exist_ok=True)
                subprocess.run(['/usr/bin/tar','-xf',str(archive),'-C',str(unpack)],check=True)
                for name,source in (('code',unpack/'workspace'),('home',unpack/'home/gpuq')):
                    os.rmdir(paths[name]);os.rename(source,paths[name])
        executor=SimpleNamespace(CONFIG=self.config,projects=lambda:SimpleNamespace(store=store,oci=lambda owner:OCI(self.config)),run=lambda *a,**kw:None)
        transfers=f.module('transfer-jobs');jobs=transfers.TransferJobs(executor);key=self.key()
        ref={'project':'demo','ownerId':'alice','userId':'bob','environment':True}
        ticket=jobs.process('transfers.project.prepare',{'id':key,'source':ref,'mode':mode})
        self.assertEqual(transfers.module('project-copy').ProjectCopy(jobs).export(key),0)
        target_config={**self.config,**{name:str(self.base/('target-'+name)) for name in ('root','workspacesRoot','datasetsRoot')}}
        for name in ('root','workspacesRoot','datasetsRoot'):Path(target_config[name]).mkdir(mode=0o700)
        target_store=f.module('project-store').ProjectStore(Path(target_config['root']),config=target_config)
        active=set()
        def systemctl(argv,**kwargs):
            if 'show' in argv:return 'active' if argv[-1].removeprefix('gpuq-transfer-').removesuffix('.service*') in active else ''
        target_executor=SimpleNamespace(CONFIG=target_config,projects=lambda:SimpleNamespace(store=target_store,oci=lambda owner:OCI(target_config)),run=systemctl)
        target=transfers.TransferJobs(target_executor);target.config['transferPeers']={'source':{}}
        worker=target.worker
        def running(key):
            active.add(key)
            try:return worker(key)
            finally:active.remove(key)
        target.worker=running
        interrupted=[not interrupt]
        class Peer:
            def __init__(self,*a):pass
            def close(self):pass
            def call(self,action,**fields):
                if action=='file' and fields.get('offset',0)>0 and not interrupted[0]:
                    interrupted[0]=True;raise TimeoutError('fixture network interruption')
                return jobs.read({'id':key,'action':action,**fields},ticket['token'])
        return SimpleNamespace(store=store,paths=paths,key=key,source=jobs,target=target,transfers=transfers,peer=Peer,ref=ref,target_store=target_store,native=native,oci=oci)

    def test_existing_container_is_reused_and_only_changed_file_bodies_cross_the_peer(self):
        t=self.transport(interrupt=False,mode='incremental');t.target_store.create('alice','demo')
        paths=t.target_store.dev_paths('alice','demo');folder=paths['code'].parent
        t.target.s.atomic_json(folder/'oci.json',{'image':'target-image','container':'keep-container'})
        (paths['code']/'target-only').write_text('keep-data')
        (paths['home']/'target-settings').write_text('keep-settings')
        (paths['code']/'train.py').write_text('old-code')
        import shutil
        shutil.copy2(t.paths['code']/'run.sh',paths['code']/'run.sh')
        rootfs=self.base/'loaded-rootfs';rootfs.mkdir()
        (rootfs/'installed-dependency').write_text('dependency-old')
        (rootfs/'target-only-dependency').write_text('keep-dependency')
        token=t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':token},'source':t.ref,'target':{**t.ref,'mode':'incremental'}})
        reads=[]
        class Peer(t.peer):
            def call(self,action,**fields):
                if action=='file':reads.append(fields)
                return super().call(action,**fields)
        with patch.object(t.transfers,'PeerClient',Peer):self.assertEqual(t.target.worker(t.key),0,t.target.status({'id':t.key}))
        self.assertEqual(t.target.s.read_json(folder/'oci.json')['container'],'keep-container')
        self.assertEqual((paths['code']/'train.py').read_bytes(),(t.paths['code']/'train.py').read_bytes())
        self.assertEqual((paths['code']/'target-only').read_text(),'keep-data')
        self.assertEqual((paths['home']/'target-settings').read_text(),'keep-settings')
        self.assertEqual((rootfs/'installed-dependency').read_text(),'dependency-v1')
        self.assertEqual((rootfs/'target-only-dependency').read_text(),'keep-dependency')
        self.assertFalse(any(args[0] in ('commit','save','load','create','rm','restart','stop') for args in t.native))
        self.assertEqual(t.target.status({'id':t.key})['bytes'],(t.paths['code']/'train.py').stat().st_size+len('dependency-v1')+len('original-home'))
        self.assertTrue(reads)
        trash=f.module('project-purge').Trash(t.target.config);trash.restore({'key':t.key})
        with tarfile.open(paths['code']/'.copy-backups'/(t.key+'.tar')) as saved:
            self.assertEqual(saved.extractfile('code/train.py').read(),b'old-code')
            self.assertEqual(saved.extractfile('rootfs/installed-dependency').read(),b'dependency-old')
        second=self.key();ticket=t.source.prepare({'id':second,'source':t.ref,'mode':'incremental'})
        self.assertEqual(t.transfers.module('project-copy').ProjectCopy(t.source).export(second),0)
        class RepeatPeer:
            def __init__(self,*args):pass
            def close(self):pass
            def call(self,action,**fields):
                if action=='file':raise AssertionError('An unchanged copy must send no file bodies')
                return t.source.read({'id':second,'action':action,**fields},ticket['token'])
        t.target.start({'id':second,'sourceMachine':'source','ticket':ticket,'source':t.ref,'target':{**t.ref,'mode':'incremental'}})
        copy_module=t.transfers.module('project-copy');load_module=t.transfers.module
        with patch.object(t.transfers,'PeerClient',RepeatPeer), \
                patch.object(t.transfers,'module',side_effect=lambda name:copy_module if name=='project-copy' else load_module(name)), \
                patch.object(copy_module.ProjectCopy,'idle',side_effect=AssertionError('An unchanged copy must not acquire an exclusive lease')):
            self.assertEqual(t.target.worker(second),0,t.target.status({'id':second}))
        self.assertEqual(t.target.status({'id':second})['bytes'],0)

    def test_interrupted_incremental_install_reuses_original_backup_and_resumes_without_recreating_container(self):
        t=self.transport(mode='incremental');t.target_store.create('alice','demo')
        paths=t.target_store.dev_paths('alice','demo');folder=paths['code'].parent
        t.target.s.atomic_json(folder/'oci.json',{'image':'old','container':'keep-container'})
        rootfs=self.base/'loaded-rootfs';rootfs.mkdir();(rootfs/'installed-dependency').write_text('old-dependency')
        (paths['code']/'train.py').write_text('old-code');original=t.target.e.projects;interrupted=[False]
        def projects():
            result=original();factory=result.oci
            def oci(owner):
                engine=factory(owner);apply=engine.copy_files
                def files(project,action,**kwargs):
                    value=apply(project,action,**kwargs)
                    if action=='apply' and not interrupted[0]:interrupted[0]=True;raise ValueError('installation interrupted')
                    return value
                engine.copy_files=files;return engine
            result.oci=oci;return result
        t.target.e.projects=projects;token=t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':token},'source':t.ref,'target':{**t.ref,'mode':'incremental'}})
        with patch.object(t.transfers,'PeerClient',t.peer):
            self.assertEqual(t.target.worker(t.key),1)  # interrupted body at its saved offset
            self.assertEqual(t.target.status({'id':t.key})['state'],'PAUSED')
            t.target.resume({'id':t.key});self.assertEqual(t.target.worker(t.key),1)  # after apply, before completion
            self.assertEqual(t.target.status({'id':t.key})['state'],'FAILED')
            self.assertFalse((Path(t.target.config['workspacesRoot'])/'.copies'/t.key).exists())
            self.assertFalse((Path(t.source.config['workspacesRoot'])/'.copy-exports'/t.key).exists())
            self.assertFalse((paths['code']/'.copy-backups'/(t.key+'.tar')).exists())
            (paths['code']/'train.py').write_text('an edit still needs to be applied on resume')
            t.source.prepare({'id':t.key,'source':t.ref,'mode':'incremental'})
            self.assertEqual(t.transfers.module('project-copy').ProjectCopy(t.source).export(t.key),0)
            t.target.resume({'id':t.key})
            with patch('os.fstatvfs',return_value=SimpleNamespace(f_bavail=64*1024**3,f_frsize=1)):
                self.assertEqual(t.target.worker(t.key),1)  # existing backup cannot bypass the resource floor
            t.source.prepare({'id':t.key,'source':t.ref,'mode':'incremental'})
            self.assertEqual(t.transfers.module('project-copy').ProjectCopy(t.source).export(t.key),0)
            t.target.resume({'id':t.key});self.assertEqual(t.target.worker(t.key),0,t.target.status({'id':t.key}))
        self.assertEqual(t.target.s.read_json(folder/'oci.json')['container'],'keep-container')
        self.assertFalse((paths['code']/'.copy-backups'/(t.key+'.tar')).exists())
        trash=f.module('project-purge').Trash(t.target.config);trash.restore({'key':t.key})
        with tarfile.open(paths['code']/'.copy-backups'/(t.key+'.tar')) as saved:
            self.assertEqual(saved.extractfile('code/train.py').read(),b'old-code')
            self.assertEqual(saved.extractfile('rootfs/installed-dependency').read(),b'old-dependency')

    def test_full_transfer_reuses_a_container_created_while_the_source_was_exporting(self):
        t=self.transport(interrupt=False);t.target_store.create('alice','demo')
        paths=t.target_store.dev_paths('alice','demo');folder=paths['code'].parent
        t.target.s.atomic_json(folder/'oci.json',{'image':'target','container':'created-during-transfer'})
        rootfs=self.base/'loaded-rootfs';rootfs.mkdir();(rootfs/'installed-dependency').write_text('old-target-dependency')
        (rootfs/'keep-dependency').write_text('keep');(paths['code']/'keep-data').write_text('keep')
        token=t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':token},'source':t.ref,'target':{**t.ref,'mode':'full'}})
        with patch.object(t.transfers,'PeerClient',t.peer):self.assertEqual(t.target.worker(t.key),0,t.target.status({'id':t.key}))
        self.assertEqual(t.target.s.read_json(folder/'oci.json')['container'],'created-during-transfer')
        self.assertEqual((rootfs/'installed-dependency').read_text(),'dependency-v1')
        self.assertEqual((rootfs/'keep-dependency').read_text(),'keep');self.assertEqual((paths['code']/'keep-data').read_text(),'keep')
        self.assertFalse(any(args[0]=='create' for args in t.native))
        loaded=next(i for i,args in enumerate(t.native) if args[0]=='load')
        self.assertIn(('rmi','localhost/gpuq-copy:'+t.key),t.native[loaded+1:])

    def test_original_key_resume_replans_when_a_new_target_appears_after_staging_was_installed(self):
        t=self.transport(interrupt=False);original=t.target.e.projects;created=[False]
        def projects():
            result=original();factory=result.oci
            def oci(owner):
                engine=factory(owner);apply=engine.copy_files
                def files(project,action,**kwargs):
                    value=apply(project,action,**kwargs)
                    if action=='apply' and not created[0]:
                        created[0]=True;t.target_store.create('alice','demo');paths=t.target_store.dev_paths('alice','demo')
                        (paths['code']/'train.py').write_text('concurrent-code')
                        t.target.s.atomic_json(paths['code'].parent/'oci.json',{'image':'concurrent','container':'concurrent-container'})
                        (self.base/'loaded-rootfs/installed-dependency').write_text('concurrent-dependency')
                    return value
                engine.copy_files=files;return engine
            result.oci=oci;return result
        t.target.e.projects=projects;token=t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':token},'source':t.ref,'target':t.ref})
        with patch.object(t.transfers,'PeerClient',t.peer):
            self.assertEqual(t.target.worker(t.key),1)
            t.source.prepare({'id':t.key,'source':t.ref})
            self.assertEqual(t.transfers.module('project-copy').ProjectCopy(t.source).export(t.key),0)
            t.target.resume({'id':t.key})
            self.assertEqual(t.target.worker(t.key),0,t.target.status({'id':t.key}))
        paths=t.target_store.dev_paths('alice','demo')
        self.assertEqual(t.target.s.read_json(paths['code'].parent/'oci.json')['container'],'concurrent-container')
        self.assertFalse((Path(t.target.config['workspacesRoot'])/'.copies'/t.key).exists())
        self.assertTrue(any(args[0]=='rm' and args[1]!='concurrent-container' for args in t.native))
        self.assertEqual((self.base/'loaded-rootfs/installed-dependency').read_text(),'dependency-v1')
        trash=f.module('project-purge').Trash(t.target.config);trash.restore({'key':t.target.s.read_json(t.target.path(t.key))['backupKey']})
        with tarfile.open(paths['code']/'.copy-backups'/(t.key+'.tar')) as saved:
            self.assertEqual(saved.extractfile('code/train.py').read(),b'concurrent-code')
            self.assertEqual(saved.extractfile('rootfs/installed-dependency').read(),b'concurrent-dependency')

    def test_copy_prepares_a_background_environment_bundle_instead_of_only_workspace_files(self):
        store=f.module('project-store').ProjectStore(Path(self.config['root']),config=self.config)
        store.create('alice','demo')
        (store.dev_paths('alice','demo')['code']/'train.py').write_text('print("original")')
        commands=[]
        executor=SimpleNamespace(CONFIG=self.config,projects=lambda:SimpleNamespace(store=store),run=lambda argv,**kw:commands.append(argv))
        jobs=f.module('transfer-jobs').TransferJobs(executor)
        result=jobs.prepare({'id':self.key(),'source':{'project':'demo','ownerId':'alice','environment':True}})
        self.assertEqual(result['state'],'PREPARING')
        self.assertIn('--project-copy-export-worker',commands[0])
        self.assertEqual((store.dev_paths('alice','demo')['code']/'train.py').read_text(),'print("original")')

    def test_task_copy_resumes_real_bytes_and_merges_into_the_normal_target_project(self):
        t=self.transport();t.target_store.create('alice','demo')
        old=t.target_store.dev_paths('alice','demo');(old['code']/'train.py').write_text('target-original')
        target={**t.ref,'jobId':t.key}
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']},'source':t.ref,'target':target})
        with patch.object(t.transfers,'PeerClient',t.peer):
            self.assertEqual(t.target.worker(t.key),1);self.assertEqual(t.target.status({'id':t.key})['state'],'PAUSED')
            t.target.resume({'id':t.key});self.assertEqual(t.target.worker(t.key),0)
        paths=t.target_store.dev_paths('alice','demo')
        self.assertEqual((paths['code']/'train.py').read_bytes(),(t.paths['code']/'train.py').read_bytes())
        self.assertEqual((paths['code']/'entry').readlink(),Path('run.sh'))
        self.assertTrue((paths['code']/'run.sh').stat().st_mode&0o100);self.assertTrue((paths['code']/'empty').is_dir())
        self.assertEqual((paths['home']/'settings').read_text(),'original-home')
        self.assertEqual((self.base/'loaded-rootfs/installed-dependency').read_text(),'dependency-v1')
        trash=f.module('project-purge').Trash(t.target.config)
        trash.restore({'key':t.key})
        with tarfile.open(paths['code']/'.copy-backups'/(t.key+'.tar')) as saved:
            self.assertEqual(saved.extractfile('code/train.py').read(),b'target-original')
        self.assertIn(('commit','--pause=false','--include-volumes=false','source-dev','localhost/gpuq-copy:'+t.key),t.native)
        self.assertFalse(any(args[0] in ('stop','rm','restart') for args in t.native))
        self.assertEqual(t.target.status({'id':t.key})['state'],'SUCCEEDED')

    def test_cleanup_failure_resumes_cleanup_without_applying_again_or_recreating_staging(self):
        t=self.transport(interrupt=False);t.target_store.create('alice','demo')
        paths=t.target_store.dev_paths('alice','demo');t.target.s.atomic_json(paths['code'].parent/'oci.json',{'image':'existing','container':'keep-container'})
        root=self.base/'loaded-rootfs';root.mkdir();original=t.target.e.projects;failed=[0];applies=[]
        def projects():
            result=original();factory=result.oci
            def oci(owner):
                engine=factory(owner);run=engine.run;files=engine.copy_files
                def native(*args,**kwargs):
                    if args[0]=='rmi' and failed[0]<2:failed[0]+=1;raise ValueError('cleanup interrupted')
                    return run(*args,**kwargs)
                def copy_files(project,action,**kwargs):
                    if action=='apply':applies.append(action)
                    return files(project,action,**kwargs)
                engine.run=native;engine.copy_files=copy_files;return engine
            result.oci=oci;return result
        t.target.e.projects=projects;token=t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':token},'source':t.ref,'target':t.ref})
        with patch.object(t.transfers,'PeerClient',t.peer):
            with self.assertRaisesRegex(ValueError,'cleanup interrupted'):t.target.worker(t.key)
            self.assertTrue(t.target.status({'id':t.key})['installed'])
            self.assertEqual(t.target.status({'id':t.key})['state'],'FAILED')
            self.assertFalse((Path(t.source.config['workspacesRoot'])/'.copy-exports'/t.key).exists())
            t.target.resume({'id':t.key});self.assertEqual(t.target.worker(t.key),0,t.target.status({'id':t.key}))
        self.assertEqual(applies,['apply']);self.assertEqual(t.target.s.read_json(paths['code'].parent/'oci.json')['container'],'keep-container')
        self.assertFalse((Path(t.target.config['workspacesRoot'])/'.copies'/t.key).exists())

    def test_cancel_before_target_start_leaves_a_tombstone_and_does_not_launch_the_worker(self):
        commands=[];executor=SimpleNamespace(CONFIG=self.config,run=lambda *a,**kw:commands.append(a))
        jobs=f.module('transfer-jobs').TransferJobs(executor);key=self.key()
        self.assertEqual(jobs.cancel({'id':key})['state'],'CANCELED')
        self.assertEqual(jobs.start({'id':key,'target':{'project':'demo','environment':True}})['state'],'CANCELED')
        self.assertEqual(commands,[])

    def test_interrupted_export_is_reported_for_original_key_resume_instead_of_waiting_forever(self):
        store=f.module('project-store').ProjectStore(Path(self.config['root']),config=self.config);store.create('alice','demo')
        executor=SimpleNamespace(CONFIG=self.config,projects=lambda:SimpleNamespace(store=store),run=lambda *a,**kw:'inactive')
        jobs=f.module('transfer-jobs').TransferJobs(executor);key=self.key()
        ticket=jobs.prepare({'id':key,'source':{'project':'demo','ownerId':'alice','environment':True}})
        result=jobs.read({'id':key,'action':'list','offset':0},ticket['token'])
        self.assertEqual(result['state'],'FAILED');self.assertIn('导出中断',result['error'])

    def test_original_export_ticket_restarts_after_worker_exit_and_finishes_the_same_task_copy(self):
        t=self.transport(interrupt=False);ticket=t.source.s.read_json(t.source.path(t.key,'.source.json'))
        ticket['state']='PREPARING';t.source.s.atomic_json(t.source.path(t.key,'.source.json'),ticket)
        t.source.e.run=lambda *a,**kw:'inactive'
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':ticket['token']},'source':t.ref,'target':{**t.ref,'jobId':t.key}})
        with patch.object(t.transfers,'PeerClient',t.peer):
            self.assertEqual(t.target.worker(t.key),1)
            restarted=t.source.prepare({'id':t.key,'source':t.ref})
            self.assertEqual(restarted['id'],t.key);self.assertEqual(restarted['token'],ticket['token'])
            self.assertEqual(t.transfers.module('project-copy').ProjectCopy(t.source).export(t.key),0)
            t.target.resume({'id':t.key});self.assertEqual(t.target.worker(t.key),0)
        self.assertEqual(t.target.status({'id':t.key})['state'],'SUCCEEDED')

    def test_manual_copy_publishes_a_new_project_and_lost_completion_reply_does_not_reinstall_it(self):
        t=self.transport(interrupt=False);token=t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':token},'source':t.ref,'target':{**t.ref,'project':'new-project'}})
        lost=[False]
        class Peer(t.peer):
            def call(self,action,**fields):
                value=super().call(action,**fields)
                if action=='complete' and not lost[0]:lost[0]=True;raise TimeoutError('lost completion response')
                return value
        with patch.object(t.transfers,'PeerClient',Peer):
            self.assertEqual(t.target.worker(t.key),1);self.assertEqual(t.target.status({'id':t.key})['state'],'PAUSED')
            before=sum(args[0]=='load' for args in t.native)
            t.target.resume({'id':t.key});self.assertEqual(t.target.worker(t.key),0)
            self.assertEqual(sum(args[0]=='load' for args in t.native),before)
        paths=t.target_store.dev_paths('alice','new-project')
        self.assertEqual((paths['code']/'train.py').read_bytes(),(t.paths['code']/'train.py').read_bytes())
        self.assertEqual((paths['home']/'settings').read_text(),'original-home')
        self.assertFalse((Path(t.target.config['workspacesRoot'])/'.copies'/t.key).exists())
        self.assertFalse((paths['code'].parent/'received').exists())

    def test_cancel_during_environment_install_does_not_publish_the_new_manual_project(self):
        t=self.transport(interrupt=False);original=t.target.e.projects
        def projects():
            result=original();factory=result.oci
            def oci(owner):
                engine=factory(owner);extract=engine.copy_files
                def finish(*args,**kwargs):
                    result=extract(*args,**kwargs)
                    if args[1]=='apply':t.target.cancel({'id':t.key})
                    return result
                engine.copy_files=finish;return engine
            result.oci=oci;return result
        t.target.e.projects=projects
        token=t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':token},'source':t.ref,'target':{**t.ref,'project':'new-project'}})
        with patch.object(t.transfers,'PeerClient',t.peer):self.assertEqual(t.target.worker(t.key),0)
        self.assertEqual(t.target.status({'id':t.key})['state'],'CANCELED')
        self.assertFalse((t.target_store.owner_path('alice')/'new-project').exists())
        self.assertFalse((Path(t.target.config['workspacesRoot'])/'.copies'/t.key).exists())
        self.assertFalse((Path(t.source.config['workspacesRoot'])/'.copy-exports'/t.key).exists())
        self.assertTrue(any(args[0]=='rm' and args[-1].startswith('gpuq-dev-') for args in t.native))
        self.assertIn(('rmi','localhost/gpuq-copy:'+t.key),t.native)

    def test_cancel_without_a_worker_cleans_staging_image_backup_and_source_export(self):
        t=self.transport(interrupt=False);t.target_store.create('alice','demo')
        paths=t.target_store.dev_paths('alice','demo');t.target.s.atomic_json(paths['code'].parent/'oci.json',{'image':'existing','container':'keep-container'})
        token=t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':token},'source':t.ref,'target':t.ref})
        folder=t.transfers.module('project-copy').ProjectCopy(t.target).target({'id':t.key})
        (folder/'received').mkdir();(folder/'received/image.tar').write_bytes(b'partial-image')
        t.target.s.atomic_json(folder/'oci.json',{'image':'localhost/gpuq-copy:'+t.key,'container':'gpuq-dev-staged'})
        backup=paths['code']/'.copy-backups'/(t.key+'.tar');backup.parent.mkdir();backup.write_bytes(b'restore-these-files')
        source_row=t.source.s.read_json(t.source.path(t.key,'.source.json'));source_row['state']='PREPARING'
        t.source.s.atomic_json(t.source.path(t.key,'.source.json'),source_row);stopped=[]
        t.source.e.run=lambda argv,**kwargs:stopped.append(argv)
        with patch.object(t.transfers,'PeerClient',t.peer):
            self.assertEqual(t.target.cancel({'id':t.key})['state'],'CANCELED')
            self.assertEqual(t.target.cancel({'id':t.key})['state'],'CANCELED')
        self.assertFalse(folder.exists());self.assertFalse(backup.exists())
        self.assertFalse((Path(t.source.config['workspacesRoot'])/'.copy-exports'/t.key).exists())
        self.assertIn(('rm','--ignore','gpuq-dev-staged'),t.native)
        self.assertIn(('rmi','localhost/gpuq-copy:'+t.key),t.native)
        self.assertEqual(stopped,[['/usr/bin/systemctl','--user','stop','gpuq-project-export-'+t.key+'.service']])
        self.assertIn(('rmi','--ignore','localhost/gpuq-copy:'+t.key),t.native)
        self.assertEqual(t.target.s.read_json(paths['code'].parent/'oci.json')['container'],'keep-container')
        f.module('project-purge').Trash(t.target.config).restore({'key':t.key})
        self.assertEqual(backup.read_bytes(),b'restore-these-files')

    def test_existing_disk_floor_is_checked_before_the_export_creates_an_image_layer(self):
        store=f.module('project-store').ProjectStore(Path(self.config['root']),config=self.config);store.create('alice','demo')
        calls=[]
        class OCI:
            def workspace_container(self,project):return {'container':'source-dev'}
            def run(self,*args,**kw):
                calls.append(args)
                if args[0]=='container':return '100 100'
                if args[0]=='image':return '100'
                if args[:2]==('unshare','/usr/bin/du'):return '1 code\n1 home'
                return ''
        executor=SimpleNamespace(CONFIG=self.config,projects=lambda:SimpleNamespace(store=store,oci=lambda owner:OCI()),run=lambda *a,**kw:None)
        transfers=f.module('transfer-jobs');jobs=transfers.TransferJobs(executor);key=self.key()
        jobs.prepare({'id':key,'source':{'project':'demo','ownerId':'alice','environment':True}})
        with patch('os.fstatvfs',return_value=SimpleNamespace(f_bavail=64*1024**3+250,f_frsize=1)):
            self.assertEqual(transfers.module('project-copy').ProjectCopy(jobs).export(key),1)
        self.assertFalse(any(args[0]=='commit' for args in calls))

    def test_incremental_export_does_not_reserve_full_copy_commit_and_image_staging_layers(self):
        with patch('os.fstatvfs',return_value=SimpleNamespace(f_bavail=64*1024**3+150,f_frsize=1)):
            t=self.transport(interrupt=False,mode='incremental')
        self.assertEqual(t.source.s.read_json(t.source.path(t.key,'.source.json'))['state'],'READY')

    def test_target_disk_floor_includes_the_archive_unpacking_space_before_loading(self):
        store=f.module('project-store').ProjectStore(Path(self.config['root']),config=self.config)
        calls=[]
        engine=SimpleNamespace(locked=lambda project:contextlib.nullcontext(),load=lambda project:{},
            run=lambda *a,**kw:calls.append(a),workspace_command=lambda *a,**kw:None)
        executor=SimpleNamespace(CONFIG=self.config,projects=lambda:SimpleNamespace(store=store,oci=lambda owner:engine))
        jobs=f.module('transfer-jobs').TransferJobs(executor);copy=f.module('project-copy').ProjectCopy(jobs);key=self.key()
        row={'id':key,'state':'RUNNING','target':{'project':'demo','ownerId':'alice','jobId':key},'createdAt':'fixture'}
        jobs.s.atomic_json(jobs.path(key),row);folder=copy.target(row);bundle=folder/'received';bundle.mkdir()
        jobs.s.atomic_json(bundle/'manifest.json',{'image':'fixture','rootfsBytes':100})
        for name in ('image.tar','workspace.tar'):(bundle/name).write_bytes(b'x'*100)
        with patch('os.fstatvfs',return_value=SimpleNamespace(f_bavail=64*1024**3+350,f_frsize=1)):
            with self.assertRaises(ValueError):copy.install(row)
        self.assertEqual(calls,[])

if __name__=='__main__':unittest.main()
