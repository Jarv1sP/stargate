import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createNodeDispatchBindingsSchema, SqliteNodeDispatchBindings} from '../src/infrastructure/sqlite/node-dispatch-bindings.mjs';
import {LookupNodeDispatch} from '../src/application/lookup-node-dispatch.mjs';
import {SubmitNodeDispatch} from '../src/application/submit-node-dispatch.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';

const hasCode = code => error => error.code === code;
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); createNodeDispatchBindingsSchema(db);
  const bindings = new SqliteNodeDispatchBindings({database: db, machineId: 'node-1'});
  const binding = {dispatchId: randomUUID(), jobId: randomUUID(), accountId: 'alice', machineId: 'node-1', gpuCount: 2,
    nativeMaxGpus: 4, requestHash: 'a'.repeat(64), nativeDigest: 'b'.repeat(64), nativeOwner: 'runtime-alice', nativeName: 'training'};
  const submission = {submit_key: binding.dispatchId, owner: binding.nativeOwner, name: binding.nativeName, gpu_count: 4,
    argv: ['/approved/runner', 'literal'], env: {PRIVATE: 'fixture-only'}};
  const plan = {schema: 1, identity: {...binding}, project: {id: 'project-1', project: 'training', release: 'a'.repeat(64),
    projectUUID: randomUUID(), generation: 'b'.repeat(64)}, inputs: []};
  const planJson = JSON.stringify(plan), planDigest = createHash('sha256').update(planJson).digest('hex');
  submission.argv.push('--dispatch-id', binding.dispatchId, '--plan-digest', planDigest);
  bindings.prepareTraining({binding, built: {submission, nativeDigest: binding.nativeDigest}, planJson, planDigest});
  const nativeReceipt = {job_id: 'J0123456789ab', submit_key: binding.dispatchId, submit_digest: binding.nativeDigest,
    owner: binding.nativeOwner, name: binding.nativeName, gpu_count: 4};
  const calls = [], state = {receipt: null, submitError: null, lookupError: null};
  const reader = {async lookup() {if (state.lookupError) throw state.lookupError; return state.receipt;}};
  const native = {async submit(command) {
    calls.push(command);
    if (state.submitError) throw state.submitError;
    state.receipt = nativeReceipt;
    return {job_id: nativeReceipt.job_id};
  }};
  let approvals = 0;
  const admission = {async acquire({binding: value}) {approvals++; return {...value, scope: 'launch-ready', grantId: value.dispatchId};}};
  const app = new SubmitNodeDispatch({bindings, receipts: new LookupNodeDispatch({bindings, native: reader}), admission, native});
  return {db, bindings, binding, submission, nativeReceipt, calls, state, native, admission, app,
    approvals: () => approvals, reference: {machineId: 'node-1', dispatchId: binding.dispatchId}};
}

test('send uses only the stored private spec and fixed initial grant; accepted retry is read-only', async t => {
  const f = fixture(t), first = await f.app.execute(f.reference);
  assert.equal(first.kind, 'accepted'); assert.equal(first.receipt.gpuCount, 2);
  assert.deepEqual(f.calls, [{submission: f.submission, grantId: f.binding.dispatchId, maxGpus: 2, expectedDigest: f.binding.nativeDigest}]);
  assert.equal(f.calls[0].submission.gpu_count, 4);
  f.admission.acquire = async () => {assert.fail('Historical acceptance does not request new admission');};
  assert.deepEqual(await f.app.execute(f.reference), first);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(first).includes('fixture-only'), false);
});

test('admission rejection and mismatched approval cannot reach native submission', async t => {
  const f = fixture(t);
  f.admission.acquire = async () => {throw new ApplicationError('FORBIDDEN');};
  await assert.rejects(f.app.execute(f.reference), hasCode('FORBIDDEN'));
  f.admission.acquire = async ({binding: value}) => ({...value, scope: 'launch-ready', grantId: value.dispatchId, gpuCount: 4});
  await assert.rejects(f.app.execute(f.reference), hasCode('NODE_LAUNCH_NOT_AUTHORIZED'));
  assert.equal(f.calls.length, 0);
});

test('quota-only authorization is not enough to bypass project and data launch admission', async t => {
  const f = fixture(t);
  f.admission.acquire = async ({binding: value}) => ({...value, scope: 'initial-quota', grantId: value.dispatchId});
  await assert.rejects(f.app.execute(f.reference), hasCode('NODE_LAUNCH_NOT_AUTHORIZED'));
  assert.equal(f.calls.length, 0);
});

test('missing durable launch material is not reconstructed or submitted', async t => {
  const f = fixture(t); f.db.exec('DELETE FROM v2_node_runtime_plans; DELETE FROM v2_node_launch_specs');
  await assert.rejects(f.app.execute(f.reference), hasCode('NODE_LAUNCH_NOT_PREPARED'));
  assert.equal(f.approvals(), 0); assert.equal(f.calls.length, 0);
});

test('a bare native spec or a changed stored plan cannot bypass preparation', async t => {
  const f = fixture(t), original = f.db.prepare('SELECT * FROM v2_node_runtime_plans').get();
  f.db.exec('DELETE FROM v2_node_runtime_plans');
  assert.ok(f.bindings.launch(f.reference));
  await assert.rejects(f.app.execute(f.reference), hasCode('NODE_LAUNCH_NOT_PREPARED'));
  f.db.prepare('INSERT INTO v2_node_runtime_plans VALUES(?,?,?)')
    .run(original.dispatch_id, original.plan_json.replace('training', 'different'), original.plan_digest);
  await assert.rejects(f.app.execute(f.reference), hasCode('NODE_RUNTIME_PLAN_IDENTITY_MISMATCH'));
  assert.equal(f.approvals(), 0); assert.equal(f.calls.length, 0);
});

test('uncertain native submission is not retried; later original receipt recovers acceptance', async t => {
  const f = fixture(t); f.state.submitError = new ApplicationError('NATIVE_OUTCOME_UNCONFIRMED');
  await assert.rejects(f.app.execute(f.reference), hasCode('NATIVE_OUTCOME_UNCONFIRMED'));
  assert.equal(f.calls.length, 1);
  f.state.receipt = f.nativeReceipt;
  assert.equal((await f.app.execute(f.reference)).kind, 'accepted');
  assert.equal(f.calls.length, 1);
});

test('native success without matching durable evidence remains unconfirmed', async t => {
  const f = fixture(t);
  f.native.submit = async () => ({job_id: 'J0123456789ab'});
  assert.equal((await f.app.execute(f.reference)).kind, 'unconfirmed');
  f.native.submit = async () => {f.state.receipt = {...f.nativeReceipt, submit_digest: 'c'.repeat(64)}; return {job_id: 'J0123456789ab'};};
  await assert.rejects(f.app.execute(f.reference), hasCode('NATIVE_OUTCOME_UNCONFIRMED'));
});
