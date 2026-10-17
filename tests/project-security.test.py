"""OCI/gitalike project behavior, task allocation and the two filesystem walls."""
import base64,importlib.util,json,os,shutil,subprocess,tempfile,unittest,uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('directory_fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)


class ProjectContract(unittest.TestCase):
    setUp=f.DirectoryContract.setUp
    key=f.DirectoryContract.key

    def test_create_with_repository_and_git_status_are_container_commands(self):
        source=self.base/'repo';source.mkdir(mode=0o700)
        subprocess.run(['git','init','--initial-branch=main',str(source)],check=True,capture_output=True)
        (source/'train.py').write_text('print("hello")\n')
        subprocess.run(['git','-C',str(source),'add','train.py'],check=True)
        subprocess.run(['git','-C',str(source),'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture'],check=True,capture_output=True)
        ops=f.module('project-ops').ProjectOperations(SimpleNamespace(CONFIG=self.config,ROOT=Path(self.config['root']),run=lambda *a,**k:None))
        calls=[]
        class LocalGitTransport:
            # The test substitutes only OCI transport; the git commands/bytes are real.
            def git(_,user,project,args):
                calls.append(args);path=ops.store.dev_paths(user,project)['code']
                result=subprocess.run(['git','-C',str(path),*args],capture_output=True,text=True)
                if result.returncode:raise ValueError(result.stderr)
                return result.stdout.strip()
        with patch.object(ops,'oci',return_value=LocalGitTransport()):
            created=ops.process('projects.create',{'userId':'alice','project':'demo','repo':str(source)})
            self.assertEqual(created['cloneState'],'PENDING');self.assertEqual(ops.initialize('alice','demo'),0);created=ops.process('projects.status',{'userId':'alice','project':'demo'})
            self.assertEqual(created['git']['url'],str(source));self.assertEqual(created['git']['branch'],'main')
            self.assertEqual(len(created['git']['commit']),40)
            replay=ops.process('projects.create',{'userId':'alice','project':'demo','repo':str(source)})
            self.assertEqual(replay['git']['commit'],created['git']['commit'])
            self.assertEqual(sum(a[0]=='clone' for a in calls),1)

    def test_oci_arguments_are_private_namespace_only_and_training_dataset_is_readonly(self):
        oci=f.module('personal-oci');engine=oci.PersonalOCI.__new__(oci.PersonalOCI)
        engine.config={'machine':'test','personalOci':{'cdiSpec':str(self.base/'cdi.json')}};engine.owner='alice'
        engine.proxy={'https_proxy':'http://proxy.test:3128'}
        engine._mount_sources={3:str(self.base/'work'),4:str(self.base/'dataset'),5:str(self.base/'output')}
        (self.base/'cdi.json').write_text(json.dumps({'kind':'nvidia.com/gpu','devices':[{'name':'GPU-a'}]}))
        spec={'project':'demo','argv':['python','train.py'],'id':self.key()}
        args=engine.arguments(spec,{'environmentMode':'oci','workspace':True},False,['GPU-a'],[(3,'/workspace',False),(4,'/datasets',True),(5,'/outputs',False)])
        self.assertIn('nvidia.com/gpu=GPU-a',args);self.assertIn(str(self.base/'dataset')+':/datasets:ro',args)
        self.assertIn('--pid=private',args);self.assertIn('--network=slirp4netns:allow_host_loopback=false',args)
        self.assertIn('--env=https_proxy=http://proxy.test:3128',args)
        for forbidden in ('--privileged','--pid=host','--network=host','docker.sock','/data/mine'):
            self.assertFalse(any(forbidden in a for a in args),forbidden)

    def test_terminal_mounts_dataset_writable_and_does_not_get_gpu(self):
        oci=f.module('personal-oci');engine=oci.PersonalOCI.__new__(oci.PersonalOCI);engine.config={'machine':'test'};engine.owner='alice';engine._mount_sources={3:str(self.base/'dataset')}
        args=engine.arguments({'project':'demo','argv':['/bin/bash']},{'environmentMode':'oci','workspace':True},True,[],[(3,'/datasets',False)])
        self.assertIn(str(self.base/'dataset')+':/datasets:rw',args);self.assertFalse('--device' in args)

    def test_run_project_keeps_workspace_writable_and_reads_prior_task_outputs(self):
        oci=f.module('personal-oci');store=f.module('project-store').ProjectStore(Path(self.config['root']),config=self.config)
        store.create('alice','demo');dataset_fd=self.data.open_directory(Path(self.config['datasetsRoot']))
        self.addCleanup(os.close,dataset_fd);outputs=[]
        for index,terminal in enumerate((False,False,True)):
            spec={'id':self.key(),'userId':'alice','project':'demo','argv':['python','train.py']}
            paths=store.runtime_paths(spec,spec['id']);outputs.append(paths['output'])
            fds={name:self.data.open_directory(paths[name]) for name in ('code','home','output')}
            for fd in fds.values():self.addCleanup(os.close,fd)
            engine=oci.PersonalOCI.__new__(oci.PersonalOCI);engine.config={'machine':'test'};engine.owner='alice'
            def execute(job,project,is_terminal,uuids,mounts,*,control):
                engine._mount_sources={fd:os.readlink('/proc/self/fd/'+str(fd)) for fd,_,_ in mounts}
                args=engine.arguments(job,project,is_terminal,uuids,mounts,control)
                self.assertIn(str(paths['code'])+':/workspace:rw',args)
                self.assertIn(str(paths['output'])+':/outputs:rw',args)
                self.assertIn(str(Path(self.config['root'])/'outputs')+':/job-outputs:rw',args)
                mounted=next(fd for fd,target,_ in mounts if target=='/job-outputs')
                for previous in outputs[:-1]:
                    file=os.open(previous.name+'/result.txt',os.O_RDONLY,dir_fd=mounted)
                    try:self.assertEqual(os.read(file,16),str(outputs.index(previous)).encode())
                    finally:os.close(file)
                    copied=os.open(previous.name+'/copied-from-next.txt',os.O_WRONLY|os.O_CREAT,0o600,dir_fd=mounted)
                    try:os.write(copied,b'comparison')
                    finally:os.close(copied)
                self.assertIn(str(self.config['datasetsRoot'])+':/datasets:'+('rw' if is_terminal else 'ro'),args)
                # Substitute only OCI transport; shared workspace/output bytes are real.
                shared=paths['code']/'shared.txt'
                if index:self.assertEqual(shared.read_text(),str(index-1))
                shared.write_text(str(index));(paths['output']/'result.txt').write_text(str(index));return 0
            engine.execute=execute
            with patch.object(oci,'PersonalOCI',return_value=engine):
                project={**paths,'readonly':True} if index else paths
                self.assertEqual(oci.run_project(self.config,spec,project,terminal,[],fds['code'],fds,
                    [(dataset_fd,'/datasets')]),0)
        self.assertEqual(len(set(outputs)),3)
        self.assertEqual([(output/'result.txt').read_text() for output in outputs],['0','1','2'])

    def test_many_outputs_use_one_mount_and_new_results_are_visible_without_restart(self):
        import resource
        oci=f.module('personal-oci');store=f.module('project-store').ProjectStore(Path(self.config['root']),config=self.config)
        store.create('alice','demo');self.config['personalOci']={'baseImage':'example.invalid/test:latest'}
        spec={'id':self.key(),'userId':'alice','project':'demo','argv':['python','train.py']}
        paths=store.runtime_paths(spec,spec['id'])
        for _ in range(200):store.workspace_output('alice','demo',jobid=self.key())
        source=store.workspace_output('alice','demo',jobid=self.key())/'map.osa';source.write_bytes(b'existing map')
        inode=source.stat().st_ino
        fds={name:self.data.open_directory(paths[name]) for name in ('code','home','output')}
        for fd in fds.values():self.addCleanup(os.close,fd)
        engine=oci.PersonalOCI(self.config,'alice')
        def execute_workspace(job,args,env):
            self.assertEqual(sum(arg.endswith(':/job-outputs:rw') for arg in args),1)
            late=store.workspace_output('alice','demo',jobid=self.key())/'late.txt';late.write_bytes(b'new result')
            root=Path(next(arg.removesuffix(':/job-outputs:rw') for arg in args if arg.endswith(':/job-outputs:rw')))
            self.assertEqual((root/late.parent.name/'late.txt').read_bytes(),b'new result')
            self.assertEqual((root/source.parent.name/'map.osa').read_bytes(),b'existing map')
            shutil.copyfile(root/source.parent.name/'map.osa',root/late.parent.name/'copied-map.osa')
            self.assertEqual((root/late.parent.name/'copied-map.osa').read_bytes(),b'existing map')
            return 0
        engine.execute_workspace=execute_workspace
        soft,hard=resource.getrlimit(resource.RLIMIT_NOFILE)
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE,(min(soft,128),hard))
            with patch.object(oci,'PersonalOCI',return_value=engine),patch('os.getuid',return_value=os.getuid() or 1000):
                self.assertEqual(oci.run_project(self.config,spec,paths,True,[],fds['code'],fds,[]),0)
        finally:resource.setrlimit(resource.RLIMIT_NOFILE,(soft,hard))
        self.assertEqual(source.stat().st_ino,inode);self.assertEqual(source.read_bytes(),b'existing map')

    def test_only_assigned_cdi_device_is_used(self):
        engine=f.module('personal-oci').PersonalOCI.__new__(f.module('personal-oci').PersonalOCI);engine.owner='alice';engine._mount_sources={}
        file=self.base/'cdi.json';file.write_text(json.dumps({'kind':'nvidia.com/gpu','devices':[{'name':'GPU-a'},{'name':'GPU-b'}]}));engine.config={'machine':'test','personalOci':{'cdiSpec':str(file)}}
        args=engine.arguments({'project':'demo','argv':['python']},{'environmentMode':'oci'},False,['GPU-a'],[])
        self.assertEqual([args[i+1] for i,a in enumerate(args[:-1]) if a=='--device'],['nvidia.com/gpu=GPU-a'])

    def test_argv_limit_is_resource_floor_and_not_field_whitelist(self):
        resources=f.module('job-resources');spec={'cards':2,'futureField':'ignored'}
        limits=resources.requested_limits(spec,False,{'jobMemoryGiBPerCard':16})
        self.assertEqual(limits['memory'],32*1024**3)
        with self.assertRaises(ValueError):resources.requested_limits({'cards':0},False,{})

    def test_unknown_scheduling_fields_do_not_refuse_current_request(self):
        policy=f.module('scheduling-policy')
        value={'rank':'P2','yieldPolicy':'never','restartPolicy':'never','checkpointable':False,'extra':'ignored'}
        self.assertEqual(policy.normalize_job_policy({'scheduling':value})['priority'],2)

    def test_deleting_project_does_not_probe_or_cancel_active_tasks(self):
        ops=f.module('project-ops').ProjectOperations(SimpleNamespace(CONFIG=self.config,ROOT=Path(self.config['root']),run=lambda *a,**k:None))
        ops.store.create('alice','demo');row=ops.process('projects.retire',{'userId':'bob','ownerId':'alice','project':'demo','key':self.key(),'actor':{'userId':'bob'}})
        self.assertEqual(row['kind'],'project');self.assertEqual(row['actor']['userId'],'bob');self.assertEqual(ops.store.list(),[])

    def test_disk_samples_use_private_mounts_and_report_missing_without_zero(self):
        samples=self.data.disk_samples(self.config);self.assertEqual(len(samples),1)
        self.assertIn('availableBytes',samples[0]);self.assertEqual(samples[0]['mountPoint'],str(self.base))
        with patch('os.statvfs',side_effect=OSError('offline')):self.assertIsNone(self.data.disk_samples(self.config)[0]['availableBytes'])

    def test_four_real_nvidia_cdi_mount_sets_accept_only_the_assigned_gpu(self):
        oci=f.module('personal-oci');samples=json.loads((ROOT/'tests/fixtures/nvidia-cdi-mounts.json').read_text())['samples']
        self.assertEqual(len(samples),4)
        for sample in samples:
            with self.subTest(sample=sample['sample']):
                file=self.base/'cdi.json'
                file.write_text(json.dumps({'kind':sample['kind'],'devices':[{'name':name} for name in sample['deviceNames']],
                    'containerEdits':{'mounts':sample['mounts']}}))
                engine=oci.PersonalOCI.__new__(oci.PersonalOCI);engine.owner='alice';engine._mount_sources={}
                engine.config={'machine':'test','personalOci':{'cdiSpec':str(file)}}
                assigned=sample['deviceNames'][:1]
                args=engine.arguments({'project':'demo','argv':['python']},{'environmentMode':'oci'},False,assigned,[])
                self.assertEqual([args[i+1] for i,arg in enumerate(args[:-1]) if arg=='--device'],[sample['kind']+'='+assigned[0]])
                self.assertFalse('--volume' in args)  # Driver mounts belong to the standard CDI, not a second platform list.

    def test_system_disk_path_outside_cdi_is_not_mounted(self):
        oci=f.module('personal-oci');engine=oci.PersonalOCI.__new__(oci.PersonalOCI);engine.config=self.config
        engine._mount_sources={};fd=os.open('/etc/hosts',os.O_RDONLY|os.O_NOFOLLOW);self.addCleanup(os.close,fd)
        with self.assertRaisesRegex(ValueError,'系统盘'):
            with engine.named_mounts([(fd,'/etc/hosts',True)],[]):self.fail('Non-CDI system path was mounted')
        self.assertEqual(engine._mount_sources,{})

    def test_output_mount_keeps_data_directory_when_shared_path_is_replaced(self):
        probe=subprocess.run(['unshare','--user','--map-root-user','--mount','true'],capture_output=True)
        if probe.returncode:self.skipTest('Local user namespaces unavailable: '+probe.stderr.decode().strip())
        source=self.base/'output';source.mkdir();(source/'marker').write_bytes(b'original output')
        folder=self.base/'runtime';folder.mkdir(mode=0o700)
        program='''
import importlib.util,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('rootfs',sys.argv[1]);rootfs=importlib.util.module_from_spec(spec);spec.loader.exec_module(rootfs)
source,folder=map(Path,sys.argv[2:]);kept=source.with_name('kept')
namespace=os.readlink('/proc/self/ns/mnt');original_open=os.open
def replace_after_open(path,*args,**kwargs):
    fd=original_open(path,*args,**kwargs)
    if os.fspath(path)==str(source):
        source.rename(kept);source.symlink_to('/etc',target_is_directory=True)
    return fd
flags=['--volume',str(source)+':/outputs:rw']
os.open=replace_after_open
try:
    with rootfs.output_mount(flags,folder) as mounted:
        anchor=Path(mounted[1].removesuffix(':/outputs:rw'))
        assert anchor!=source and (anchor/'marker').read_bytes()==b'original output'
        (anchor/'copied').write_bytes(b'new output')
        assert (kept/'copied').read_bytes()==b'new output'
finally:os.open=original_open
assert os.readlink('/proc/self/ns/mnt')==namespace and not list(folder.iterdir())
try:
    with rootfs.output_mount(flags,folder):raise AssertionError('System symlink was mounted')
except (NotADirectoryError,FileExistsError):pass
assert os.readlink('/proc/self/ns/mnt')==namespace and not list(folder.iterdir())
'''
        result=subprocess.run(['unshare','--user','--map-root-user','--mount','python3','-c',program,
            str(ROOT/'node/workspace-rootfs.py'),str(source),str(folder)],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_gpu_interactive_terminal_accepts_assigned_cdi_and_rw_datasets(self):
        oci=f.module('personal-oci');engine=oci.PersonalOCI.__new__(oci.PersonalOCI)
        engine.owner='alice';engine._mount_sources={3:str(self.base/'workspace'),4:str(self.base/'datasets')}
        file=self.base/'cdi.json';file.write_text(json.dumps({'kind':'nvidia.com/gpu','devices':[{'name':'GPU-a'}]}))
        engine.config={'machine':'test','personalOci':{'cdiSpec':str(file)}}
        args=engine.arguments({'id':self.key(),'project':'demo','interactive':True},{'environmentMode':'oci'},True,['GPU-a'],[(3,'/workspace',False),(4,'/datasets',False)],['--setenv','PATH','/opt/gpuq/bin:/usr/bin'])
        self.assertIn('nvidia.com/gpu=GPU-a',args);self.assertIn(str(self.base/'datasets')+':/datasets:rw',args);self.assertIn('--tty',args)

    def test_sampler_unavailable_gpu_is_unknown_and_does_not_crash(self):
        probe=f.module('node-probe')
        with patch.object(probe,'command',side_effect=OSError('no local GPU')):
            result=probe.probe({**self.config,'gpu':'/test-only/missing-gpu'})
        self.assertIsNone(result['gpus']);self.assertIsNone(result['tasks']);self.assertEqual(len(result['disks']),1)

    def test_lost_submit_redispatches_and_cancel_stays_unknown_under_original_key(self):
        node=self.node();node.projects().store.create('alice','demo');jid=self.key()
        spec={'id':jid,'userId':'bob','ownerId':'alice','username':'bob','project':'demo','cards':1,'argv':['python','train.py'],'workspace':True}
        node.gpu=lambda *a:(_ for _ in ()).throw(TimeoutError('lost reply'))
        self.assertEqual(node.process('watch',{'job':spec})['schedulerState'],'NOT_SUBMITTED')
        with self.assertRaises(TimeoutError):node.process('sync',{'job':spec})
        # Absent from GPUQ after a lost reply: redispatch is safe, GPUQ dedups by the original key.
        self.assertEqual(node.process('watch',{'job':spec})['schedulerState'],'NOT_SUBMITTED')
        self.assertEqual(node.process('cancel',{'job':spec})['state'],'UNKNOWN')
        self.assertEqual(node.process('sync',{'job':spec})['state'],'UNKNOWN')

    def test_terminal_close_after_shell_exit_is_closed(self):
        node=self.node();jid=self.key();folder=node.module('project-store').private_dir(node.ROOT/'terminals',create=True)
        node.atomic_json(folder/(jid+'.json'),{'id':jid,'userId':'alice','project':'demo'})
        def run(argv,timeout=18):raise ValueError('Failed to stop amax-term-'+jid+'.service: Unit amax-term-'+jid+'.service not loaded.')
        node.run=run;node.terminal_alive=lambda folder,jid:False
        self.assertEqual(node.process('terminal.close',{'id':jid})['state'],'STOPPED')

    def node(self):
        code=self.base/'code';code.mkdir(mode=0o700)
        for source in (ROOT/'node').glob('*.py'):shutil.copy2(source,code/source.name)
        self.config.update(database=str(self.base/'gpuq.sqlite'),gpu='/fixed/gpu',jobMemoryGiBPerCard=16)
        (code/'node-config.json').write_text(json.dumps(self.config))
        import sqlite3,sys
        with sqlite3.connect(self.config['database']) as db:db.execute('create table jobs(id text,submit_key text)')
        spec=importlib.util.spec_from_file_location('test_node',code/'node-executor.py');node=importlib.util.module_from_spec(spec)
        sys.modules[spec.name]=node;spec.loader.exec_module(node);return node

    def test_cancel_reason_is_error_only_for_dependency_jobs(self):
        import sqlite3
        node=self.node();jid=self.key()
        spec={'id':jid,'userId':'alice','project':'demo','cards':1,'argv':['python','train.py']}
        with sqlite3.connect(self.config['database']) as db:db.execute('insert into jobs values(?,?)',('J000000000001',jid))
        for reason in ('用户取消','抢占取消'):
            node.gpu=lambda *args:{'job':{'state':'CANCELED','state_reason':reason},'attempts':[]}
            result=node.process('watch',{'job':spec})
            self.assertIsNone(result['error']);self.assertEqual(result['queueReason'],reason)
        result=node.process('watch',{'job':{**spec,'after':['J000000000002']}})
        self.assertEqual(result['error'],reason)

    def test_submit_watch_cancel_outputs_and_original_key_use_current_project(self):
        import sqlite3
        node=self.node();node.projects().store.create('alice','demo');jid=self.key()
        spec={'id':jid,'userId':'alice','username':'alice','project':'demo','cards':1,'argv':['python','train.py'],'name':'test','minVramGiB':0,'workspace':True,'after':['J000000000002','J000000000003']}
        calls=[]
        def native(*args):
            calls.append(args)
            if args[0]=='submit':
                with sqlite3.connect(self.config['database']) as db:db.execute('insert into jobs values(?,?)',('J000000000001',jid))
                return {'job_id':'J000000000001'}
            return {'job':{'id':'J000000000001','state':'SUCCEEDED','priority':2,'submit_key':jid,'name':'portal-'+jid[:8],'owner':'portal:alice'},'attempts':[]}
        node.gpu=native
        self.assertEqual(node.process('sync',{'job':spec})['state'],'SUCCEEDED')
        self.assertEqual(node.process('sync',{'job':spec})['state'],'SUCCEEDED')
        self.assertEqual(sum(a[0]=='submit' for a in calls),1)
        submit=next(a for a in calls if a[0]=='submit');self.assertIn('GPUQ_CONSOLE_OCI=1',submit);self.assertIn(str(Path(node.HERE)/'oci-runner.py'),submit)
        self.assertEqual([submit[i+1] for i,value in enumerate(submit) if value=='--after'],spec['after'])
        path=node.projects().store.runtime_paths(spec,jid)['output'];(path/'result.txt').write_bytes(b'result')
        data=node.process('files.get',{'userId':'bob','area':'output','runId':jid,'path':'result.txt'})
        self.assertEqual(base64.b64decode(data['data']),b'result')
        key=self.key();deleted=node.process('outputs.delete',{'userId':'bob','jobId':jid,'path':'result.txt','key':key,'actor':{'userId':'bob'}})
        self.assertEqual(deleted['kind'],'output')
        node.process('projects.retire.restore',{'userId':'carol','key':key,'actor':{'userId':'carol'}})
        self.assertEqual((path/'result.txt').read_bytes(),b'result')

if __name__=='__main__':unittest.main()
