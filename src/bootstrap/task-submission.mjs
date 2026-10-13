import {SubmitTrainingTask} from '../application/submit-training-task.mjs';
import {ValidateTrainingResources} from '../application/validate-training-resources.mjs';
import {AuthenticateSession} from '../application/authenticate-session.mjs';
import {SqliteTrainingQueue} from '../infrastructure/sqlite/training-queue.mjs';
import {SqliteTrainingCatalog} from '../infrastructure/sqlite/training-catalog.mjs';
import {SqliteSessionReader} from '../infrastructure/sqlite/session-reader.mjs';
import {GpuqPolicy} from '../infrastructure/gpuq-policy.mjs';
import {createSessionAuthenticator} from '../api/session-authenticator.mjs';
import {createTaskSubmissionHandler} from '../api/task-submission-handler.mjs';

export function assembleTaskSubmission({database, publicOrigin, python, clock = Date.now, reportError}) {
  const queue = new SqliteTrainingQueue({database});
  const authenticateSession = new AuthenticateSession({sessions: new SqliteSessionReader({database}), clock});
  return createTaskSubmissionHandler({authenticate: createSessionAuthenticator({authenticateSession, publicOrigin}), reportError,
    submit: new SubmitTrainingTask({queue, clock, catalog: new SqliteTrainingCatalog({database}),
      resources: new ValidateTrainingResources({policy: new GpuqPolicy({python})})}),
    lookup: {execute: (actor, {requestId}) => queue.request(actor, requestId, clock())}});
}
