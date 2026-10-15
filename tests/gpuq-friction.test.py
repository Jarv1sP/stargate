"""Round5: real SQLite/SDK/files, synthetic systemd/GPU facts; no remote hosts."""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

loader = importlib.util.spec_from_file_location('friction_scheduler', Path(__file__).with_name('gpuq-priority.test.py'))
F = importlib.util.module_from_spec(loader); loader.loader.exec_module(F)
from gpuq import checkpoint, cluster, cluster_node, elastic, hami, sync, progress
from gpuq.backends import UnitIdentityError, UserSystemdBackend
from gpuq.rpc import ApiError
from gpuq.store import Store, StoreConflictError


class SchedulerFriction(unittest.TestCase):
    setUp = F.SchedulerPriorityTests.setUp
    submit = F.SchedulerPriorityTests.submit
    running = F.SchedulerPriorityTests.running
    snapshot = F.SchedulerPriorityTests.snapshot

    def test_current_database_opens_with_extra_objects_and_changed_metadata(self):
        job, attempt = self.running()
        leases = self.store.list_leases()
        self.store._get_connection().executescript('CREATE TABLE extra_status(value); PRAGMA user_version=99; PRAGMA application_id=123; UPDATE schema_meta SET schema_version=42;')
        self.store.close()
        with patch.object(Store, '_validate_integrity', side_effect=AssertionError('startup read-back')):
            self.store.open(); self.store.initialize()
        self.assertEqual(self.store.get_job(job['id'])['state'], 'RUNNING')
        self.assertEqual(self.store.list_leases(), leases)
        self.assertEqual(self.store.get_attempt(attempt['id'])['job_id'], job['id'])
        self.assertEqual(self.store.check_integrity()['schema_version'], 99)

    def test_native_requests_ignore_extra_fields_and_display_history(self):
        job = self.submit()
        result = self.coordinator.handle_api('set_job_display', {
            'job_id': job['id'],
            'metadata': {'name': 'shared', 'description': '', 'extra': True,
                         'submitter': {'name': 'Bob', 'username': 'bob', 'extra': True}}, 'extra': True})
        self.assertEqual(result['display_metadata']['name'], 'shared')
        first = self.coordinator.handle_api('set_priority_rank', {'job_id':job['id'], 'priority':4, 'extra':True})
        second = self.coordinator.handle_api('set_priority_rank', {'job_id':job['id'], 'priority':1})
        self.assertEqual((first['priority'],second['priority']), (4,1))
        self.assertEqual(self.coordinator.handle_api('show', {'job_id':job['id'], 'extra':True})['job']['id'], job['id'])

    def test_submission_extra_fields_ignore_but_original_key_still_deduplicates(self):
        key = str(uuid.uuid4())
        job = self.submit(submit_key=key, extra='first')
        self.assertEqual(self.submit(submit_key=key, extra='changed')['id'], job['id'])
        with self.assertRaises(StoreConflictError): self.submit(submit_key=key, argv=['/bin/echo','different'])
        self.assertEqual(len(self.store.list_jobs()),1)

    def test_current_unit_is_observed_after_stored_boot_pid_and_ticks_change(self):
        job, attempt = self.running()
        self.store.update_attempt(attempt['id'], boot_id='old', main_pid=111, start_ticks=1)
        current = self.store.get_attempt(attempt['id'])
        self.systemd.status.return_value = SimpleNamespace(main_pid=222)
        self.assertIs(self.coordinator._verified_status(current), self.systemd.status.return_value)

    def test_signal_deadline_escalates_the_active_unit_and_retains_its_lease(self):
        job, attempt=self.running()
        self.store.update_attempt(attempt['id'],state='TERM_REQUESTED',term_deadline_at=0)
        self.systemd.status.return_value=SimpleNamespace(main_pid=1,is_cleanup_ready=False,control_group='/user.slice/gpuq-test.service')
        self.coordinator._reconcile_attempts()
        self.assertEqual(self.store.get_attempt(attempt['id'])['state'],'KILL_REQUESTED')
        self.assertTrue(any(a['action_type']=='KILL_UNIT' for a in self.store.list_actions()))
        self.assertEqual(len(self.store.list_leases()),1)

    def test_missing_audit_history_does_not_block_resource_release(self):
        _, attempt = self.running()
        self.store._get_connection().execute('DELETE FROM gpu_allocation_history')
        self.assertEqual(self.store.release_leases(attempt_id=attempt['id']),1)
        self.assertEqual(self.store.list_leases(),[])

    def test_progress_extra_fields_and_changed_totals_do_not_block_reporting(self):
        job, attempt = self.running()
        value = {'version':99,'job_id':'old-label','attempt_id':attempt['id'],'sequence':1,'phase':'train',
                 'epochs_completed':1,'epochs_total':10,'steps_completed':None,'steps_total':None,
                 'metrics':{},'eta_seconds':None,'stall_timeout_seconds':None,'severity':'info','message':None,'extra':True}
        first = self.store.accept_attempt_progress(value)
        self.assertEqual(first['progress']['job_id'],job['id'])
        second = self.store.accept_attempt_progress({**value,'sequence':2,'epochs_total':20})
        self.assertTrue(second['accepted'])
        self.assertEqual(second['progress']['snapshot']['epochs_total'],20)
        self.assertEqual(self.store.get_job(job['id'])['state'],'RUNNING')

    def test_labels_and_progress_have_no_extra_per_field_size_limits(self):
        job, attempt=self.running()
        metadata={'name':'x'*200,'description':'y'*3000,'submitter':{'name':'z'*80,'username':'u'*80}}
        changed=self.coordinator.handle_api('set_job_display',{'job_id':job['id'],'metadata':metadata})
        self.assertEqual(changed['display_metadata'],metadata)
        value={'job_id':job['id'],'attempt_id':attempt['id'],'sequence':1,'phase':'p'*100,
               'epochs_completed':1,'epochs_total':10,'steps_completed':None,'steps_total':None,
               'metrics':{'metric '+str(i):i for i in range(40)},'eta_seconds':None,
               'stall_timeout_seconds':None,'severity':'info','message':'m'*600}
        result=self.store.accept_attempt_progress(value)
        self.assertEqual(len(result['progress']['snapshot']['metrics']),40)
        self.assertEqual(result['progress']['snapshot']['message'],value['message'])
        with self.assertRaises(progress.ProgressProtocolError):
            progress.validate_progress_payload({**value,'phase':'p'*(progress.MAX_PROGRESS_FILE_BYTES+1)})

    def test_fleet_admission_extra_fields_do_not_change_original_token(self):
        self.coordinator._set_health("ok")
        key = str(uuid.uuid4())
        submission = {'submit_key':str(uuid.uuid4()),'name':'fleet','owner':'member','priority':2,
                      'dispatch_mode':'queue','checkpoint_capability':'none','restart_policy':'never',
                      'gpu_count':1,'placement':'any','requested_gpu_uuids':[],
                      'argv':['/bin/true'],'cwd':str(self.root),'env':{}}
        first = cluster_node.node_api(self.coordinator, 'fleet_admit', {'token':key,'submission':submission,'extra':1})
        second = cluster_node.node_api(self.coordinator, 'fleet_admit', {'token':key,'submission':{**submission,'extra':2},'extra':3})
        self.assertEqual(first,second)
        self.assertTrue(first['accepted'])

    def test_unavailable_node_keeps_admission_key_retryable(self):
        key=str(uuid.uuid4())
        submission={'submit_key':str(uuid.uuid4()),'name':'fleet','owner':'member','priority':2,
                    'dispatch_mode':'queue','checkpoint_capability':'none','restart_policy':'never',
                    'gpu_count':1,'placement':'any','requested_gpu_uuids':[],
                    'argv':['/bin/true'],'cwd':str(self.root),'env':{}}
        with self.assertRaises(ApiError) as unavailable:
            cluster_node.node_api(self.coordinator,'fleet_admit',{'token':key,'submission':submission})
        self.assertEqual(unavailable.exception.code,'UNAVAILABLE')
        self.assertIsNone(self.store.get_setting('fleet.admission.'+key))
        self.coordinator._set_health('ok')
        result=cluster_node.node_api(self.coordinator,'fleet_admit',{'token':key,'submission':submission})
        self.assertTrue(result['accepted'])


