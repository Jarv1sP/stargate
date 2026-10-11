import {parseDataReadRequest} from './data-read.mjs';
import {InvalidRequest, InvalidResponse} from './errors.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function parseManagedLeaseRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'jobId,machineId,source' || !uuid(value.jobId)) throw new InvalidRequest('lease');
  const reference = parseDataReadRequest({machineId: value.machineId, source: value.source});
  if (reference.source.kind === 'directory') throw new InvalidRequest('source.kind');
  return {...reference, jobId: value.jobId};
}

export function parseManagedLeaseResult(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'accountId,jobId,leaseId,machineId,readOnly,source'
      || !uuid(value.leaseId) || value.readOnly !== true || typeof value.accountId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value.accountId)) throw new InvalidResponse();
    return {...parseManagedLeaseRequest({machineId: value.machineId, jobId: value.jobId, source: value.source}),
      accountId: value.accountId, leaseId: value.leaseId, readOnly: true};
  } catch {throw new InvalidResponse();}
}
