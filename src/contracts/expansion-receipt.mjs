import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const EXPANSION_RECEIPT_ROUTE = '/internal/v2/dispatch/expansion-receipt';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const nativeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 4096;
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

export function parseExpansionReceiptRequest(value) {
  if (!exact(value, ['machineId', 'changeId']) || typeof value.machineId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.machineId) || !uuid(value.changeId)) throw new InvalidRequest('expansion');
  return {machineId: value.machineId, changeId: value.changeId};
}

export function parseExpansionReceipt(value) {
  if (value === null) return null;
  try {
    if (!exact(value, ['changeId','dispatchId','planId','sourceAttemptId','fromReservedGpuCount','sourceGpuCount','targetGpuCount',
      'jobId','accountId','machineId','requestHash','nodeJobId','planState','planVersion','sourceAttemptState',
      'successorAttemptId','successorAttemptState','planReservedGpuCount','jobReservedGpuCount','jobLeasedGpuCount'])
      || !uuid(value.dispatchId) || !uuid(value.jobId) || !nativeId(value.planId) || !nativeId(value.sourceAttemptId) || !nativeId(value.nodeJobId)
      || typeof value.accountId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value.accountId)
      || typeof value.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestHash)
      || !count(value.fromReservedGpuCount) || value.fromReservedGpuCount < 1 || !count(value.targetGpuCount) || value.targetGpuCount <= value.fromReservedGpuCount
      || !count(value.sourceGpuCount) || value.sourceGpuCount < 1 || value.sourceGpuCount > value.fromReservedGpuCount
      || !Number.isSafeInteger(value.planVersion) || value.planVersion < 0
      || !['SAVE_REQUESTED','CHECKPOINT_ACKED','TERM_REQUESTED','RESTART_PENDING','RESTART_PLANNED','COMPLETED','WITHDRAWN','FAILED','CANCELED'].includes(value.planState)
      || typeof value.sourceAttemptState !== 'string' || value.sourceAttemptState.length > 64
      || (value.successorAttemptId !== null && !nativeId(value.successorAttemptId))
      || (value.successorAttemptState !== null && (typeof value.successorAttemptState !== 'string' || value.successorAttemptState.length > 64))
      || !count(value.planReservedGpuCount) || !count(value.jobReservedGpuCount) || !count(value.jobLeasedGpuCount)) throw new InvalidResponse();
    parseExpansionReceiptRequest({machineId: value.machineId, changeId: value.changeId});
    return {...value};
  } catch {throw new InvalidResponse();}
}
