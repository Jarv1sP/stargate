import {NodeJsonTransport} from './node-json-transport.mjs';
import {NODE_COMPLETION_ROUTES, parseNodeCompletionReference, parseNodeCompletion} from '../contracts/node-completion.mjs';
import {ApplicationError} from '../domain/errors.mjs';

/** Finalize once per call. A later reconciliation always queries the original ID first. */
export class HttpNodeCompletions {
  constructor(options) {this.transport = new NodeJsonTransport(options);}
  lookup(reference) {return this.#call('lookup', reference);}
  finalize(reference) {return this.#call('finalize', reference);}
  async #call(operation, reference) {
    const input = parseNodeCompletionReference(reference);
    try {
      const result = parseNodeCompletion(await this.transport.request(input.machineId, NODE_COMPLETION_ROUTES[operation], input));
      if (result === null) {
        if (operation === 'lookup') return null;
        throw new Error('Node finalization returned no receipt');
      }
      if (result.receipt.machineId !== input.machineId || result.receipt.dispatchId !== input.dispatchId) {
        throw new Error('Node completion identity differs');
      }
      return result;
    } catch (cause) {
      throw new ApplicationError(operation === 'lookup' ? 'NODE_COMPLETION_UNAVAILABLE' : 'NODE_COMPLETION_UNCONFIRMED', {cause});
    }
  }
}
