import {parseDataReadRequest} from './data-read.mjs';
import {InvalidRequest, InvalidResponse} from './errors.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const account = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value);
export const MANAGED_LEASE_ACQUIRE_ROUTE = '/internal/v2/data-lease/acquire';
export const MANAGED_LEASE_LOOKUP_ROUTE = '/internal/v2/data-lease/lookup';

/** Account identity comes from the authenticated coordinator's persisted task. */
export function parseNodeManagedLeaseRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'accountId,request') throw new InvalidRequest('request');
  if (!account(value.accountId)) throw new InvalidRequest('accountId');
  return {accountId: value.accountId, request: parseManagedLeaseRequest(value.request)};
}

export function parseManagedLeaseRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'jobId,machineId,source' || !uuid(value.jobId)) throw new InvalidRequest('lease');
  const reference = parseDataReadRequest({machineId: value.machineId, source: value.source});
  if (reference.source.kind === 'directory') throw new InvalidRequest('source.kind');
  return {...reference, jobId: value.jobId};
}

export function parseManagedLeaseResult(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'accountId,jobId,leaseId,machineId,readOnly,source'
      || !uuid(value.leaseId) || value.readOnly !== true || !account(value.accountId)) throw new InvalidResponse();
    return {...parseManagedLeaseRequest({machineId: value.machineId, jobId: value.jobId, source: value.source}),
      accountId: value.accountId, leaseId: value.leaseId, readOnly: true};
  } catch {throw new InvalidResponse();}
}

/** Transport receipt validation; a valid lease for a different task is not an ACK. */
export function parseNodeManagedLeaseResult(value, {request, accountId}) {
  const result = parseManagedLeaseResult(value);
  if (result.accountId !== accountId || result.jobId !== request.jobId || result.machineId !== request.machineId
    || result.source.kind !== request.source.kind || result.source.datasetId !== request.source.datasetId
    || result.source.version !== request.source.version) throw new InvalidResponse();
  return result;
}
