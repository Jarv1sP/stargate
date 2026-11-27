"""Bounded queue backfill against real SQLite; no GPU or training processes."""
import importlib.util
from pathlib import Path
import unittest

loader = importlib.util.spec_from_file_location('backfill_fixture', Path(__file__).with_name('gpuq-priority.test.py'))
F = importlib.util.module_from_spec(loader)
loader.loader.exec_module(F)
from gpuq.constants import AttemptState, JobState
from gpuq.coordinator import Coordinator
from gpuq import checkpoint


class Backfill(unittest.TestCase):
    setUp = F.SchedulerPriorityTests.setUp
    submit = F.SchedulerPriorityTests.submit
    running = F.SchedulerPriorityTests.running
    snapshot = F.SchedulerPriorityTests.snapshot
    state = F.SchedulerPriorityTests.state

    def finish(self, job):
        attempt = self.store.list_attempts(job_id=job['id'])[0]
        self.store.release_leases(attempt_id=attempt['id'], reason='test process finished')
        self.store.update_attempt(attempt['id'], state=AttemptState.EXITED_SUCCESS, exit_code=0)
        self.store.update_job(job['id'], state=JobState.SUCCEEDED)

    def started(self, job):
        attempt = self.store.list_attempts(job_id=job['id'])[0]
        self.store.update_attempt(attempt['id'], state=AttemptState.RUNNING)
        self.store.update_job(job['id'], state=JobState.RUNNING)
        return self.store.get_attempt(attempt['id'])

    def test_one_noninterruptible_batch_then_accumulate_for_gang(self):
        holders = [self.running((i,))[0] for i in (0, 1)]
        head = self.submit(gpu_count=3)
        first, second, third = [self.submit() for _ in range(3)]
        self.coordinator._schedule()
        self.assertEqual([self.state(j) for j in (head, first, second, third)],
                         ['PENDING', 'STARTING', 'STARTING', 'PENDING'])
        self.finish(first)
        self.store.close(); self.store.open()
        self.coordinator = Coordinator(self.config, self.store, F.Mock(), self.systemd, boot_id='test-boot')
        self.snapshot()
        self.coordinator._schedule()
        self.assertEqual(self.state(third), 'PENDING', 'restart must not grant another batch')
        self.finish(second)
        self.coordinator._schedule()
        self.assertEqual(self.state(head), 'PENDING')
        self.assertEqual(self.state(third), 'PENDING')
        self.finish(holders[0])
        self.coordinator._schedule()
        self.assertEqual(self.state(head), 'STARTING')
        self.assertEqual(len(self.store.list_leases(job_id=head['id'])), 3)

    def test_no_fit_does_not_spend_batch_and_ready_jobs_skip_dependencies(self):
        parent, _ = self.running((0, 1, 2))
        dependent = self.submit(priority=4, after=[parent['id']])
        head = self.submit(gpu_count=2)
        self.coordinator._dependency_waiting = self.coordinator._reconcile_dependencies()
        self.coordinator._schedule()
        small = self.submit()
        self.coordinator._schedule()
        self.assertEqual(self.state(small), 'STARTING')
        self.assertEqual(self.state(head), 'PENDING')
        self.assertEqual(self.state(dependent), 'PENDING')

    def test_same_priority_borrowed_card_yields_but_normal_running_job_does_not(self):
        holder, _ = self.running((0, 1))
        head = self.submit(gpu_count=3, preempt_idle_only=True)
        ordinary = self.submit()
        borrower = self.submit(yield_policy='now', restart_policy='on-preempt')
        self.coordinator._schedule()
        self.assertEqual(self.state(borrower), 'STARTING')
        attempt = self.started(borrower)
        self.started(ordinary)
        self.assertEqual(self.coordinator._api_show({'job_id':borrower['id']})['job']['backfill_for'], head['id'])
        self.coordinator._schedule()
        self.assertEqual(self.state(borrower), 'RUNNING', 'do not interrupt until enough cards can be assembled')
        self.finish(holder)
        self.coordinator._schedule()
        self.assertEqual(self.state(borrower), 'PREEMPTING')
        self.assertEqual(self.state(ordinary), 'RUNNING')
        self.assertEqual(self.store.get_attempt(attempt['id'])['preempt_requested_by_job_id'], head['id'])
        self.assertTrue(self.coordinator._preemption_is_still_needed(self.store.get_attempt(attempt['id'])))
        self.store.update_attempt(attempt['id'], state=AttemptState.DRAINING, exit_code=-15)
        self.coordinator._finalize_attempt(self.store.get_attempt(attempt['id']))
        self.assertEqual(self.state(borrower), 'PENDING')
        self.coordinator._schedule()
        self.assertEqual(self.state(head), 'STARTING')
        self.assertEqual(self.state(borrower), 'PENDING')
        self.finish(head)
        self.coordinator._schedule()
        self.assertEqual(self.state(borrower), 'STARTING')
        self.assertEqual(self.store.list_attempts(job_id=borrower['id'])[0]['ordinal'], 2)
        self.assertIsNone(self.coordinator._api_show({'job_id':borrower['id']})['job']['backfill_for'])

    def test_save_borrower_uses_checkpoint_request_not_term_and_preserves_promise(self):
        holder, _ = self.running((0, 1, 2))
        head = self.submit(gpu_count=2, preempt_idle_only=True, dispatch_mode='preempt-now')
        borrower = self.submit(yield_policy='save', checkpoint_capability='epoch-v1', restart_policy='on-preempt')
        self.coordinator._schedule()
        attempt = self.started(borrower)
        self.finish(holder)
        # Two unrelated occupied cards leave one genuinely free plus the loan.
        self.running((0, 1))
        self.coordinator._schedule()
        current = self.store.get_attempt(attempt['id'])
        self.assertEqual(current['state'], 'SAVE_REQUESTED')
        self.assertTrue(self.coordinator._preemption_is_still_needed(current))
        self.assertIn('GPU-3', self.coordinator._promised_preemption_gpu_uuids(head))
        actions = self.store.list_actions(attempt_id=attempt['id'])
        self.assertIn('REQUEST_SAVE', [a['action_type'] for a in actions])
        self.assertNotIn('TERM_UNIT', [a['action_type'] for a in actions])
        self.coordinator._execute_save_request(next(a for a in actions if a['action_type']=='REQUEST_SAVE'))
        saved = self.root / 'borrower-checkpoint'
        def save():
            saved.write_bytes(b'fixture model state')
            return {'checkpoint_path':str(saved)}
        with self.assertRaises(SystemExit) as exited:
            checkpoint.checkpoint_at_epoch_end(save, control_dir=attempt['control_dir'], expected_nonce=current['preempt_nonce'])
        self.assertEqual(exited.exception.code, 75)
        self.coordinator._record_checkpoint_ack(current, self.coordinator._valid_ack(current),
                                                expected_state=AttemptState.SAVE_REQUESTED)
        self.store.update_attempt(attempt['id'], state=AttemptState.DRAINING, exit_code=75)
        self.coordinator._finalize_attempt(self.store.get_attempt(attempt['id']))
        self.coordinator._schedule()
        self.assertEqual(self.state(head), 'STARTING')
        self.assertEqual(self.state(borrower), 'PENDING')
        self.finish(head); self.coordinator._schedule()
        resumed = self.store.list_attempts(job_id=borrower['id'])[0]
        self.assertEqual(resumed['launch_resume_checkpoint_path'], str(saved))
        self.assertEqual(resumed['resume_from_attempt_id'], attempt['id'])
        self.assertEqual(self.store.get_job(borrower['id'])['sequence'], borrower['sequence'])

    def test_canceling_head_removes_loan_and_does_not_cancel_borrower(self):
        self.running((0, 1, 2))
        head = self.submit(gpu_count=2)
        borrower = self.submit(yield_policy='now')
        self.coordinator._schedule(); self.started(borrower)
        self.store.update_job(head['id'], state=JobState.CANCELED)
        self.assertIsNone(self.coordinator._api_show({'job_id':borrower['id']})['job']['backfill_for'])
        self.assertEqual(self.state(borrower), 'RUNNING')

    def test_pending_reason_reports_real_card_requirement(self):
        self.running((0, 1, 2))
        head = self.submit(gpu_count=3)
        self.coordinator._schedule()
        reason = self.store.get_job(head['id'])['state_reason']
        self.assertIn('需要 3 张', reason)
        self.assertIn('当前可用 1 张', reason)

    def test_loan_survives_restart_and_cannot_reclaim_unrelated_same_priority_job(self):
        holder, _ = self.running((0, 1, 2))
        head = self.submit(gpu_count=2, preempt_idle_only=True)
        borrower = self.submit(yield_policy='now')
        self.coordinator._schedule(); attempt = self.started(borrower)
        self.store.close(); self.store.open()
        self.coordinator = Coordinator(self.config, self.store, F.Mock(), self.systemd, boot_id='test-boot')
        self.snapshot()
        other = self.submit(priority=2)
        self.assertFalse(self.coordinator._victim_in_scope({**other, 'preempt_idle_only':True}, borrower, attempt))
        self.finish(holder); self.running((0, 1))
        self.coordinator._schedule()
        self.assertEqual(self.state(borrower), 'PREEMPTING')
        self.assertEqual(self.store.get_attempt(attempt['id'])['preempt_requested_by_job_id'], head['id'])

    def test_save_timeout_withdraws_without_killing_borrower(self):
        holder, _ = self.running((0, 1, 2))
        head = self.submit(gpu_count=2)
        borrower = self.submit(yield_policy='save', checkpoint_capability='epoch-v1')
        self.coordinator._schedule(); attempt = self.started(borrower)
        self.finish(holder); self.running((0, 1))
        self.coordinator._schedule()
        self.coordinator._rollback_undelivered_preemption(self.store.get_attempt(attempt['id']),
                                                        'test checkpoint timeout', fail_requester=True)
        self.assertEqual(self.state(borrower), 'RUNNING')
        self.assertEqual(self.state(head), 'FAILED')
        self.assertFalse(any(a['action_type'] in ('TERM_UNIT','KILL_UNIT') for a in self.store.list_actions()))

    def test_pinned_blocker_keeps_requested_free_card_and_uses_only_unrelated_card(self):
        self.running((0,))
        head = self.submit(gpu_count=2, placement='pinned', requested_gpu_uuids=['GPU-0', 'GPU-1'])
        flexible = self.submit(gpu_count=3)
        small = self.submit()
        self.coordinator._schedule()
        self.assertEqual(self.state(head), 'PENDING')
        self.assertEqual(self.state(flexible), 'PENDING')
        self.assertEqual(self.state(small), 'STARTING')
        self.assertEqual(self.store.list_attempts(job_id=small['id'])[0]['gpu_indices'], [2])

    def test_elastic_head_uses_legal_minimum_without_bypassing_available_start(self):
        self.running((0, 1))
        head = self.submit(gpu_count=4, min_gpu_count=1, elastic_gpu_count=True,
                           target_global_batch_size=24, per_device_micro_batch_size=4)
        small = self.submit()
        self.coordinator._schedule()
        self.assertEqual(self.state(head), 'STARTING')
        self.assertEqual(self.store.list_attempts(job_id=head['id'])[0]['gpu_indices'], [2, 3])
        self.assertEqual(self.state(small), 'PENDING')

    def test_failed_allocation_does_not_spend_batch_or_leave_loan(self):
        self.running((0, 1, 2))
        head = self.submit(gpu_count=2)
        small = self.submit()
        with F.patch.object(self.store, 'enqueue_action', side_effect=RuntimeError('test write failure')):
            with self.assertRaisesRegex(RuntimeError, 'test write failure'):
                self.coordinator._schedule()
        self.assertEqual(self.state(small), 'PENDING')
        self.assertEqual(self.store.list_leases(job_id=small['id']), [])
        self.assertIsNone(self.store.get_setting('queue-backfill:'+head['id']))
        self.coordinator._schedule()
        self.assertEqual(self.state(small), 'STARTING')

    def test_save_only_request_does_not_grant_unreclaimable_repeated_now_loans(self):
        self.running((0, 1, 2))
        head = self.submit(gpu_count=2, dispatch_mode='preempt-save')
        first = self.submit(yield_policy='now')
        second = self.submit(yield_policy='now')
        self.coordinator._schedule()
        self.assertEqual(self.state(first), 'STARTING')
        self.assertIsNone(self.coordinator._api_show({'job_id':first['id']})['job']['backfill_for'])
        self.finish(first); self.coordinator._schedule()
        self.assertEqual(self.state(second), 'PENDING')

    def test_external_and_quarantined_free_looking_cards_are_not_backfilled(self):
        self.running((0, 1))
        self.snapshot(occupied=(2,))
        self.coordinator._external = {'GPU-2':{1002}}
        self.coordinator._quarantines['GPU-3'] = F.Mock()
        head = self.submit(gpu_count=3)
        small = self.submit()
        self.coordinator._schedule()
        self.assertEqual(self.state(small), 'PENDING')
        self.assertEqual(self.store.list_leases(job_id=small['id']), [])

    def test_returned_loan_is_not_reborrowed_during_idle_confirmation_gap(self):
        holder, _ = self.running((0, 1))
        head = self.submit(gpu_count=3, preempt_idle_only=True)
        ordinary = self.submit()
        borrower = self.submit(yield_policy='now', restart_policy='on-preempt')
        self.coordinator._schedule(); self.started(ordinary); attempt = self.started(borrower)
        self.finish(holder); self.coordinator._schedule()
        self.store.update_attempt(attempt['id'], state=AttemptState.DRAINING, exit_code=-15)
        self.coordinator._finalize_attempt(self.store.get_attempt(attempt['id']))
        self.coordinator._idle_counts['GPU-3'] = 0
        self.coordinator._schedule()
        self.assertEqual(self.state(borrower), 'PENDING')
        self.assertEqual(self.state(head), 'PENDING')
        self.assertEqual(self.store.list_leases(job_id=borrower['id']), [])
        self.coordinator._idle_counts['GPU-3'] = 2
        self.coordinator._schedule()
        self.assertEqual(self.state(head), 'STARTING')

    def test_reclaiming_own_loan_precedes_interrupting_unrelated_low_priority_work(self):
        holder, _ = self.running((0, 1, 2))
        head = self.submit(gpu_count=2, preempt_idle_only=True)
        borrower = self.submit(yield_policy='now')
        self.coordinator._schedule(); self.started(borrower)
        self.finish(holder)
        ordinary, _ = self.running((0,))
        idle, _ = self.running((1,), priority=0, yield_policy='now', preempt_idle_only=True)
        self.coordinator._schedule()
        self.assertEqual(self.state(borrower), 'PREEMPTING')
        self.assertEqual(self.state(idle), 'RUNNING')
        self.assertEqual(self.state(ordinary), 'RUNNING')

    def test_head_start_retires_old_loans_even_if_head_is_later_requeued(self):
        holder, _ = self.running((0, 1, 2))
        head = self.submit(gpu_count=2)
        borrower = self.submit(yield_policy='now')
        self.coordinator._schedule(); self.started(borrower)
        self.finish(holder); self.coordinator._schedule()
        self.assertEqual(self.state(head), 'STARTING')
        self.assertIsNone(self.store.get_setting('borrowed-for:'+borrower['id']))
        attempt = self.store.list_attempts(job_id=head['id'])[0]
        self.store.release_leases(attempt_id=attempt['id'], reason='test head preempted')
        self.store.update_attempt(attempt['id'], state=AttemptState.PREEMPTED)
        self.store.update_job(head['id'], state=JobState.PENDING)
        self.assertIsNone(self.coordinator._api_show({'job_id':borrower['id']})['job']['backfill_for'])

    def test_no_restart_borrower_still_reserves_returned_capacity_until_idle(self):
        holder, _ = self.running((0, 1))
        head = self.submit(gpu_count=3, preempt_idle_only=True)
        ordinary = self.submit()
        borrower = self.submit(yield_policy='now', restart_policy='never')
        self.coordinator._schedule(); self.started(ordinary); attempt = self.started(borrower)
        self.finish(holder); self.coordinator._schedule()
        self.store.update_attempt(attempt['id'], state=AttemptState.DRAINING, exit_code=-15)
        self.coordinator._finalize_attempt(self.store.get_attempt(attempt['id']))
        self.assertEqual(self.state(borrower), 'CANCELED')
        self.assertIsNone(self.store.get_setting('borrowed-for:'+borrower['id']))
        self.coordinator._idle_counts['GPU-3'] = 0
        self.assertIn('GPU-3', self.coordinator._promised_preemption_gpu_uuids(head))
        another = self.submit(yield_policy='now')
        self.coordinator._schedule()
        self.assertEqual(self.state(another), 'PENDING')


if __name__ == '__main__':
    unittest.main()
