import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {SqliteTaskAuthority} from '../src/infrastructure/sqlite/task-authority.mjs';
import {ValidateTrainingResources} from '../src/application/validate-training-resources.mjs';
import {GpuqPolicy} from '../src/infrastructure/gpuq-policy.mjs';
import {ReserveTaskExpansion} from '../src/application/reserve-task-expansion.mjs';
import {ReconcileTaskExpansion} from '../src/application/reconcile-task-expansion.mjs';
import {createNodeDispatchBindingsSchema, SqliteNodeDispatchBindings} from '../src/infrastructure/sqlite/node-dispatch-bindings.mjs';
import {createNodeExpansionBindingsSchema, SqliteNodeExpansionBindings} from '../src/infrastructure/sqlite/node-expansion-bindings.mjs';
import {LookupNodeExpansion} from '../src/application/lookup-node-expansion.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await computeFixture(t); f.ready(); createTrainingQueueSchema(f.database); createTrainingDispatchSchema(f.database);
  const queue = new SqliteTrainingQueue({database: f.database}), dispatches = new SqliteTrainingDispatches({database: f.database});
  function addJob(gpuCount = 2, accepted = true) {
    const input = trainingSubmission();
    input.resources = {...input.resources, maxGpus: 8, autoScaleUp: true, batch: {globalBatchSize: 64, microBatchSize: 4}};
    input.scheduling = {...input.scheduling, checkpoint: 'epoch-v1', restart: 'on-preempt', yieldPolicy: 'save'};
    const jobId = queue.enqueue(f.actor, input, f.now).request.jobId;
    dispatches.prepareForTask(jobId, {machineId: 'node-1', gpuCount}, f.now);
    if (accepted) {
      const permit = dispatches.beginSend(jobId, f.now);
      dispatches.recordSendOutcome({dispatchId: permit.dispatch.dispatchId, senderToken: permit.senderToken, nodeJobId: 'J' + randomUUID().replaceAll('-', '')});
    }
    return jobId;
  }
  const app = new ReserveTaskExpansion({authority: new SqliteTaskAuthority({database: f.database}), claims: f.claims,
    validator: new ValidateTrainingResources({policy: new GpuqPolicy({python: process.env.V2_PYTHON || 'python3'})})});
  return {...f, app, addJob, dispatches};
}

async function completionFixture(t) {
  const f = await fixture(t), jobId = f.addJob();
  const change = {changeId: randomUUID(), fromReservedGpuCount: 2, sourceGpuCount: 2, targetGpuCount: 4};
  await f.app.execute(jobId, change);
  const observed = {...f.claims.expansion(change.changeId), planId: 'S' + randomUUID(), sourceAttemptId: 'A-source',
    successorAttemptId: 'A-successor', planState: 'COMPLETED', planVersion: 4,
    sourceAttemptState: 'PREEMPTED', successorAttemptState: 'RUNNING', planReservedGpuCount: 0,
    jobReservedGpuCount: 0, jobLeasedGpuCount: 4};
  return {...f, jobId, change, observed};
}

test('matched completed expansion becomes applied without refund and permits the next quota proposal', async t => {
  const f = await completionFixture(t);
  const result = f.claims.confirmExpansionApplied(f.observed);
  assert.equal(result.state, 'APPLIED');
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 4);
  f.database.exec('UPDATE v2_compute_policies SET total_cards=8; UPDATE v2_machine_grants SET max_cards=8');
  await f.app.execute(f.jobId, {changeId: randomUUID(), fromReservedGpuCount: 4, sourceGpuCount: 4, targetGpuCount: 8});
  assert.deepEqual(f.claims.confirmExpansionApplied(f.observed), result);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 8);
  assert.equal(f.dispatches.getForTask(f.jobId).gpuCount, 2);
});

