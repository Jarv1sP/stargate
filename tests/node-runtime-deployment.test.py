"""Execute actual upgrade copies, then import deployed entrypoint in a process.

All node/config/DB/unit files are temporary. Only external mount/systemd/CPU
preflights are mocked; file planning, backup and copying execute unchanged.
"""
import ast
import contextlib
from contextlib import closing
import importlib.util
import io
import json
import os
import pwd
import runpy
from pathlib import Path
import shutil
import stat
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace,ModuleType
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1];DEPLOY=ROOT/'deploy'
sys.path.insert(0,str(DEPLOY))
import node_runtime


def load(path,name):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


class DependencyValidation(unittest.TestCase):
    def test_subset_view_helper_is_in_both_complete_runtime_cohorts(self):
        for profile in ('common-p0', 'ray-p0'):
            with self.subTest(profile=profile):
                _, payloads = node_runtime.preflight(DEPLOY, profile)
                self.assertIn('dataset-subset.py', payloads)
                self.assertIn('dataset-cache.py', payloads)
                # Real import of just the shipped files detects omitted dynamic
                # dependencies without installing or invoking the node executor.
                with tempfile.TemporaryDirectory() as folder:
                    for name in ('dataset-subset.py', 'dataset-cache.py'):
                        (Path(folder) / name).write_bytes(payloads[name])
                    result = subprocess.run([sys.executable, '-B', '-c',
                        "import runpy; m=runpy.run_path('dataset-subset.py'); print(m['PROTOCOL'])"],
                        cwd=folder, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), 'dataset-subset-v1')

    def test_pure_python_suffix_in_a_dynamic_filename_is_not_a_dependency(self):
        node_runtime.validate_dependencies({'worker.py':b"name = 'helper'\nfilename = name + '.py'\n"})

    def test_missing_concrete_python_filename_still_fails(self):
        source=b"filename = 'foo.py'\n"
        with self.assertRaisesRegex(SystemExit,r'^Runtime manifest misses dependencies of worker.py: foo\.py$'):
            node_runtime.validate_dependencies({'worker.py':source})
        node_runtime.validate_dependencies({'worker.py':source,'foo.py':b''})


