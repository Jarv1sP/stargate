import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {FinalizeNodeDispatch} from '../src/application/finalize-node-dispatch.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';
import {createNodeDispatchBindingsSchema} from '../src/infrastructure/sqlite/node-dispatch-bindings.mjs';
import {SqliteNodeCompletions, createNodeCompletionsSchema} from '../src/infrastructure/sqlite/node-completions.mjs';

const hasCode = code => error => error.code === code;
function fixture() {
  const binding = {dispatchId: randomUUID(), jobId: randomUUID(), accountId: 'alice', machineId: 'node-1', gpuCount: 1,
    nativeMaxGpus: 2, requestHash: 'a'.repeat(64), nativeDigest: 'b'.repeat(64), nativeOwner: 'alice', nativeName: 'fixed'};
  const reference = {machineId: binding.machineId, dispatchId: binding.dispatchId};
  const launch = {binding, planDigest: 'c'.repeat(64), plan: {inputs: [
    {source: {kind: 'directory', sourceId: 'raw'}},
    {source: {kind: 'cache', datasetId: 'images', version: 'd'.repeat(64)}, leaseId: randomUUID()},
    {source: {kind: 'warehouse', datasetId: 'images', version: 'd'.repeat(64)}, leaseId: randomUUID()},
  ]}};
  const receipt = {protocol: 'managed-completion-v1', job_id: 'J0123456789ab', submit_key: binding.dispatchId,
    submit_digest: binding.nativeDigest, grant_id: binding.dispatchId, grant_revision: 2, state: 'CANCELED',
    native_version: 3, finished_at: 20, sealed_at: 21, latest_attempt: null};
  const calls = [], state = {native: null, local: null};
  const bindings = {async training() {calls.push('plan'); return structuredClone(launch);}};
  const native = {async completion(input) {assert.equal(input.submitKey, binding.dispatchId); calls.push('native-read'); return state.native;},
    async complete(input) {
      assert.deepEqual(input, {submitKey: binding.dispatchId, grantId: binding.dispatchId, expectedDigest: binding.nativeDigest});
      calls.push('native-close'); state.native = receipt; return receipt;
    }};
  const leaser = {async close(input, {actor}) {
    assert.equal(input.jobId, binding.jobId); assert.equal(input.machineId, binding.machineId); assert.equal(actor.id, binding.accountId);
    assert.notEqual(input.source.kind, 'directory'); calls.push('data-' + input.source.kind);
    return {closed: true, released: true};
  }};
  const completions = {async get() {return state.local;}, async record(value) {calls.push('record'); state.local = {...value, dataReleased: true}; return state.local;}};
  return {binding, launch, reference, receipt, state, calls, native, leaser, completions, bindings,
    app: new FinalizeNodeDispatch({bindings, native, leaser, completions})};
}

test('native completion precedes all data closure, and a saved receipt skips every side effect', async () => {
  const f = fixture();
  const first = await f.app.execute(f.reference);
  assert.deepEqual(f.calls, ['plan', 'native-read', 'native-close', 'data-cache', 'data-warehouse', 'record']);
  assert.equal(first.dataReleased, true); assert.deepEqual(first.native, f.receipt);
  const before = [...f.calls];
  assert.deepEqual(await f.app.execute(f.reference), first); assert.deepEqual(f.calls, before);
});

test('repeated requests during slow cleanup share one operation and failure leaves the original ID recoverable', async () => {
  const f = fixture(), entered = Promise.withResolvers(), gate = Promise.withResolvers(), close = f.leaser.close;
  f.leaser.close = async () => {entered.resolve(); await gate.promise; throw new Error('fixture slow cleanup failed');};
  const first = f.app.execute(f.reference);
  await entered.promise;
  const second = f.app.execute({...f.reference});
  assert.equal(first, second);
  const failed = assert.rejects(first, /fixture slow cleanup failed/);
  gate.resolve(); await failed;
  assert.equal(f.state.local, null);
  f.leaser.close = close;
  assert.equal((await f.app.execute(f.reference)).dataReleased, true);
  assert.equal(f.calls.filter(value => value === 'native-close').length, 1);
});

test('a lost native completion reply releases nothing until the original receipt is queried', async () => {
  const f = fixture(), complete = f.native.complete;
  f.native.complete = async input => {await complete(input); throw new ApplicationError('NATIVE_OUTCOME_UNCONFIRMED');};
  await assert.rejects(f.app.execute(f.reference), hasCode('NATIVE_OUTCOME_UNCONFIRMED'));
  assert.deepEqual(f.calls, ['plan', 'native-read', 'native-close']); assert.equal(f.state.local, null);
  assert.equal((await f.app.execute(f.reference)).dataReleased, true);
  assert.equal(f.calls.filter(value => value === 'native-close').length, 1);
});

test('partial data failure keeps the native completion and replays only task-scoped idempotent closure', async () => {
  const f = fixture(), close = f.leaser.close; let fail = true;
  f.leaser.close = async (...args) => {
    if (args[0].source.kind === 'warehouse' && fail) throw new ApplicationError('MANAGED_DATA_LEASE_UNAVAILABLE');
    return close(...args);
  };
  await assert.rejects(f.app.execute(f.reference), hasCode('MANAGED_DATA_LEASE_UNAVAILABLE'));
  assert.equal(f.state.native, f.receipt); assert.equal(f.state.local, null);
  fail = false;
  assert.equal((await f.app.execute(f.reference)).dataReleased, true);
  assert.equal(f.calls.filter(value => value === 'native-close').length, 1);
  assert.equal(f.calls.filter(value => value === 'record').length, 1);
});

