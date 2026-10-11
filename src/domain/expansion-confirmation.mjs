import {ApplicationError} from './errors.mjs';

export function requireExpansionIdentity(expected, observed) {
  const fields = ['changeId', 'jobId', 'machineId', 'accountId', 'dispatchId', 'nodeJobId', 'requestHash', 'fromReservedGpuCount', 'sourceGpuCount', 'targetGpuCount'];
  if (!observed || fields.some(field => observed[field] !== expected[field])) throw new ApplicationError('EXPANSION_OBSERVATION_MISMATCH');
}

/** Records historical application only. No terminal/failure observation authorizes a refund. */
export function expansionCompletion(expected, observed) {
  requireExpansionIdentity(expected, observed);
  const nativeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
  if (observed.planState !== 'COMPLETED' || !nativeId(observed.planId) || !nativeId(observed.sourceAttemptId)
    || !nativeId(observed.successorAttemptId) || !Number.isSafeInteger(observed.planVersion) || observed.planVersion < 0) {
    throw new ApplicationError('EXPANSION_NOT_CONFIRMED');
  }
  return {planId: observed.planId, sourceAttemptId: observed.sourceAttemptId, successorAttemptId: observed.successorAttemptId};
}