class SDKAndTransferFriction(unittest.TestCase):
    def test_checkpoint_saves_the_requested_file_once_and_acknowledges_its_key(self):
        with tempfile.TemporaryDirectory(prefix='c4-checkpoint-') as d:
            directory=Path(d); nonce=str(uuid.uuid4()); saved=directory/'checkpoint.bin'
            (directory/'request.json').write_text(json.dumps({'nonce':nonce,'attempt_id':'attempt',
                'requested_by_job_id':'requester','created_at':1,'extra':True}))
            calls=[]
            def save():
                calls.append(1);saved.write_bytes(b'checkpoint-data');return {'checkpoint_path':str(saved)}
            with self.assertRaises(SystemExit) as exited:
                checkpoint.checkpoint_at_epoch_end(save, control_dir=directory, expected_nonce=nonce)
            self.assertEqual(exited.exception.code,75); self.assertEqual(saved.read_bytes(),b'checkpoint-data')
            self.assertEqual(len(calls),1)
            # Same original request must not save the same epoch a second time.
            with self.assertRaises(SystemExit): checkpoint.checkpoint_at_epoch_end(save,control_dir=directory,expected_nonce=nonce)
            self.assertEqual(len(calls),1)
            self.assertTrue(checkpoint.checkpoint_acknowledged({'nonce':nonce,'exit_code':75,'extra':True},nonce=nonce))
            self.assertFalse(checkpoint.checkpoint_acknowledged({'nonce':'other','exit_code':75},nonce=nonce))

    def test_checkpoint_save_reads_request_once_and_retains_distributed_decision(self):
        with tempfile.TemporaryDirectory(prefix='c4-checkpoint-peer-') as d:
            directory=Path(d)
            (directory/'request.json').write_text(json.dumps({'nonce':'key','attempt_id':'attempt','requested_by_job_id':'requester','created_at':1}))
            with patch.object(checkpoint,'_load_request',wraps=checkpoint._load_request) as read:
                with self.assertRaises(SystemExit):
                    checkpoint.checkpoint_at_epoch_end(lambda:None,control_dir=directory,broadcast_decision=lambda decision:{**decision,'extra':True})
                self.assertEqual(read.call_count,1)
            with self.assertRaises(SystemExit) as peer_exit:
                checkpoint.checkpoint_at_epoch_end(lambda:None,rank=1,control_dir=directory,
                    broadcast_decision=lambda _: {'status':'ack','extra':True})
            self.assertEqual(peer_exit.exception.code,75)

    def test_checkpoint_failure_keeps_training_error_and_no_success_ack(self):
        with tempfile.TemporaryDirectory(prefix='c4-checkpoint-error-') as d:
            directory=Path(d)
            (directory/'request.json').write_text(json.dumps({'nonce':'key','attempt_id':'attempt','requested_by_job_id':'requester','created_at':1}))
            with self.assertRaisesRegex(OSError,'disk full'):
                checkpoint.checkpoint_at_epoch_end(lambda: (_ for _ in ()).throw(OSError('disk full')),control_dir=directory)
            self.assertFalse((directory/'ack.json').exists())

    def test_explicit_batch_parameters_and_torchrun_worker_count_take_precedence(self):
        plan=elastic.plan_elastic_batch(128,4,world_size=4,environ={'GPUQ_TARGET_GLOBAL_BATCH_SIZE':'64','GPUQ_PER_DEVICE_MICRO_BATCH_SIZE':'2','WORLD_SIZE':'2','GPUQ_ASSIGNED_GPU_COUNT':'8'})
        self.assertEqual((plan.world_size,plan.effective_global_batch_size),(4,128))
        self.assertEqual(elastic.resolve_world_size(environ={'WORLD_SIZE':'2','GPUQ_ASSIGNED_GPU_COUNT':'8'}),2)
        self.assertEqual(elastic.compatible_world_sizes(128,4,1,8),(1,2,4,8))

    def test_hami_runtime_locates_the_installed_library(self):
        with tempfile.TemporaryDirectory(prefix='c4-hami-') as d:
            directory=Path(d)/'hami';directory.mkdir();library=directory/'libvgpu.so';library.write_bytes(b'fixture-library')
            self.assertEqual(hami.runtime_library(Path(d)/'gpuq.pyz'),library)

    def test_systemd_reports_the_current_unit_and_protects_its_cgroup(self):
        unit='gpuq-test.service'
        props={'Id':unit,'Description':'current label','InvocationID':'b'*32,'MainPID':'42',
               'ExecMainStatus':'0','LoadState':'loaded','ActiveState':'active','SubState':'running',
               'Result':'success','ExecMainCode':'exited','ControlGroup':'/user.slice/'+unit,'extra':'ignored'}
        text='\n'.join(k+'='+v for k,v in props.items())+'\n'
        backend=UserSystemdBackend(runner=lambda *a,**kw:subprocess.CompletedProcess(a,0,text,''))
        status=backend.status(unit_name=unit)
        self.assertEqual((status.main_pid,status.invocation_id),(42,'b'*32))
        props['ControlGroup']='/user.slice/other.service'
        with self.assertRaises(UnitIdentityError): backend._validated_status(unit=unit,properties=props)

    def test_file_copy_runs_once_with_pending_capacity(self):
        with tempfile.TemporaryDirectory(prefix='c4-sync-') as d:
            source=Path(d);(source/'file.bin').write_bytes(b'file-data')
            with patch.object(sync,'preview',return_value={'new_files':1,'new_bytes':9,'conflicts':0,'examples':[]}), \
                 patch.object(sync.subprocess,'run',return_value=SimpleNamespace(returncode=0)) as transfer:
                result=sync.transfer(source,'/srv/dataset',{'ssh':'fixture'},[],dry_run=False,as_json=True)
            self.assertEqual(result['bytes'],9);self.assertTrue(result['ready']);self.assertEqual(transfer.call_count,1)
            header=base64.urlsafe_b64encode(json.dumps({'dest':'/srv/dataset','phase':'copy','required_bytes':9,'exclude':[]}).encode()).decode()
            self.assertEqual(sync.decode_header(header)['required_bytes'],9)

    def test_fleet_dispatch_accepts_actual_uuid_and_unknown_retries_same_target(self):
        with tempfile.TemporaryDirectory(prefix='c4-fleet-dispatch-') as d:
            store=cluster.QueueStore(Path(d)/'fleet.db',initialize=True)
            try:
                job=store.submit({'hosts':['fixture']},{'submit_key':str(uuid.uuid4()),'priority':2,'name':'job','owner':'member'})
                remote_job=str(uuid.uuid4());calls=[]
                def transport(inventory,host,scope,op,args):
                    calls.append((host,op,args))
                    if op=='preflight':return {'kind':'idle','count':1,'submission':{'argv':['/bin/true']}}
                    if len([c for c in calls if c[1]=='fleet_admit'])==1:raise OSError('temporary disconnect')
                    return {'accepted':True,'job_id':remote_job}
                coordinator=cluster.FleetCoordinator(store,{'hosts':{'fixture':{}}},transport)
                with self.assertRaises(OSError):coordinator.process(job)
                pending=store.get(job['id']);self.assertEqual(pending['state'],'DISPATCHING')
                token=pending['token'];coordinator.process(pending)
                after=store.get(job['id']);self.assertEqual(after['remote_job'],remote_job)
                self.assertEqual(after['token'],token)
                admits=[c for c in calls if c[1]=='fleet_admit'];self.assertEqual(admits[0],admits[1])
            finally:store.close()

    def test_fleet_queue_opens_extra_metadata_and_keeps_one_message_key(self):
        with tempfile.TemporaryDirectory(prefix='c4-fleet-') as d:
            path=Path(d)/'fleet.db';store=cluster.QueueStore(path,initialize=True)
            key=str(uuid.uuid4());body={'message_key':key,'owner':'member','body':'message'}
            before=store.board('board_post',body)
            store.conn.executescript('PRAGMA application_id=5; PRAGMA user_version=99; CREATE TABLE extra(value);');store.close()
            store=cluster.QueueStore(path)
            try:
                self.assertEqual(store.board('board_post',{**body,'extra':True}),before)
                self.assertEqual(store.board('board_post',{**body,'body':'different'}),before)
                self.assertEqual(len(store.board('board_list',{})['messages']),1)
            finally:store.close()


if __name__=='__main__':unittest.main()