test('identity mismatches or incomplete success cannot settle an expansion', async t => {
  const f = await completionFixture(t);
  for (const change of [{jobId: randomUUID()}, {dispatchId: randomUUID()}, {nodeJobId: 'Jother'}, {accountId: 'other'},
    {machineId: 'other'}, {requestHash: '0'.repeat(64)}, {fromReservedGpuCount: 1, sourceGpuCount: 1}, {targetGpuCount: 8}]) {
    assert.throws(() => f.claims.confirmExpansionApplied({...f.observed, ...change}), hasCode('EXPANSION_OBSERVATION_MISMATCH'));
  }
  for (const change of [{planState: 'FAILED'}, {successorAttemptId: null}, {planVersion: -1}]) {
    assert.throws(() => f.claims.confirmExpansionApplied({...f.observed, ...change}), hasCode('EXPANSION_NOT_CONFIRMED'));
  }
  assert.equal(f.claims.expansion(f.change.changeId).state, 'RESERVED');
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 4);
});

test('completion proof cannot be rebound to a different plan or attempt', async t => {
  const f = await completionFixture(t); f.claims.confirmExpansionApplied(f.observed);
  for (const change of [{planId: 'S-other'}, {sourceAttemptId: 'A-other'}, {successorAttemptId: 'A-other'}]) {
    assert.throws(() => f.claims.confirmExpansionApplied({...f.observed, ...change}), hasCode('COMPUTE_EXPANSION_CONFLICT'));
  }
});

test('late applied evidence can be recorded after account disable without authorizing new expansion', async t => {
  const f = await completionFixture(t); f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  assert.equal(f.claims.confirmExpansionApplied(f.observed).state, 'APPLIED');
  await assert.rejects(f.app.execute(f.jobId, {changeId: randomUUID(), fromReservedGpuCount: 4, sourceGpuCount: 4, targetGpuCount: 8}), hasCode('TASK_NOT_AUTHORIZED'));
});

test('reconciliation keeps failed or absent plans unconfirmed and never refunds their extra quota', async t => {
  const f = await completionFixture(t); let reply = null;
  const nodes = {async lookup(reference) {
    assert.deepEqual(reference, {machineId: 'node-1', changeId: f.change.changeId}); return reply;
  }};
  const app = new ReconcileTaskExpansion({claims: f.claims, nodes});
  assert.equal((await app.execute(f.change.changeId)).kind, 'unconfirmed');
  reply = {...f.observed, planState: 'FAILED', jobLeasedGpuCount: 4};
  assert.equal((await app.execute(f.change.changeId)).kind, 'unconfirmed');
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 4);
  reply = f.observed;
  const result = await app.execute(f.change.changeId);
  assert.equal(result.kind, 'applied');
  nodes.lookup = async () => {assert.fail('Applied expansion must not be queried again');};
  assert.deepEqual(await app.execute(f.change.changeId), result);
});

test('applied-state write failure preserves reservation and quota', async t => {
  const f = await completionFixture(t);
  f.database.exec("CREATE TRIGGER fail_apply BEFORE UPDATE ON v2_compute_expansions BEGIN SELECT RAISE(ABORT,'apply failure'); END");
  assert.throws(() => f.claims.confirmExpansionApplied(f.observed), /apply failure/);
  assert.equal(f.claims.expansion(f.change.changeId).state, 'RESERVED');
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 4);
});

