import {parseDispatchReceipt, parseDispatchReceiptRequest} from './dispatch-receipt.mjs';
import {InvalidResponse} from './errors.mjs';

export const NODE_COMPLETION_ROUTES = {lookup: '/internal/v2/dispatch/completion', finalize: '/internal/v2/dispatch/finalize'};
export {parseDispatchReceiptRequest as parseNodeCompletionReference};
const completedTaskStates = ['SUCCEEDED', 'FAILED', 'CANCELED'];
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Minimal node evidence, not user-supplied status or a copy of the launch plan. */
export function parseNodeCompletion(value) {
  if (value === null) return null;
  const fields = ['receipt', 'state', 'nativeVersion', 'finishedAtSeconds', 'sealedAtSeconds', 'dataReleased'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || !fields.every(key => Object.hasOwn(value, key)) || !completedTaskStates.includes(value.state)
    || !Number.isSafeInteger(value.nativeVersion) || value.nativeVersion < 0 || value.dataReleased !== true
    || (value.finishedAtSeconds !== null && !time(value.finishedAtSeconds)) || !time(value.sealedAtSeconds)) throw new InvalidResponse();
  const receipt = parseDispatchReceipt(value.receipt);
  if (receipt === null) throw new InvalidResponse();
  return {...value, receipt};
}

export function nodeCompletionResult(value) {
  if (value === null) return null;
  const {binding: b, native: n} = value;
  return {receipt: {dispatchId: b.dispatchId, jobId: b.jobId, accountId: b.accountId, machineId: b.machineId,
    gpuCount: b.gpuCount, requestHash: b.requestHash, nodeJobId: n.job_id},
  state: n.state, nativeVersion: n.native_version, finishedAtSeconds: n.finished_at,
  sealedAtSeconds: n.sealed_at, dataReleased: value.dataReleased};
}
