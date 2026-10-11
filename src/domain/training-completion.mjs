import {ApplicationError} from './errors.mjs';

export function taskHasCompletion(task) {
  return task.dispatch?.state === 'ACCEPTED' && ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(task.stage);
}

/** Bind remote evidence to the already accepted dispatch, never a caller's job ID. */
export function requireCompletionIdentity(dispatch, receipt) {
  if (['dispatchId', 'jobId', 'accountId', 'machineId', 'gpuCount', 'requestHash', 'nodeJobId']
    .some(key => dispatch[key] !== receipt[key])) throw new ApplicationError('TRAINING_COMPLETION_MISMATCH');
}
