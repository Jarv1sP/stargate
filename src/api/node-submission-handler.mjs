import {createJsonRoutes} from './json-http.mjs';
import {createNodeAuthenticator} from './node-authenticator.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {NODE_SUBMISSION_ROUTE, parseNodeSubmission, parseNodeSubmissionResult} from '../contracts/node-submission.mjs';

export function createNodeSubmissionHandler({machineId, credential, submit, reportError}) {
  return createJsonRoutes({authenticate: createNodeAuthenticator(credential), reportError,
    // Mutating intent: a client disconnect must not interrupt/replay the native send.
    routes: new Map([[NODE_SUBMISSION_ROUTE, {parse: parseNodeSubmission, useCase: {async execute(_actor, input) {
      if (input.machineId !== machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
      return parseNodeSubmissionResult(await submit.execute(input));
    }}}]]),
    statuses: {UNAUTHENTICATED: 401, FORBIDDEN: 403, NODE_LAUNCH_NOT_AUTHORIZED: 403,
      NODE_DISPATCH_MACHINE_MISMATCH: 409, NODE_LAUNCH_NOT_PREPARED: 409, INVALID_MANAGED_REQUEST: 409,
      NODE_RUNTIME_PLAN_IDENTITY_MISMATCH: 409, NODE_DISPATCH_BINDING_CONFLICT: 409,
      NODE_LAUNCH_AUTHORIZATION_UNAVAILABLE: 503, GPUQ_RECEIPT_UNAVAILABLE: 503,
      NATIVE_OUTCOME_UNCONFIRMED: 503, NATIVE_OPERATION_REJECTED: 503, NATIVE_DISPATCH_RECEIPT_MISMATCH: 503},
  });
}
