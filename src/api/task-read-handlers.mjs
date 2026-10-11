import {createJsonRoutes} from './json-http.mjs';
import {createNodeAuthenticator} from './node-authenticator.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {parseDispatchReceiptRequest} from '../contracts/dispatch-receipt.mjs';
import {TASK_READ_ROUTE, NODE_JOB_OBSERVATION_ROUTE, parseTaskReadRequest, parseTaskReadResult, parseNodeJobObservation} from '../contracts/task-read.mjs';

export function createTaskReadHandler({authenticate, readTask, reportError}) {
  return createJsonRoutes({authenticate, reportError,
    routes: new Map([[TASK_READ_ROUTE, {parse: parseTaskReadRequest,
      useCase: {async execute(actor, input) {return parseTaskReadResult(await readTask.execute(actor, input));}}}]]),
    statuses: {UNAUTHENTICATED: 401, FORBIDDEN: 403, TASK_READ_CHANGED: 409, TASK_OBSERVATION_MISMATCH: 503},
  });
}

export function createNodeTaskReadHandler({machineId, credential, observeJob, reportError}) {
  return createJsonRoutes({authenticate: createNodeAuthenticator(credential), reportError,
    routes: new Map([[NODE_JOB_OBSERVATION_ROUTE, {parse: parseDispatchReceiptRequest, useCase: {
      async execute(_actor, input) {
        if (input.machineId !== machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
        return parseNodeJobObservation(await observeJob.execute(input));
      },
    }}]]),
    statuses: {UNAUTHENTICATED: 401, NODE_DISPATCH_MACHINE_MISMATCH: 409, GPUQ_JOB_UNAVAILABLE: 503, NATIVE_DISPATCH_RECEIPT_MISMATCH: 503},
  });
}
