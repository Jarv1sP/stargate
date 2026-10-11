import {computeFixture} from './v2-compute-fixture.mjs';
import {trainingSubmission} from './v2-training-submission.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../../src/infrastructure/sqlite/training-queue.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../../src/infrastructure/sqlite/training-dispatches.mjs';

export async function dispatchFixture(t, {submission = trainingSubmission()} = {}) {
  const f = await computeFixture(t); f.ready(); createTrainingQueueSchema(f.database); createTrainingDispatchSchema(f.database);
  const queue = new SqliteTrainingQueue({database: f.database});
  const jobId = queue.enqueue(f.actor, submission, f.now).request.jobId;
  const dispatches = new SqliteTrainingDispatches({database: f.database});
  const prepared = dispatches.prepareForTask(jobId, {machineId: 'node-1', gpuCount: 2}, f.now);
  return {...f, queue, jobId, dispatches, prepared};
}
