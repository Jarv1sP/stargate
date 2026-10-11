import {NodeJsonTransport} from './node-json-transport.mjs';
import {ApplicationError, TransientReadError} from '../domain/errors.mjs';
import {parseDispatchReceiptRequest} from '../contracts/dispatch-receipt.mjs';
import {NODE_JOB_OBSERVATION_ROUTE, NODE_JOB_OBSERVATION_MAX_BYTES, parseNodeJobObservation} from '../contracts/task-read.mjs';

export class HttpJobObserver {
  constructor(options) {this.transport = new NodeJsonTransport({...options, maxResponseBytes: NODE_JOB_OBSERVATION_MAX_BYTES});}
  async observe(reference, {signal, timeoutMs} = {}) {
    const input = parseDispatchReceiptRequest(reference);
    try {
      const result = parseNodeJobObservation(await this.transport.request(input.machineId, NODE_JOB_OBSERVATION_ROUTE, input, {signal, timeoutMs}));
      if (result !== null && (result.receipt.machineId !== input.machineId || result.receipt.dispatchId !== input.dispatchId)) {
        throw new Error('Job observation identity mismatch');
      }
      return result;
    } catch (cause) {
      signal?.throwIfAborted();
      throw new (cause instanceof TransientReadError ? TransientReadError : ApplicationError)('NODE_JOB_UNAVAILABLE', {cause});
    }
  }
}