test('missing plans, unconfirmed native closure and foreign receipts cannot close data', async () => {
  const f = fixture();
  f.native.complete = async () => {throw new ApplicationError('NATIVE_OUTCOME_UNCONFIRMED');};
  await assert.rejects(f.app.execute(f.reference), hasCode('NATIVE_OUTCOME_UNCONFIRMED'));
  for (const change of [{submit_key: randomUUID()}, {grant_id: randomUUID()}, {submit_digest: 'f'.repeat(64)}]) {
    f.state.native = {...f.receipt, ...change};
    await assert.rejects(f.app.execute(f.reference), hasCode('NODE_COMPLETION_IDENTITY_MISMATCH'));
  }
  f.bindings.training = async () => null;
  await assert.rejects(f.app.execute(f.reference), hasCode('NODE_LAUNCH_NOT_PREPARED'));
  assert.equal(f.state.local, null); assert.ok(!f.calls.some(value => value.startsWith('data-')));
});

test('unconfirmed data response never becomes a completed receipt; raw-only jobs need no fake lease', async () => {
  const f = fixture();
  for (const result of [null, {closed: false, released: true}, {closed: true, released: false}]) {
    f.leaser.close = async () => result;
    await assert.rejects(f.app.execute(f.reference), hasCode('NODE_DATA_RELEASE_UNCONFIRMED'));
    assert.equal(f.state.local, null);
  }
  f.launch.plan.inputs = f.launch.plan.inputs.slice(0, 1);
  f.leaser.close = async () => {throw new Error('raw sources have no lease');};
  assert.equal((await f.app.execute(f.reference)).dataReleased, true);
});

function databaseFixture(t) {
  const f = fixture(), database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec('PRAGMA foreign_keys=ON'); createNodeDispatchBindingsSchema(database);
  // Repository-only fixture. Full compiler/real lease coverage is in the integration suite.
  database.prepare('INSERT INTO v2_node_dispatch_bindings VALUES(?,?)').run(f.binding.dispatchId, JSON.stringify(f.binding));
  database.prepare('INSERT INTO v2_node_launch_specs VALUES(?,?)').run(f.binding.dispatchId, '{}');
  database.prepare('INSERT INTO v2_node_runtime_plans VALUES(?,?,?)').run(f.binding.dispatchId, '{}', f.launch.planDigest);
  return {...f, database, store: new SqliteNodeCompletions({database, machineId: 'node-1'}),
    record: {binding: f.binding, planDigest: f.launch.planDigest, native: f.receipt}};
}

test('node completion storage is idempotent across key order and uses the existing immutable binding', t => {
  const f = databaseFixture(t);
  assert.equal(f.store.get(f.reference), null);
  const first = f.store.record(f.record);
  const reordered = Object.fromEntries(Object.entries(f.receipt).reverse());
  assert.deepEqual(f.store.record({...f.record, native: reordered}), first);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_node_completions').get().n, 1);
  f.database.exec('PRAGMA query_only=ON');
  assert.deepEqual(f.store.get(f.reference), first);
  assert.equal(f.database.isTransaction, false);
});

test('foreign binding, plan and changed completion conflict without overwriting the original receipt', t => {
  const f = databaseFixture(t);
  assert.throws(() => f.store.record({...f.record, planDigest: 'e'.repeat(64)}), hasCode('NODE_COMPLETION_PLAN_CHANGED'));
  assert.throws(() => f.store.record({...f.record, binding: {...f.binding, accountId: 'bob'}}), hasCode('NODE_COMPLETION_IDENTITY_MISMATCH'));
  assert.throws(() => f.store.get({...f.reference, machineId: 'node-2'}), hasCode('NODE_DISPATCH_MACHINE_MISMATCH'));
  const first = f.store.record(f.record);
  assert.throws(() => f.store.record({...f.record, native: {...f.receipt, native_version: 4}}), hasCode('NODE_COMPLETION_CONFLICT'));
  assert.deepEqual(f.store.get(f.reference), first);
});

test('failed node receipt write can be retried, while an old database requires an explicit upgrade', t => {
  const f = databaseFixture(t);
  f.database.exec("CREATE TEMP TRIGGER fail_close BEFORE INSERT ON v2_node_completions BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");
  assert.throws(() => f.store.record(f.record), /fixture receipt failure/);
  assert.equal(f.store.get(f.reference), null); assert.equal(f.database.isTransaction, false);
  f.database.exec('DROP TRIGGER fail_close; DROP TABLE v2_node_completions');
  assert.throws(() => f.store.get(f.reference), /no such table/);
  assert.equal(f.database.prepare("SELECT name FROM sqlite_master WHERE name='v2_node_completions'").get(), undefined);
  createNodeCompletionsSchema(f.database);
  assert.equal(f.store.record(f.record).dataReleased, true);
});
