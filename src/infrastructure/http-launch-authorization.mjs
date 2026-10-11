import {NodeJsonTransport} from './node-json-transport.mjs';
import {LAUNCH_AUTHORIZATION_ROUTE, launchAuthorizationRequest, parseLaunchApproval} from '../contracts/launch-authorization.mjs';
import {ApplicationError} from '../domain/errors.mjs';

/** Node-to-coordinator query, with this node's own credential and fixed identity. */
export class HttpLaunchAuthorization {
  constructor({machineId, origin, credential, ...options}) {
    this.machineId = machineId;
    this.transport = new NodeJsonTransport({...options, nodes: [{machineId, origin, credential}]});
  }
  async acquire(command) {
    const input = launchAuthorizationRequest(command);
    if (input.binding.machineId !== this.machineId) throw new ApplicationError('NODE_LAUNCH_NOT_AUTHORIZED');
    try {
      const result = parseLaunchApproval(await this.transport.request(this.machineId, LAUNCH_AUTHORIZATION_ROUTE, input));
      if (Object.keys(input.binding).some(key => result[key] !== input.binding[key])) throw new Error('Launch approval identity mismatch');
      return result;
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      throw new ApplicationError('NODE_LAUNCH_AUTHORIZATION_UNAVAILABLE', {cause});
    }
  }
}
