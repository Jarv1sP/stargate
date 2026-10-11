"""Root release barrier and real temporary SQLite; no host services or GPU."""
import importlib.util
import ast
import json
import os
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

loader = importlib.util.spec_from_file_location('gate_priority_fixture', Path(__file__).with_name('gpuq-priority.test.py'))
F = importlib.util.module_from_spec(loader)
loader.loader.exec_module(F)
from gpuq import coordinator as C
from gpuq.backends import UnitIdentityError, UnitNotFoundError
from gpuq.rpc import ApiError
from gpuq.constants import ActionType


class NativeReleaseGate(unittest.TestCase):
    setUp = F.SchedulerPriorityTests.setUp
    submit = F.SchedulerPriorityTests.submit
    snapshot = F.SchedulerPriorityTests.snapshot
    running = F.SchedulerPriorityTests.running

    def gate(self):
        return {'state': 'CLOSED', 'valid': True, 'release_id': '22222222-2222-4222-8222-222222222222'}

    def dump(self):
        return '\n'.join(self.store._get_connection().iterdump())

    def test_two_physical_scans_preserve_database_and_never_call_mutators(self):
        self.submit()
        self.coordinator.gpu_provider.snapshot.return_value = self.coordinator._snapshot
        with patch.object(C, '_read_release_gate', return_value=self.gate()):
            before = self.dump()
            for name in ('_scan_progress', '_retire_previous_boot_attempts', '_repair_incomplete_plans',
                         '_reconcile_attempts', '_reconcile_scale_up_plans', '_process_actions', '_schedule'):
                stub = Mock(side_effect=AssertionError('mutation during gate'))
                setattr(self.coordinator, name, stub)
            self.coordinator.tick()
            self.coordinator.tick()
            self.assertEqual(self.coordinator.health_name, 'ok')
            self.assertEqual(self.coordinator.handle_api('health', {})['recovery_scans'], 2)
            self.assertEqual(self.coordinator.gpu_provider.snapshot.call_count, 2)
            health = self.coordinator.handle_api('health', {})
            self.assertEqual(health['native_release_gate'], self.gate())
            self.assertEqual(health['schedulable_gpu_indices'], [])
            self.assertEqual(self.dump(), before)
            self.systemd.start.assert_not_called()
            self.systemd.terminate.assert_not_called()
            self.systemd.kill.assert_not_called()
            self.systemd.cleanup.assert_not_called()

    def test_running_unit_and_leases_remain_physically_verified_without_heartbeat(self):
        _, attempt = self.running()
        self.store._get_connection().execute('UPDATE leases SET lease_token=? WHERE attempt_id=?', (attempt['id'], attempt['id']))
        self.coordinator.gpu_provider.snapshot.return_value = self.coordinator._snapshot
        self.systemd.status.return_value = SimpleNamespace(main_pid=os.getpid(), control_group='/isolated/fixture', is_cleanup_ready=False)
        before = self.dump()
        with patch.object(C, '_read_release_gate', return_value=self.gate()):
            self.coordinator.tick()
            self.coordinator.tick()
            self.assertEqual(self.coordinator.health_name, 'ok')
            self.assertEqual(self.coordinator._statuses[attempt['id']], self.systemd.status.return_value)
            self.assertEqual(self.systemd.status.call_count, 2)
            self.assertEqual(self.dump(), before)

    def test_every_external_mutation_including_observe_sync_and_fleet_is_rejected(self):
        with patch.object(C, '_read_release_gate', return_value=self.gate()):
            before = self.dump()
            for op in ('submit', 'cancel', 'retry', 'set_priority', 'set_priority_rank', 'set_job_display',
                       'set_observe_only', 'complete_managed', 'sync_begin', 'sync_finish', 'fleet_offer', 'fleet_admit', 'fleet_retry', 'unknown'):
                with self.subTest(op=op), self.assertRaises(ApiError) as caught:
                    self.coordinator.handle_api(op, {})
                self.assertEqual(caught.exception.code, 'MAINTENANCE')
            self.assertEqual(self.dump(), before)

    def test_readonly_show_status_events_watch_and_log_are_still_available(self):
        job, _ = self.running()
        with patch.object(C, '_read_release_gate', return_value=self.gate()):
            before = self.dump()
            for op, args in [('health', {}), ('status', {}), ('show', {'job_id': job['id']}),
                             ('job_watch', {'job_id': job['id']}), ('events', {}), ('log_path', {'job_id': job['id']})]:
                self.coordinator.handle_api(op, args)
            self.assertEqual(self.dump(), before)
            self.assertIn('native-release-gate-v1', self.coordinator.handle_api('status', {})['daemon']['capabilities'])

    def test_closed_constructor_does_not_initialize_missing_database_mode(self):
        self.store._get_connection().execute("DELETE FROM settings WHERE key='observe_only'")
        before = self.dump()
        with patch.object(C, '_read_release_gate', return_value=self.gate()):
            C.Coordinator(self.config, self.store, Mock(), self.systemd, boot_id='test-boot')
        self.assertEqual(self.dump(), before)

    def test_invalid_gate_stays_closed_and_cannot_be_opened_by_observe_rpc(self):
        self.coordinator.gpu_provider.snapshot.return_value = self.coordinator._snapshot
        invalid = {**self.gate(), 'valid': False, 'release_id': None}
        with patch.object(C, '_read_release_gate', return_value=invalid):
            self.coordinator.tick()
            self.coordinator.tick()
            self.assertEqual(self.coordinator.health_name, 'degraded')
            with self.assertRaises(ApiError):
                self.coordinator.handle_api('set_observe_only', {'observe_only': False})

    def test_explicit_root_removal_requires_two_fresh_scans_before_scheduling(self):
        self.coordinator.gpu_provider.snapshot.return_value = self.coordinator._snapshot
        state = self.gate()
        with patch.object(C, '_read_release_gate', side_effect=lambda *_: dict(state)):
            self.coordinator.tick(); self.coordinator.tick()
            self.coordinator._schedule = Mock()
            state.update(state='ABSENT', valid=True, release_id=None)
            self.coordinator.tick()
            self.assertEqual(self.coordinator.health_name, 'recovering')
            self.coordinator._schedule.assert_not_called()
            self.coordinator.tick()
            self.coordinator._schedule.assert_called_once()

    def test_actual_action_methods_fail_before_even_reading_action_identity(self):
        with patch.object(C, '_read_release_gate', return_value=self.gate()):
            before = self.dump()
            for name, kwargs in [('_process_actions', {}), ('_execute_start', {}),
                                 ('_execute_save_request', {}), ('_execute_signal', {'kill': True}),
                                 ('_execute_cleanup', {})]:
                with self.subTest(name=name), self.assertRaises(ApiError):
                    args = [] if name == '_process_actions' else [{}]
                    getattr(self.coordinator, name)(*args, **kwargs)
            self.assertEqual(self.dump(), before)

    def test_pending_actions_are_not_claimed_completed_retried_or_executed(self):
        job, attempt = self.running()
        self.store._get_connection().execute('UPDATE leases SET lease_token=? WHERE attempt_id=?', (attempt['id'], attempt['id']))
        self.store.enqueue_action(action_type=ActionType.CLEANUP_UNIT, job_id=job['id'], attempt_id=attempt['id'], payload={})
        self.coordinator.gpu_provider.snapshot.return_value = self.coordinator._snapshot
        self.systemd.status.return_value = SimpleNamespace(main_pid=os.getpid(), control_group='/fixture', is_cleanup_ready=False)
        before = self.dump()
        with patch.object(C, '_read_release_gate', return_value=self.gate()):
            self.coordinator.tick(); self.coordinator.tick()
            self.assertEqual(self.coordinator.health_name, 'ok')
            self.assertEqual(self.dump(), before)
            self.systemd.cleanup.assert_not_called()

    def test_gate_arriving_during_physical_snapshot_stops_before_any_recovery(self):
        state = {'state': 'ABSENT', 'valid': True, 'release_id': None}
        def snapshot():
            state.update(self.gate())
            return self.coordinator._snapshot
        self.coordinator.gpu_provider.snapshot.side_effect = snapshot
        before = self.dump()
        with patch.object(C, '_read_release_gate', side_effect=lambda *_: dict(state)):
            self.coordinator.tick()
        self.assertEqual(self.dump(), before)
        self.systemd.start.assert_not_called()
        self.assertEqual(self.coordinator._release_gate, self.gate())

    def test_all_direct_store_writes_and_control_effects_are_guarded(self):
        tree = ast.parse(Path(C.__file__).read_text())
        cls = next(item for item in tree.body if isinstance(item, ast.ClassDef) and item.name == 'Coordinator')
        writes = {'transaction', 'set_setting', 'submit_job', 'set_job_display', 'set_pending_priority_class',
                  'set_pending_priority_rank', 'update_job', 'update_attempt', 'append_event', 'enqueue_action',
                  'acquire_leases', 'release_leases', 'heartbeat_leases', 'claim_actions', 'complete_action',
                  'fail_action', 'transition_scale_up_plan'}
        audited = []
        for method in cls.body:
            if not isinstance(method, ast.FunctionDef) or method.name == '__init__':
                continue
            has_write = any(isinstance(item, ast.Call) and isinstance(item.func, ast.Attribute)
                and isinstance(item.func.value, ast.Attribute) and isinstance(item.func.value.value, ast.Name)
                and item.func.value.value.id == 'self'
                and ((item.func.value.attr == 'store' and item.func.attr in writes)
                     or (item.func.value.attr == 'systemd' and item.func.attr in {'start', 'kill', 'terminate', 'cleanup'}))
                for item in ast.walk(method))
            if has_write:
                audited.append(method.name)
                self.assertTrue(any(isinstance(d, ast.Name) and d.id == '_release_mutation' for d in method.decorator_list), method.name)
        self.assertGreater(len(audited), 30)

    def test_old_boot_and_missing_unit_remain_unknown_and_do_not_retire(self):
        _, attempt = self.running()
        self.coordinator.gpu_provider.snapshot.return_value = self.coordinator._snapshot
        self.systemd.status.side_effect = UnitNotFoundError('missing')
        before = self.dump()
        with patch.object(C, '_read_release_gate', return_value=self.gate()):
            self.coordinator.tick()
            self.assertEqual(self.coordinator.health_name, 'degraded')
            self.assertEqual(self.dump(), before)
            self.store._get_connection().execute('UPDATE attempts SET boot_id=? WHERE id=?', ('old-boot', attempt['id']))
            before = self.dump()
            self.coordinator.tick()
            self.assertEqual(self.coordinator.health_name, 'degraded')
            self.assertEqual(self.dump(), before)

    def test_fence_health_is_not_bypassed_while_closed(self):
        self.coordinator.gpu_provider.snapshot.return_value = self.coordinator._snapshot
        with patch.object(C, '_read_release_gate', return_value=self.gate()), \
             patch.object(self.coordinator, '_audit_gpu_fences', side_effect=C.GpuFenceAuditError('unprovable lease')):
            self.coordinator.tick()
            self.assertEqual(self.coordinator.health_name, 'degraded')
            self.assertEqual(self.coordinator.handle_api('health', {})['recovery_scans'], 0)


