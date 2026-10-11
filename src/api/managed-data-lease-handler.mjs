import {MANAGED_LEASE_ACQUIRE_ROUTE, MANAGED_LEASE_LOOKUP_ROUTE,
  parseNodeManagedLeaseRequest, parseNodeManagedLeaseResult} from '../contracts/managed-data-lease.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {createNodeAuthenticator} from './node-authenticator.mjs';
import {createJsonRoutes} from './json-http.mjs';

/** Internal only. The coordinator checks task ACL; node configuration bounds delegation. */
export function createManagedDataLeaseHandler({machineId, credential, leaser, reportError}) {
  const operation = name => ({async execute(_coordinator, input) {
    if (input.request.machineId !== machineId) throw new ApplicationError('SOURCE_NODE_MISMATCH');
    const result = await leaser[name](input.request, {actor: {id: input.accountId}});
    if (name === 'lookup' && result === null) return null;
    return parseNodeManagedLeaseResult(result, input);
  }});
  return createJsonRoutes({authenticate: createNodeAuthenticator(credential), reportError,
    routes: new Map([
      [MANAGED_LEASE_ACQUIRE_ROUTE, {parse: parseNodeManagedLeaseRequest, useCase: operation('acquire')}],
      [MANAGED_LEASE_LOOKUP_ROUTE, {parse: parseNodeManagedLeaseRequest, useCase: operation('lookup')}],
    ]),
    statuses: {UNAUTHENTICATED: 401, FORBIDDEN: 403, SOURCE_NODE_MISMATCH: 409, MANAGED_DATA_LEASE_UNAVAILABLE: 503},
  });
}
