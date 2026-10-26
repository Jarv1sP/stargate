"""Explicit resume retains the original receiver and never interrupts a project merge."""
import fcntl,importlib.util,os,subprocess,unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('fixture',Path(__file__).with_name('project-copy.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class Resume(unittest.TestCase):
    setUp=f.ProjectCopy.setUp
    key=f.ProjectCopy.key
    transport=f.ProjectCopy.transport

    def active(self):
        t=self.transport();token=t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']
        t.target.start({'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':token},'source':t.ref,'target':t.ref})
        with patch.object(t.transfers,'PeerClient',t.peer):self.assertEqual(t.target.worker(t.key),1)
        row=t.target.s.read_json(t.target.path(t.key));row.update(state='RUNNING',phase='传输文件');t.target.s.atomic_json(t.target.path(t.key),row)
        return t,row

    def test_running_resume_stops_outside_progress_lock_and_preserves_bytes_under_shared_project_lease(self):
        t,before=self.active();commands=[]
        use=t.target.e.projects().oci('alice').folder/'use-demo.lock'
        consumer=os.open(use,os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(consumer,fcntl.LOCK_SH)
        probe=os.open(use,os.O_RDWR);self.addCleanup(os.close,probe)
        def run(argv,**kwargs):
            commands.append(argv)
            if 'stop' in argv:
                os.close(consumer)
                with self.assertRaises(BlockingIOError):fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with t.target.lock(t.key):self.assertEqual(t.target.s.read_json(t.target.path(t.key))['state'],'RUNNING')
            return ''
        t.target.e.run=run;result=t.target.resume({'id':t.key})
        self.assertEqual(result['id'],t.key);self.assertEqual(result['state'],'PENDING');self.assertEqual(result['bytes'],before['bytes'])
        self.assertEqual(t.target.s.read_json(t.target.path(t.key))['ticket'],before['ticket'])
        self.assertEqual([argv[0] for argv in commands],['/usr/bin/systemctl','/usr/bin/systemd-run'])
        fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.assertTrue((Path(t.target.config['workspacesRoot'])/'.copies'/t.key/'received').exists())

    def test_resume_during_project_merge_returns_current_state_without_stopping(self):
        t,_=self.active();file=t.target.path(t.key);row=t.target.s.read_json(file);row['phase']='合并项目文件';t.target.s.atomic_json(file,row)
        fd=os.open(t.target.e.projects().oci('alice').folder/'use-demo.lock',os.O_RDWR|os.O_CREAT,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX)
            t.target.e.run=lambda *args,**kwargs:self.fail('an installer was stopped')
            result=t.target.resume({'id':t.key});self.assertEqual(result['state'],'RUNNING');self.assertEqual(result['phase'],'合并项目文件')
        finally:os.close(fd)

    def test_stop_unknown_never_launches_or_discards_partial_files(self):
        t,before=self.active();commands=[]
        def run(argv,**kwargs):
            commands.append(argv);raise subprocess.TimeoutExpired(argv,kwargs['timeout'])
        t.target.e.run=run
        self.assertEqual(t.target.resume({'id':t.key})['state'],'UNKNOWN')
        self.assertEqual(len(commands),1);self.assertIn('stop',commands[0])
        self.assertEqual(t.target.s.read_json(t.target.path(t.key))['bytes'],before['bytes'])
        self.assertEqual(t.target.s.read_json(t.target.path(t.key))['state'],'RUNNING')

    def test_concurrent_cancel_is_not_restarted_after_stop(self):
        t,_=self.active();commands=[]
        def run(argv,**kwargs):
            commands.append(argv);file=t.target.path(t.key)
            with t.target.lock(t.key):
                row=t.target.s.read_json(file);row['state']='CANCELED';t.target.s.atomic_json(file,row)
            return ''
        t.target.e.run=run
        self.assertEqual(t.target.resume({'id':t.key})['state'],'CANCELED');self.assertEqual(len(commands),1)

    def test_terminal_records_never_stop_or_launch_a_receiver(self):
        t,_=self.active();file=t.target.path(t.key)
        for state in ('CANCELED','SUCCEEDED'):
            row=t.target.s.read_json(file);row['state']=state;t.target.s.atomic_json(file,row)
            t.target.e.run=lambda *args,**kwargs:self.fail('terminal transfer restarted')
            self.assertEqual(t.target.resume({'id':t.key})['state'],state)

    def test_successful_project_copy_removes_only_its_upload_metadata(self):
        t,_=self.active();t.target.resume({'id':t.key})
        with patch.object(t.transfers,'PeerClient',t.peer):self.assertEqual(t.target.worker(t.key),0)
        uploads=t.transfers.module('data-uploads').Uploads(t.target.config,'alice')
        self.assertFalse(list(uploads.folder.glob('*.json')))
        self.assertFalse(t.target.path(t.key,'.upload-keys').exists())

    def test_preparing_source_reports_existing_archive_bytes_without_rescanning_project(self):
        t=self.transport(interrupt=False,mode='incremental');file=t.source.path(t.key,'.source.json')
        row=t.source.s.read_json(file);row['state']='PREPARING';t.source.s.atomic_json(file,row)
        t.source.e.run=lambda *args,**kwargs:'active'
        page=t.source.read({'id':t.key,'action':'list'},row['token'])
        expected=sum((Path(row['root'])/name).stat().st_size for name in ('rootfs.tar','workspace.tar'))
        self.assertEqual(page['state'],'PREPARING');self.assertIn('整理文件清单',page['phase'])
        self.assertIn(f'{expected:,}',page['phase'])

    def test_initial_start_and_explicit_resume_cannot_launch_over_each_other(self):
        t=self.transport(interrupt=False);entered,release,stopped=Event(),Event(),Event();unit=[False];launches=[0]
        token=t.source.s.read_json(t.source.path(t.key,'.source.json'))['token']
        def run(argv,**kwargs):
            if 'stop' in argv:stopped.set();unit[0]=False
            elif argv[0]=='/usr/bin/systemd-run':
                launches[0]+=1
                if launches[0]==1:
                    entered.set()
                    if not release.wait(4):raise AssertionError('start was not released')
                if unit[0]:raise ValueError('unit already exists')
                unit[0]=True
            return ''
        t.target.e.run=run
        with ThreadPoolExecutor(2) as pool:
            starting=pool.submit(t.target.start,{'id':t.key,'sourceMachine':'source','ticket':{'id':t.key,'token':token},'source':t.ref,'target':t.ref})
            try:
                self.assertTrue(entered.wait(2));resuming=pool.submit(t.target.resume,{'id':t.key})
                self.assertFalse(stopped.wait(.2),'resume raced the original launch')
            finally:release.set()
            self.assertEqual(starting.result(3)['state'],'PENDING');self.assertEqual(resuming.result(3)['state'],'PENDING')
        self.assertEqual(t.target.s.read_json(t.target.path(t.key))['state'],'PENDING')


if __name__=='__main__':unittest.main()
