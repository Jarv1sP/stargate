import {createJsonRoutes} from './json-http.mjs';
import {createNodeAuthenticator} from './node-authenticator.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {NODE_PREPARATION_ROUTES, NODE_PREPARATION_MAX_BYTES, parseNodePreparation, parseNodePreparationReference, nodePreparationResult} from '../contracts/node-preparation.mjs';

export function createNodePreparationHandler({machineId, credential, preparation, reportError}) {
  return createJsonRoutes({authenticate: createNodeAuthenticator(credential), reportError,
    routes: new Map([
      [NODE_PREPARATION_ROUTES.prepare, {maxRequestBytes: NODE_PREPARATION_MAX_BYTES, parse: parseNodePreparation,
        useCase: {async execute(_actor, input) {
          if (input.binding.machineId !== machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
          return nodePreparationResult(await preparation.execute(input));
        }}}],
      [NODE_PREPARATION_ROUTES.lookup, {readOnly: true, parse: parseNodePreparationReference,
        useCase: {async execute(_actor, input) {
          if (input.machineId !== machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
          return nodePreparationResult(await preparation.lookup(input));
        }}}],
    ]), statuses: {UNAUTHENTICATED: 401, FORBIDDEN: 403, INVALID_TRAINING_REQUEST: 400, TRAINING_REQUEST_TOO_LARGE: 400,
      NODE_DISPATCH_MACHINE_MISMATCH: 409, NODE_PREPARATION_CONFLICT: 409, NODE_RUNTIME_PLAN_IDENTITY_MISMATCH: 409,
      TRAINING_DATA_PATH_CONFLICT: 409, PROJECT_INSTANCE_CHANGED: 409, PROJECT_RUN_CONFLICT: 409, PROJECT_NOT_ACTIVE: 409,
      PROJECT_RUNTIME_CHANGED: 409, NODE_RUNTIME_PLAN_CONFLICT: 409, NODE_DISPATCH_BINDING_CONFLICT: 409,
      NODE_LAUNCH_SPEC_CONFLICT: 409, PROJECT_RUN_UNAVAILABLE: 503, MANAGED_DATA_LEASE_UNAVAILABLE: 503, GPU_POOL_UNAVAILABLE: 503},
  });
}