class GateReader(unittest.TestCase):
    setUp = F.SchedulerPriorityTests.setUp
    snapshot = F.SchedulerPriorityTests.snapshot
    # No tests operate on /run or require root. Only stat owner is represented
    # as root for these isolated filesystem fixtures; production checks remain
    # literal UID 0. Real symlinks, links, inode replacement, sizes and modes are
    # used, not mocked file contents.
    def trusted(self, info):
        fields = ['st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_uid', 'st_nlink']
        return SimpleNamespace(**{name: 0 if name == 'st_uid' else getattr(info, name) for name in fields})

    def read(self, path, *, trusted=True, read_hook=None):
        original_lstat, original_stat, original_fstat, original_read = Path.lstat, os.stat, os.fstat, os.read
        def wrap_lstat(p):
            info = original_lstat(p)
            return self.trusted(info) if trusted else info
        def wrap_stat(*args, **kwargs):
            info = original_stat(*args, **kwargs)
            return self.trusted(info) if trusted else info
        def wrap_fstat(fd):
            info = original_fstat(fd)
            return self.trusted(info) if trusted else info
        def wrap_read(*args):
            value = original_read(*args)
            if read_hook:
                read_hook()
            return value
        with patch.object(C, '_RELEASE_GATE_PATH', path), patch.object(Path, 'lstat', wrap_lstat), \
             patch.object(C.os, 'stat', wrap_stat), patch.object(C.os, 'fstat', wrap_fstat), patch.object(C.os, 'read', wrap_read):
            return C._read_release_gate('test-boot', lambda: 100.)

    def file(self, raw=None):
        parent = self.root / 'gate'
        parent.mkdir(mode=0o755)
        parent.chmod(0o755)
        path = parent / 'gate.json'
        value = {'schema': 1, 'state': 'CLOSED', 'releaseId': str(uuid.uuid4()), 'bootId': 'test-boot', 'deadlineMonotonic': 200.}
        path.write_text(json.dumps(value) if raw is None else raw)
        path.chmod(0o644)
        return path, value

    def test_reader_accepts_only_exact_closed_contract_and_absent_is_normal(self):
        path, value = self.file()
        self.assertEqual(self.read(path), {'state': 'CLOSED', 'valid': True, 'release_id': value['releaseId']})
        path.unlink()
        self.assertEqual(self.read(path)['state'], 'ABSENT')
        self.assertEqual(self.read(self.root / 'missing' / 'gate.json')['state'], 'ABSENT')

    def test_bad_contracts_deadlines_and_duplicate_keys_never_open(self):
        path, value = self.file()
        for changes in [{'state': 'OPEN'}, {'schema': True}, {'releaseId': 'bad'}, {'bootId': 'old'},
                        {'deadlineMonotonic': 99}, {'deadlineMonotonic': 701}, {'deadlineMonotonic': True},
                        {'deadlineMonotonic': float('inf')}, {'extra': 1}]:
            with self.subTest(changes=changes):
                path.write_text(json.dumps({**value, **changes}))
                self.assertEqual(self.read(path)['state'], 'CLOSED')
                self.assertFalse(self.read(path)['valid'])
        path.write_text('{"schema":1,"schema":1}')
        self.assertFalse(self.read(path)['valid'])

    def test_permissions_owner_hardlink_symlink_and_oversize_fail_closed(self):
        path, _ = self.file()
        for mode in [0o600, 0o666, 0o755]:
            path.chmod(mode)
            self.assertFalse(self.read(path)['valid'])
        path.chmod(0o644)
        if os.getuid() != 0:
            self.assertFalse(self.read(path, trusted=False)['valid'])
        alias = path.with_name('alias')
        os.link(path, alias)
        self.assertFalse(self.read(path)['valid'])
        alias.unlink()
        path.write_text('x' * 4097)
        self.assertFalse(self.read(path)['valid'])
        path.unlink(); path.symlink_to(alias)
        self.assertFalse(self.read(path)['valid'])

    def test_bad_parent_and_replaced_inode_during_read_fail_closed(self):
        path, value = self.file()
        path.parent.chmod(0o777)
        self.assertFalse(self.read(path)['valid'])
        path.parent.chmod(0o755)
        def replace():
            other = path.with_name('replacement')
            other.write_text(json.dumps(value)); other.chmod(0o644)
            other.replace(path)
        self.assertFalse(self.read(path, read_hook=replace)['valid'])


if __name__ == '__main__':
    unittest.main()
