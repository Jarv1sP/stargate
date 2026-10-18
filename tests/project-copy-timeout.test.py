"""Slow project exports finish, and a podman timeout says which step timed out."""
import importlib.util,os,subprocess,tarfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('copy_fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class CopyTimeout(unittest.TestCase):
    setUp=f.DirectoryContract.setUp
    key=f.DirectoryContract.key

    def test_podman_timeout_names_the_step_without_the_command_line(self):
        oci=f.module('personal-oci');engine=oci.PersonalOCI.__new__(oci.PersonalOCI)
        engine.config={'personalOci':{}};engine.env={};engine.s=f.module('project-store')
        engine.folder=engine.s.private_dir(Path(self.config['workspacesRoot'])/'engine',create=True)
        def slow(argv,**kwargs):raise subprocess.TimeoutExpired(argv,kwargs['timeout'])
        with patch.object(oci,'subprocess',SimpleNamespace(run=slow,TimeoutExpired=subprocess.TimeoutExpired)):
            with self.assertRaises(ValueError) as caught:engine.run('container','inspect','--size','dev-container')
        self.assertEqual(str(caught.exception),'容器操作超时（30 秒未完成）：podman container inspect，请稍后按原编号重试。')

    def test_export_sizing_of_a_large_project_is_not_cut_off_at_30_seconds(self):
        store=f.module('project-store').ProjectStore(Path(self.config['root']),config=self.config)
        store.create('alice','demo');(store.dev_paths('alice','demo')['code']/'train.py').write_text('print(1)')
        dependency=self.base/'dependency';dependency.write_text('installed')
        class Engine:
            def workspace_container(self,project):return {'container':'dev-container'}
            def run(self,*args,timeout=30):
                # A large rootfs/workspace needs 40 s just to be measured.
                if (args[0]=='container' or args[:2]==('unshare','/usr/bin/du')) and timeout<40:
                    raise subprocess.TimeoutExpired(['podman',*args],timeout)
                if args[0]=='container':return '100 200'
                if args[:2]==('unshare','/usr/bin/du'):return '1 code\n1 home'
                if args[0]=='save':
                    with tarfile.open(args[args.index('--output')+1],'w') as archive:archive.add(dependency,arcname='dependency')
                if args[:2]==('unshare','/usr/bin/tar'):subprocess.run(args[1:],check=True)
                return ''
        executor=SimpleNamespace(CONFIG=self.config,run=lambda *a,**kw:None,
                                 projects=lambda:SimpleNamespace(store=store,oci=lambda owner:Engine()))
        transfers=f.module('transfer-jobs');jobs=transfers.TransferJobs(executor);key=self.key()
        jobs.process('transfers.project.prepare',{'id':key,'source':{'project':'demo','ownerId':'alice','userId':'bob','environment':True},'mode':'full'})
        copy=transfers.module('project-copy').ProjectCopy(jobs)
        self.assertEqual(copy.export(key),0,jobs.s.read_json(jobs.path(key,'.source.json')).get('error'))
        self.assertEqual(jobs.s.read_json(jobs.path(key,'.source.json'))['state'],'READY')


if __name__=='__main__':unittest.main()
