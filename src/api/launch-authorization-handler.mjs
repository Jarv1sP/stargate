import {createJsonRoutes} from './json-http.mjs';
import {createMachineAuthenticator} from './node-authenticator.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {LAUNCH_AUTHORIZATION_ROUTE, LAUNCH_AUTHORIZATION_MAX_BYTES, parseLaunchAuthorization, parseLaunchApproval} from '../contracts/launch-authorization.mjs';

export function createLaunchAuthorizationHandler({peers, authorization, reportError}) {
  return createJsonRoutes({authenticate: createMachineAuthenticator(peers), reportError,
    routes: new Map([[LAUNCH_AUTHORIZATION_ROUTE, {readOnly: true, maxRequestBytes: LAUNCH_AUTHORIZATION_MAX_BYTES,
      parse: parseLaunchAuthorization, useCase: {async execute(actor, input) {
        if (actor.machineId !== input.binding.machineId) throw new ApplicationError('FORBIDDEN');
        return parseLaunchApproval(await authorization.acquire(input));
      }}}]]),
    statuses: {UNAUTHENTICATED: 401, FORBIDDEN: 403, TASK_NOT_AUTHORIZED: 403, TASK_SCOPE_MISMATCH: 403,
      NODE_LAUNCH_NOT_AUTHORIZED: 403, NODE_LAUNCH_PROJECT_CHANGED: 403, NODE_LAUNCH_INPUTS_CHANGED: 403,
      PROJECT_ARCHIVED: 403, PROJECT_RELEASE_NOT_FOUND: 403, COMPUTE_CLAIM_CHANGED: 403, COMPUTE_QUOTA_EXCEEDED: 403,
      COMPUTE_ACCOUNTING_UNREADY: 503},
  });
}