class RuntimeDeployment(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.base=Path(self.temp.name)
        self.source=self.base/'source';shutil.copytree(DEPLOY,self.source)
        self.dest=self.base/'node';self.dest.mkdir(mode=0o700);self.root=self.base/'state';self.root.mkdir(mode=0o700)
        self.conda=self.base/'conda';(self.conda/'bin').mkdir(parents=True);(self.conda/'bin/python').touch()
        self.cache=self.base/'cache';self.cache.mkdir(mode=0o700);self.home=self.base/'home';self.units=self.home/'.config/systemd/user';self.units.mkdir(parents=True)
        self.config={'root':str(self.root),'gpu':'/not/a/gpu','cards':3,'database':str(self.base/'db'),'conda':str(self.conda),'hostRoot':False,'runtimeProfileMarker':'keep-exactly'}
        self.path=self.dest/'node-config.json';self.path.write_text(json.dumps(self.config));self.path.chmod(0o600)
        for name in ('platform-root-guard.py','node-executor.py','terminal-helper.py','job-diagnostics.py'):shutil.copy2(DEPLOY/name,self.dest/name);(self.dest/name).chmod(0o700)
        shutil.copy2(DEPLOY/'sandbox-runner-common-p0.py',self.dest/'sandbox-runner.py')
        for name in node_runtime.manifest()['units']:(self.units/name).write_text((DEPLOY/name).read_text().replace('%h/.local/libexec/gpuq-console',str(self.dest)))
        with closing(sqlite3.connect(self.config['database'])) as db:db.execute('CREATE TABLE jobs(id TEXT,submit_key TEXT)');db.commit()
        self.dataset=load(DEPLOY/'upgrade-datasets.py','runtime_dataset_upgrade');self.projects=load(DEPLOY/'upgrade-projects.py','runtime_project_upgrade')

    def dataset_apply(self,module=None):
        module=module or self.dataset
        # Keep the real runtime payload on disk; mock only cache/mount probing.
        fake=SimpleNamespace(_data2_mount=lambda:None,DatasetCache=lambda **_:None)
        loader=SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _:None))
        if hasattr(module,'cache_module'):
            probe=patch.object(module,'cache_module',return_value=fake)
        else:
            # Legacy repro retains its original loader code. Limit its mock to
            # this exact cache probe, leaving unrelated imports intact.
            original_spec=module.importlib.util.spec_from_file_location;original_module=module.importlib.util.module_from_spec
            probe=contextlib.ExitStack()
            probe.enter_context(patch.object(module.importlib.util,'spec_from_file_location',side_effect=lambda name,path,*a,**kw:loader if name=='gpuq_dataset_cache' else original_spec(name,path,*a,**kw)))
            probe.enter_context(patch.object(module.importlib.util,'module_from_spec',side_effect=lambda spec:fake if spec is loader else original_module(spec)))
        with probe,patch.object(module,'DATASET_ROOT',self.cache),patch.object(module.subprocess,'run',return_value=SimpleNamespace(stdout='--ro-bind-fd')),contextlib.redirect_stdout(io.StringIO()) as output:
            module.main(['--directory',str(self.dest),'--source',str(self.source),'--apply'])
        return json.loads(output.getvalue())

    def projects_apply(self,profile='common-p0'):
        with patch.object(self.projects.Path,'home',return_value=self.home),patch.object(self.projects,'timer_preflight'),patch.object(self.projects,'cpu_preflight',return_value={'cpuMax':'1 1','memoryMax':1,'pidsMax':1}),contextlib.redirect_stdout(io.StringIO()) as output:
            self.projects.main(['--directory',str(self.dest),'--source',str(self.source),'--runtime-profile',profile,'--apply'])
        return json.loads(output.getvalue())

    def deployed_import(self):
        script="import runpy; n=runpy.run_path(%r,run_name='deployed_runtime'); print('LOADED',n['SCHEDULING'].normalize_job_policy({})['kind'])"%str(self.dest/'node-executor.py')
        return subprocess.run([sys.executable,'-c',script],capture_output=True,text=True,timeout=10)

    def assert_complete(self,profile):
        result=self.deployed_import();self.assertEqual(result.returncode,0,result.stderr);self.assertIn('LOADED legacy',result.stdout)
        for target,original in node_runtime.runtime_plan(profile):
            self.assertEqual((self.dest/target).read_bytes(),(self.source/original).read_bytes(),target)
            self.assertEqual(stat.S_IMODE((self.dest/target).stat().st_mode),0o700,target)
        self.assertEqual(json.loads(self.path.read_text())['runtimeProfileMarker'],'keep-exactly')

    def test_ray_profile_marker_is_the_actual_trusted_resource_argument(self):
        payload=(self.source/'sandbox-runner.py').read_bytes()
        self.assertEqual(self.projects.runner_profile(payload),'ray-p0')
        functions=self.projects.functions(payload)
        call=next(node for node in ast.walk(functions['main']) if isinstance(node,ast.Call)
                  and isinstance(node.func,ast.Name) and node.func.id=='run_job')
        value=next(item.value for item in call.keywords if item.arg=='resource_module')
        self.assertIsInstance(value,ast.Constant);self.assertEqual(value.value,'job-resources.py')
        implementation=functions['run_job']
        self.assertIn('resource_module',[arg.arg for arg in implementation.args.kwonlyargs])
        self.assertTrue(any(isinstance(node,ast.Call) and isinstance(node.func,ast.Name)
                            and node.func.id=='local_module' and len(node.args)==2
                            and isinstance(node.args[1],ast.Name) and node.args[1].id=='resource_module'
                            for node in ast.walk(implementation)))
        self.projects_apply('ray-p0');self.assert_complete('ray-p0')

    def test_dataset_upgrade_installs_real_bootstrap_and_all_helpers_common_profile(self):
        out=self.dataset_apply();self.assertEqual(out['runtimeProfile'],'common-p0');self.assert_complete('common-p0')

    def test_dataset_upgrade_preserves_ray_profile_without_explicit_change(self):
        shutil.copy2(DEPLOY/'sandbox-runner.py',self.dest/'sandbox-runner.py');out=self.dataset_apply();self.assertEqual(out['runtimeProfile'],'ray-p0');self.assert_complete('ray-p0')

    def test_project_upgrade_installs_real_bootstrap_and_config_stays_byte_exact(self):
        config=self.path.read_bytes();self.projects_apply();self.assertEqual(self.path.read_bytes(),config);self.assert_complete('common-p0')

    def test_project_upgrade_explicit_ray_cohort_has_resource_dependencies(self):
        self.projects_apply('ray-p0');self.assert_complete('ray-p0')

    def test_admin_quota_lifecycle_is_deployed_with_its_setup_dependency_in_every_profile(self):
        # The offline administrator command is not imported by the node RPC
        # entrypoint. Exercise its real deployed CLI, not just a file count.
        for profile in ('common-p0','ray-p0'):
            with self.subTest(profile=profile):
                planned=dict(node_runtime.runtime_plan(profile))
                for name in ('manage-storage-quota.py','configure-storage-quota.py'):
                    self.assertIn(name,planned)
                self.projects_apply(profile);self.assert_complete(profile)
                before={p.name:p.read_bytes() for p in self.dest.iterdir() if p.is_file()}
                result=subprocess.run([sys.executable,'-B',str(self.dest/'manage-storage-quota.py'),'--help'],
                                      capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,0,result.stderr)
                for command in ('policy','migrate','status'):self.assertIn(command,result.stdout)
                self.assertEqual(before,{p.name:p.read_bytes() for p in self.dest.iterdir() if p.is_file()})

    def test_admin_quota_setup_omission_aborts_real_import_graph_before_copy(self):
        manifest=json.loads((self.source/'node-runtime.json').read_text())
        manifest['dependencies'].remove('configure-storage-quota.py')
        (self.source/'node-runtime.json').write_text(json.dumps(manifest))
        before={p.name:p.read_bytes() for p in self.dest.iterdir() if p.is_file()}
        with self.assertRaisesRegex(SystemExit,'misses dependencies.*configure-storage-quota'):
            self.projects_apply()
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.dest.iterdir() if p.is_file()})
        self.assertFalse(list(self.dest.glob('before-projects-*')))

    def test_missing_ray_only_dependencies_abort_without_downgrading_existing_profile(self):
        shutil.copy2(DEPLOY/'sandbox-runner.py',self.dest/'sandbox-runner.py')
        before=(self.dest/'sandbox-runner.py').read_bytes()
        for name in node_runtime.manifest()['profiles']['ray-p0']['extra']:
            path=self.source/name;payload=path.read_bytes();path.unlink()
            try:
                with self.subTest(missing=name),self.assertRaises(SystemExit):self.dataset_apply()
                self.assertEqual((self.dest/'sandbox-runner.py').read_bytes(),before);self.assertFalse(list(self.dest.glob('before-datasets-*')))
            finally:path.write_bytes(payload)

    def test_missing_every_runtime_dependency_aborts_data_upgrade_before_any_copy(self):
        for target,original in node_runtime.runtime_plan('common-p0'):
            with self.subTest(missing=original):
                path=self.source/original;payload=path.read_bytes();path.unlink();before={p.name:p.read_bytes() for p in self.dest.iterdir() if p.is_file()}
                try:
                    with self.assertRaises(SystemExit):self.dataset_apply()
                    self.assertEqual(before,{p.name:p.read_bytes() for p in self.dest.iterdir() if p.is_file()});self.assertFalse(list(self.dest.glob('before-datasets-*')))
                finally:path.write_bytes(payload)

    def test_manifest_omission_is_detected_by_actual_local_import_graph(self):
        manifest=json.loads((self.source/'node-runtime.json').read_text());manifest['dependencies'].remove('scheduling-policy.py');(self.source/'node-runtime.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(SystemExit,'misses dependencies.*scheduling-policy'):self.dataset_apply()
        self.assertFalse(list(self.dest.glob('before-datasets-*')))

    def test_missing_every_runtime_dependency_aborts_project_upgrade_before_any_copy(self):
        for target,original in node_runtime.runtime_plan('common-p0'):
            with self.subTest(missing=original):
                path=self.source/original;payload=path.read_bytes();path.unlink();before={p.name:p.read_bytes() for p in self.dest.iterdir() if p.is_file()}
                try:
                    with self.assertRaises((SystemExit,FileNotFoundError)):self.projects_apply()
                    self.assertEqual(before,{p.name:p.read_bytes() for p in self.dest.iterdir() if p.is_file()});self.assertFalse(list(self.dest.glob('before-projects-*')))
                finally:path.write_bytes(payload)

    @unittest.skipUnless(Path('/sys/fs/cgroup/cgroup.controllers').exists(), 'fresh Linux install requires cgroup v2')
    def test_fresh_install_uses_same_preflight_and_copies_then_imports(self):
        checkout=self.base/'checkout';shutil.copytree(self.source,checkout/'deploy')
        home=self.base/'install-home';programs=home/'.local/libexec/gpuq-console';programs.mkdir(parents=True)
        # Existing ray profile is retained because no profile flag is supplied.
        shutil.copy2(DEPLOY/'sandbox-runner.py',programs/'sandbox-runner.py')
        (programs/'node-config.json').write_text(json.dumps(self.config))
        scheduler=self.base/'scheduler';scheduler.mkdir();(scheduler/'config.json').write_text(json.dumps({'db_path':self.config['database'],'observe_only':True}))
        (home/'bin').mkdir();(home/'bin/gpu').touch()
        inventory=self.base/'inventory.json';inventory.write_text(json.dumps({'vpsTailIP':'127.0.0.1','nodes':[{'id':'test-node','user':pwd.getpwuid(os.getuid()).pw_name,'workspaceRoot':str(self.root),'gpuqRoot':str(scheduler),'conda':str(self.conda),'cards':3}]}))
        key=self.base/'test.pub';key.write_text('ssh-ed25519 synthetic-fixture-key')
        command=['install-node.py','--inventory',str(inventory),'--node','test-node','--collector-key',str(key),'--executor-key',str(key)]
        with patch.object(sys,'argv',command),patch.object(Path,'home',return_value=home),patch('shutil.which',return_value='/synthetic/binary'),patch('subprocess.run',return_value=SimpleNamespace(stdout='--bind-fd --ro-bind-fd',stderr='',returncode=0)),contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(checkout/'deploy/install-node.py'),run_name='__main__')
        self.dest=programs;self.path=programs/'node-config.json';self.assert_complete('ray-p0')

    def reproduce_pr5(self):
        payload=subprocess.check_output(['git','show','834d4d6:deploy/upgrade-datasets.py'],cwd=ROOT)
        legacy=ModuleType('legacy_pr5_upgrade');legacy.__file__=str(DEPLOY/'upgrade-datasets.py');exec(compile(payload,legacy.__file__,'exec'),legacy.__dict__)
        self.dataset_apply(legacy);out=self.deployed_import()
        self.assertNotEqual(out.returncode,0);self.assertIn('scheduling-policy.py',out.stderr)
        print(json.dumps({'pr5_reproduced':True,'entrypoint_exit':out.returncode,'missing_dependency':'scheduling-policy.py','real_upgrade_copy':True}))


if __name__=='__main__':
    if sys.argv[1:]==['--reproduce-pr5']:
        case=RuntimeDeployment();case.setUp()
        try:case.reproduce_pr5()
        finally:case.doCleanups()
    else:unittest.main()
