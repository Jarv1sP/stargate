import {SqliteLaunchAuthorization} from '../infrastructure/sqlite/launch-authorization.mjs';
import {SqliteTrainingDispatches} from '../infrastructure/sqlite/training-dispatches.mjs';
import {SqliteNodeDispatchBindings} from '../infrastructure/sqlite/node-dispatch-bindings.mjs';
import {GpuqReceiptReader} from '../infrastructure/gpuq-receipt-reader.mjs';
import {GpuqManagedClient} from '../infrastructure/gpuq-managed-client.mjs';
import {HttpLaunchAuthorization} from '../infrastructure/http-launch-authorization.mjs';
import {HttpNodeSubmissions} from '../infrastructure/http-node-submissions.mjs';
import {LookupNodeDispatch} from '../application/lookup-node-dispatch.mjs';
import {SubmitNodeDispatch} from '../application/submit-node-dispatch.mjs';
import {SendTrainingDispatch} from '../application/send-training-dispatch.mjs';
import {createLaunchAuthorizationHandler} from '../api/launch-authorization-handler.mjs';
import {createNodeSubmissionHandler} from '../api/node-submission-handler.mjs';

export function assembleLaunchAuthorization({database, peers, reportError}) {
  return createLaunchAuthorizationHandler({peers, authorization: new SqliteLaunchAuthorization({database}), reportError});
}

export function assembleNodeSubmission({database, machineId, credential, coordinator, socketPath, python, timeoutMs, reportError}) {
  const bindings = new SqliteNodeDispatchBindings({database, machineId});
  const receipts = new LookupNodeDispatch({bindings, native: new GpuqReceiptReader({socketPath, python, timeoutMs})});
  const submit = new SubmitNodeDispatch({bindings, receipts,
    admission: new HttpLaunchAuthorization({...coordinator, machineId}), native: new GpuqManagedClient({socketPath, python, timeoutMs})});
  return createNodeSubmissionHandler({machineId, credential, submit, reportError});
}

export function assembleTrainingSender({database, nodes, clock, ...transportOptions}) {
  return new SendTrainingDispatch({dispatches: new SqliteTrainingDispatches({database}),
    nodes: new HttpNodeSubmissions({...transportOptions, nodes}), clock});
}
