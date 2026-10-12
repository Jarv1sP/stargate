"""Synthetic local environment contracts; never access a real node or install packages."""
import importlib.util
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
store_module = load('environment_store', 'project-store.py')
runner = load('environment_runner', 'sandbox-runner.py')
common_runner = load('environment_common_runner', 'sandbox-runner-common-p0.py')

class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.base = self.root / 'base'
        (self.base / 'bin').mkdir(parents=True)
        (self.base / 'bin/python').write_text('synthetic interpreter, never run')
        (self.base / 'conda-meta').mkdir()
        (self.base / 'lib').mkdir()
        self.store = store_module.ProjectStore(self.root, self.base, reserve_bytes=0)
        self.user = 'environment-test-user'
    def tearDown(self):
        for root, dirs, _ in os.walk(self.root, followlinks=False):
            Path(root).chmod(0o700)
            for name in dirs:
                path = Path(root) / name
                if not path.is_symlink(): path.chmod(0o700)
        self.temp.cleanup()
    def environment(self, slug, mode=None, config='include-system-site-packages = false\n'):
        self.store.create(self.user, slug, mode)
        paths = self.store.dev_paths(self.user, slug)
        (paths['env'] / 'pyvenv.cfg').write_text(config)
        (paths['env'] / 'bin').mkdir()
        (paths['env'] / 'bin/python').symlink_to('/opt/conda/bin/python')
        return paths
    def test_old_metadata_and_release_digest_unchanged(self):
        self.environment('old')
        path, meta = self.store._project(self.user, 'old')
        del meta['environmentMode']
        store_module.atomic_json(path / 'project.json', meta)
        self.assertEqual(self.store.status(self.user, 'old')['environmentMode'], 'shared')
        result = self.store.publish(self.user, 'old')
        release = self.store.release(self.user, 'old', result['release'])
        self.assertNotIn('environmentMode', release['meta'])
        self.assertEqual(result['release'], store_module.digest({key: release['meta'][key] for key in ('schema','base','content')}))
        self.assertEqual(self.store.create(self.user, 'old')['environmentMode'], 'shared')
    def test_explicit_mode_is_immutable_no_reinstall_or_cross_user_change(self):
        paths = self.environment('clean', 'isolated')
        original = (paths['env'] / 'pyvenv.cfg').read_bytes()
        self.assertEqual(self.store.create(self.user, 'clean')['environmentMode'], 'isolated')
        with self.assertRaisesRegex(ValueError, 'cannot be changed'):
            self.store.create(self.user, 'clean', 'shared')
        self.assertEqual((paths['env'] / 'pyvenv.cfg').read_bytes(), original)
        self.assertEqual(self.store.create('other-user', 'clean')['environmentMode'], 'shared')
        for value in ('auto','',True,{},['isolated']):
            with self.assertRaises(ValueError): self.store.create(self.user, 'bad', value)
    def test_isolated_release_mode_is_hashed_and_ordinary_offline_assets_frozen(self):
        paths = self.environment('clean', 'isolated')
        (paths['code'] / 'offline/wheels').mkdir(parents=True)
        (paths['code'] / 'offline/wheels/a.whl').write_bytes(b'wheel-fixture')
        (paths['home'] / 'token').write_text('must-not-publish-fixture')
        result = self.store.publish(self.user, 'clean')
        release = self.store.release(self.user, 'clean', result['release'])
        self.assertEqual(result['environmentMode'], 'isolated')
        self.assertEqual(release['meta']['environmentMode'], 'isolated')
        self.assertEqual(result['release'], store_module.digest({key: release['meta'][key] for key in ('schema','base','content','environmentMode')}))
        self.assertEqual((release['code'] / 'offline/wheels/a.whl').read_bytes(), b'wheel-fixture')
        self.assertFalse((release['code'].parent / 'home').exists())
        self.assertEqual(self.store.status(self.user, 'clean')['offlineAssetsPath'], '/workspace/offline')
        (paths['code'] / 'offline/wheels/a.whl').write_bytes(b'changed')
        self.assertEqual((release['code'] / 'offline/wheels/a.whl').read_bytes(), b'wheel-fixture')
    def test_isolated_publish_rejects_inherited_missing_or_ambiguous_configuration(self):
        paths = self.environment('clean', 'isolated')
        for config in ('include-system-site-packages = true\n','home = /opt/conda/bin\n','include-system-site-packages = false\ninclude-system-site-packages = true\n'):
            (paths['env'] / 'pyvenv.cfg').write_text(config)
            with self.assertRaisesRegex(ValueError, 'Isolated project requires'):
                self.store.publish(self.user, 'clean')
            self.assertEqual(self.store.status(self.user, 'clean')['releases'], [])
            self.assertEqual((paths['env'] / 'pyvenv.cfg').read_text(), config)
    def test_shared_existing_environment_not_reinterpreted_or_rebuilt(self):
        self.environment('shared', 'shared', 'home = /opt/conda/bin\n')
        self.assertEqual(self.store.publish(self.user, 'shared')['environmentMode'], 'shared')
    def test_offline_symlink_does_not_smuggle_home_cache(self):
        paths = self.environment('clean', 'isolated')
        (paths['code'] / 'offline').symlink_to(paths['home'])
        with self.assertRaises(ValueError): self.store.publish(self.user, 'clean')
    def test_path_keeps_project_python_and_ray_wrapper_but_not_conda_fallback(self):
        self.assertEqual(runner.project_path('isolated', True), '/opt/project-env/bin:/opt/gpuq/bin:/usr/bin:/bin')
        self.assertIn('/opt/conda/bin', runner.project_path('shared', True))
        with self.assertRaises(ValueError): runner.project_path('unknown')
        self.assertIsNone(runner.project_runtime({}, self.root, {}, 'old-job', False))
    def test_common_profile_preserves_environment_contract_without_ray_preflight(self):
        for name in ('project_runtime','project_path','project_bootstrap'):
            self.assertEqual(inspect.getsource(getattr(common_runner,name)),inspect.getsource(getattr(runner,name)))
        source=inspect.getsource(common_runner.main)
        self.assertIn("'/opt/gpuq/bin/gpuq-network'",source)
        self.assertIn("project_path(project['environmentMode'],resources=True)",source)
        self.assertNotIn('read_budget(',source)
        self.assertIn('resources.verify_memory_pool(group,cfg)',source)
        self.assertNotIn('read_budget',source)
    def bootstrap(self, root, mode, initialize):
        command = runner.project_bootstrap(['/bin/bash','--noprofile','--norc'], mode)
        real_path = Path
        real_open = os.open
        def path(value): return root if value == '/opt/project-env' else real_path(value)
        def open_file(value,*args,**kwargs): return real_open(root.parent / '.gpuq-env-init.lock' if value == '/home/gpuq/.gpuq-env-init.lock' else value,*args,**kwargs)
        with patch('pathlib.Path', side_effect=path), patch.object(sys,'argv',['-c',*command[3:]]), patch('os.open',side_effect=open_file), patch('subprocess.run',side_effect=initialize) as run, patch('os.execvpe') as execute:
            exec(compile(command[2], '<project-bootstrap>', 'exec'), {})
        return run, execute
    def test_bootstrap_flag_and_real_isolated_python_without_network_or_pip(self):
        root = self.root / 'venv'; root.mkdir()
        real_run = subprocess.run
        calls = []
        def initialize(command, **kwargs):
            calls.append(command)
            # Use only the local stdlib venv; no pip/ensurepip/download invoked.
            return real_run([sys.executable,'-m','venv','--without-pip','--copies',str(root)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        _, execute = self.bootstrap(root, 'isolated', initialize)
        self.assertNotIn('--system-site-packages', calls[0])
        self.assertEqual(execute.call_args.args[:2], ('/bin/bash',['/bin/bash','--noprofile','--norc']))
        result = real_run([str(root/'bin/python'),'-I','-c','import json,site; print(json.dumps(site.getsitepackages()))'],check=True,capture_output=True,text=True)
        self.assertTrue(all(str(root) in value for value in json.loads(result.stdout)))
        before = (root / 'pyvenv.cfg').read_bytes()
        run, _ = self.bootstrap(root, 'isolated', lambda *a,**k: self.fail('existing venv reinstalled'))
        run.assert_not_called(); self.assertEqual((root / 'pyvenv.cfg').read_bytes(), before)
    def test_bootstrap_shared_default_and_conflict_do_not_overwrite(self):
        root = self.root / 'venv'; root.mkdir()
        def initialize(command, **kwargs):
            self.assertIn('--system-site-packages', command)
            (root / 'pyvenv.cfg').write_text('include-system-site-packages = true\n')
        self.bootstrap(root, 'shared', initialize)
        with self.assertRaisesRegex(RuntimeError, 'no automatic reinstall'):
            self.bootstrap(root, 'isolated', lambda *a,**k: self.fail('unexpected reinstall'))
        (root / 'pyvenv.cfg').unlink(); (root / 'user-file').write_text('preserve')
        with self.assertRaisesRegex(RuntimeError, 'not empty'):
            self.bootstrap(root, 'isolated', lambda *a,**k: self.fail('unexpected reinstall'))
    def test_node_rpc_create_accepts_mode_only_at_create_and_preserves_default(self):
        ops_module = load('environment_operations', 'project-ops.py')
        ops = ops_module.ProjectOperations(SimpleNamespace(HERE=DEPLOY,ROOT=self.root,CONFIG={'conda':str(self.base)},workspace=lambda user:None))
        args = {'userId':self.user,'project':'node-clean'}
        self.assertEqual(ops.process('projects.create',{**args,'environmentMode':'isolated'})['environmentMode'],'isolated')
        self.assertEqual(ops.process('projects.create',args)['environmentMode'],'isolated')
        for operation in ('projects.status','projects.publish','projects.list'):
            with self.assertRaises(ValueError): ops.process(operation,{**args,'environmentMode':'isolated'})
        for mode in (None,True,'auto',{}):
            with self.assertRaises(ValueError): ops.process('projects.create',{**args,'environmentMode':mode})
    def test_two_project_terminals_initialize_once(self):
        root=self.root/'concurrent';root.mkdir()
        lock=self.root/'init.lock';marker=self.root/'init.marker'
        bootstrap=runner.project_bootstrap(['/bin/true'],'isolated')[2].replace("pathlib.Path('/opt/project-env')",f'pathlib.Path({str(root)!r})').replace("'/home/gpuq/.gpuq-env-init.lock'",repr(str(lock)))
        setup=f'''import subprocess,pathlib,time,os
def initialize(command,**kwargs):
    fd=os.open({str(marker)!r},os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd)
    time.sleep(0.2)
    pathlib.Path({str(root/'pyvenv.cfg')!r}).write_text('include-system-site-packages = false\\n')
subprocess.run=initialize
'''
        processes=[subprocess.Popen([sys.executable,'-c',setup+bootstrap,'isolated',sys.executable,'-c','pass'],stdout=subprocess.PIPE,stderr=subprocess.PIPE) for _ in range(2)]
        try:
            outcomes=[(process,process.communicate(timeout=10)) for process in processes]
            for process,(_,error) in outcomes:self.assertEqual(process.returncode,0,error.decode())
        finally:
            for process in processes:
                if process.poll() is None:process.kill();process.communicate()
        self.assertTrue(marker.exists())

if __name__ == '__main__': unittest.main()
