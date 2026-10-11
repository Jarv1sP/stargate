import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dirname} from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {createNodeDispatchBindingsSchema, SqliteNodeDispatchBindings} from '../src/infrastructure/sqlite/node-dispatch-bindings.mjs';
import {LookupNodeDispatch} from '../src/application/lookup-node-dispatch.mjs';
import {GpuqReceiptReader} from '../src/infrastructure/gpuq-receipt-reader.mjs';
import {assembleDispatchReceipt} from '../src/bootstrap/dispatch-receipt.mjs';
import {HttpDispatchReceipts} from '../src/infrastructure/http-dispatch-receipts.mjs';
import {DISPATCH_RECEIPT_ROUTE} from '../src/contracts/dispatch-receipt.mjs';
import {dispatchFixture} from './helpers/v2-dispatch-fixture.mjs';
import {SqliteTrainingDispatches, createTrainingDispatchSchema} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {ReconcileTrainingDispatch} from '../src/application/reconcile-training-dispatch.mjs';
import {createNodeExpansionBindingsSchema, SqliteNodeExpansionBindings} from '../src/infrastructure/sqlite/node-expansion-bindings.mjs';
import {LookupNodeExpansion} from '../src/application/lookup-node-expansion.mjs';
import {HttpExpansionReceipts} from '../src/infrastructure/http-expansion-receipts.mjs';
import {EXPANSION_RECEIPT_ROUTE} from '../src/contracts/expansion-receipt.mjs';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {ReconcileTaskExpansion} from '../src/application/reconcile-task-expansion.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'v2-node-binding-')), path = join(folder, 'node.sqlite');
  const db = new DatabaseSync(path); t.after(async () => {db.close(); await rm(folder, {recursive: true, force: true});});
  createNodeDispatchBindingsSchema(db);
  const binding = {dispatchId: randomUUID(), jobId: randomUUID(), accountId: 'alice', machineId: 'node-1', gpuCount: 2,
    nativeMaxGpus: 2, requestHash: 'a'.repeat(64), nativeDigest: 'b'.repeat(64), nativeOwner: 'runtime-alice', nativeName: 'training'};
  const bindings = new SqliteNodeDispatchBindings({database: db, machineId: 'node-1'});
  const receipt = {job_id: 'J0123456789ab', submit_key: binding.dispatchId, submit_digest: binding.nativeDigest,
    owner: binding.nativeOwner, name: binding.nativeName, gpu_count: binding.gpuCount, state: 'PENDING'};
  return {db, path, binding, bindings, receipt, reference: {machineId: 'node-1', dispatchId: binding.dispatchId}};
}

async function expansionFixture(t) {
  const f = await fixture(t); f.binding.nativeMaxGpus = 4; f.receipt.gpu_count = 4;
  f.bindings.bind(f.binding); createNodeExpansionBindingsSchema(f.db);
  const expansion = {changeId: randomUUID(), dispatchId: f.binding.dispatchId, planId: 'S' + randomUUID(),
    sourceAttemptId: 'A' + randomUUID(), fromReservedGpuCount: 2, sourceGpuCount: 2, targetGpuCount: 4};
  const expansions = new SqliteNodeExpansionBindings({database: f.db, machineId: 'node-1'});
  const scaleReceipt = {job_id: f.receipt.job_id, submit_key: f.binding.dispatchId, submit_digest: f.binding.nativeDigest,
    plan_id: expansion.planId, plan_state: 'FAILED', plan_version: 3, from_gpu_count: 2, target_gpu_count: 4,
    source_attempt_id: expansion.sourceAttemptId, successor_attempt_id: 'A-successor', source_attempt_state: 'PREEMPTED',
    successor_attempt_state: 'PLANNED', plan_reserved_gpu_count: 0, job_reserved_gpu_count: 0, job_leased_gpu_count: 4};
  return {...f, expansion, expansions, scaleReceipt, expansionReference: {machineId: 'node-1', changeId: expansion.changeId}};
}

