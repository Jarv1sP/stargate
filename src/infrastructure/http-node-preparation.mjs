import {NodeJsonTransport} from './node-json-transport.mjs';
import {NODE_PREPARATION_ROUTES, NODE_PREPARATION_REPLY_BYTES, parseNodePreparation, parseNodePreparationReference, parseNodePreparationResult} from '../contracts/node-preparation.mjs';
import {ApplicationError} from '../domain/errors.mjs';

/** Single calls only. Lost preparation replies are queried by the original reference. */
export class HttpNodePreparation {
  constructor(options) {this.transport = new NodeJsonTransport({...options, maxResponseBytes: NODE_PREPARATION_REPLY_BYTES});}
  prepare(command) {const input = parseNodePreparation(command); return this.#call('prepare', input.binding, input);}
  lookup(reference) {const input = parseNodePreparationReference(reference); return this.#call('lookup', input, input);}
  async #call(operation, reference, input) {
    try {
      const result = parseNodePreparationResult(await this.transport.request(reference.machineId, NODE_PREPARATION_ROUTES[operation], input));
      if (result === null) {
        if (operation === 'lookup') return null;
        throw new Error('Preparation returned no record');
      }
      if (Object.keys(reference).some(key => result.binding[key] !== reference[key])) throw new Error('Preparation identity mismatch');
      return result;
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      throw new ApplicationError(operation === 'lookup' ? 'NODE_PREPARATION_UNAVAILABLE' : 'NODE_PREPARATION_UNCONFIRMED', {cause});
    }
  }
}
