"""A stopped receiver is resumable under its original key, with staged bytes intact."""
import importlib.util,os,subprocess,time,unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
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

    def test_slow_status_query_does_not_block_progress_or_pause_a_resumed_worker(self):
        t,_=self.interrupted();querying,release,progressed=Event(),Event(),Event()
        def slow(*args,**kwargs):
            querying.set()
            if not release.wait(5):raise AssertionError('query not released')
            return 'inactive'
        t.target.e.run=slow
        def progress():
            t.target.phase(t.key,'传输文件',startedAt=time.time());progressed.set()
        with ThreadPoolExecutor(2) as pool:
            query=pool.submit(t.target.process,'transfers.status',{'id':t.key})
            try:
                self.assertTrue(querying.wait(2));writer=pool.submit(progress)
                self.assertTrue(progressed.wait(1),'status held the transfer write lock')
            finally:release.set()
            writer.result(3);self.assertEqual(query.result(3)['state'],'RUNNING')

    def test_old_observation_does_not_pause_a_pending_resume_before_its_worker_starts(self):
        t,_=self.interrupted()
        def resume_during_query(*args,**kwargs):
            file=t.target.path(t.key);row=t.target.s.read_json(file)
            row['state']='PENDING';t.target.s.atomic_json(file,row)
            return 'inactive'
        t.target.e.run=resume_during_query
        self.assertEqual(t.target.process('transfers.status',{'id':t.key})['state'],'PENDING')

    def test_list_has_one_shared_observation_budget_and_keeps_unread_rows_unknown(self):
        t,row=self.interrupted();other=self.key();row.update(id=other,key=other)
        t.target.s.atomic_json(t.target.path(other),row)
        clock=[0];calls=[]
        def timeout(*args,**kwargs):
            calls.append(kwargs['timeout']);clock[0]+=5
            raise subprocess.TimeoutExpired(['systemctl'],kwargs['timeout'])
        t.target.e.run=timeout
        with patch.object(t.transfers.time,'monotonic',side_effect=lambda:clock[0]):
            rows=t.target.process('transfers.list',{})['transfers']
        self.assertEqual(len(calls),1);self.assertEqual({row['state'] for row in rows},{'UNKNOWN'})


if __name__=='__main__':unittest.main()
