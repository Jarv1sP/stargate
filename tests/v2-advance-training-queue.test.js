import test from 'node:test';
import assert from 'node:assert/strict';
import {rename, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {PrepareTaskDispatch} from '../src/application/prepare-task-dispatch.mjs';
import {AdvanceTrainingQueue} from '../src/application/advance-training-queue.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';
import {assembleTrainingQueue} from '../src/bootstrap/training-queue.mjs';
import {projectFixture, python} from './helpers/v2-project-fixture.mjs';
import {createTrainingCatalogSchema} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {createProjectRegistrationSchema, SqliteProjectRegistrations} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {RegisterProjectRelease} from '../src/application/register-project-release.mjs';
import {LocalSourceReader} from '../src/infrastructure/local-source-reader.mjs';
import {SqliteSourceCatalog} from '../src/infrastructure/sqlite/data-read-repositories.mjs';

async function fixture(t, priorities) {
  const f = await computeFixture(t); f.ready(); createTrainingQueueSchema(f.database); createTrainingDispatchSchema(f.database);
  const queue = new SqliteTrainingQueue({database: f.database}), dispatches = new SqliteTrainingDispatches({database: f.database});
  const jobs = priorities.map(priority => {
    const input = trainingSubmission(); input.scheduling.priority = priority;
    return queue.enqueue(f.actor, input, f.now).request.jobId;
  });
  const calls = [], behavior = new Map();
  const observer = {async execute(jobId) {
    calls.push(jobId);
    if (behavior.get(jobId) instanceof Error) throw behavior.get(jobId);
    return {candidates: behavior.get(jobId) === 'waiting' ? [] : [{machineId: 'node-1', quotaFit: {exclusiveFreeFitGpuCount: 1}}]};
  }};
  const prepare = new PrepareTaskDispatch({observer, dispatches});
  return {...f, queue, dispatches, jobs, calls, behavior, app: new AdvanceTrainingQueue({queue, prepare})};
}

test('priority order advances ready tasks without a waiting head blocking lower-priority work', async t => {
  const f = await fixture(t, [0, 4, 2]);
  f.behavior.set(f.jobs[1], 'waiting');
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  const result = await f.app.execute();
  assert.deepEqual(f.calls, [f.jobs[1], f.jobs[2], f.jobs[0]]);
  assert.deepEqual(result.outcomes.map(row => row.kind), ['waiting', 'prepared', 'prepared']);
  assert.equal(result.nextCursor, null);
  assert.equal(f.claims.balancesForTask(f.jobs[1], ['node-1'])[0].heldTotal, 2);
  assert.deepEqual(f.queue.pending().map(row => row.jobId), [f.jobs[1]]);
  assert.equal((await f.app.execute()).outcomes.length, 1);
});

test('queue page cursors continue to lower priorities even if a waiting job stays at the head', async t => {
  const f = await fixture(t, [4, 4, 2, 0]);
  f.behavior.set(f.jobs[0], 'waiting');
  const first = await f.app.execute({limit: 2});
  assert.equal(first.outcomes.length, 2); assert.ok(first.nextCursor);
  const second = await f.app.execute({limit: 2, after: first.nextCursor});
  assert.deepEqual(second.outcomes.map(row => row.jobId), f.jobs.slice(2));
  const end = await f.app.execute({limit: 2, after: second.nextCursor});
  assert.deepEqual(end, {outcomes: [], nextCursor: null});
  assert.deepEqual(f.queue.pending().map(row => row.jobId), [f.jobs[0]]);
});

test('a task-local rejection does not block another task and does not silently cancel the rejected one', async t => {
  const f = await fixture(t, [4, 2]);
  f.behavior.set(f.jobs[0], new ApplicationError('PROJECT_ARCHIVED'));
  const result = await f.app.execute();
  assert.deepEqual(result.outcomes[0], {jobId: f.jobs[0], kind: 'unavailable', reason: 'PROJECT_ARCHIVED'});
  assert.equal(result.outcomes[1].kind, 'prepared');
  assert.deepEqual(f.queue.pending().map(row => row.jobId), [f.jobs[0]]);
});

test('accounting outage and unexpected implementation errors stop the pass without fabricating outcomes', async t => {
  const f = await fixture(t, [4, 2]);
  f.database.exec('UPDATE v2_compute_accounting SET ready=0');
  await assert.rejects(f.app.execute(), error => error.code === 'COMPUTE_ACCOUNTING_UNREADY');
  assert.deepEqual(f.calls, [f.jobs[0]]);
  f.ready(); f.calls.length = 0;
  f.behavior.set(f.jobs[0], new Error('unexpected failure'));
  await assert.rejects(f.app.execute(), /unexpected failure/);
  assert.deepEqual(f.calls, [f.jobs[0]]);
  assert.equal(f.queue.pending().length, 2);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 0);
});

