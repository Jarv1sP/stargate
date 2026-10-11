import {projectNodeJobObservation} from './task-read.mjs';
import {taskHasCompletion} from './training-completion.mjs';

export function taskDiagnosticUnknowns(task) {
  return ['live-processes', 'current-node-capacity', 'kernel-counters', 'worker-captures',
    ...(taskHasCompletion(task) ? [] : ['storage-lease-release'])];
}

/** Native ledger facts only. No kernel/process sampling or automatic remediation. */
export function projectNodeDiagnostics(binding, native) {
  const r = native.resources, grant = r.grant, plan = r.scale_plan;
  const leases = r.leases.map(row => ({attemptId: row.attempt_id, gpuUuid: row.gpu_uuid, gpuIndex: row.gpu_index}));
  const reservations = r.reservations.map(row => ({planId: row.plan_id, gpuUuid: row.gpu_uuid, gpuIndex: row.gpu_index}));
  const actions = r.pending_actions.map(row => ({id: row.id, attemptId: row.attempt_id, type: row.type,
    attemptCount: row.attempt_count, availableAtSeconds: row.available_at, errorRecorded: row.error_recorded === 1, claimRecorded: row.claim_recorded === 1}));
  const page = (items, total) => ({items, total, truncated: total > items.length});
  return {...projectNodeJobObservation(binding, native), resources: {
    request: {minGpus: r.policy.min_gpu_count, maxGpus: r.policy.gpu_count, allowedGpuCounts: [...r.allowed_gpu_counts]},
    allocation: {mode: r.mode === null ? 'native' : r.mode, grant: grant === null ? null : {
      id: grant.grant_id, revision: grant.revision, maxGpuCount: grant.max_gpu_count, initialMaxGpuCount: grant.initial_max_gpu_count}},
    leases: page(leases, r.lease_count), reservations: page(reservations, r.reservation_count), pendingActions: page(actions, r.pending_action_count),
    scalePlan: plan === null ? null : {id: plan.id, state: plan.state, sourceAttemptId: plan.source_attempt_id,
      successorAttemptId: plan.successor_attempt_id, sourceGpuCount: plan.from_gpu_count, targetGpuCount: plan.target_gpu_count},
  }};
}

/** Explain recorded evidence; never turn a missing observation into a diagnosis. */
export function taskDiagnosticFindings({task, kind, node, quota}) {
  const findings = [], add = (code, level = 'info') => findings.push({code, level});
  const completed = taskHasCompletion(task);
  if (completed) add('TASK_RESOURCES_RELEASED');
  if (quota?.state === 'HELD') add('PLATFORM_QUOTA_HELD');
  if (['SENDING', 'UNKNOWN'].includes(task.stage)) add('DISPATCH_ACK_PENDING');
  if (kind !== 'observed') {
    add(kind === 'not-queried' ? 'NOT_DISPATCHED_FOR_READ' : kind === 'not-observed' ? 'NATIVE_NOT_OBSERVED' : 'NODE_READ_UNAVAILABLE', kind === 'not-queried' ? 'info' : 'warning');
    return findings;
  }
  const {resources: r, latestAttempt: attempt, progress} = node;
  if (node.state === 'PENDING') add(node.reason ? 'NATIVE_WAIT_REASON_RECORDED' : 'NATIVE_WAIT_REASON_UNKNOWN');
  if (node.state === 'FAILED') add('NATIVE_JOB_FAILED', 'error');
  if (node.state === 'LOST' || attempt?.state === 'LOST' || attempt?.state === 'STUCK') add('EXECUTION_UNCONFIRMED', 'warning');
  if (attempt?.exitCode !== null && attempt?.exitCode !== undefined && attempt.exitCode !== 0) add('ATTEMPT_NONZERO_EXIT', 'warning');
  if (['SAVE_REQUESTED', 'SAVE_WITHDRAWING', 'CHECKPOINT_ACKED'].includes(attempt?.state)) add('CHECKPOINT_HANDOFF');
  if (['TERM_REQUESTED', 'KILL_REQUESTED', 'DRAINING'].includes(attempt?.state)) add('ATTEMPT_STOPPING');
  if (progress?.stale) add('PROGRESS_STALLED', 'warning');
  if (progress?.error || ['warning', 'error'].includes(progress?.snapshot?.severity)) add('PROGRESS_REPORTED_PROBLEM', 'warning');
  if (r.allocation.mode === 'external-v1') {
    if (r.allocation.grant === null) add('ALLOCATION_GRANT_MISSING', 'warning');
    else {
      if (r.allocation.grant.id !== node.receipt.dispatchId) add('ALLOCATION_GRANT_ID_MISMATCH', 'warning');
      if (r.allocation.grant.initialMaxGpuCount === null) add('INITIAL_GRANT_UNCONFIRMED', 'warning');
      else if (r.allocation.grant.initialMaxGpuCount !== node.receipt.gpuCount) add('INITIAL_GRANT_MISMATCH', 'warning');
      if (!(completed && r.allocation.grant.maxGpuCount === 0)
        && !r.request.allowedGpuCounts.some(count => count <= r.allocation.grant.maxGpuCount)) add('NO_LEGAL_GRANTED_GPU_COUNT', 'warning');
    }
  }
  const retained = r.leases.total + r.reservations.total > 0;
  add(retained ? 'NATIVE_RESOURCE_RECORDS_PRESENT' : 'NATIVE_RESOURCE_RECORDS_EMPTY');
  if (retained && ['SUCCEEDED', 'FAILED', 'CANCELED', 'LOST'].includes(node.state)) add('TERMINAL_WITH_RESOURCE_RECORDS', 'warning');
  if (r.leases.items.some(lease => lease.attemptId !== attempt?.id)) add('OLDER_ATTEMPT_LEASES', 'warning');
  if (r.scalePlan !== null) add('SCALE_UP_IN_PROGRESS');
  if (r.pendingActions.total > 0) add('NATIVE_ACTIONS_PENDING');
  if (r.pendingActions.items.some(action => action.errorRecorded)) add('NATIVE_ACTION_ERROR_RECORDED', 'warning');
  if ([r.leases, r.reservations, r.pendingActions].some(page => page.truncated)) add('EVIDENCE_TRUNCATED', 'warning');
  return findings;
}
