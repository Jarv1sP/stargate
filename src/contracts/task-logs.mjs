import {InvalidRequest, InvalidResponse} from './errors.mjs';
import {parseDispatchReceipt, parseDispatchReceiptRequest} from './dispatch-receipt.mjs';
import {parseTaskReadRequest, parseTaskView, requireTaskReceipt, attemptStates} from './task-read.mjs';

export const TASK_LOGS_ROUTE = '/api/v2/tasks/logs';
export const NODE_TASK_LOGS_ROUTE = '/internal/v2/tasks/logs';
export const MAX_LOG_BYTES = 65536;
export const TERMINAL_LOG_ATTEMPTS = ['PREEMPTED', 'EXITED_SUCCESS', 'EXITED_FAILURE', 'CANCELED'];
const fields = ['attemptId', 'fileId', 'offset', 'maxBytes'];
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function parseLogCursor(value) {
  if (!exact(value, fields) || (value.attemptId !== null && !id(value.attemptId)) || (value.fileId !== null && !hash(value.fileId))
    || (value.offset !== null && !integer(value.offset)) || !integer(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > MAX_LOG_BYTES
    || (value.fileId !== null && (value.attemptId === null || value.offset === null))
    || (value.offset !== null && value.offset !== 0 && value.fileId === null)) throw new InvalidRequest('cursor');
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}

export function parseTaskLogRequest(value) {
  if (!exact(value, ['jobId', ...fields])) throw new InvalidRequest('request');
  return {...parseTaskReadRequest({jobId: value.jobId}), ...parseLogCursor(Object.fromEntries(fields.map(key => [key, value[key]])))};
}
export function parseNodeLogRequest(value) {
  if (!exact(value, ['machineId', 'dispatchId', ...fields])) throw new InvalidRequest('request');
  return {...parseDispatchReceiptRequest({machineId: value.machineId, dispatchId: value.dispatchId}),
    ...parseLogCursor(Object.fromEntries(fields.map(key => [key, value[key]])))};
}

export function parseLogChunk(value) {
  if (value === null) return null;
  if (!exact(value, ['receipt', 'attemptId', 'ordinal', 'attemptState', 'fileId', 'offset', 'nextOffset', 'observedSize', 'dataBase64'])
    || !id(value.attemptId) || !integer(value.ordinal) || value.ordinal < 1 || !attemptStates.includes(value.attemptState)
    || !hash(value.fileId) || ![value.offset, value.nextOffset, value.observedSize].every(integer)
    || value.offset > value.nextOffset || value.nextOffset > value.observedSize || value.nextOffset - value.offset > MAX_LOG_BYTES
    || typeof value.dataBase64 !== 'string' || value.dataBase64.length > 4 * Math.ceil(MAX_LOG_BYTES / 3)) throw new InvalidResponse();
  let bytes;
  try {bytes = atob(value.dataBase64);} catch {throw new InvalidResponse();}
  if (btoa(bytes) !== value.dataBase64 || bytes.length !== value.nextOffset - value.offset
    || (bytes.length === 0 && value.offset < value.observedSize)) throw new InvalidResponse();
  const receipt = parseDispatchReceipt(value.receipt);
  if (receipt === null) throw new InvalidResponse();
  return {...value, receipt};
}

export function requireLogCursor(chunk, request) {
  if (chunk === null) return;
  if ((request.attemptId !== null && chunk.attemptId !== request.attemptId)
    || (request.fileId !== null && chunk.fileId !== request.fileId)
    || (request.offset !== null ? chunk.offset !== request.offset : chunk.offset !== Math.max(0, chunk.observedSize - request.maxBytes))
    || chunk.nextOffset - chunk.offset > request.maxBytes) throw new InvalidResponse();
}

export function parseTaskLogResult(value) {
  if (!exact(value, ['task', 'log']) || !exact(value.log, ['kind', 'chunk'])
    || !['not-queried', 'not-observed', 'unavailable', 'chunk'].includes(value.log.kind)
    || (value.log.kind === 'chunk') !== (value.log.chunk !== null)) throw new InvalidResponse();
  const task = parseTaskView(value.task), chunk = parseLogChunk(value.log.chunk);
  if (value.log.kind !== 'not-queried' && (!task.dispatch || task.dispatch.state === 'PREPARED')) throw new InvalidResponse();
  if (chunk) requireTaskReceipt(task, chunk.receipt);
  return {task, log: {...value.log, chunk}};
}
