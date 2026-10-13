import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const TASK_SUBMISSION_ROUTES = {submit: '/api/v2/tasks/submit', request: '/api/v2/tasks/request'};
export const TASK_SUBMISSION_MAX_BYTES = 65536;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const text = (value, max) => typeof value === 'string' && value.isWellFormed() && [...value].length <= max;

export function parseTaskRequestReference(value) {
  if (!exact(value, ['requestId']) || !uuid(value.requestId)) throw new InvalidRequest('requestId');
  return {requestId: value.requestId};
}

/** Immutable enqueue acknowledgement. Read the job separately for its current status. */
export function parseTaskSubmissionReceipt(value) {
  if (value === null) return null;
  if (!exact(value, ['request', 'sequence', 'queuedAtMs']) || !integer(value.sequence, 1) || !integer(value.queuedAtMs)) throw new InvalidResponse();
  const r = value.request;
  if (!exact(r, ['jobId', 'requestId', 'state', 'name', 'description', 'submitter', 'createdAtMs'])
    || !uuid(r.jobId) || !uuid(r.requestId) || r.state !== 'RECORDED' || !integer(r.createdAtMs)
    || !text(r.name, 64) || !r.name || !text(r.description, 2000)
    || !exact(r.submitter, ['accountId', 'username', 'displayName'])
    || Object.values(r.submitter).some(value => !text(value, 256) || !value)) throw new InvalidResponse();
  return {...value, request: {...r, submitter: {...r.submitter}}};
}
