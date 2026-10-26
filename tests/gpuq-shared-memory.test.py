"""Shared VRAM admission and headroom use the same per-attempt accounting."""
from dataclasses import replace
import importlib.util
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

loader=importlib.util.spec_from_file_location('shared_scheduler_fixture',Path(__file__).with_name('gpuq-priority.test.py'))
F=importlib.util.module_from_spec(loader);loader.loader.exec_module(F)
from gpuq.backends import NvidiaSmiProvider


class SharedMemory(unittest.TestCase):
    submit=F.SchedulerPriorityTests.submit

    def setUp(self):
        F.SchedulerPriorityTests.setUp(self)
        self.config=replace(self.config,managed_gpu_uuids=('GPU-5',))
        self.coordinator.config=self.config

    snapshot=F.SchedulerPriorityTests.snapshot

    def holder(self,reserved=None):
        args={'placement':'pinned','requested_gpu_uuids':['GPU-5']}
        if reserved is not None:args.update(share_gpu=True,vram_mb=reserved)
        job=self.submit(**args);aid='A'+uuid.uuid4().hex
        control,log=self.coordinator._create_attempt_paths(job['id'],aid)
        attempt=self.store.create_attempt(job['id'],attempt_id=aid,state='RUNNING',gpu_uuids=['GPU-5'],gpu_indices=[5],
            unit_name='gpuq-'+aid.lower(),unit_token='attempt:'+aid,boot_id='test-boot',invocation_id='a'*32,
            control_dir=str(control),log_path=str(log))
        self.store.acquire_leases(job['id'],aid,{'GPU-5':5},memory_capacity_mb=32479)
        self.store.update_job(job['id'],state='RUNNING')
        self.coordinator._statuses[aid]=SimpleNamespace(control_group='/user.slice/'+aid+'.service',
            main_pid=0,invocation_id='a'*32,is_cleanup_ready=False)
        return attempt

    def observe(self,used,memory,owners):
        # Supply an already-attributed hardware observation; no host /proc reads.
        device=SimpleNamespace(index=5,uuid='GPU-5',memory_total_mib=32607,memory_used_mib=used,
            memory_free_mib=32607-used,utilization_percent=50,compute_pids=tuple(memory),compute_memory_mib=memory)
        self.coordinator._snapshot=(device,);self.coordinator._process_owners=dict(owners)
        return device

    def pending(self,reserved=8192):
        return self.submit(placement='pinned',requested_gpu_uuids=['GPU-5'],share_gpu=True,vram_mb=reserved)

    def usage(self):return self.coordinator._gpu_usage()[0]

    def test_gpu5_15198_actual_17312_reserved_admits_an_8gib_job(self):
        holder=self.holder(17312)
        self.observe(15198,{51:15198},{51:holder['id']})
        pending=self.pending()
        self.coordinator._schedule_shared()
        self.assertEqual(self.store.get_job(pending['id'])['state'],'STARTING')
        # The newly planned job now reserves its 8GiB without a process yet.
        row=self.usage();self.assertEqual(row['shared_reserved_mb'],17312+8192)
        self.assertEqual(row['sharing_headroom_mb'],32607-128-17312-8192)

    def test_headroom_is_15167_instead_of_zero_before_new_admission(self):
        holder=self.holder(17312);self.observe(15198,{51:15198},{51:holder['id']})
        self.assertEqual(self.usage()['sharing_headroom_mb'],15167)
        self.assertEqual(self.usage()['shared_reserved_mb'],17312)

    def test_actual_above_budget_and_external_and_exclusive_usage_stay_counted(self):
        ordinary=self.holder();holder=self.holder(8000)
        self.observe(20000,{1:4000,2:12000,3:4000},{1:ordinary['id'],2:holder['id'],3:None})
        self.assertEqual(self.usage()['sharing_headroom_mb'],12479)
        self.assertTrue(self.coordinator._shared_devices_for_job(self.pending(12000)))
        self.assertFalse(self.coordinator._shared_devices_for_job(self.pending(13000)))

    def test_each_jobs_max_is_separate_and_multiple_pids_are_summed(self):
        a=self.holder(12000);b=self.holder(1000)
        self.observe(15000,{1:400,2:600,3:12000,4:2000},{1:a['id'],2:a['id'],3:b['id'],4:None})
        self.assertEqual(self.usage()['sharing_headroom_mb'],6479)
        self.assertTrue(self.coordinator._shared_devices_for_job(self.pending(6000)))
        self.assertFalse(self.coordinator._shared_devices_for_job(self.pending(8192)))

    def test_unknown_process_memory_keeps_that_jobs_full_reservation_plus_actual(self):
        a=self.holder(8000);b=self.holder(8000)
        self.observe(12000,{1:6000,2:None},{1:a['id'],2:b['id']})
        self.assertEqual(self.usage()['sharing_headroom_mb'],10479)
        self.assertFalse(self.coordinator._shared_devices_for_job(self.pending(11000)))
        # A process not attributed to B stays in the physical total; A still
        # gets its known allocation counted once.
        self.observe(12000,{1:6000,2:6000},{1:a['id'],2:None})
        self.assertEqual(self.usage()['sharing_headroom_mb'],10479)

    def test_unreadable_cgroup_falls_back_without_guessing_the_job(self):
        holder=self.holder(17312);self.observe(15198,{51:15198},{})
        self.assertEqual(self.usage()['sharing_headroom_mb'],0)
        self.assertFalse(self.coordinator._shared_devices_for_job(self.pending()))
        # Missing one worker's cgroup must not credit the partial known usage.
        self.observe(15198,{51:7000,52:8198},{51:holder['id']})
        self.assertEqual(self.usage()['sharing_headroom_mb'],0)

    def test_tick_reuses_descendant_attribution_and_external_pids_without_an_extra_read(self):
        holder=self.holder(17312);device=self.observe(15198,{51:14000,52:1198},{})
        status=self.coordinator._statuses[holder['id']]
        self.systemd.status.return_value=status
        self.coordinator.cgroup_for_pid=Mock(side_effect=lambda pid:status.control_group+'/payload/worker' if pid==51 else '/system.slice/other.service')
        self.coordinator.gpu_provider.snapshot.return_value=(device,)
        self.coordinator.tick()
        self.assertEqual(self.coordinator._process_owners,{51:holder['id'],52:None})
        self.assertEqual(self.usage()['sharing_headroom_mb'],13969)
        self.assertTrue(self.coordinator._shared_devices_for_job(self.pending()))
        self.assertEqual(self.coordinator.cgroup_for_pid.call_count,2)

    def test_fresh_start_uses_fresh_attribution_without_overwriting_the_cached_snapshot(self):
        holder=self.holder(17312);self.observe(15198,{51:15198},{51:holder['id']})
        cached=dict(self.coordinator._process_owners);status=self.coordinator._statuses[holder['id']]
        self.systemd.status.return_value=status
        self.coordinator.cgroup_for_pid=Mock(return_value=status.control_group+'/payload')
        fresh=SimpleNamespace(**{**vars(self.coordinator._snapshot[0]),'compute_pids':(61,), 'compute_memory_mib':{61:18000},'memory_used_mib':18000})
        self.assertTrue(self.coordinator._shared_devices_for_job(self.pending(),devices=(fresh,),fresh=True))
        self.assertEqual(self.coordinator._process_owners,cached)
        self.assertEqual(self.usage()['sharing_headroom_mb'],15167)

    def test_failed_status_observation_does_not_reuse_previous_pid_ownership(self):
        holder=self.holder(17312);device=self.observe(15198,{51:15198},{51:holder['id']})
        self.coordinator.gpu_provider.snapshot.return_value=(device,)
        with patch.object(self.coordinator,'_collect_statuses',return_value=({},['status unavailable'])):
            self.coordinator.tick()
        self.assertEqual(self.coordinator._process_owners,{})
        self.assertEqual(self.usage()['sharing_headroom_mb'],0)

    def test_process_sample_ahead_of_device_total_never_loses_actual_usage(self):
        holder=self.holder(8000);self.observe(7000,{51:12000},{51:holder['id']})
        self.assertEqual(self.usage()['sharing_headroom_mb'],20479)


