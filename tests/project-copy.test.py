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

    def transport(self,interrupt=True):
        """Replace the external OCI engine only; archives, offsets and files are real."""
        store=f.module('project-store').ProjectStore(Path(self.config['root']),config=self.config)
        store.create('alice','demo');paths=store.dev_paths('alice','demo')
        (paths['code']/'train.py').write_bytes(b'x'*(1024**2)+b'original')
        (paths['code']/'run.sh').write_text('#!/bin/sh\nexit 0\n');(paths['code']/'run.sh').chmod(0o755)
        (paths['code']/'entry').symlink_to('run.sh');(paths['code']/'empty').mkdir()
        (paths['home']/'settings').write_text('original-home')
        rootfs=self.base/'source-rootfs';rootfs.mkdir();(rootfs/'installed-dependency').write_text('dependency-v1')
        native=[];outer=self
        class OCI:
            def __init__(self,config):self.config=config;self.state_folder=None
            def workspace_container(self,project):return {'container':'source-dev','image':'source-image'}
            def locked(self,project):return contextlib.nullcontext()
            def load(self,project):
                path=self.state_folder/'oci.json'
                return json.loads(path.read_text()) if path.exists() else {'container':None}
            def run(self,*args,**kwargs):
                native.append(args)
                if args[0] in ('commit','rmi','create'):return 'new-container'
                if args[0]=='container':return '100 100'
                if args[:2]==('unshare','/usr/bin/du'):return '1 code\n1 home'
                if args[0]=='save':
                    with tarfile.open(args[args.index('--output')+1],'w') as archive:archive.add(rootfs/'installed-dependency',arcname='installed-dependency')
                    return ''
                if args[0]=='load':
                    loaded=outer.base/'loaded-rootfs';loaded.mkdir(exist_ok=True)
                    with tarfile.open(args[args.index('--input')+1]) as archive:archive.extractall(loaded)
                    return ''
                if args[:2]==('unshare','/usr/bin/tar'):
                    subprocess.run(args[1:],check=True);return ''
                raise AssertionError(args)
            def workspace_command(self,owner,project,argv,*,paths,archive,timeout):
                # Simulate the two bind mounts in an isolated fixture directory.
                unpack=outer.base/'unpacked';unpack.mkdir(exist_ok=True)
                subprocess.run(['tar','-xf',str(archive),'-C',str(unpack)],check=True)
                for name,source in (('code',unpack/'workspace'),('home',unpack/'home/gpuq')):
                    os.rmdir(paths[name]);os.rename(source,paths[name])
        executor=SimpleNamespace(CONFIG=self.config,projects=lambda:SimpleNamespace(store=store,oci=lambda owner:OCI(self.config)),run=lambda *a,**kw:None)
        transfers=f.module('transfer-jobs');jobs=transfers.TransferJobs(executor);key=self.key()
        ref={'project':'demo','ownerId':'alice','userId':'bob','environment':True}
        ticket=jobs.process('transfers.project.prepare',{'id':key,'source':ref})
        self.assertEqual(transfers.module('project-copy').ProjectCopy(jobs).export(key),0)
        target_config={**self.config,**{name:str(self.base/('target-'+name)) for name in ('root','workspacesRoot','datasetsRoot')}}
        for name in ('root','workspacesRoot','datasetsRoot'):Path(target_config[name]).mkdir(mode=0o700)
        target_store=f.module('project-store').ProjectStore(Path(target_config['root']),config=target_config)
        target_executor=SimpleNamespace(CONFIG=target_config,projects=lambda:SimpleNamespace(store=target_store,oci=lambda owner:OCI(target_config)),run=lambda *a,**kw:None)
        target=transfers.TransferJobs(target_executor);target.config['transferPeers']={'source':{}}
        interrupted=[not interrupt]
        class Peer:
            def __init__(self,*a):pass
            def close(self):pass
            def call(self,action,**fields):
                if action=='file' and fields.get('offset',0)>0 and not interrupted[0]:
                    interrupted[0]=True;raise TimeoutError('fixture network interruption')
                return jobs.read({'id':key,'action':action,**fields},ticket['token'])
        return SimpleNamespace(store=store,paths=paths,key=key,source=jobs,target=target,transfers=transfers,peer=Peer,ref=ref,target_store=target_store,native=native)

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

    def test_task_copy_resumes_real_bytes_and_uses_its_new_environment_without_replacing_a_same_name_project(self):
        t=self.transport();t.target_store.create('alice','demo')
        old=t.target_store.dev_paths('alice','demo');(old['code']/'train.py').write_text('target-original')
        target={**t.ref,'jobId':t.key}
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']},'source':t.ref,'target':target})
        with patch.object(t.transfers,'PeerClient',t.peer):
            self.assertEqual(t.target.worker(t.key),1);self.assertEqual(t.target.status({'id':t.key})['state'],'PAUSED')
            t.target.resume({'id':t.key});self.assertEqual(t.target.worker(t.key),0)
        paths=t.target_store.runtime_paths({'project':'demo','projectCopy':t.key,'userId':'bob','ownerId':'alice'},t.key)
        self.assertEqual((paths['code']/'train.py').read_bytes(),(t.paths['code']/'train.py').read_bytes())
        self.assertEqual((paths['code']/'entry').readlink(),Path('run.sh'))
        self.assertTrue((paths['code']/'run.sh').stat().st_mode&0o100);self.assertTrue((paths['code']/'empty').is_dir())
        self.assertEqual((paths['home']/'settings').read_text(),'original-home')
        self.assertEqual((self.base/'loaded-rootfs/installed-dependency').read_text(),'dependency-v1')
        self.assertEqual((old['code']/'train.py').read_text(),'target-original')
        self.assertIn(('commit','--pause=false','--include-volumes=false','source-dev','localhost/gpuq-copy:'+t.key),t.native)
        self.assertFalse(any(args[0] in ('stop','rm','restart') for args in t.native))
        self.assertEqual(t.target.status({'id':t.key})['state'],'SUCCEEDED')

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

    def test_cancel_during_environment_install_does_not_publish_the_new_manual_project(self):
        t=self.transport(interrupt=False);original=t.target.e.projects
        def projects():
            result=original();factory=result.oci
            def oci(owner):
                engine=factory(owner);extract=engine.workspace_command
                def finish(*args,**kwargs):
                    extract(*args,**kwargs);t.target.cancel({'id':t.key})
                engine.workspace_command=finish;return engine
            result.oci=oci;return result
        t.target.e.projects=projects
        token=t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':token},'source':t.ref,'target':{**t.ref,'project':'new-project'}})
        with patch.object(t.transfers,'PeerClient',t.peer):self.assertEqual(t.target.worker(t.key),0)
        self.assertEqual(t.target.status({'id':t.key})['state'],'CANCELED')
        self.assertFalse((t.target_store.owner_path('alice')/'new-project').exists())

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
