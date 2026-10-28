"""Attempt teardown removes its exact launch container, never a scanned match."""
import importlib.util,json,os,subprocess,sys,unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock,patch

spec=importlib.util.spec_from_file_location('draining_fixture',Path(__file__).with_name('gpuq-cancel-draining.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
from gpuq.backends import UnitNotFoundError,UserSystemdBackend
spec=importlib.util.spec_from_file_location('personal_oci',Path(__file__).resolve().parents[1]/'node/personal-oci.py')
oci=importlib.util.module_from_spec(spec);spec.loader.exec_module(oci)


class PayloadCleanup(unittest.TestCase):
    canceled=f.CancelDrainingTests.canceled

    def setUp(self):
        f.CancelDrainingTests.setUp(self)
        self.root=Path(self.temp.name);self.containers=self.root/'containers.json';self.calls=self.root/'engine-calls.jsonl'
        self.containers.write_text(json.dumps({'gpuq-dev-workspace':{},'gpuq-live-other':{'GPUQ_ATTEMPT_ID':'other-attempt'}}))
        self.engine_script=self.root/'engine.py'
        self.engine_script.write_text('''import json,os,sys
from pathlib import Path
args=sys.argv[1:]
with Path(os.environ['ENGINE_CALLS']).open('a') as log:log.write(json.dumps(args)+'\\n')
if args[:3]!=['rm','--force','--ignore']:raise SystemExit('unexpected engine scan or operation')
flag=Path(os.environ['FAIL_ONCE'])
if flag.exists():flag.unlink();raise SystemExit(1)
file=Path(os.environ['CONTAINERS']);rows=json.loads(file.read_text());rows.pop(args[-1],None)
file.write_text(json.dumps(rows))
''')
        self.engine=oci.PersonalOCI.__new__(oci.PersonalOCI)
        self.engine.owner='alice'
        self.engine.s=oci.module('project-store');self.engine.d=oci.module('local-data')
        self.engine.folder=self.root/'engine';(self.engine.folder/'tmp').mkdir(parents=True)
        self.engine.workspace_container=lambda project:{'container':'gpuq-dev-workspace'}
        self.engine.command=lambda *args:[sys.executable,str(self.engine_script),*args]
        self.environment={'PATH':'/usr/bin:/bin','CONTAINERS':str(self.containers),
                          'ENGINE_CALLS':str(self.calls),'FAIL_ONCE':str(self.root/'fail-once')}

    def launch(self,attempt,code):
        def start(argv,**kwargs):
            request=json.loads(Path(argv[-1]).read_text());self.name=request['execution']
            rows=json.loads(self.containers.read_text())
            rows[self.name]={key:value for item in request['flags'] if '=' in item for key,value in [item.split('=',1)]}
            self.containers.write_text(json.dumps(rows));return code
        self.engine.call=start
        with patch.dict(os.environ,{'GPUQ_CONTROL_DIR':attempt['control_dir']}):
            self.assertEqual(self.engine.execute_workspace({'project':'demo','argv':['/bin/true']},
                ['--env','GPUQ_ATTEMPT_ID='+attempt['id']],self.environment),code)
        payload=Path(attempt['control_dir']).with_suffix('.payload.json')
        self.assertEqual(json.loads(payload.read_text())['argv'][-1],self.name)
        self.assertEqual(payload.parent,Path(attempt['control_dir']).parent)
        self.assertEqual(json.loads(self.containers.read_text())[self.name]['GPUQ_ATTEMPT_ID'],attempt['id'])
        return payload

    def assert_removed(self,payload):
        rows=json.loads(self.containers.read_text());self.assertNotIn(self.name,rows)
        self.assertFalse(payload.exists())
        self.assertEqual(set(rows),{'gpuq-dev-workspace','gpuq-live-other'})
        calls=[json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertTrue(calls);self.assertTrue(all(args==['rm','--force','--ignore',self.name] for args in calls))

    def backend(self,status,*,retry=False):
        self.unloads=[]
        def run(argv,**kwargs):
            self.assertNotIn(self.name,json.loads(self.containers.read_text()))
            self.unloads.append(argv)
            return subprocess.CompletedProcess(argv,0,'','')
        backend=UserSystemdBackend(runner=run)
        backend.status=Mock(side_effect=[status,*([status] if retry else []),UnitNotFoundError('unit gone')])
        backend._assert_cgroup_empty=Mock()
        self.systemd=self.coordinator.systemd=backend

    def finish(self,code,expected,*,canceled=False):
        job,attempt=self.canceled(f.AttemptState.RUNNING,term=False,canceled=canceled)
        payload=self.launch(attempt,code)
        status=replace(self.systemd.status.return_value,exec_main_status=code)
        self.backend(status)
        self.coordinator._on_unit_exited(attempt,status)
        self.children.clear();self.coordinator._statuses[attempt['id']]=status
        self.coordinator._process_actions()
        for _ in range(self.config.release_confirmations):self.coordinator._finalize_draining_attempts()
        self.assertEqual(self.store.get_job(job['id'])['state'],expected)
        self.assertEqual(self.store.list_leases(),[]);self.assert_removed(payload)
        self.assertEqual(len(self.unloads),1)

    def test_normal_exit_cleans_only_its_payload_record(self):self.finish(0,'SUCCEEDED')

    def test_cgroup_kill_cleans_only_its_payload_record(self):self.finish(137,'CANCELED',canceled=True)

    def test_container_start_failure_cleans_only_its_payload_record(self):self.finish(125,'FAILED')

    def test_finalization_while_unit_cleanup_is_queued_keeps_scheduling(self):
        # The unit cleanup already removes the payload; finalizing first must not queue a clashing one.
        job,attempt=self.canceled(f.AttemptState.RUNNING,term=False,canceled=False)
        payload=self.launch(attempt,0)
        status=replace(self.systemd.status.return_value,exec_main_status=0)
        self.backend(status)
        self.coordinator._on_unit_exited(attempt,status)
        self.children.clear();self.coordinator._statuses[attempt['id']]=status
        for _ in range(self.config.release_confirmations):self.coordinator._finalize_draining_attempts()
        self.assertEqual(self.store.get_job(job['id'])['state'],'SUCCEEDED')
        self.coordinator._process_actions();self.assert_removed(payload)
        self.assertEqual([action['action_type'] for action in self.store.list_actions(attempt_id=attempt['id'])].count('CLEANUP_UNIT'),1)

    def test_finalization_after_unit_disappears_survives_daemon_restart(self):
        job,attempt=self.canceled(f.AttemptState.DRAINING,term=False,canceled=False)
        payload=self.launch(attempt,0);self.store.update_attempt(attempt['id'],exit_code=0)
        self.children.clear();self.coordinator._statuses.pop(attempt['id'])
        for _ in range(self.config.release_confirmations):self.coordinator._finalize_draining_attempts()
        self.assertEqual(self.store.get_job(job['id'])['state'],'SUCCEEDED')
        self.assertTrue(payload.exists())
        backend=Mock();backend.cleanup.side_effect=UnitNotFoundError('unit already gone')
        restarted=f.Coordinator(self.config,self.store,Mock(),backend,boot_id='test-boot',clock=lambda:self.now)
        restarted._process_actions();self.assert_removed(payload)

    def test_failed_cleanup_retries_from_the_original_name_after_unit_unloads(self):
        job,attempt=self.canceled(f.AttemptState.RUNNING,term=False,canceled=False)
        payload=self.launch(attempt,0);(self.root/'fail-once').touch()
        status=replace(self.systemd.status.return_value,exec_main_status=0)
        self.backend(status,retry=True)
        self.coordinator._on_unit_exited(attempt,status);self.coordinator._process_actions()
        self.assertTrue(payload.exists());self.assertIn(self.name,json.loads(self.containers.read_text()))
        self.assertEqual(self.unloads,[]);self.now+=32
        self.coordinator._process_actions();self.assert_removed(payload)
        self.assertEqual(len(self.unloads),1)
        action=self.store.list_actions(attempt_id=attempt['id'])[0]
        self.assertEqual(action['result'],{'cleaned':True})
        self.coordinator._statuses.pop(attempt['id']);self.coordinator._attempt_has_sharing=Mock(return_value=True)
        self.assertTrue(self.coordinator._attempt_gpus_released(attempt))


if __name__=='__main__':unittest.main()