test('coordinator confirms the exact expansion through the independent node binding projection', async t => {
  const f = await completionFixture(t), db = new DatabaseSync(':memory:'); t.after(() => db.close());
  createNodeDispatchBindingsSchema(db); createNodeExpansionBindingsSchema(db);
  const dispatch = {dispatchId: f.observed.dispatchId, jobId: f.jobId, accountId: 'alice', machineId: 'node-1', gpuCount: 2,
    nativeMaxGpus: 8, requestHash: f.observed.requestHash, nativeDigest: 'b'.repeat(64), nativeOwner: 'runtime-alice', nativeName: 'training'};
  new SqliteNodeDispatchBindings({database: db, machineId: 'node-1'}).bind(dispatch);
  const bindings = new SqliteNodeExpansionBindings({database: db, machineId: 'node-1'});
  bindings.bind({changeId: f.change.changeId, dispatchId: dispatch.dispatchId, planId: f.observed.planId,
    sourceAttemptId: f.observed.sourceAttemptId, fromReservedGpuCount: 2, sourceGpuCount: 2, targetGpuCount: 4});
  const lookup = new LookupNodeExpansion({bindings, native: {async lookupScale() {
    return {job_id: f.observed.nodeJobId, submit_key: dispatch.dispatchId, submit_digest: dispatch.nativeDigest,
      plan_id: f.observed.planId, plan_state: 'COMPLETED', plan_version: 4, from_gpu_count: 2, target_gpu_count: 4,
      source_attempt_id: f.observed.sourceAttemptId, successor_attempt_id: f.observed.successorAttemptId,
      source_attempt_state: 'PREEMPTED', successor_attempt_state: 'RUNNING', plan_reserved_gpu_count: 0,
      job_reserved_gpu_count: 0, job_leased_gpu_count: 4};
  }}});
  const app = new ReconcileTaskExpansion({claims: f.claims, nodes: {lookup: reference => lookup.execute(reference)}});
  assert.equal((await app.execute(f.change.changeId)).kind, 'applied');
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 4);
});

test('expansion reserves only the extra quota and never rewrites the immutable initial dispatch count', async t => {
  const f = await fixture(t), jobId = f.addJob(), original = f.dispatches.getForTask(jobId);
  const change = {changeId: randomUUID(), fromReservedGpuCount: 2, sourceGpuCount: 2, targetGpuCount: 4};
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  const result = await f.app.execute(jobId, change);
  assert.equal(result.state, 'RESERVED');
  assert.deepEqual(await f.app.execute(jobId, change), result);
  assert.equal(f.claims.balancesForTask(jobId, ['node-1'])[0].heldTotal, 4);
  assert.deepEqual(f.dispatches.getForTask(jobId), original);
  const row = f.database.prepare('SELECT gpu_count,reserved_gpu_count FROM v2_compute_claims WHERE job_id=?').get(jobId);
  assert.equal(row.gpu_count, 2); assert.equal(row.reserved_gpu_count, 4);
  await assert.rejects(f.app.execute(jobId, {changeId: randomUUID(), fromReservedGpuCount: 4, sourceGpuCount: 4, targetGpuCount: 8}), hasCode('COMPUTE_EXPANSION_PENDING'));
});

test('native legal-count rules reject fractional batch accumulation before any quota write', async t => {
  const f = await fixture(t), jobId = f.addJob();
  await assert.rejects(f.app.execute(jobId, {changeId: randomUUID(), fromReservedGpuCount: 2, sourceGpuCount: 2, targetGpuCount: 3}), hasCode('INVALID_COMPUTE_EXPANSION'));
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_expansions').get().n, 0);
});

test('physical source size may be below reserved quota: expansion charges only the quota delta', async t => {
  const f = await fixture(t), jobId = f.addJob();
  const change = {changeId: randomUUID(), fromReservedGpuCount: 2, sourceGpuCount: 1, targetGpuCount: 4};
  const result = await f.app.execute(jobId, change);
  assert.equal(result.fromReservedGpuCount, 2); assert.equal(result.sourceGpuCount, 1);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 4);
  assert.deepEqual(await f.app.execute(jobId, change), result);
  await assert.rejects(f.app.execute(jobId, {...change, sourceGpuCount: 2}), hasCode('COMPUTE_EXPANSION_CONFLICT'));
});

test('missing or over-reservation physical source counts are rejected without guessing', async t => {
  const f = await fixture(t), jobId = f.addJob();
  for (const sourceGpuCount of [undefined, 0, 4]) {
    await assert.rejects(f.app.execute(jobId, {changeId: randomUUID(), fromReservedGpuCount: 2, sourceGpuCount, targetGpuCount: 4}), hasCode('INVALID_COMPUTE_EXPANSION'));
  }
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_expansions').get().n, 0);
});

