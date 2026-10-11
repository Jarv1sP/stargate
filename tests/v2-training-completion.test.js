import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {createTrainingCompletionsSchema, SqliteTrainingCompletions} from '../src/infrastructure/sqlite/training-completions.mjs';
import {SqliteTaskReads} from '../src/infrastructure/sqlite/task-reads.mjs';
import {SqliteDispatchWork} from '../src/infrastructure/sqlite/dispatch-work.mjs';
import {FinalizeTrainingDispatch} from '../src/application/finalize-training-dispatch.mjs';
import {ReadTrainingTask} from '../src/application/read-training-task.mjs';
import {parseTaskReadResult} from '../src/contracts/task-read.mjs';
import {parseNodeCompletion} from '../src/contracts/node-completion.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';

const code = expected => error => error.code === expected;
async function fixture(t) {
  const f = await computeFixture(t); f.ready();
  createTrainingQueueSchema(f.database); createTrainingDispatchSchema(f.database);
  const queue = new SqliteTrainingQueue({database: f.database}), dispatches = new SqliteTrainingDispatches({database: f.database});
  const jobId = queue.enqueue(f.actor, trainingSubmission(), f.now).request.jobId;
  const {dispatchId} = dispatches.prepareForTask(jobId, {machineId: 'node-1', gpuCount: 2}, f.now);
  const permit = dispatches.beginSend(jobId, f.now);
  dispatches.recordSendOutcome({dispatchId, senderToken: permit.senderToken, nodeJobId: 'J0123456789ab'});
  const d = dispatches.delivery(dispatchId);
  const completion = {receipt: Object.fromEntries(['dispatchId', 'jobId', 'accountId', 'machineId', 'gpuCount', 'requestHash', 'nodeJobId']
    .map(key => [key, d[key]])), state: 'SUCCEEDED', nativeVersion: 6, finishedAtSeconds: 20, sealedAtSeconds: 21, dataReleased: true};
  const completions = new SqliteTrainingCompletions({database: f.database});
  let nodeReceipt = null;
  const calls = [], nodes = {
    async lookup() {calls.push('lookup'); return nodeReceipt;},
    async finalize() {calls.push('finalize'); nodeReceipt = structuredClone(completion); return nodeReceipt;},
  };
  const observations = {async observe() {calls.push('observe'); return {receipt: completion.receipt, state: completion.state};}};
  const app = () => new FinalizeTrainingDispatch({dispatches, completions, nodes, observations, clock: () => f.now});
  return {...f, jobId, dispatchId, queue, dispatches, completion, completions, calls, nodes, observations, app};
}

test('completion atomically releases quota, retires background work and appears in the shared read contract', async t => {
  const f = await fixture(t), read = new SqliteTaskReads({database: f.database});
  const payload = f.database.prepare('SELECT payload_json FROM v2_training_requests WHERE job_id=?').get(f.jobId).payload_json;
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).remainingGpus, 2);
  const result = await f.app().execute(f.dispatchId);
  assert.equal(result.kind, 'completed');
  assert.deepEqual(f.calls, ['lookup', 'observe', 'finalize']);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).remainingGpus, 4);
  assert.equal(f.claims.get(f.actor, f.jobId, f.now).state, 'RELEASED');
  assert.equal(f.queue.get(f.actor, f.jobId, f.now).state, 'SUCCEEDED');
  assert.deepEqual(new SqliteDispatchWork({database: f.database}).pending({limit: 10, after: null}), []);
  assert.equal(f.database.prepare('SELECT payload_json FROM v2_training_requests WHERE job_id=?').get(f.jobId).payload_json, payload);
  const reader = new ReadTrainingTask({tasks: read, nodes: {async observe() {throw new ApplicationError('NODE_JOB_UNAVAILABLE');}}, clock: () => f.now});
  f.database.exec('PRAGMA query_only=ON');
  const view = parseTaskReadResult(await reader.execute(f.actor, {jobId: f.jobId}));
  assert.equal(view.task.stage, 'SUCCEEDED'); assert.equal(view.task.dispatch.state, 'ACCEPTED');
  assert.equal(view.observation.kind, 'unavailable');
  assert.deepEqual(await f.app().execute(f.dispatchId), result);
  assert.deepEqual(f.calls, ['lookup', 'observe', 'finalize']);
});

test('pending, lost, and absent observations keep quota and never call finalization', async t => {
  const f = await fixture(t);
  for (const state of ['PENDING', 'RUNNING', 'PREEMPTING', 'LOST', null]) {
    f.observations.observe = async () => state === null ? null : {receipt: f.completion.receipt, state};
    const result = await f.app().execute(f.dispatchId);
    assert.equal(result.kind, state === null || state === 'LOST' ? 'unconfirmed' : 'active');
    assert.equal(f.completions.get(f.dispatchId), null);
    assert.equal(f.claims.get(f.actor, f.jobId, f.now).state, 'HELD');
  }
  assert.equal(f.calls.includes('finalize'), false);
});