async function nativeServer(t, f) {
  const socketPath = join(dirname(f.path), 'receipt.sock');
  const state = {value: f.receipt, rejected: false, requests: []};
  const server = net.createServer(socket => {
    let body = ''; socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', chunk => {
      body += chunk; if (!body.endsWith('\n')) return;
      const request = JSON.parse(body); state.requests.push(request);
      socket.end(JSON.stringify(state.rejected ? {request_id: request.request_id, ok: false, error: {code: 'NOT_FOUND', message: 'old daemon'}}
        : {request_id: request.request_id, ok: true, result: state.value}) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {socketPath, state};
}

const credential = 'c'.repeat(64);
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('fixed node binding persists separately from the coordinator and is idempotent across reopen', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.bindings.bind(f.binding), f.binding);
  const changes = f.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(f.bindings.bind({...f.binding}), f.binding);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
  const db = new DatabaseSync(f.path, {readOnly: true});
  try {assert.deepEqual(new SqliteNodeDispatchBindings({database: db, machineId: 'node-1'}).get(f.reference), f.binding);}
  finally {db.close();}
});

test('dispatch identity, account, platform hash and native launch identity cannot be rebound', async t => {
  const f = await fixture(t); f.bindings.bind(f.binding);
  for (const change of [{jobId: randomUUID()}, {accountId: 'bob'}, {gpuCount: 3, nativeMaxGpus: 3}, {nativeMaxGpus: 4}, {requestHash: 'c'.repeat(64)},
    {nativeDigest: 'c'.repeat(64)}, {nativeOwner: 'other'}, {nativeName: 'other'}]) {
    assert.throws(() => f.bindings.bind({...f.binding, ...change}), hasCode('NODE_DISPATCH_BINDING_CONFLICT'));
  }
  assert.throws(() => f.bindings.bind({...f.binding, machineId: 'node-2'}), hasCode('NODE_DISPATCH_MACHINE_MISMATCH'));
  assert.throws(() => f.bindings.get({...f.reference, machineId: 'node-2'}), hasCode('NODE_DISPATCH_MACHINE_MISMATCH'));
});

test('lookup queries only the original submit key and projects the platform acceptance without native metadata', async t => {
  const f = await fixture(t); f.bindings.bind(f.binding); const calls = [];
  const app = new LookupNodeDispatch({bindings: f.bindings, native: {async lookup(input) {calls.push(input); return f.receipt;}}});
  const changes = f.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(await app.execute(f.reference), {dispatchId: f.binding.dispatchId, jobId: f.binding.jobId,
    machineId: 'node-1', accountId: 'alice', gpuCount: 2, requestHash: f.binding.requestHash, nodeJobId: f.receipt.job_id});
  assert.deepEqual(calls, [{submitKey: f.binding.dispatchId}]);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('missing mapping or native receipt stays unconfirmed with no registration or resubmission', async t => {
  const f = await fixture(t); let calls = 0;
  const app = new LookupNodeDispatch({bindings: f.bindings, native: {async lookup() {calls++; return null;}}});
  assert.equal(await app.execute(f.reference), null); assert.equal(calls, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_node_dispatch_bindings').get().n, 0);
  f.bindings.bind(f.binding);
  assert.equal(await app.execute(f.reference), null); assert.equal(calls, 1);
});

test('wrong native key, digest, owner, name or GPU count is never treated as acceptance', async t => {
  const f = await fixture(t); f.bindings.bind(f.binding);
  for (const change of [{submit_key: randomUUID()}, {submit_digest: f.binding.requestHash}, {owner: 'other'},
    {name: 'other'}, {gpu_count: 3}, {job_id: '../path'}]) {
    const app = new LookupNodeDispatch({bindings: f.bindings, native: {async lookup() {return {...f.receipt, ...change};}}});
    await assert.rejects(app.execute(f.reference), hasCode('NATIVE_DISPATCH_RECEIPT_MISMATCH'));
  }
});

test('node lookup uses the actual Python native protocol bridge without submitting or scanning jobs', async t => {
  const f = await fixture(t); f.bindings.bind(f.binding);
  const {socketPath, state} = await nativeServer(t, f);
  const native = new GpuqReceiptReader({socketPath, python: process.env.V2_PYTHON || 'python3'});
  const app = new LookupNodeDispatch({bindings: f.bindings, native});
  assert.equal((await app.execute(f.reference)).nodeJobId, f.receipt.job_id);
  state.value = null;
  assert.equal(await app.execute(f.reference), null);
  state.rejected = true;
  await assert.rejects(app.execute(f.reference), hasCode('GPUQ_RECEIPT_UNAVAILABLE'));
  assert.ok(state.requests.every(request => request.op === 'submission_receipt' && request.args.submit_key === f.binding.dispatchId));
  assert.equal(state.requests.length, 3);
});

test('reopened coordinator reconciles over HTTP, node mapping and real native protocol bridge', async t => {
  const coordinator = await dispatchFixture(t), node = await fixture(t);
  coordinator.dispatches.beginSend(coordinator.jobId, coordinator.now);
  const delivery = coordinator.dispatches.delivery(coordinator.prepared.dispatchId);
  const binding = {...node.binding, dispatchId: delivery.dispatchId, jobId: delivery.jobId, accountId: delivery.accountId,
    machineId: delivery.machineId, gpuCount: delivery.gpuCount, requestHash: delivery.requestHash};
  node.bindings.bind(binding);
  const native = await nativeServer(t, node);
  const receipt = {...node.receipt, submit_key: binding.dispatchId};
  const origin = await serve(t, assembleDispatchReceipt({database: node.db, machineId: 'node-1', credential,
    socketPath: native.socketPath, python: process.env.V2_PYTHON || 'python3', reportError() {}}));
  const reopened = new DatabaseSync(coordinator.database.prepare('PRAGMA database_list').get().file);
  try {
    const dispatches = new SqliteTrainingDispatches({database: reopened});
    const app = new ReconcileTrainingDispatch({dispatches, nodes: new HttpDispatchReceipts({nodes: [{machineId: 'node-1', origin, credential}]})});
    coordinator.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
    native.state.value = null;
    assert.equal((await app.execute(delivery.dispatchId)).kind, 'unconfirmed');
    native.state.rejected = true;
    await assert.rejects(app.execute(delivery.dispatchId), hasCode('DISPATCH_NODE_UNAVAILABLE'));
    native.state.rejected = false; native.state.value = {...receipt, submit_digest: '0'.repeat(64)};
    await assert.rejects(app.execute(delivery.dispatchId), hasCode('DISPATCH_NODE_UNAVAILABLE'));
    assert.equal(dispatches.delivery(delivery.dispatchId).state, 'SENDING');
    native.state.value = receipt;
    const result = await app.execute(delivery.dispatchId);
    assert.equal(result.kind, 'accepted'); assert.equal(result.dispatch.nodeJobId, receipt.job_id);
    assert.equal(native.state.requests.length, 4);
    assert.ok(native.state.requests.every(row => row.op === 'submission_receipt'));
    assert.equal(coordinator.database.prepare("SELECT gpu_count FROM v2_compute_claims WHERE job_id=? AND state='HELD'").get(coordinator.jobId).gpu_count, 2);
  } finally {reopened.close();}
});

test('node receipt endpoint rejects missing credentials, wrong machine and request proof injection before native I/O', async t => {
  const node = await fixture(t), native = await nativeServer(t, node);
  const origin = await serve(t, assembleDispatchReceipt({database: node.db, machineId: 'node-1', credential,
    socketPath: native.socketPath, reportError() {}}));
  const post = (body, token) => fetch(origin + DISPATCH_RECEIPT_ROUTE, {method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}),
  }, body: JSON.stringify(body)});
  assert.equal((await post(node.reference)).status, 401);
  assert.equal((await post({...node.reference, machineId: 'other'}, credential)).status, 409);
  assert.equal((await post({...node.reference, requestHash: 'a'.repeat(64)}, credential)).status, 400);
  assert.equal((await post({...node.reference, socketPath: '/private'}, credential)).status, 400);
  assert.equal(native.state.requests.length, 0);
});

test('HTTP receipt reader rejects a different dispatch and does not confuse malformed data with not found', async t => {
  const node = await fixture(t); node.bindings.bind(node.binding);
  const valid = await new LookupNodeDispatch({bindings: node.bindings, native: {async lookup() {return node.receipt;}}}).execute(node.reference);
  for (const bad of [{...valid, dispatchId: randomUUID()}, {...valid, machineId: 'other'}, {...valid, requestHash: null}, {}]) {
    const origin = await serve(t, (req, res) => res.end(JSON.stringify({result: bad})));
    const reader = new HttpDispatchReceipts({nodes: [{machineId: 'node-1', origin, credential}]});
    await assert.rejects(reader.lookup(node.reference), hasCode('DISPATCH_NODE_UNAVAILABLE'));
  }
});

test('expansion-to-plan binding is immutable and one native plan cannot be associated with two changes', async t => {
  const f = await expansionFixture(t);
  assert.deepEqual(f.expansions.bind(f.expansion), f.expansion);
  assert.deepEqual(f.expansions.bind({...f.expansion}), f.expansion);
  for (const change of [{planId: 'S-other'}, {sourceAttemptId: 'A-other'}, {targetGpuCount: 3}, {fromReservedGpuCount: 1, sourceGpuCount: 1}]) {
    assert.throws(() => f.expansions.bind({...f.expansion, ...change}), hasCode('NODE_EXPANSION_BINDING_CONFLICT'));
  }
  assert.throws(() => f.expansions.bind({...f.expansion, changeId: randomUUID()}), hasCode('NODE_EXPANSION_BINDING_CONFLICT'));
  assert.throws(() => f.expansions.bind({...f.expansion, changeId: randomUUID(), planId: 'S-over-limit', targetGpuCount: 8}), hasCode('INVALID_NODE_EXPANSION_BINDING'));
  assert.throws(() => f.expansions.bind({...f.expansion, changeId: randomUUID(), dispatchId: randomUUID()}), hasCode('NODE_DISPATCH_BINDING_MISSING'));
  const db = new DatabaseSync(f.path, {readOnly: true});
  try {assert.deepEqual(new SqliteNodeExpansionBindings({database: db, machineId: 'node-1'}).get(f.expansionReference),
    {dispatch: f.binding, expansion: f.expansion});} finally {db.close();}
});

test('expansion lookup requires the exact plan and source attempt, not the latest plan of a job', async t => {
  const f = await expansionFixture(t); let calls = 0;
  const native = {async lookupScale(input) {calls++; assert.deepEqual(input, {submitKey: f.binding.dispatchId, planId: f.expansion.planId}); return f.scaleReceipt;}};
  const app = new LookupNodeExpansion({bindings: f.expansions, native});
  assert.equal(await app.execute(f.expansionReference), null); assert.equal(calls, 0);
  f.expansions.bind(f.expansion);
  const changes = f.db.prepare('SELECT total_changes() n').get().n;
  const result = await app.execute(f.expansionReference);
  assert.equal(result.planState, 'FAILED'); assert.equal(result.jobLeasedGpuCount, 4);
  assert.equal(result.changeId, f.expansion.changeId); assert.equal(result.requestHash, f.binding.requestHash);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
  for (const change of [{plan_id: 'S-newest'}, {source_attempt_id: 'A-other'}, {target_gpu_count: 8},
    {from_gpu_count: 1}, {submit_digest: f.binding.requestHash}, {job_leased_gpu_count: -1}]) {
    native.lookupScale = async () => ({...f.scaleReceipt, ...change});
    await assert.rejects(app.execute(f.expansionReference), hasCode('NATIVE_EXPANSION_RECEIPT_MISMATCH'));
  }
});

test('expansion observation traverses the native Python socket bridge without creating or releasing plans', async t => {
  const f = await expansionFixture(t); f.expansions.bind(f.expansion);
  const {socketPath, state} = await nativeServer(t, f); state.value = f.scaleReceipt;
  const app = new LookupNodeExpansion({bindings: f.expansions,
    native: new GpuqReceiptReader({socketPath, python: process.env.V2_PYTHON || 'python3'})});
  const result = await app.execute(f.expansionReference);
  assert.equal(result.planState, 'FAILED'); assert.equal(result.jobLeasedGpuCount, 4);
  assert.equal(state.requests[0].op, 'scale_up_receipt');
  assert.deepEqual(state.requests[0].args, {submit_key: f.binding.dispatchId, plan_id: f.expansion.planId});
  state.value = null;
  assert.equal(await app.execute(f.expansionReference), null);
  state.rejected = true;
  await assert.rejects(app.execute(f.expansionReference), hasCode('GPUQ_RECEIPT_UNAVAILABLE'));
  assert.equal(state.requests.length, 3);
});

test('HTTP expansion recovery reaches coordinator accounting without treating failed plans as refunds', async t => {
  const f = await computeFixture(t), node = await fixture(t); f.ready();
  createTrainingQueueSchema(f.database); createTrainingDispatchSchema(f.database); createNodeExpansionBindingsSchema(node.db);
  const input = trainingSubmission(); input.resources.autoScaleUp = true; input.resources.batch = {globalBatchSize: 64, microBatchSize: 4};
  input.scheduling = {...input.scheduling, checkpoint: 'epoch-v1', restart: 'on-preempt', yieldPolicy: 'save'};
  const jobId = new SqliteTrainingQueue({database: f.database}).enqueue(f.actor, input, f.now).request.jobId;
  const dispatches = new SqliteTrainingDispatches({database: f.database});
  dispatches.prepareForTask(jobId, {machineId: 'node-1', gpuCount: 2}, f.now);
  const permit = dispatches.beginSend(jobId, f.now);
  dispatches.recordSendOutcome({dispatchId: permit.dispatch.dispatchId, senderToken: permit.senderToken, nodeJobId: node.receipt.job_id});
  const delivery = dispatches.delivery(permit.dispatch.dispatchId), changeId = randomUUID();
  f.claims.reserveExpansionForTask(jobId, {changeId, fromReservedGpuCount: 2, sourceGpuCount: 1, targetGpuCount: 4}, f.now);
  const binding = {...node.binding, dispatchId: delivery.dispatchId, jobId, accountId: delivery.accountId, requestHash: delivery.requestHash, nativeMaxGpus: 4};
  node.bindings.bind(binding);
  const expansion = {changeId, dispatchId: binding.dispatchId, planId: 'S' + randomUUID(), sourceAttemptId: 'A-source', fromReservedGpuCount: 2, sourceGpuCount: 1, targetGpuCount: 4};
  new SqliteNodeExpansionBindings({database: node.db, machineId: 'node-1'}).bind(expansion);
  const native = await nativeServer(t, node);
  const receipt = {job_id: delivery.nodeJobId, submit_key: binding.dispatchId, submit_digest: binding.nativeDigest,
    plan_id: expansion.planId, plan_state: 'FAILED', plan_version: 3, from_gpu_count: 1, target_gpu_count: 4,
    source_attempt_id: expansion.sourceAttemptId, successor_attempt_id: 'A-successor', source_attempt_state: 'PREEMPTED',
    successor_attempt_state: 'PLANNED', plan_reserved_gpu_count: 0, job_reserved_gpu_count: 0, job_leased_gpu_count: 4};
  native.state.value = receipt;
  const origin = await serve(t, assembleDispatchReceipt({database: node.db, machineId: 'node-1', credential,
    socketPath: native.socketPath, python: process.env.V2_PYTHON || 'python3', reportError() {}}));
  const app = new ReconcileTaskExpansion({claims: f.claims, nodes: new HttpExpansionReceipts({nodes: [{machineId: 'node-1', origin, credential}]})});
  assert.equal((await app.execute(changeId)).kind, 'unconfirmed');
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 4);
  native.state.value = {...receipt, source_attempt_id: 'A-wrong'};
  await assert.rejects(app.execute(changeId), hasCode('EXPANSION_NODE_UNAVAILABLE'));
  assert.equal(f.claims.expansion(changeId).state, 'RESERVED');
  native.state.value = {...receipt, from_gpu_count: 2};
  await assert.rejects(app.execute(changeId), hasCode('EXPANSION_NODE_UNAVAILABLE'));
  native.state.value = {...receipt, plan_state: 'COMPLETED', plan_version: 4, successor_attempt_state: 'RUNNING'};
  assert.equal((await app.execute(changeId)).kind, 'applied');
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 4);
  assert.equal(native.state.requests.length, 4);
  assert.ok(native.state.requests.every(row => row.op === 'scale_up_receipt'));
});