test('quota exhaustion, stale base count and unaccepted dispatch prevent expansion grants', async t => {
  const f = await fixture(t), jobId = f.addJob();
  await assert.rejects(f.app.execute(jobId, {changeId: randomUUID(), fromReservedGpuCount: 1, sourceGpuCount: 1, targetGpuCount: 4}), hasCode('COMPUTE_CLAIM_CHANGED'));
  f.addJob();
  await assert.rejects(f.app.execute(jobId, {changeId: randomUUID(), fromReservedGpuCount: 2, sourceGpuCount: 2, targetGpuCount: 4}), hasCode('COMPUTE_QUOTA_EXCEEDED'));
  const g = await fixture(t), pending = g.addJob(2, false);
  await assert.rejects(g.app.execute(pending, {changeId: randomUUID(), fromReservedGpuCount: 2, sourceGpuCount: 2, targetGpuCount: 4}), hasCode('TRAINING_DISPATCH_NOT_ACCEPTED'));
});

test('failed quota update rolls back the expansion journal and original held count', async t => {
  const f = await fixture(t), jobId = f.addJob();
  f.database.exec("CREATE TRIGGER fail_expand BEFORE UPDATE ON v2_compute_claims BEGIN SELECT RAISE(ABORT,'expansion failure'); END");
  await assert.rejects(f.app.execute(jobId, {changeId: randomUUID(), fromReservedGpuCount: 2, sourceGpuCount: 2, targetGpuCount: 4}), /expansion failure/);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_expansions').get().n, 0);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
});

test('an expansion identifier cannot be reused for another job and new grants obey current permissions', async t => {
  const f = await fixture(t), jobs = [f.addJob(1), f.addJob(1)];
  const change = {changeId: randomUUID(), fromReservedGpuCount: 1, sourceGpuCount: 1, targetGpuCount: 2};
  await f.app.execute(jobs[0], change);
  await assert.rejects(f.app.execute(jobs[1], change), hasCode('COMPUTE_EXPANSION_CONFLICT'));
  f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  await assert.rejects(f.app.execute(jobs[1], {...change, changeId: randomUUID()}), hasCode('FORBIDDEN'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_expansions').get().n, 1);
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  await assert.rejects(f.app.execute(jobs[1], {...change, changeId: randomUUID()}), hasCode('TASK_NOT_AUTHORIZED'));
});

test('independent expansion writers cannot both reserve the last shared account credit', async t => {
  const f = await fixture(t), jobs = [f.addJob(1), f.addJob(1)];
  f.database.exec('UPDATE v2_compute_policies SET total_cards=3');
  const path = f.database.prepare('PRAGMA database_list').get().file;
  const moduleUrl = new URL('../src/infrastructure/sqlite/compute-claims.mjs', import.meta.url).href;
  const code = `
    import {DatabaseSync} from 'node:sqlite'; import {readFileSync} from 'node:fs';
    const {SqliteComputeClaims} = await import(process.argv[1]);
    const value = JSON.parse(readFileSync(0,'utf8')), db = new DatabaseSync(value.path);
    db.exec('PRAGMA busy_timeout=5000');
    try { console.log(JSON.stringify(new SqliteComputeClaims({database:db}).reserveExpansionForTask(value.jobId,value.change,value.now))); }
    catch (error) { console.log(JSON.stringify({error:error.code})); }
    finally { db.close(); }
  `;
  const run = promisify(execFile);
  const results = await Promise.all(jobs.map(async jobId => {
    const child = run(process.execPath, ['--input-type=module', '-e', code, moduleUrl]);
    child.child.stdin.end(JSON.stringify({path, jobId, now: f.now, change: {changeId: randomUUID(), fromReservedGpuCount: 1, sourceGpuCount: 1, targetGpuCount: 2}}));
    return JSON.parse((await child).stdout);
  }));
  assert.equal(results.filter(row => row.state === 'RESERVED').length, 1);
  assert.equal(results.filter(row => row.error === 'COMPUTE_QUOTA_EXCEEDED').length, 1);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 3);
});
