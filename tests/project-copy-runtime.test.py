"""Copy concurrency uses real file locks and archive/file transport; OCI is local fixture transport."""
import base64,concurrent.futures,fcntl,importlib.util,os,shutil,subprocess,sys,threading,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('copy_fixture',Path(__file__).with_name('project-copy.test.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)


class Runtime(unittest.TestCase):
    setUp=c.f.DirectoryContract.setUp
    key=c.f.DirectoryContract.key
    transport=c.ProjectCopy.transport

    def consumer(self,t,command):
        helper=c.f.module('workspace-rootfs');read=Path.read_text;root=self.base/'loaded-rootfs'
        request={'engine':['/usr/bin/podman'],'graph':str(self.base),'hostUid':1000,'container':'keep-container',
                 'execution':'gpuq-live-fixture','flags':[],'argv':['/bin/true'],
                 'workspaceLock':str(t.target.e.projects().oci('alice').folder/'use-demo.lock')}
        def run(args,**kwargs):
            return subprocess.CompletedProcess(args,0,'[{}]' if 'inspect' in args else str(root) if 'mount' in args else '','')
        def text(path,*args,**kwargs):return '0 1000 1\n' if str(path)=='/proc/self/uid_map' else read(path,*args,**kwargs)
        with patch.object(helper,'subprocess',SimpleNamespace(run=run,call=command)),patch.object(helper.os,'getuid',return_value=0),patch.object(Path,'read_text',text):
            return helper.execute(request)

    def target(self,t):
        t.target_store.create('alice','demo');paths=t.target_store.dev_paths('alice','demo')
        t.target.s.atomic_json(paths['code'].parent/'oci.json',{'container':'keep-container','image':'old-image'})
        root=self.base/'loaded-rootfs';root.mkdir();(root/'installed-dependency').write_text('old-dependency')
        (paths['code']/'train.py').write_text('old-code')
        return paths

    def start(self,t):
        ticket={'id':t.key,'token':t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']}
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':ticket,'source':t.ref,'target':{**t.ref,'mode':'incremental'}})

    def test_active_workspace_command_keeps_its_original_files_until_it_finishes(self):
        t=self.transport(interrupt=False,mode='incremental');paths=self.target(t);self.start(t)
        running=threading.Event();release=threading.Event();finished=threading.Event();downloaded=threading.Event();observed=[]
        class Peer(t.peer):
            def call(self,action,**fields):
                result=super().call(action,**fields)
                if action=='file' and base64.b64decode(result['data'])==b'original-home':downloaded.set()
                return result
        def transfer():
            try:return t.target.worker(t.key)
            finally:finished.set()
        def command(*args,**kwargs):
            observed.append((paths['code']/'train.py').read_text());running.set();release.wait(10)
            observed.append((paths['code']/'train.py').read_text());return 0
        with concurrent.futures.ThreadPoolExecutor(2) as pool,patch.object(t.transfers,'PeerClient',Peer):
            consumer=pool.submit(self.consumer,t,command)
            try:
                self.assertTrue(running.wait(3));copy=pool.submit(transfer)
                self.assertTrue(downloaded.wait(5))
                self.assertFalse(finished.wait(.3))
                self.assertEqual((paths['code']/'train.py').read_text(),'old-code')
            finally:release.set()
            consumer.result(5);self.assertEqual(copy.result(8),0,t.target.status({'id':t.key}))
        self.assertEqual(observed,['old-code','old-code'])
        self.assertEqual((paths['code']/'train.py').read_bytes(),(t.paths['code']/'train.py').read_bytes())

    def test_busy_auto_job_starts_an_independent_copy_without_waiting_for_the_running_job(self):
        self.busy_auto('incremental')

    def test_busy_auto_job_with_a_full_bundle_uses_the_original_independent_installer(self):
        self.busy_auto('full')

    def busy_auto(self,mode):
        t=self.transport(interrupt=False,mode=mode);paths=self.target(t);exports=[]
        if mode=='incremental':self.assertFalse(any(args[0] in ('commit','save') for args in t.native))
        def launch(argv,**kwargs):
            if '--project-copy-export-worker' in argv:
                exports.append(argv);self.assertEqual(t.transfers.module('project-copy').ProjectCopy(t.source).export(t.key),0)
        t.source.e.run=launch
        ticket={'id':t.key,'token':t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']}
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':ticket,'source':t.ref,
                        'target':{**t.ref,'mode':mode,'jobId':t.key}})
        running=threading.Event();release=threading.Event();observed=[]
        def command(*args,**kwargs):
            observed.append((paths['code']/'train.py').read_text());running.set();release.wait(10)
            observed.append((paths['code']/'train.py').read_text());return 0
        with concurrent.futures.ThreadPoolExecutor(2) as pool,patch.object(t.transfers,'PeerClient',t.peer):
            consumer=pool.submit(self.consumer,t,command)
            try:
                self.assertTrue(running.wait(3));copy=pool.submit(t.target.worker,t.key)
                self.assertEqual(copy.result(5),0,t.target.status({'id':t.key}))
                self.assertFalse(release.is_set())
                row=t.target.status({'id':t.key});self.assertEqual(row['state'],'SUCCEEDED');self.assertFalse(row['installed'])
                runtime=Path(t.target.config['workspacesRoot'])/'.copies'/t.key
                self.assertEqual((runtime/'code/train.py').read_bytes(),(t.paths['code']/'train.py').read_bytes())
                self.assertEqual((runtime/'home/settings').read_text(),'original-home')
                self.assertNotEqual(t.target.s.read_json(runtime/'oci.json')['container'],'keep-container')
                self.assertEqual((paths['code']/'train.py').read_text(),'old-code')
                self.assertEqual((self.base/'loaded-rootfs/installed-dependency').read_text(),'old-dependency')
            finally:release.set()
            self.assertEqual(consumer.result(5),0)
        self.assertEqual(observed,['old-code','old-code'])
        self.assertEqual(len(exports),int(mode=='incremental'))
        self.assertFalse((Path(t.source.config['workspacesRoot'])/'.copy-exports'/t.key).exists())

    def test_merge_does_not_hold_the_short_oci_lock_and_new_commands_wait_without_failing(self):
        t=self.transport(interrupt=False,mode='incremental');self.target(t);self.start(t)
        applying=threading.Event();release=threading.Event();started=threading.Event();original=t.target.e.projects
        def projects():
            result=original();factory=result.oci
            def oci(owner):
                engine=factory(owner);files=engine.copy_files
                def copy_files(project,action,**kwargs):
                    if action=='apply':applying.set();release.wait(10)
                    return files(project,action,**kwargs)
                engine.copy_files=copy_files;return engine
            result.oci=oci;return result
        t.target.e.projects=projects
        def command(*args,**kwargs):started.set();return 0
        with concurrent.futures.ThreadPoolExecutor(2) as pool,patch.object(t.transfers,'PeerClient',t.peer):
            copy=pool.submit(t.target.worker,t.key)
            try:
                self.assertTrue(applying.wait(5));engine=original().oci('alice')
                consumer=pool.submit(self.consumer,t,command)
                self.assertFalse(started.wait(.2))
                with engine.locked('demo'):pass
            finally:release.set()
            self.assertEqual(copy.result(8),0,t.target.status({'id':t.key}));consumer.result(5)
        self.assertTrue(started.is_set())

    def test_existing_running_podman_job_is_allowed_to_finish_before_merge(self):
        t=self.transport(interrupt=False,mode='incremental');paths=self.target(t);self.start(t)
        checked=threading.Event();release=threading.Event();original=t.target.e.projects
        def projects():
            result=original();factory=result.oci
            def oci(owner):
                engine=factory(owner);run=engine.run
                def native(*args,**kwargs):
                    if args[0]=='ps':checked.set();return '' if release.is_set() else 'running-job'
                    return run(*args,**kwargs)
                engine.run=native;return engine
            result.oci=oci;return result
        t.target.e.projects=projects
        with concurrent.futures.ThreadPoolExecutor(1) as pool,patch.object(t.transfers,'PeerClient',t.peer):
            copy=pool.submit(t.target.worker,t.key)
            try:
                self.assertTrue(checked.wait(4));self.assertEqual((paths['code']/'train.py').read_text(),'old-code')
            finally:release.set()
            self.assertEqual(copy.result(8),0,t.target.status({'id':t.key}))

    def test_files_changed_during_download_are_replanned_before_apply(self):
        t=self.transport(interrupt=False,mode='incremental');paths=self.target(t)
        shutil.copy2(t.paths['code']/'run.sh',paths['code']/'run.sh');self.start(t);changed=[False]
        class Peer(t.peer):
            def call(self,action,**fields):
                if action=='file':
                    lock=t.target.e.projects().oci('alice').folder/'use-demo.lock'
                    fd=os.open(lock,os.O_RDWR|os.O_CREAT,0o600)
                    try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    finally:os.close(fd)
                if action=='file' and not changed[0]:
                    changed[0]=True;(paths['code']/'run.sh').write_text('edited while the copy downloaded')
                return super().call(action,**fields)
        with patch.object(t.transfers,'PeerClient',Peer):self.assertEqual(t.target.worker(t.key),0,t.target.status({'id':t.key}))
        self.assertEqual((paths['code']/'run.sh').read_text(),'#!/bin/sh\nexit 0\n')

    def test_slow_older_copy_finishes_before_the_newer_copy_can_plan_or_overwrite(self):
        t=self.transport(interrupt=False,mode='incremental');paths=self.target(t);self.start(t)
        second=self.key();(t.paths['code']/'train.py').write_text('newer-code')
        ticket=t.source.prepare({'id':second,'source':t.ref,'mode':'incremental'})
        self.assertEqual(t.transfers.module('project-copy').ProjectCopy(t.source).export(second),0)
        t.target.start({'id':second,'sourceMachine':'source','ticket':ticket,'source':t.ref,'target':{**t.ref,'mode':'incremental'}})
        first_read=threading.Event();release=threading.Event();second_listed=threading.Event()
        class Peer:
            def __init__(self,config,ticket):self.ticket=ticket
            def close(self):pass
            def call(self,action,**fields):
                if self.ticket['id']==t.key and action=='file':first_read.set();release.wait(10)
                if self.ticket['id']==second and action=='list':second_listed.set()
                return t.source.read({'id':self.ticket['id'],'action':action,**fields},self.ticket['token'])
        with concurrent.futures.ThreadPoolExecutor(2) as pool,patch.object(t.transfers,'PeerClient',Peer):
            first=pool.submit(t.target.worker,t.key)
            try:
                self.assertTrue(first_read.wait(4));newer=pool.submit(t.target.worker,second)
                self.assertFalse(second_listed.wait(.25))
            finally:release.set()
            self.assertEqual(first.result(8),0,t.target.status({'id':t.key}));self.assertEqual(newer.result(8),0,t.target.status({'id':second}))
        self.assertEqual((paths['code']/'train.py').read_text(),'newer-code')

    def test_projects_status_times_out_while_a_merge_holds_the_execution_lease(self):
        t=self.transport(interrupt=False,mode='incremental');self.target(t);requests=[]
        engine=t.target.e.projects().oci('alice');workspace_command=engine.workspace_command
        engine.workspace_command=lambda *args,**kwargs:workspace_command(*args,timeout=.05,**kwargs)
        operations=c.f.module('project-ops').ProjectOperations.__new__(c.f.module('project-ops').ProjectOperations)
        operations.store=t.target_store;operations.oci=lambda owner:engine
        lock=engine.folder/'use-demo.lock';fd=os.open(lock,os.O_RDWR|os.O_CREAT,0o600)
        fcntl.flock(fd,fcntl.LOCK_EX)
        def transport(args,**kwargs):
            requests.append(__import__('json').loads(Path(args[-1]).read_text()))
            self.assertEqual(kwargs.get('timeout'),.05)
            return subprocess.run([sys.executable,'-c',
                'import fcntl,sys; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_SH)',str(lock)],**kwargs)
        try:
            with patch.object(t.oci,'subprocess',SimpleNamespace(run=transport)):
                with self.assertRaises(subprocess.TimeoutExpired):operations.status('alice','demo')
        finally:os.close(fd)
        self.assertEqual(requests[0]['commandTimeout'],.05)


if __name__=='__main__':unittest.main()
