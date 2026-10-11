import {createJsonRoutes} from './json-http.mjs';
import {createNodeAuthenticator} from './node-authenticator.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {NODE_COMPLETION_ROUTES, parseNodeCompletionReference, nodeCompletionResult} from '../contracts/node-completion.mjs';

export function createNodeFinalizationHandler({machineId, credential, finalize, completions, reportError}) {
  const route = (operation, readOnly) => ({readOnly, parse: parseNodeCompletionReference,
    useCase: {async execute(_actor, input) {
      if (input.machineId !== machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
      return nodeCompletionResult(await operation(input));
    }}});
  return createJsonRoutes({authenticate: createNodeAuthenticator(credential), reportError,
    routes: new Map([
      [NODE_COMPLETION_ROUTES.lookup, route(input => completions.get(input), true)],
      [NODE_COMPLETION_ROUTES.finalize, route(input => finalize.execute(input), false)],
    ]), statuses: {UNAUTHENTICATED: 401, NODE_DISPATCH_MACHINE_MISMATCH: 409, NODE_LAUNCH_NOT_PREPARED: 409,
      NATIVE_OPERATION_REJECTED: 409, NATIVE_OUTCOME_UNCONFIRMED: 503, NATIVE_COMPLETION_UNAVAILABLE: 503,
      MANAGED_DATA_LEASE_UNAVAILABLE: 503, NODE_DATA_RELEASE_UNCONFIRMED: 503},
  });
}
