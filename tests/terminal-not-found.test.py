"""Terminal recovery uses the per-ID lock and never recreates a voided key."""
import fcntl,importlib.util,os,subprocess,threading,unittest
from pathlib import Path
from unittest.mock import Mock
s=importlib.util.spec_from_file_location('terminal_fixture',Path(__file__).with_name('project-security.test.py'))
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)

class TerminalRecovery(unittest.TestCase):
    setUp=f.ProjectContract.setUp
    key=f.ProjectContract.key
    node=f.ProjectContract.node

    def fixture(self):
        node=self.node();folder=node.module('project-store').private_dir(node.ROOT/'terminals',create=True)
        jid=self.key();node.run=Mock(return_value='LoadState=not-found\nActiveState=inactive\nMainPID=0\n')
        return node,folder,jid

    def absent(self,result,jid):
        self.assertEqual(result['id'],jid);self.assertEqual(result['state'],'NOT_FOUND')
        self.assertIs(result['canCreate'],True);self.assertIs(result['created'],False)

    def test_never_delivered_open_is_voided_and_late_open_never_launches(self):
        node,folder,jid=self.fixture()
        self.absent(node.terminal_status({'id':jid}),jid)
        marker=node.module('project-store').read_json(folder/(jid+'.void.json'))
        self.assertEqual(marker['id'],jid);self.assertGreater(marker['voidedAt'],0)
        result=node.terminal_op('terminal.open',dict(key=jid,mode='new',clientId=self.key(),userId='alice',project='demo'))
        self.absent(result,jid);self.assertIn('作废',result['error'])
        for operation in ('terminal.open','terminal.close','terminal.detach','terminal.exchange'):
            with self.subTest(operation=operation):self.absent(node.terminal_op(operation,dict(id=jid,mode='reconnect')),jid)
        self.assertFalse((folder/(jid+'.json')).exists())
        self.assertFalse(any('systemd-run' in command.args[0][0] for command in node.run.call_args_list))
        self.assertEqual(node.terminal_status({}),{'sessions':[]})

    def test_created_spec_is_never_missing_and_repeated_open_does_not_launch(self):
        node,folder,jid=self.fixture();client=self.key()
        node.atomic_json(folder/(jid+'.json'),dict(id=jid,userId='alice',project='demo'))
        for active,state in ((True,'ALIVE'),(False,'STOPPED')):
            with self.subTest(active=active):
                node.run.return_value='LoadState=loaded\nActiveState='+('active' if active else 'inactive')+'\nMainPID='+('123' if active else '0')+'\n'
                self.assertEqual(node.terminal_status({'id':jid})['state'],state)
                result=node.terminal_op('terminal.open',dict(key=jid,mode='new',clientId=client))
                self.assertEqual(result['state'],'OPEN' if active else 'STOPPED')
                self.assertFalse((folder/(jid+'.void.json')).exists())
                self.assertEqual(node.terminal_status({})['sessions'][0]['state'],'RUNNING' if active else 'STOPPED')
        self.assertFalse(any('systemd-run' in command.args[0][0] for command in node.run.call_args_list))

    def test_each_missing_operation_can_confirm_and_void_an_unused_id(self):
        node,folder,_=self.fixture()
        for operation in ('terminal.open','terminal.close','terminal.detach','terminal.exchange'):
            jid=self.key()
            with self.subTest(operation=operation):
                self.absent(node.terminal_op(operation,dict(id=jid,mode='reconnect')),jid)
                self.assertTrue((folder/(jid+'.void.json')).exists())
        node.run.assert_called_with(['/usr/bin/systemctl','--user','show','amax-term-'+jid+'.service','--property=LoadState,ActiveState,MainPID'],timeout=5)

    def test_first_status_before_the_terminal_directory_exists(self):
        node,folder,jid=self.fixture();folder.rmdir()
        self.absent(node.terminal_status({'id':jid}),jid)
        self.assertTrue((folder/(jid+'.void.json')).exists())

    def test_missing_operations_all_keep_uncertain_observations_unknown(self):
        node,folder,jid=self.fixture()
        for observation in (ValueError('systemctl failed'),subprocess.TimeoutExpired('systemctl',5),OSError('unavailable'),
                            'LoadState=loaded\nActiveState=active\nMainPID=123\n','LoadState=loaded\nActiveState=inactive\nMainPID=0\n',''):
            node.run.side_effect=observation if isinstance(observation,Exception) else None
            node.run.return_value=observation
            for operation in ('terminal.status','terminal.open','terminal.close','terminal.detach','terminal.exchange'):
                with self.subTest(observation=str(observation),operation=operation):
                    result=node.terminal_op(operation,dict(id=jid,mode='reconnect'))
                    self.assertEqual(result['state'],'UNKNOWN');self.assertNotIn('canCreate',result)
                    self.assertFalse((folder/(jid+'.void.json')).exists())

    def test_session_or_socket_without_spec_stays_unknown(self):
        node,folder,jid=self.fixture()
        for suffix in ('.session.json','.sock'):
            path=folder/(jid+suffix);path.write_text('incomplete')
            for operation in ('terminal.status','terminal.open','terminal.close','terminal.detach','terminal.exchange'):
                self.assertEqual(node.terminal_op(operation,dict(id=jid,mode='reconnect'))['state'],'UNKNOWN')
            self.assertFalse((folder/(jid+'.void.json')).exists());path.unlink()
        node.run.assert_not_called()

    def test_atomic_marker_failure_stays_unknown(self):
        node,folder,jid=self.fixture();node.atomic_json=Mock(side_effect=OSError('disk unavailable'))
        self.assertEqual(node.terminal_status({'id':jid})['state'],'UNKNOWN')
        self.assertFalse((folder/(jid+'.void.json')).exists())

    def test_status_during_creation_cannot_void_the_in_flight_key(self):
        node,folder,jid=self.fixture();locked=threading.Event();release=threading.Event()
        def create():
            fd=os.open(folder/(jid+'.lock'),os.O_RDWR|os.O_CREAT,0o600)
            try:
                fcntl.flock(fd,fcntl.LOCK_EX);locked.set();release.wait(8)
                node.atomic_json(folder/(jid+'.json'),dict(id=jid,userId='alice',project='demo'))
            finally:os.close(fd)
        creator=threading.Thread(target=create);creator.start();self.assertTrue(locked.wait(2))
        try:
            self.assertEqual(node.terminal_status({'id':jid})['state'],'UNKNOWN')
            self.assertFalse((folder/(jid+'.void.json')).exists());node.run.assert_not_called()
        finally:release.set();creator.join(5)
        self.assertFalse(creator.is_alive());node.run.return_value='LoadState=loaded\nActiveState=active\nMainPID=123\n'
        self.assertEqual(node.terminal_status({'id':jid})['state'],'ALIVE')

if __name__=='__main__':unittest.main()
