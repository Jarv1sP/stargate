import {ApplicationError} from './errors.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const nativeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
export function nodeExpansionBinding(value) {
  if (!value || !uuid(value.changeId) || !uuid(value.dispatchId) || !nativeId(value.planId) || !nativeId(value.sourceAttemptId)
    || !Number.isSafeInteger(value.fromReservedGpuCount) || !Number.isSafeInteger(value.targetGpuCount)
    || !Number.isSafeInteger(value.sourceGpuCount) || value.sourceGpuCount < 1 || value.sourceGpuCount > value.fromReservedGpuCount
    || value.fromReservedGpuCount < 1 || value.targetGpuCount <= value.fromReservedGpuCount || value.targetGpuCount > 4096) {
    throw new ApplicationError('INVALID_NODE_EXPANSION_BINDING');
  }
  return {changeId: value.changeId, dispatchId: value.dispatchId, planId: value.planId,
    sourceAttemptId: value.sourceAttemptId, fromReservedGpuCount: value.fromReservedGpuCount, sourceGpuCount: value.sourceGpuCount, targetGpuCount: value.targetGpuCount};
}

export function nativeExpansionObservation(dispatch, expansion, receipt) {
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 4096;
  if (!receipt || receipt.submit_key !== dispatch.dispatchId || receipt.submit_digest !== dispatch.nativeDigest
    || receipt.plan_id !== expansion.planId || receipt.source_attempt_id !== expansion.sourceAttemptId
    || receipt.from_gpu_count !== expansion.sourceGpuCount || receipt.target_gpu_count !== expansion.targetGpuCount
    || !nativeId(receipt.job_id) || (receipt.successor_attempt_id !== null && !nativeId(receipt.successor_attempt_id))
    || !Number.isSafeInteger(receipt.plan_version) || receipt.plan_version < 0
    || !['SAVE_REQUESTED','CHECKPOINT_ACKED','TERM_REQUESTED','RESTART_PENDING','RESTART_PLANNED','COMPLETED','WITHDRAWN','FAILED','CANCELED'].includes(receipt.plan_state)
    || typeof receipt.source_attempt_state !== 'string'
    || (receipt.successor_attempt_state !== null && typeof receipt.successor_attempt_state !== 'string')
    || !count(receipt.plan_reserved_gpu_count) || !count(receipt.job_reserved_gpu_count) || !count(receipt.job_leased_gpu_count)) {
    throw new ApplicationError('NATIVE_EXPANSION_RECEIPT_MISMATCH');
  }
  return {...expansion, jobId: dispatch.jobId, accountId: dispatch.accountId, machineId: dispatch.machineId,
    requestHash: dispatch.requestHash, nodeJobId: receipt.job_id, planState: receipt.plan_state, planVersion: receipt.plan_version,
    sourceAttemptState: receipt.source_attempt_state, successorAttemptId: receipt.successor_attempt_id,
    successorAttemptState: receipt.successor_attempt_state, planReservedGpuCount: receipt.plan_reserved_gpu_count,
    jobReservedGpuCount: receipt.job_reserved_gpu_count, jobLeasedGpuCount: receipt.job_leased_gpu_count};
}