test('overlapping queue passes recover one dispatch per job instead of double charging', async t => {
  const f = await fixture(t, [4, 2]);
  const results = await Promise.all([f.app.execute(), f.app.execute()]);
  assert.ok(results.every(result => result.outcomes.every(row => row.kind === 'prepared')));
  for (const jobId of f.jobs) {
    assert.equal(results[0].outcomes.find(row => row.jobId === jobId).dispatch.dispatchId,
      results[1].outcomes.find(row => row.jobId === jobId).dispatch.dispatchId);
  }
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_dispatches').get().n, 2);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
});

test('assembled queue waits for the original directory and prepares the same task after recovery and logout', async t => {
  const f = await fixture(t, []), project = await projectFixture(t);
  createTrainingCatalogSchema(f.database); createProjectRegistrationSchema(f.database);
  await new RegisterProjectRelease({registrations: new SqliteProjectRegistrations({database: f.database}), projects: project.reader})
    .execute(f.actor, {...project.request, projectId: 'project-1'});
  const input = trainingSubmission(); input.project.release = project.release;
  input.dataSources = [{kind: 'directory', sourceId: 'images'}];
  const jobId = f.queue.enqueue(f.actor, input, f.now).request.jobId;
  const originalRequest = f.database.prepare('SELECT * FROM v2_training_requests WHERE job_id=?').get(jobId);
  const {host_path: source} = f.database.prepare("SELECT host_path FROM v2_source_bindings WHERE resource_id='images'").get();
  const sample = join(source, 'sample.bin');
  await writeFile(sample, 'existing training data');
  const before = await stat(sample);
  const app = assembleTrainingQueue({database: f.database, projects: project.reader, python,
    sources: new LocalSourceReader({machineId: 'node-1', catalog: new SqliteSourceCatalog({database: f.database})}),
    pools: {async inspect() {return {machineId: 'node-1', gpuUuids: ['GPU-a', 'GPU-b'], freeGpuUuids: ['GPU-a', 'GPU-b'], dispatchEnabled: true};}}});
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  await rename(source, source + '-offline');
  for (let pass = 0; pass < 2; pass++) {
    const waiting = await app.execute();
    assert.deepEqual(waiting.outcomes, [{jobId, kind: 'waiting', reason: 'no-current-exclusive-fit'}]);
    assert.deepEqual(f.queue.pending().map(row => row.jobId), [jobId]);
    assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_dispatches').get().n, 0);
    assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_claims').get().n, 0);
    await assert.rejects(stat(source), {code: 'ENOENT'});
  }
  await rename(source + '-offline', source);
  const result = await app.execute();
  assert.equal(result.outcomes.length, 1); assert.equal(result.outcomes[0].jobId, jobId);
  assert.equal(result.outcomes[0].kind, 'prepared'); assert.equal(result.outcomes[0].dispatch.gpuCount, 2);
  assert.deepEqual(f.queue.pending(), []);
  assert.equal(f.claims.balancesForTask(jobId, ['node-1'])[0].heldTotal, 2);
  assert.deepEqual(await app.execute(), {outcomes: [], nextCursor: null});
  assert.deepEqual(f.database.prepare('SELECT * FROM v2_training_requests WHERE job_id=?').get(jobId), originalRequest);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_requests').get().n, 1);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_dispatches').get().n, 1);
  const after = await stat(sample);
  assert.deepEqual([after.ino, after.mtimeMs, after.size], [before.ino, before.mtimeMs, before.size]);
});
