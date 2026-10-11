import {ApplicationError} from './errors.mjs';
import {requireActiveSession} from './session-policy.mjs';
import {nativeDispatchAcceptance} from './node-dispatch.mjs';

/** Viewing existing work does not reserve quota or depend on current free GPUs. */
export function requireTaskRead(actor, facts, now) {
  requireActiveSession(facts.session, now);
  if (facts.session.accountId !== actor.id || facts.session.sessionId !== actor.sessionId) throw new ApplicationError('UNAUTHENTICATED');
  if (!facts.accountId || (facts.accountId !== actor.id && facts.session.accountRole !== 'admin')) throw new ApplicationError('FORBIDDEN');
  if (facts.machineId !== null && (!facts.machineEnabled || (facts.session.accountRole !== 'admin' && !facts.machineGranted))) throw new ApplicationError('FORBIDDEN');
}

export function requireSameTaskRead(before, after) {
  const fields = ['jobId', 'accountId', 'requestHash', 'dispatchId', 'machineId', 'gpuCount'];
  if (fields.some(key => before[key] !== after[key]) || (before.nodeJobId !== null && before.nodeJobId !== after.nodeJobId)) {
    throw new ApplicationError('TASK_READ_CHANGED');
  }
}

/** Projection of a trusted native observation after matching its original launch. */
export function projectNodeJobObservation(binding, native) {
  const {job, latest_attempt: attempt, progress} = native;
  const receipt = nativeDispatchAcceptance(binding, {...job, job_id: job.id});
  const snapshot = progress?.snapshot;
  return {receipt, state: job.state, priority: job.priority, reason: job.state_reason,
    latestAttempt: attempt === null ? null : {id: attempt.id, ordinal: attempt.ordinal, state: attempt.state,
      assignedGpus: attempt.gpu_uuids.map((uuid, index) => ({uuid, index: attempt.gpu_indices[index]})),
      exitCode: attempt.exit_code, failureReason: attempt.failure_reason},
    progress: progress === null ? null : {reported: progress.reported, stale: progress.stale, error: progress.error,
      heartbeatAgeSeconds: progress.heartbeat_age_seconds, progressAgeSeconds: progress.progress_age_seconds,
      snapshot: snapshot === null ? null : {sequence: snapshot.sequence, phase: snapshot.phase,
        epochsCompleted: snapshot.epochs_completed, epochsTotal: snapshot.epochs_total,
        stepsCompleted: snapshot.steps_completed, stepsTotal: snapshot.steps_total, metrics: snapshot.metrics,
        etaSeconds: snapshot.eta_seconds, stallTimeoutSeconds: snapshot.stall_timeout_seconds,
        severity: snapshot.severity, message: snapshot.message, updatedAtSeconds: snapshot.updated_at}},
    latestEventId: native.latest_event_id};
}
