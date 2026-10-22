"""Concurrent cold starts share one initialization without failing GPU jobs."""
import importlib.util,json,tempfile,threading,unittest
from concurrent.futures import ThreadPoolExecutor,TimeoutError
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('oci_fixture',ROOT/'node/personal-oci.py')
oci=importlib.util.module_from_spec(spec);spec.loader.exec_module(oci)


class WorkspaceInitialization(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.path=Path(self.temporary.name)/'oci.json'
        self.engine=oci.PersonalOCI.__new__(oci.PersonalOCI)
        self.engine.s=oci.module('project-store');self.engine.policy={'baseImage':'fixture-image'}
        self.engine.state_path=lambda slug:self.path

    def test_an_existing_workspace_is_usable_while_another_operation_holds_the_short_lock(self):
        self.path.write_text(json.dumps({'container':'existing','image':'fixture-image'}))
        self.engine.run=lambda *args,**kwargs:self.fail('existing workspace must not pull or create')
        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.engine.locked('project'):
                value=pool.submit(self.engine.workspace_container,'project')
                self.assertEqual(value.result(timeout=1)['container'],'existing')

    def test_image_initialization_longer_than_the_short_lock_timeout_is_shared_once(self):
        entered,release=threading.Event(),threading.Event();commands=[]
        def run(*args,**kwargs):
            commands.append(args[0])
            if args[0]=='pull':
                entered.set()
                if not release.wait(10):raise AssertionError('test initialization not released')
            return ''
        self.engine.run=run
        with ThreadPoolExecutor(max_workers=2) as pool:
            first=pool.submit(self.engine.workspace_container,'project')
            try:
                self.assertTrue(entered.wait(2))
                second=pool.submit(self.engine.workspace_container,'project')
                with self.assertRaises(TimeoutError):second.result(timeout=2.5)
            finally:release.set()
            a,b=first.result(timeout=2),second.result(timeout=2)
        self.assertEqual(a,b);self.assertEqual(commands,['pull','create'])
        self.assertEqual(json.loads(self.path.read_text())['container'],a['container'])

    def test_failed_initialization_releases_the_lock_without_publishing_an_empty_container(self):
        def fail(*args,**kwargs):raise ValueError('fixture pull failed')
        self.engine.run=fail
        with self.assertRaisesRegex(ValueError,'fixture pull failed'):self.engine.workspace_container('project')
        self.assertFalse(self.path.exists())
        self.engine.run=lambda *args,**kwargs:''
        self.assertIsNotNone(self.engine.workspace_container('project')['container'])


if __name__=='__main__':unittest.main()