class ProcessMemorySnapshot(unittest.TestCase):
    def test_existing_compute_query_also_carries_memory_in_one_poll(self):
        calls=[]
        def runner(argv,**kwargs):
            calls.append(argv)
            raw='5, GPU-5, 32607, 15198, 17409, 70\n' if '--query-gpu=' in argv[1] else 'GPU-5, 51, 15198\n'
            return subprocess.CompletedProcess(argv,0,raw,'')
        device=NvidiaSmiProvider(runner=runner).snapshot()[0]
        self.assertEqual(device.compute_pids,(51,));self.assertEqual(device.compute_memory_mib,{51:15198})
        self.assertEqual(len(calls),2)
        self.assertIn('--query-compute-apps=gpu_uuid,pid,used_gpu_memory',calls[1])

    def test_unavailable_process_memory_stays_unknown_and_does_not_fail_the_snapshot(self):
        for row in ('GPU-5, 51, N/A','GPU-5, 51, [Not Supported]','GPU-5, 51, -1','GPU-5, 51'):
            with self.subTest(row=row):
                runner=Mock(side_effect=[subprocess.CompletedProcess([],0,'5, GPU-5, 32607, 15198, 17409, 70\n',''),subprocess.CompletedProcess([],0,row+'\n','')])
                device=NvidiaSmiProvider(runner=runner).snapshot()[0]
                self.assertEqual(device.compute_pids,(51,));self.assertIsNone(device.compute_memory_mib[51])


if __name__=='__main__':unittest.main()
