import {NodeJsonTransport} from './node-json-transport.mjs';
import {ApplicationError, TransientReadError} from '../domain/errors.mjs';
import {parseDispatchReceiptRequest} from '../contracts/dispatch-receipt.mjs';
import {NODE_JOB_OBSERVATION_ROUTE, NODE_JOB_OBSERVATION_MAX_BYTES, parseNodeJobObservation} from '../contracts/task-read.mjs';
import {NODE_TASK_LOGS_ROUTE, parseNodeLogRequest, parseLogChunk, requireLogCursor} from '../contracts/task-logs.mjs';
import {NODE_TASK_DIAGNOSTICS_ROUTE, parseNodeDiagnostics} from '../contracts/task-diagnostics.mjs';

export class HttpJobObserver {
  constructor(options) {this.transport = new NodeJsonTransport({...options, maxResponseBytes: NODE_JOB_OBSERVATION_MAX_BYTES});}
  observe(reference, options) {return this.#query(NODE_JOB_OBSERVATION_ROUTE, parseDispatchReceiptRequest(reference), parseNodeJobObservation, options);}
  diagnostics(reference, options) {return this.#query(NODE_TASK_DIAGNOSTICS_ROUTE, parseDispatchReceiptRequest(reference), parseNodeDiagnostics, options);}
  async logs(reference, options) {
    const input = parseNodeLogRequest(reference), result = await this.#query(NODE_TASK_LOGS_ROUTE, input, parseLogChunk, options);
    try {requireLogCursor(result, input);} catch (cause) {throw new ApplicationError('NODE_JOB_UNAVAILABLE', {cause});}
    return result;
  }
  async #query(route, input, parse, {signal, timeoutMs} = {}) {
    try {
      const result = parse(await this.transport.request(input.machineId, route, input, {signal, timeoutMs}));
      if (result !== null && (result.receipt.machineId !== input.machineId || result.receipt.dispatchId !== input.dispatchId)) {
        throw new Error('Job observation identity mismatch');
      }
      return result;
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof ApplicationError && cause.code === 'TASK_LOG_CHANGED') throw cause;
      throw new (cause instanceof TransientReadError ? TransientReadError : ApplicationError)('NODE_JOB_UNAVAILABLE', {cause});
    }
  }
}
