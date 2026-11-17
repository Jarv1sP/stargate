"""Idle reclaim, historical output and per-project concurrent terminal admission."""
import base64,fcntl,importlib.util,os,tempfile,threading,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
s=importlib.util.spec_from_file_location('terminal_fixture',Path(__file__).with_name('project-security.test.py'))
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)


class TerminalLifecycle(unittest.TestCase):
    def setUp(self):
        # The fixture's synthetic mount point must use the canonical temp path on macOS too.
        with patch.object(tempfile,'tempdir',str(Path(tempfile.gettempdir()).resolve())):f.ProjectContract.setUp(self)
    key=f.ProjectContract.key
    node=f.ProjectContract.node

    def fixture(self):
        node=self.node();folder=node.module('project-store').private_dir(node.ROOT/'terminals',create=True)
        node.projects().store.create('alice','demo')
        node.projects().store.create('bob','demo')
        life=node.module('terminal-lifecycle');life.CGROUP_ROOT=self.base/'cgroups';life.PROC_ROOT=self.base/'proc'
        self.live=set()
        def run(argv,timeout=18):
            if argv[0].endswith('systemd-run'):
                self.live.add(next(arg.split('amax-term-')[1] for arg in argv if arg.startswith('--unit=')))
            elif 'stop' in argv:self.live.discard(argv[-1][len('amax-term-'):-len('.service')])
            return ''
        node.run=Mock(side_effect=run);node.terminal_alive=lambda folder,jid:jid in self.live
        node.terminal_unit_observation=lambda jid:{'ActiveState':'active','ControlGroup':'/term-'+jid}
        original=node.module
        node.module=lambda name:life if name=='terminal-lifecycle' else SimpleNamespace(requested_limits=lambda *a:{'memory':1024**3,'cpu':2}) if name=='job-resources' else original(name)
        return node,folder,life,life.Terminals(node)

    def terminal(self,node,folder,life,*,owner='alice',interactive=False,session=None,pids='123\n'):
        jid=self.key();self.live.add(jid)
        node.atomic_json(folder/(jid+'.json'),{'id':jid,'userId':owner,'ownerId':owner,'project':'demo','interactive':interactive})
        node.atomic_json(folder/(jid+'.session.json'),session or {'state':'DETACHED','leaseExpiresAt':0})
        output=folder/(jid+'.output');output.write_bytes(b'history\r\n');output.chmod(0o600)
        old=time.time()-90000
        for suffix in ('.json','.session.json','.output'):os.utime(folder/(jid+suffix),(old,old))
        payload=life.CGROUP_ROOT/('term-'+jid)/'libpod-payload-abc';payload.mkdir(parents=True)
        (payload/'cgroup.procs').write_text(pids)
        process=life.PROC_ROOT/'123';process.mkdir(parents=True,exist_ok=True)
        (process/'cmdline').write_bytes(b'\0'.join(arg.encode() for arg in life.SHELL)+b'\0')
        return jid,payload

    def open(self,node,**kwargs):
        return node.terminal_op('terminal.open',dict(key=self.key(),clientId=self.key(),machine='node-a',userId='alice',project='demo',**kwargs))

    def test_idle_close_uses_normal_stop_and_keeps_read_only_history_and_reason(self):
        node,folder,life,terminals=self.fixture();jid,_=self.terminal(node,folder,life)
        result=terminals.collect();self.assertEqual(result[0]['state'],'STOPPED')
        node.run.assert_called_once_with(['/usr/bin/systemctl','--user','stop','amax-term-'+jid+'.service'])
        stored=node.module('project-store').read_json(folder/(jid+'.session.json'))
        self.assertEqual(stored['state'],'CLOSED');self.assertEqual(stored['closedReason'],'idle');self.assertEqual(stored['leaseExpiresAt'],0)
        (folder/(jid+'.sock')).touch()  # A killed helper can leave its old socket behind.
        attached=self.open(node,id=jid,mode='reconnect')
        self.assertTrue(attached['readOnly']);self.assertEqual(attached['closedReason'],'idle')
        output=node.terminal_op('terminal.exchange',dict(id=jid,writerToken=attached['writerToken'],offset=0,input=base64.b64encode(b'dangerous command\n').decode()))
        self.assertTrue(output['exited']);self.assertEqual(base64.b64decode(output['data']),b'history\r\n')
        node.terminal_op('terminal.detach',{'id':jid,'writerToken':attached['writerToken']})
        node.terminal_op('terminal.close',{'id':jid})
        after=node.module('project-store').read_json(folder/(jid+'.session.json'))
        self.assertEqual(after['state'],'CLOSED');self.assertEqual(after['closedReason'],'idle');self.assertEqual(after['closedAt'],stored['closedAt'])

    def test_active_lease_interactive_and_other_processes_never_close(self):
        node,folder,life,terminals=self.fixture()
        self.terminal(node,folder,life,session={'state':'OPEN','leaseExpiresAt':time.time()+30})
        self.terminal(node,folder,life,interactive=True)
        self.terminal(node,folder,life,pids='123\n456\n')
        self.terminal(node,folder,life,pids='456\n')
        process=life.PROC_ROOT/'456';process.mkdir();(process/'cmdline').write_bytes(b'python\0train.py\0')
        self.assertEqual(terminals.collect(),[]);node.run.assert_not_called()

    def test_old_helpers_use_session_and_output_mtimes_even_with_stale_explicit_activity(self):
        node,folder,life,terminals=self.fixture()
        for suffix in ('.session.json','.output'):
            jid,_=self.terminal(node,folder,life,session={'state':'DETACHED','leaseExpiresAt':0,'lastInteractionAt':1})
            os.utime(folder/(jid+suffix),None)
        self.assertEqual(terminals.collect(),[]);node.run.assert_not_called()
        jid,_=self.terminal(node,folder,life,session={'state':'DETACHED','leaseExpiresAt':0,'lastInteractionAt':time.time()})
        jid,_=self.terminal(node,folder,life)
        node.atomic_json(folder/(jid+'.activity.json'),{'lastOutputAt':time.time()})
        self.assertEqual(terminals.collect(),[]);node.run.assert_not_called()

    def test_missing_or_unreadable_process_observation_and_busy_id_are_skipped(self):
        node,folder,life,terminals=self.fixture();jid,payload=self.terminal(node,folder,life)
        (payload/'cgroup.procs').unlink();self.assertEqual(terminals.collect(),[])
        (payload/'cgroup.procs').write_text('123\n')
        with patch.object(Path,'read_bytes',side_effect=PermissionError('unreadable')):
            self.assertEqual(terminals.collect()[0]['state'],'UNKNOWN')
        fd=os.open(folder/(jid+'.lock'),os.O_RDWR)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX);self.assertEqual(terminals.collect(),[])
        finally:os.close(fd)
        node.run.assert_not_called()

    def test_output_arriving_during_process_observation_prevents_close(self):
        node,folder,life,terminals=self.fixture();jid,_=self.terminal(node,folder,life)
        original=terminals.shell_only
        def observe(jid):
            result=original(jid);os.utime(folder/(jid+'.output'),None);return result
        terminals.shell_only=observe
        self.assertEqual(terminals.collect(),[]);node.run.assert_not_called()

    def test_twenty_first_refused_reconnect_takeover_and_idempotent_open_still_work(self):
        node,folder,life,terminals=self.fixture();ids=[]
        for _ in range(20):ids.append(self.terminal(node,folder,life)[0])
        stopped,_=self.terminal(node,folder,life);self.live.remove(stopped)
        rejected=self.open(node)
        self.assertEqual(rejected['state'],'REJECTED');self.assertFalse(rejected['created']);self.assertEqual(rejected['openCount'],20)
        self.assertFalse((folder/(rejected['id']+'.json')).exists())
        self.assertEqual(len(rejected['oldestIds']),3)
        for jid in rejected['oldestIds']:self.assertIn('gpuctl terminal close '+jid+' --machine node-a',rejected['reason'])
        for request in ({'id':ids[0],'mode':'reconnect'},{'id':ids[0],'mode':'reconnect','takeover':True},{'key':ids[1]}):
            args=dict(key=self.key(),clientId=self.key(),userId='alice',project='demo',**request) if 'key' not in request else dict(clientId=self.key(),userId='alice',project='demo',**request)
            self.assertEqual(node.terminal_op('terminal.open',args)['state'],'OPEN')
        node.run.assert_not_called()
        other=self.open(node,ownerId='bob');self.assertEqual(other['state'],'OPEN')

    def test_new_gpu_terminal_also_shares_the_cap(self):
        node,folder,life,terminals=self.fixture()
        for _ in range(20):self.terminal(node,folder,life)
        job={'id':self.key(),'userId':'alice','project':'demo','cards':1,'argv':life.SHELL,'interactive':True}
        node.gpu=Mock()
        with self.assertRaisesRegex(ValueError,'已有 20 个'):
            node.job_operation('sync',{'job':job})
        self.assertFalse((folder/(job['id']+'.json')).exists());node.gpu.assert_not_called()

    def test_runtime_gpu_copy_admission_does_not_depend_on_original_project_directory(self):
        node,folder,life,terminals=self.fixture()
        for _ in range(20):self.terminal(node,folder,life)
        copy_id=self.key();store=node.module('project-store')
        copy=store.private_dir(node.module('project-copy').runtime_folder(node.CONFIG,copy_id),create=True)
        node.atomic_json(copy/'project.json',{})
        Path(node.CONFIG['workspacesRoot'],'alice','demo').rename(Path(node.CONFIG['workspacesRoot'],'alice','retired-demo'))
        job={'id':self.key(),'userId':'alice','project':'demo','cards':1,'argv':life.SHELL,'interactive':True,'projectCopy':copy_id}
        node.gpu=Mock()
        with self.assertRaisesRegex(ValueError,'已有 20 个'):node.job_operation('sync',{'job':job})
        node.gpu.assert_not_called()

    def test_simultaneous_new_ids_share_the_project_limit(self):
        node,folder,life,terminals=self.fixture()
        for _ in range(19):self.terminal(node,folder,life)
        results=[];errors=[];start=threading.Barrier(3)
        def attempt():
            try:start.wait();results.append(self.open(node))
            except Exception as error:errors.append(error)
        threads=[threading.Thread(target=attempt) for _ in range(2)]
        for thread in threads:thread.start()
        start.wait()
        for thread in threads:thread.join(10);self.assertFalse(thread.is_alive())
        self.assertEqual(errors,[]);self.assertCountEqual([row['state'] for row in results],['OPEN','REJECTED'])


if __name__=='__main__':unittest.main()