test('expansion endpoint refuses authentication, machine and proof injection errors before native queries', async t => {
  const f = await expansionFixture(t), native = await nativeServer(t, f);
  const origin = await serve(t, assembleDispatchReceipt({database: f.db, machineId: 'node-1', credential, socketPath: native.socketPath, reportError() {}}));
  const post = (body, token) => fetch(origin + EXPANSION_RECEIPT_ROUTE, {method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}),
  }, body: JSON.stringify(body)});
  assert.equal((await post(f.expansionReference)).status, 401);
  assert.equal((await post({...f.expansionReference, machineId: 'other'}, credential)).status, 409);
  assert.equal((await post({...f.expansionReference, planState: 'COMPLETED'}, credential)).status, 400);
  assert.equal((await post({...f.expansionReference, planId: 'other'}, credential)).status, 400);
  assert.equal(native.state.requests.length, 0);
});

test('HTTP expansion reader rejects wrong identity and malformed counts instead of reporting absence', async t => {
  const f = await expansionFixture(t); f.expansions.bind(f.expansion);
  const valid = await new LookupNodeExpansion({bindings: f.expansions, native: {async lookupScale() {return f.scaleReceipt;}}}).execute(f.expansionReference);
  for (const bad of [{...valid, changeId: randomUUID()}, {...valid, machineId: 'other'}, {...valid, jobLeasedGpuCount: -1},
    {...valid, successorAttemptState: undefined}, {...valid, sourceGpuCount: undefined}, {}]) {
    const origin = await serve(t, (req, res) => res.end(JSON.stringify({result: bad})));
    await assert.rejects(new HttpExpansionReceipts({nodes: [{machineId: 'node-1', origin, credential}]}).lookup(f.expansionReference), hasCode('EXPANSION_NODE_UNAVAILABLE'));
  }
});
