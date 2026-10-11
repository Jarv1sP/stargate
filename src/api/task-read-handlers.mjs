import {createJsonRoutes} from './json-http.mjs';
import {createNodeAuthenticator} from './node-authenticator.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {parseDispatchReceiptRequest} from '../contracts/dispatch-receipt.mjs';
import {TASK_READ_ROUTE, NODE_JOB_OBSERVATION_ROUTE, parseTaskReadRequest, parseTaskReadResult, parseNodeJobObservation} from '../contracts/task-read.mjs';
import {TASK_LOGS_ROUTE, NODE_TASK_LOGS_ROUTE, parseTaskLogRequest, parseNodeLogRequest, parseLogChunk, parseTaskLogResult, requireLogCursor} from '../contracts/task-logs.mjs';
import {TASK_DIAGNOSTICS_ROUTE, NODE_TASK_DIAGNOSTICS_ROUTE, parseTaskDiagnosticResult, parseNodeDiagnostics} from '../contracts/task-diagnostics.mjs';

const readStatuses = {TASK_READ_BUSY: 429, TASK_READ_TIMEOUT: 504, TASK_READ_ABORTED: 499};

export function createTaskReadHandler({authenticate, readTask, reportError}) {
  return createJsonRoutes({authenticate, reportError,
    routes: new Map([
      [TASK_READ_ROUTE, {readOnly: true, parse: parseTaskReadRequest,
        useCase: {async execute(actor, input, options) {return parseTaskReadResult(await readTask.execute(actor, input, options));}}}],
      [TASK_LOGS_ROUTE, {readOnly: true, parse: parseTaskLogRequest,
        useCase: {async execute(actor, input, options) {return parseTaskLogResult(await readTask.logs(actor, input, options));}}}],
      [TASK_DIAGNOSTICS_ROUTE, {readOnly: true, parse: parseTaskReadRequest,
        useCase: {async execute(actor, input, options) {return parseTaskDiagnosticResult(await readTask.diagnostics(actor, input, options));}}}],
    ]),
    statuses: {...readStatuses, UNAUTHENTICATED: 401, FORBIDDEN: 403, TASK_READ_CHANGED: 409, TASK_LOG_CHANGED: 409, TASK_OBSERVATION_MISMATCH: 503},
  });
}

export function createNodeTaskReadHandler({machineId, credential, observeJob, reportError}) {
  return createJsonRoutes({authenticate: createNodeAuthenticator(credential), reportError,
    routes: new Map([
      [NODE_JOB_OBSERVATION_ROUTE, {readOnly: true, parse: parseDispatchReceiptRequest, useCase: {
        async execute(_actor, input, options) {
          if (input.machineId !== machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
          return parseNodeJobObservation(await observeJob.execute(input, options));
        },
      }}],
      [NODE_TASK_LOGS_ROUTE, {readOnly: true, parse: parseNodeLogRequest, useCase: {
        async execute(_actor, input, options) {
          if (input.machineId !== machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
          const chunk = parseLogChunk(await observeJob.logs(input, options));
          requireLogCursor(chunk, input);
          return chunk;
        },
      }}],
      [NODE_TASK_DIAGNOSTICS_ROUTE, {readOnly: true, parse: parseDispatchReceiptRequest, useCase: {
        async execute(_actor, input, options) {
          if (input.machineId !== machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
          return parseNodeDiagnostics(await observeJob.diagnostics(input, options));
        },
      }}],
    ]),
    statuses: {...readStatuses, UNAUTHENTICATED: 401, NODE_DISPATCH_MACHINE_MISMATCH: 409, GPUQ_JOB_UNAVAILABLE: 503,
      TASK_LOG_UNAVAILABLE: 503, TASK_LOG_CHANGED: 409, NATIVE_DISPATCH_RECEIPT_MISMATCH: 503},
  });
}
