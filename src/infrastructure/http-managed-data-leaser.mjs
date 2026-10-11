import {MANAGED_LEASE_ACQUIRE_ROUTE, MANAGED_LEASE_LOOKUP_ROUTE,
  parseNodeManagedLeaseRequest, parseNodeManagedLeaseResult} from '../contracts/managed-data-lease.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {NodeJsonTransport} from './node-json-transport.mjs';

/** One RPC per call. An uncertain acquire is recovered only by explicit lookup. */
export class HttpManagedDataLeaser {
  constructor(options) {this.transport = new NodeJsonTransport(options);}
  acquire(request, context) {return this.#call(MANAGED_LEASE_ACQUIRE_ROUTE, request, context);}
  lookup(request, context) {return this.#call(MANAGED_LEASE_LOOKUP_ROUTE, request, context);}

  async #call(route, request, {actor} = {}) {
    const input = parseNodeManagedLeaseRequest({request, accountId: actor?.id});
    try {
      const result = await this.transport.request(input.request.machineId, route, input);
      if (route === MANAGED_LEASE_LOOKUP_ROUTE && result === null) return null;
      return parseNodeManagedLeaseResult(result, input);
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      throw new ApplicationError('MANAGED_DATA_LEASE_UNAVAILABLE', {cause});
    }
  }
}
