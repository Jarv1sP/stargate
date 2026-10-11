import {InvalidResponse} from './errors.mjs';
import {parseNodeJobObservation, parseTaskView, requireTaskReceipt} from './task-read.mjs';

export const TASK_DIAGNOSTICS_ROUTE = '/api/v2/tasks/diagnostics';
export const NODE_TASK_DIAGNOSTICS_ROUTE = '/internal/v2/tasks/diagnostics';
export const DIAGNOSTIC_UNKNOWNS = ['live-processes', 'current-node-capacity', 'kernel-counters', 'worker-captures', 'storage-lease-release'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const count = value => integer(value) && value <= 4096;
const gpu = row => typeof row.gpuUuid === 'string' && /^GPU-[A-Za-z0-9][A-Za-z0-9-]*$/.test(row.gpuUuid) && integer(row.gpuIndex);
const codes = new Set(['TASK_RESOURCES_RELEASED', 'PLATFORM_QUOTA_HELD', 'DISPATCH_ACK_PENDING', 'NOT_DISPATCHED_FOR_READ', 'NATIVE_NOT_OBSERVED',
  'NODE_READ_UNAVAILABLE', 'NATIVE_WAIT_REASON_RECORDED', 'NATIVE_WAIT_REASON_UNKNOWN', 'NATIVE_JOB_FAILED',
  'EXECUTION_UNCONFIRMED', 'ATTEMPT_NONZERO_EXIT', 'CHECKPOINT_HANDOFF', 'ATTEMPT_STOPPING', 'PROGRESS_STALLED',
  'PROGRESS_REPORTED_PROBLEM', 'ALLOCATION_GRANT_MISSING', 'NO_LEGAL_GRANTED_GPU_COUNT', 'NATIVE_RESOURCE_RECORDS_PRESENT',
  'ALLOCATION_GRANT_ID_MISMATCH', 'INITIAL_GRANT_UNCONFIRMED', 'INITIAL_GRANT_MISMATCH',
  'NATIVE_RESOURCE_RECORDS_EMPTY', 'TERMINAL_WITH_RESOURCE_RECORDS', 'OLDER_ATTEMPT_LEASES', 'SCALE_UP_IN_PROGRESS',
  'NATIVE_ACTIONS_PENDING', 'NATIVE_ACTION_ERROR_RECORDED', 'EVIDENCE_TRUNCATED']);

function page(value, limit, parse, key) {
  if (!exact(value, ['items', 'total', 'truncated']) || !Array.isArray(value.items) || value.items.length > limit
    || !integer(value.total) || value.total < value.items.length || value.truncated !== (value.total > value.items.length)) throw new InvalidResponse();
  const items = value.items.map(parse);
  if (new Set(items.map(key)).size !== items.length) throw new InvalidResponse();
  return {...value, items};
}

export function parseNodeDiagnostics(value) {
  if (value === null) return null;
  const {resources: r, ...observation} = value;
  const node = parseNodeJobObservation(observation);
  if (!exact(r, ['request', 'allocation', 'leases', 'reservations', 'pendingActions', 'scalePlan'])
    || !exact(r.request, ['minGpus', 'maxGpus', 'allowedGpuCounts']) || !count(r.request.minGpus) || r.request.minGpus < 1
    || !count(r.request.maxGpus) || r.request.maxGpus < r.request.minGpus
    || !Array.isArray(r.request.allowedGpuCounts) || r.request.allowedGpuCounts.length > 4096
    || r.request.allowedGpuCounts.some((n, index, list) => !count(n) || n < r.request.minGpus || n > r.request.maxGpus || index > 0 && n <= list[index - 1])
    || !exact(r.allocation, ['mode', 'grant']) || !['native', 'external-v1'].includes(r.allocation.mode)) throw new InvalidResponse();
  const grant = r.allocation.grant;
  if (grant !== null && (!exact(grant, ['id', 'revision', 'maxGpuCount', 'initialMaxGpuCount'])
    || !id(grant.id) || !integer(grant.revision, 1) || !count(grant.maxGpuCount)
    || grant.initialMaxGpuCount !== null && !count(grant.initialMaxGpuCount))) throw new InvalidResponse();
  const leases = page(r.leases, 4096, row => {
    if (!exact(row, ['attemptId', 'gpuUuid', 'gpuIndex']) || !id(row.attemptId) || !gpu(row)) throw new InvalidResponse();
    return {...row};
  }, row => `${row.attemptId}/${row.gpuUuid}`);
  const reservations = page(r.reservations, 4096, row => {
    if (!exact(row, ['planId', 'gpuUuid', 'gpuIndex']) || !id(row.planId) || !gpu(row)) throw new InvalidResponse();
    return {...row};
  }, row => row.gpuUuid);
  const pendingActions = page(r.pendingActions, 16, row => {
    if (!exact(row, ['id', 'attemptId', 'type', 'attemptCount', 'availableAtSeconds', 'errorRecorded', 'claimRecorded'])
      || !id(row.id) || row.attemptId !== null && !id(row.attemptId)
      || !['START_UNIT', 'REQUEST_SAVE', 'TERM_UNIT', 'KILL_UNIT', 'CLEANUP_UNIT'].includes(row.type)
      || !integer(row.attemptCount) || typeof row.availableAtSeconds !== 'number' || !Number.isFinite(row.availableAtSeconds) || row.availableAtSeconds < 0
      || typeof row.errorRecorded !== 'boolean' || typeof row.claimRecorded !== 'boolean') throw new InvalidResponse();
    return {...row};
  }, row => row.id);
  const plan = r.scalePlan;
  if (plan !== null && (!exact(plan, ['id', 'state', 'sourceAttemptId', 'successorAttemptId', 'sourceGpuCount', 'targetGpuCount'])
    || !id(plan.id) || !id(plan.sourceAttemptId) || plan.successorAttemptId !== null && !id(plan.successorAttemptId)
    || !['SAVE_REQUESTED', 'CHECKPOINT_ACKED', 'TERM_REQUESTED', 'RESTART_PENDING', 'RESTART_PLANNED'].includes(plan.state)
    || !count(plan.sourceGpuCount) || plan.sourceGpuCount < 1 || !count(plan.targetGpuCount) || plan.targetGpuCount <= plan.sourceGpuCount)) throw new InvalidResponse();
  return {...node, resources: {request: {...r.request, allowedGpuCounts: [...r.request.allowedGpuCounts]},
    allocation: {...r.allocation, grant: grant === null ? null : {...grant}}, leases, reservations, pendingActions, scalePlan: plan === null ? null : {...plan}}};
}

export function parseTaskDiagnosticResult(value) {
  if (!exact(value, ['task', 'diagnostics', 'quota', 'findings', 'unknowns']) || !exact(value.diagnostics, ['kind', 'node'])
    || !['not-queried', 'not-observed', 'unavailable', 'observed'].includes(value.diagnostics.kind)
    || (value.diagnostics.kind === 'observed') !== (value.diagnostics.node !== null)) throw new InvalidResponse();
  const task = parseTaskView(value.task), node = parseNodeDiagnostics(value.diagnostics.node), quota = value.quota;
  if (value.diagnostics.kind !== 'not-queried' && (!task.dispatch || task.dispatch.state === 'PREPARED')) throw new InvalidResponse();
  if (node) requireTaskReceipt(task, node.receipt);
  if (quota !== null && (!exact(quota, ['machineId', 'state', 'initialGpuCount', 'reservedGpuCount']) || !id(quota.machineId)
    || !['HELD', 'RELEASED'].includes(quota.state) || !count(quota.initialGpuCount) || quota.initialGpuCount < 1
    || !count(quota.reservedGpuCount) || quota.reservedGpuCount < 1
    || task.dispatch && (quota.machineId !== task.dispatch.machineId || quota.initialGpuCount !== task.dispatch.gpuCount))) throw new InvalidResponse();
  if (!Array.isArray(value.findings) || value.findings.length > codes.size || value.findings.some(row =>
    !exact(row, ['code', 'level']) || !codes.has(row.code) || !['info', 'warning', 'error'].includes(row.level))
    || new Set(value.findings.map(row => row.code)).size !== value.findings.length
    || JSON.stringify(value.unknowns) !== JSON.stringify(task.dispatch?.state === 'ACCEPTED'
      && ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(task.stage) ? DIAGNOSTIC_UNKNOWNS.slice(0, -1) : DIAGNOSTIC_UNKNOWNS)) throw new InvalidResponse();
  return {task, diagnostics: {...value.diagnostics, node}, quota: quota === null ? null : {...quota},
    findings: value.findings.map(row => ({...row})), unknowns: [...value.unknowns]};
}
