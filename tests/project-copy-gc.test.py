"""Abandoned exports and receivers are reclaimed without breaking active copies."""
import importlib.util,os,time,unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('copy_fixture',Path(__file__).with_name('project-copy-runtime.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class CopyCollect(unittest.TestCase):
    setUp=f.Runtime.setUp
    key=f.Runtime.key
    transport=f.Runtime.transport
    target=f.Runtime.target
    runtime_job=f.Runtime.runtime_job

    def age(self,path):os.utime(path,(time.time()-90000,)*2)

    def test_collect_removes_complete_and_failed_export_directories_and_preserves_the_result(self):
        t=self.transport(interrupt=False);original=t.source.s.read_json(t.source.path(t.key,'.source.json'))
        for state in ('COMPLETE','FAILED'):
            key=self.key();folder=Path(original['root']).parent.parent/key;folder.mkdir(mode=0o700);(folder/'leftover').write_bytes(b'bytes')
            row={**original,'id':key,'root':str(folder/'bundle'),'state':state,'error':'original failure'}
            file=t.source.path(key,'.source.json');t.source.s.atomic_json(file,row)
            with self.subTest(state=state):
                self.assertTrue(t.source.collect());self.assertFalse(folder.exists())
                self.assertEqual(t.source.s.read_json(file)['state'],state)
                self.assertEqual(t.source.s.read_json(file)['error'],'original failure')

    def test_unread_ready_export_expires_and_the_original_key_can_export_again(self):
        t=self.transport(interrupt=False);file=t.source.path(t.key,'.source.json');row=t.source.s.read_json(file);self.age(file)
        self.assertEqual(t.source.collect()[0]['state'],'FAILED')
        self.assertFalse(Path(row['root']).parent.exists())
        self.assertEqual(t.source.s.read_json(file)['error'],'复制已过期，请重新发起复制')
        ticket=t.source.prepare({'id':t.key,'source':t.ref})
        self.assertEqual(ticket['id'],t.key);self.assertEqual(ticket['token'],row['token']);self.assertEqual(ticket['state'],'PREPARING')
        self.assertEqual(t.transfers.module('project-copy').ProjectCopy(t.source).export(t.key),0)
        self.assertEqual(t.source.s.read_json(file)['state'],'READY')

    def test_expired_preparing_export_is_stopped_before_its_directory_is_removed(self):
        t=self.transport(interrupt=False);file=t.source.path(t.key,'.source.json');row=t.source.s.read_json(file);row['state']='PREPARING'
        t.source.s.atomic_json(file,row);self.age(file);commands=[]
        t.source.e.run=lambda argv,**kw:commands.append(argv) or ''
        self.assertEqual(t.source.collect()[0]['state'],'FAILED')
        self.assertTrue(any('stop' in argv and 'gpuq-project-export-'+t.key+'.service' in argv for argv in commands))
        self.assertFalse(Path(row['root']).parent.exists())

    def test_authenticated_reads_and_repeated_prepare_keep_an_export_alive_without_waiting_for_its_lock(self):
        t=self.transport(interrupt=False);file=t.source.path(t.key,'.source.json');row=t.source.s.read_json(file)
        self.age(file);t.source.read({'id':t.key,'action':'list'},row['token'])
        self.assertEqual(t.source.collect(),[]);self.assertTrue(Path(row['root']).exists())
        row['state']='PREPARING';t.source.s.atomic_json(file,row);self.age(file)
        with t.source.lock(t.key,source=True):
            self.assertEqual(t.source.prepare({'id':t.key,'source':t.ref})['state'],'PREPARING')
        self.assertEqual(t.source.collect(),[])

    def start(self,t):
        ticket={'id':t.key,'token':t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']}
        return t.target.start({'id':t.key,'sourceMachine':'source','ticket':ticket,'source':t.ref,'target':t.ref})

    def test_receiver_launch_failure_releases_the_source_even_without_a_worker(self):
        t=self.transport(interrupt=False)
        def launch(argv,**kwargs):raise ValueError('systemd refused to start the receiver')
        t.target.e.run=launch
        with patch.object(t.transfers,'PeerClient',t.peer):self.assertEqual(self.start(t)['state'],'FAILED')
        self.assertEqual(t.source.s.read_json(t.source.path(t.key,'.source.json'))['state'],'COMPLETE')
        self.assertFalse((Path(t.source.config['workspacesRoot'])/'.copy-exports'/t.key).exists())

    def test_failure_before_receiving_also_releases_both_ends(self):
        t=self.transport(interrupt=False);self.start(t)
        copy=t.transfers.module('project-copy');loader=t.transfers.module
        with patch.object(copy.ProjectCopy,'serialized',side_effect=ValueError('cannot start copy')),patch.object(t.transfers,'module',side_effect=lambda name:copy if name=='project-copy' else loader(name)),patch.object(t.transfers,'PeerClient',t.peer):
            self.assertEqual(t.target.worker(t.key),1)
        self.assertEqual(t.target.status({'id':t.key})['state'],'FAILED')
        self.assertEqual(t.source.s.read_json(t.source.path(t.key,'.source.json'))['state'],'COMPLETE')

    def test_hourly_collect_retries_source_completion_without_a_status_query(self):
        t=self.transport(interrupt=False);self.start(t)
        class Offline(t.peer):
            def call(self,action,**fields):raise ConnectionError('offline')
        with patch.object(t.transfers,'PeerClient',Offline):self.assertEqual(t.target.cancel({'id':t.key})['state'],'CANCELED')
        self.assertTrue(t.target.s.read_json(t.target.path(t.key))['sourceCompletePending'])
        with patch.object(t.transfers,'PeerClient',t.peer):t.target.collect()
        self.assertNotIn('sourceCompletePending',t.target.s.read_json(t.target.path(t.key)))
        self.assertEqual(t.source.s.read_json(t.source.path(t.key,'.source.json'))['state'],'COMPLETE')

    def test_paused_receiver_keeps_offsets_until_it_is_unread_for_24_hours(self):
        t=self.transport();self.start(t)
        with patch.object(t.transfers,'PeerClient',t.peer):self.assertEqual(t.target.worker(t.key),1)
        row=t.target.s.read_json(t.target.path(t.key));self.assertEqual(row['state'],'PAUSED');self.assertGreater(row['bytes'],0)
        folder=Path(t.target.config['workspacesRoot'])/'.copies'/t.key
        self.assertEqual(t.target.collect(),[]);self.assertTrue(folder.exists())
        self.assertEqual(t.target.s.read_json(t.target.path(t.key))['bytes'],row['bytes'])
        self.age(t.target.path(t.key));t.target.resume({'id':t.key})
        self.assertEqual(t.target.collect(),[]);self.assertTrue(folder.exists())
        self.assertEqual(t.target.s.read_json(t.target.path(t.key))['bytes'],row['bytes'])
        self.age(t.target.path(t.key));self.age(t.source.path(t.key,'.source.json'))
        with patch.object(t.transfers,'PeerClient',t.peer):result=t.target.collect()
        self.assertEqual(result[0]['state'],'FAILED');self.assertFalse(folder.exists())
        self.assertEqual(t.target.s.read_json(t.target.path(t.key))['error'],'复制已过期，请重新发起复制')
        self.assertEqual(t.source.s.read_json(t.source.path(t.key,'.source.json'))['state'],'FAILED')

    def test_resume_waits_for_old_staging_cleanup_and_preserves_a_freshly_read_source(self):
        t=self.transport();self.start(t)
        with patch.object(t.transfers,'PeerClient',t.peer):self.assertEqual(t.target.worker(t.key),1)
        self.age(t.target.path(t.key));entered,release=Event(),Event()
        copy=t.transfers.module('project-copy');loader=t.transfers.module;cleanup=copy.ProjectCopy.cleanup
        def delayed(instance,row):
            entered.set()
            if not release.wait(5):raise AssertionError('cleanup not released')
            return cleanup(instance,row)
        with patch.object(copy.ProjectCopy,'cleanup',delayed),patch.object(t.transfers,'module',side_effect=lambda name:copy if name=='project-copy' else loader(name)),patch.object(t.transfers,'PeerClient',t.peer),ThreadPoolExecutor(2) as pool:
            collecting=pool.submit(t.target.collect)
            try:
                self.assertTrue(entered.wait(3))
                ticket=t.source.prepare({'id':t.key,'source':t.ref})
                resumed=pool.submit(t.target.resume,{'id':t.key})
            finally:release.set()
            collecting.result(3);self.assertEqual(resumed.result(3)['state'],'PENDING')
        self.assertEqual(t.source.s.read_json(t.source.path(t.key,'.source.json'))['state'],'READY')
        self.assertEqual(ticket['id'],t.key)
        with patch.object(t.transfers,'PeerClient',t.peer):self.assertEqual(t.target.worker(t.key),0,t.target.status({'id':t.key}))

    def test_collect_keeps_queued_and_running_runtime_copies_then_reclaims_a_finished_one(self):
        t,node,job,folder=self.runtime_job();t.target.e.native=lambda job:'J000000000001'
        self.age(t.target.path(t.key))
        for state in ('PENDING','RUNNING'):
            t.target.e.gpu=lambda *args:{'job':{'state':state}}
            self.assertEqual(t.target.collect(),[]);self.assertTrue(folder.exists())
        t.target.e.gpu=lambda *args:{'job':{'state':'SUCCEEDED'}}
        with patch.object(t.transfers,'PeerClient',t.peer):t.target.collect()
        self.assertFalse(folder.exists());self.assertTrue((t.target_store.dev_paths('alice','demo')['code']/'train.py').exists())

    def test_successful_runtime_waiting_for_portal_dispatch_is_not_expired(self):
        t,node,job,folder=self.runtime_job();t.target.e.native=lambda job:None
        self.age(t.target.path(t.key))
        with patch.object(t.target,'cleanup_copy',side_effect=AssertionError('deleted a prepared job before dispatch')):
            self.assertEqual(t.target.collect(),[])
        self.assertTrue((folder/'project.json').exists())


if __name__=='__main__':unittest.main()
