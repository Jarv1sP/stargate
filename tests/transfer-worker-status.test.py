"""A stopped receiver is resumable under its original key, with staged bytes intact."""
import importlib.util,os,subprocess,time,unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('copy_fixture',Path(__file__).with_name('project-copy.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class WorkerStatus(unittest.TestCase):
    setUp=f.ProjectCopy.setUp
    key=f.ProjectCopy.key
    transport=f.ProjectCopy.transport

    def interrupted(self):
        t=self.transport();t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']},'source':t.ref,'target':t.ref})
        with patch.object(t.transfers,'PeerClient',t.peer):self.assertEqual(t.target.worker(t.key),1)
        row=t.target.s.read_json(t.target.path(t.key));row.update(state='RUNNING',error=None)
        t.target.s.atomic_json(t.target.path(t.key),row)
        return t,row

    def test_stopped_receiver_keeps_bytes_and_original_key_resume_finishes(self):
        t,before=self.interrupted()
        t.target.e.run=lambda *a,**kw:'inactive'
        row=t.target.process('transfers.status',{'id':t.key})
        self.assertEqual(row['state'],'PAUSED');self.assertIn('原编号',row['error'])
        self.assertEqual(row['bytes'],before['bytes']);self.assertEqual(row['key'],t.key)
        folder=Path(t.target.config['workspacesRoot'])/'.copies'/t.key
        self.assertTrue(folder.exists())
        t.target.e.run=lambda *a,**kw:'active'
        with patch.object(t.transfers,'PeerClient',t.peer):
            t.target.resume({'id':t.key});self.assertEqual(t.target.worker(t.key),0)
        self.assertEqual(t.target.process('transfers.status',{'id':t.key})['state'],'SUCCEEDED')

    def test_list_also_observes_a_failed_receiver(self):
        t,_=self.interrupted();t.target.e.run=lambda *a,**kw:'failed'
        row=t.target.process('transfers.list',{})['transfers'][0]
        self.assertEqual(row['state'],'PAUSED')

    def test_live_or_unreadable_receiver_is_never_reported_as_stopped(self):
        t,_=self.interrupted()
        for active in ('active','activating','deactivating','reloading'):
            t.target.e.run=lambda *a,**kw:active
            self.assertEqual(t.target.process('transfers.status',{'id':t.key})['state'],'RUNNING')
        for error in (OSError('systemd unavailable'),subprocess.TimeoutExpired(['systemctl'],5)):
            def unavailable(*a,**kw):raise error
            t.target.e.run=unavailable
            self.assertEqual(t.target.process('transfers.status',{'id':t.key})['state'],'UNKNOWN')
            self.assertEqual(t.target.s.read_json(t.target.path(t.key))['state'],'RUNNING')

    def test_pending_launch_has_a_grace_period_but_a_lost_worker_does_not_wait_forever(self):
        t,_=self.interrupted();file=t.target.path(t.key);row=t.target.s.read_json(file)
        row.update(state='PENDING',createdAt=time.time());t.target.s.atomic_json(file,row)
        t.target.e.run=lambda *a,**kw:''
        self.assertEqual(t.target.process('transfers.status',{'id':t.key})['state'],'PENDING')
        os.utime(file,(time.time()-60,time.time()-60))
        self.assertEqual(t.target.process('transfers.status',{'id':t.key})['state'],'PAUSED')

    def test_late_phase_updates_cannot_change_a_terminal_transfer(self):
        t,_=self.interrupted();file=t.target.path(t.key)
        for state in ('CANCELED','SUCCEEDED'):
            row=t.target.s.read_json(file);row.update(state=state,phase='finished');t.target.s.atomic_json(file,row)
            t.target.phase(t.key,'合并项目文件')
            self.assertEqual(t.target.process('transfers.status',{'id':t.key})['phase'],'finished')


if __name__=='__main__':unittest.main()
