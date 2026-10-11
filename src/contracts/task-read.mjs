import {InvalidRequest, InvalidResponse} from './errors.mjs';
import {parseDispatchReceipt, parseDispatchReceiptRequest} from './dispatch-receipt.mjs';

export const TASK_READ_ROUTE = '/api/v2/tasks/read';
export const NODE_JOB_OBSERVATION_ROUTE = '/internal/v2/tasks/observe';
export const NODE_JOB_OBSERVATION_MAX_BYTES = 2 * 1024 * 1024;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const text = (value, max) => typeof value === 'string' && value.isWellFormed() && [...value].length <= max;
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nullable = (value, check) => value === null || check(value);
const jobStates = ['PENDING', 'STARTING', 'RUNNING', 'PREEMPTING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'LOST'];
export const attemptStates = ['PLANNED', 'STARTING', 'RUNNING', 'SAVE_REQUESTED', 'SAVE_WITHDRAWING', 'CHECKPOINT_ACKED',
  'TERM_REQUESTED', 'KILL_REQUESTED', 'DRAINING', 'PREEMPTED', 'EXITED_SUCCESS', 'EXITED_FAILURE', 'CANCELED', 'LOST', 'STUCK'];

export function parseTaskReadRequest(value) {
  if (!exact(value, ['jobId']) || !uuid(value.jobId)) throw new InvalidRequest('jobId');
  return {jobId: value.jobId};
}

function parseProgress(value) {
  if (value === null) return null;
  if (!exact(value, ['reported', 'stale', 'error', 'heartbeatAgeSeconds', 'progressAgeSeconds', 'snapshot'])
    || typeof value.reported !== 'boolean' || typeof value.stale !== 'boolean' || !nullable(value.error, value => text(value, 2048))
    || !nullable(value.heartbeatAgeSeconds, number) || !nullable(value.progressAgeSeconds, number)) throw new InvalidResponse();
  const snapshot = value.snapshot;
  if (!value.reported) {
    if (snapshot !== null || value.stale || value.heartbeatAgeSeconds !== null || value.progressAgeSeconds !== null) throw new InvalidResponse();
    return {...value};
  }
  if (!exact(snapshot, ['sequence', 'phase', 'epochsCompleted', 'epochsTotal', 'stepsCompleted', 'stepsTotal', 'metrics',
    'etaSeconds', 'stallTimeoutSeconds', 'severity', 'message', 'updatedAtSeconds'])
    || !integer(snapshot.sequence, 1) || !text(snapshot.phase, 64) || !snapshot.phase
    || !['info', 'warning', 'error'].includes(snapshot.severity) || !nullable(snapshot.message, value => text(value, 512))
    || !number(snapshot.updatedAtSeconds) || !nullable(snapshot.etaSeconds, number)
    || !nullable(snapshot.stallTimeoutSeconds, value => number(value) && value >= 30 && value <= 86400)
    || (snapshot.severity === 'info' && snapshot.message !== null)
    || value.heartbeatAgeSeconds === null || value.progressAgeSeconds === null) throw new InvalidResponse();
  for (const kind of ['epochs', 'steps']) {
    const completed = snapshot[kind + 'Completed'], total = snapshot[kind + 'Total'];
    if (!(completed === null && total === null) && !(integer(completed) && integer(total, 1) && completed <= total)) throw new InvalidResponse();
  }
  if (!snapshot.metrics || typeof snapshot.metrics !== 'object' || Array.isArray(snapshot.metrics)
    || Object.keys(snapshot.metrics).length > 32 || Object.entries(snapshot.metrics).some(([key, value]) =>
      !/^[A-Za-z][A-Za-z0-9_.:/-]{0,63}$/.test(key) || typeof value !== 'number' || !Number.isFinite(value))) throw new InvalidResponse();
  return {...value, snapshot: {...snapshot, metrics: {...snapshot.metrics}}};
}

export function parseNodeJobObservation(value) {
  if (value === null) return null;
  if (!exact(value, ['receipt', 'state', 'priority', 'reason', 'latestAttempt', 'progress', 'latestEventId'])
    || !jobStates.includes(value.state) || !integer(value.priority) || value.priority > 4
    || !nullable(value.reason, value => text(value, 8192)) || !integer(value.latestEventId)) throw new InvalidResponse();
  const receipt = parseDispatchReceipt(value.receipt), attempt = value.latestAttempt;
  if (receipt === null) throw new InvalidResponse();
  if (attempt !== null) {
    if (!exact(attempt, ['id', 'ordinal', 'state', 'assignedGpus', 'exitCode', 'failureReason'])
      || !text(attempt.id, 256) || !attempt.id || !integer(attempt.ordinal, 1) || !attemptStates.includes(attempt.state)
      || !nullable(attempt.exitCode, Number.isSafeInteger) || !nullable(attempt.failureReason, value => text(value, 8192))
      || !Array.isArray(attempt.assignedGpus) || attempt.assignedGpus.length > 4096
      || attempt.assignedGpus.some(gpu => !exact(gpu, ['uuid', 'index']) || !text(gpu.uuid, 256)
        || !/^GPU-[A-Za-z0-9][A-Za-z0-9-]*$/.test(gpu.uuid) || !integer(gpu.index))
      || new Set(attempt.assignedGpus.map(gpu => gpu.uuid)).size !== attempt.assignedGpus.length
      || new Set(attempt.assignedGpus.map(gpu => gpu.index)).size !== attempt.assignedGpus.length) throw new InvalidResponse();
  }
  const progress = parseProgress(value.progress);
  if ((attempt === null) !== (progress === null)) throw new InvalidResponse();
  return {...value, receipt, progress, latestAttempt: attempt === null ? null : {...attempt, assignedGpus: attempt.assignedGpus.map(gpu => ({...gpu}))}};
}

export function parseTaskView(task) {
  if (!exact(task, ['jobId', 'name', 'description', 'submitter', 'createdAtMs', 'stage', 'dispatch'])) throw new InvalidResponse();
  if (!uuid(task.jobId) || !text(task.name, 256) || !task.name || !text(task.description, 6000) || !integer(task.createdAtMs)
    || !['RECORDED', 'QUEUED', 'CANCELED', 'PREPARED', 'SENDING', 'UNKNOWN', 'ACCEPTED'].includes(task.stage)
    || !exact(task.submitter, ['accountId', 'username', 'displayName'])
    || Object.values(task.submitter).some(value => !text(value, 256) || !value)) throw new InvalidResponse();
  const dispatch = task.dispatch;
  if (dispatch !== null) {
    if (!exact(dispatch, ['dispatchId', 'machineId', 'gpuCount', 'state', 'nodeJobId']) || !integer(dispatch.gpuCount, 1)
      || dispatch.gpuCount > 4096 || !['PREPARED', 'SENDING', 'UNKNOWN', 'ACCEPTED'].includes(dispatch.state)
      || !nullable(dispatch.nodeJobId, value => text(value, 128) && value.length > 0)
      || (dispatch.state === 'ACCEPTED') !== (dispatch.nodeJobId !== null) || task.stage !== dispatch.state) throw new InvalidResponse();
    try {parseDispatchReceiptRequest({machineId: dispatch.machineId, dispatchId: dispatch.dispatchId});}
    catch {throw new InvalidResponse();}
  } else if (!['RECORDED', 'QUEUED', 'CANCELED'].includes(task.stage)) throw new InvalidResponse();
  return {...task, submitter: {...task.submitter}, dispatch: dispatch === null ? null : {...dispatch}};
}

export function requireTaskReceipt(task, receipt) {
  const dispatch = task.dispatch;
  if (!dispatch || receipt.jobId !== task.jobId || receipt.accountId !== task.submitter.accountId
    || receipt.dispatchId !== dispatch.dispatchId || receipt.machineId !== dispatch.machineId
    || receipt.gpuCount !== dispatch.gpuCount || (dispatch.nodeJobId !== null && dispatch.nodeJobId !== receipt.nodeJobId)) throw new InvalidResponse();
}

export function parseTaskReadResult(value) {
  if (!exact(value, ['task', 'observation'])) throw new InvalidResponse();
  const task = parseTaskView(value.task), {observation} = value, {dispatch} = task;
  if (!exact(observation, ['kind', 'node']) || !['not-queried', 'not-observed', 'unavailable', 'observed'].includes(observation.kind)
    || (observation.kind === 'observed') !== (observation.node !== null)) throw new InvalidResponse();
  if (observation.kind !== 'not-queried' && (!dispatch || dispatch.state === 'PREPARED')) throw new InvalidResponse();
  const node = parseNodeJobObservation(observation.node);
  if (node) requireTaskReceipt(task, node.receipt);
  return {task, observation: {...observation, node}};
}