test('a lost finalization reply is recovered by the original node receipt without another write', async t => {
  const f = await fixture(t), finalize = f.nodes.finalize;
  f.nodes.finalize = async () => {await finalize(); throw new ApplicationError('NODE_COMPLETION_UNCONFIRMED');};
  await assert.rejects(f.app().execute(f.dispatchId), code('NODE_COMPLETION_UNCONFIRMED'));
  assert.equal(f.claims.get(f.actor, f.jobId, f.now).state, 'HELD');
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  const result = await f.app().execute(f.dispatchId);
  assert.equal(result.kind, 'completed');
  assert.deepEqual(f.calls, ['lookup', 'observe', 'finalize', 'lookup']);
  assert.equal(f.database.prepare('SELECT state FROM v2_compute_claims WHERE job_id=?').get(f.jobId).state, 'RELEASED');
});

test('foreign task/node/account/receipt evidence is rejected before cleanup and settlement', async t => {
  const f = await fixture(t);
  for (const change of [{dispatchId: randomUUID()}, {jobId: randomUUID()}, {accountId: 'bob'}, {machineId: 'node-2'},
    {gpuCount: 1}, {requestHash: 'f'.repeat(64)}, {nodeJobId: 'Jdifferent'}]) {
    const receipt = {...f.completion.receipt, ...change};
    f.observations.observe = async () => ({receipt, state: 'SUCCEEDED'});
    await assert.rejects(f.app().execute(f.dispatchId), code('TRAINING_COMPLETION_MISMATCH'));
    assert.throws(() => f.completions.settle({...f.completion, receipt}, f.now), error =>
      ['TRAINING_COMPLETION_MISMATCH', 'TRAINING_DISPATCH_NOT_ACCEPTED'].includes(error.code));
  }
  assert.equal(f.calls.includes('finalize'), false);
  assert.equal(f.completions.get(f.dispatchId), null);
  assert.equal(f.claims.get(f.actor, f.jobId, f.now).state, 'HELD');
});

test('a failed quota write rolls back terminal history and expansion closure; retry settles exactly once', async t => {
  const f = await fixture(t), changeId = randomUUID();
  f.database.prepare("INSERT INTO v2_compute_expansions VALUES(?,?,?,?,?,'RESERVED',?,NULL)").run(changeId, f.jobId, 2, 2, 3, f.now);
  f.database.prepare('UPDATE v2_compute_claims SET reserved_gpu_count=3 WHERE job_id=?').run(f.jobId);
  f.database.exec("CREATE TEMP TRIGGER fail_release BEFORE UPDATE ON v2_compute_claims BEGIN SELECT RAISE(ABORT,'fixture settlement failure'); END");
  await assert.rejects(f.app().execute(f.dispatchId), /fixture settlement failure/);
  assert.equal(f.completions.get(f.dispatchId), null);
  assert.equal(f.claims.expansion(changeId).state, 'RESERVED');
  assert.equal(f.claims.get(f.actor, f.jobId, f.now).state, 'HELD');
  f.database.exec('DROP TRIGGER fail_release');
  const first = (await f.app().execute(f.dispatchId)).completion;
  assert.equal(f.claims.expansion(changeId).state, 'RELEASED');
  assert.throws(() => f.claims.confirmExpansionApplied({...f.claims.expansion(changeId), planState: 'COMPLETED',
    planId: 'plan-1', sourceAttemptId: 'A-old', successorAttemptId: 'A-new', planVersion: 1}), code('COMPUTE_CLAIM_CHANGED'));
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).remainingGpus, 4);
  const reordered = Object.fromEntries(Object.entries(f.completion).reverse());
  assert.deepEqual(f.completions.settle(reordered, f.now + 9999), first);
  assert.throws(() => f.completions.settle({...f.completion, state: 'FAILED'}, f.now), code('TRAINING_COMPLETION_CONFLICT'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_completions').get().n, 1);
  assert.equal(f.calls.filter(x => x === 'finalize').length, 1);
});

test('failed/canceled outcomes remain distinct and an old database requires an explicit schema upgrade', async t => {
  const f = await fixture(t);
  f.database.exec('DROP TABLE v2_training_completions');
  assert.throws(() => f.completions.get(f.dispatchId), /no such table/);
  createTrainingCompletionsSchema(f.database);
  f.completion.state = 'FAILED';
  assert.equal((await f.app().execute(f.dispatchId)).completion.state, 'FAILED');
  assert.equal(new SqliteTaskReads({database: f.database}).snapshot(f.actor, f.jobId, f.now).task.stage, 'FAILED');
  assert.throws(() => parseNodeCompletion({...f.completion, dataReleased: false}));
  assert.throws(() => parseNodeCompletion({...f.completion, state: 'LOST'}));
  assert.throws(() => parseNodeCompletion({...f.completion, hostPath: '/not-on-wire'}));
});
