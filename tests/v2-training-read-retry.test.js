import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {stat} from 'node:fs/promises';
import {ApplicationError, TransientReadError} from '../src/domain/errors.mjs';
import {TrainingReadBudget} from '../src/application/training-read-budget.mjs';
import {ResolveTrainingData} from '../src/application/resolve-training-data.mjs';
import {ResolveDataRead} from '../src/application/resolve-data-read.mjs';
import {RegisterManagedSource} from '../src/application/register-managed-source.mjs';
import {ImportDataAccess} from '../src/application/import-data-access.mjs';
import {HttpSourceReader} from '../src/infrastructure/http-source-reader.mjs';
import {HttpManagedDataLeaser} from '../src/infrastructure/http-managed-data-leaser.mjs';
import {createSourceInspectionHandler} from '../src/api/source-inspection-handler.mjs';
import {createDataReadHandler} from '../src/api/data-read-handler.mjs';
import {createManagedRegistrationHandler} from '../src/api/managed-registration-handler.mjs';
import {createDataAccessImportHandler} from '../src/api/data-access-import-handler.mjs';
import {REGISTER_MANAGED_SOURCE_ROUTE} from '../src/contracts/managed-registration.mjs';
import {DATA_ACCESS_IMPORT_ROUTES} from '../src/contracts/data-access-import.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {publishedFixture, python} from './helpers/v2-published-fixture.mjs';

const actor = {id: 'alice'}, credential = 'c'.repeat(64);
const source = {kind: 'directory', sourceId: 'images'}, request = {machineId: 'node-1', source};
const busy = () => new TransientReadError('SOURCE_BUSY');
const hasCode = code => error => error.code === code;
function scope(options = {}) {
  let time = 0;
  const waits = [];
  const reads = new TrainingReadBudget({clock: () => time, sleep: async ms => {waits.push(ms); time += ms;}, ...options});
  return {reads, waits, elapse(ms) {time += ms;}};
}
function training(sources, check = async () => {}) {
  return new ResolveTrainingData({sources, access: {requireRead: check}});
}
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('only source inspection is retried, at most three attempts with one actor and exact reference', async () => {
  const f = scope(), calls = [];
  const sources = {async inspect(input, context) {
    calls.push({input: structuredClone(input), context: structuredClone(context)});
    if (calls.length < 3) throw busy();
    return {availability: 'available'};
  }};
  const result = await training(sources).execute(actor, {machineId: 'node-1', sources: [source]}, {reads: f.reads});
  assert.equal(result[0].availability, 'available'); assert.deepEqual(f.waits, [250, 500]);
  assert.deepEqual(calls.map(call => call.input), [request, request, request]);
  assert.ok(calls.every(call => call.context.actor.id === 'alice'));
  assert.equal(calls[0].context.timeoutMs, undefined);
  assert.equal(calls[1].context.timeoutMs, 11750); assert.equal(calls[2].context.timeoutMs, 11250);
  assert.deepEqual(Object.getOwnPropertyNames(TrainingReadBudget.prototype), ['constructor', 'inspect']);
});

test('shared retry budget accounts for failures, waits and successful retries across sources', async () => {
  const f = scope(), attempts = new Map();
  const sources = {async inspect(input, context) {
    const name = input.source.sourceId, count = (attempts.get(name) ?? 0) + 1; attempts.set(name, count);
    if (name === 'first') {
      f.elapse(count === 1 ? 6000 : 5000);
      if (count === 1) throw busy();
      assert.equal(context.timeoutMs, 5750); return {availability: 'available'};
    }
    f.elapse(600); throw busy();
  }};
  const refs = ['first', 'second'].map(sourceId => ({kind: 'directory', sourceId}));
  await assert.rejects(training(sources).execute(actor, {machineId: 'node-1', sources: refs}, {reads: f.reads}), hasCode('SOURCE_BUSY'));
  assert.deepEqual([...attempts], [['first', 2], ['second', 1]]);
  assert.deepEqual(f.waits, [250]); assert.equal(f.reads.remainingMs, 150);
  // A fresh observation gets a fresh budget; no shared process-global retry state.
  assert.equal(scope().reads.remainingMs, 12000);
});

test('successful first reads do not consume extra-wait budget; exhausted retry wait never starts another attempt', async () => {
  const f = scope();
  await f.reads.inspect({async inspect() {f.elapse(5000); return {availability: 'available'};}}, request, {actor, check: async () => {}});
  assert.equal(f.reads.remainingMs, 12000);
  let calls = 0;
  const exhausted = scope({sleep: async () => {exhausted.elapse(12000);}});
  await assert.rejects(exhausted.reads.inspect({async inspect() {calls++; throw busy();}}, request, {actor, check: async () => {}}), hasCode('SOURCE_BUSY'));
  assert.equal(calls, 1); assert.equal(exhausted.reads.remainingMs, 0);
});

test('permission, unknown failure, absent data and invalid replies do not trigger retries', async () => {
  for (const failure of [new ApplicationError('FORBIDDEN'), new ApplicationError('UNAUTHENTICATED'),
    new ApplicationError('SOURCE_UNAVAILABLE'), new ApplicationError('SOURCE_NODE_UNAVAILABLE'), new Error('unexpected')]) {
    const f = scope(); let calls = 0;
    await assert.rejects(training({async inspect() {calls++; throw failure;}})
      .execute(actor, {machineId: 'node-1', sources: [source]}, {reads: f.reads}), error => error === failure);
    assert.equal(calls, 1); assert.deepEqual(f.waits, []);
  }
  const f = scope(); let calls = 0;
  await assert.rejects(training({async inspect() {calls++; return {availability: 'missing', reason: 'not-found'};}})
    .execute(actor, {machineId: 'node-1', sources: [source]}, {reads: f.reads}), hasCode('TRAINING_DATA_UNAVAILABLE'));
  assert.equal(calls, 1); assert.deepEqual(f.waits, []);
});

test('zero authorization, revocation during I/O or backoff, and candidate-context changes all stop retries', async () => {
  for (const moment of ['initial', 'read', 'sleep', 'context']) {
    let revoked = moment === 'initial', calls = 0;
    const f = scope({sleep: async () => {revoked = true;},
      check: async () => {if (moment === 'context' && revoked) throw new ApplicationError('TRAINING_CONTEXT_CHANGED');}});
    const sources = {async inspect() {calls++; if (moment !== 'sleep') revoked = true; throw busy();}};
    const check = async () => {if (revoked && moment !== 'context') throw new ApplicationError('FORBIDDEN');};
    await assert.rejects(training(sources, check).execute(actor, {machineId: 'node-1', sources: [source]}, {reads: f.reads}),
      hasCode(moment === 'context' ? 'TRAINING_CONTEXT_CHANGED' : 'FORBIDDEN'));
    assert.equal(calls, moment === 'initial' ? 0 : 1);
  }
});

test('classified transport resets recover; TLS, credential, schema and identity failures remain single observations', async () => {
  for (const variant of ['reset', 'tls', 'credential', '401-cleanup', '403-cleanup', 'wrong-status', 'invalid-json', 'wrong-node', 'unknown-code']) {
    let calls = 0;
    const fetch = async (_url, options) => {
      calls++; assert.equal(options.redirect, 'error');
      if (variant === 'reset' && calls < 3) throw new TypeError('fixture reset', {cause: {code: 'ECONNRESET'}});
      if (variant === 'tls') throw new TypeError('fixture certificate', {cause: {code: 'CERT_HAS_EXPIRED'}});
      if (variant === 'credential') return new Response(JSON.stringify({error: {code: 'SOURCE_BUSY'}}), {status: 403});
      if (variant.endsWith('-cleanup')) return {status: Number(variant.slice(0, 3)), body: {async cancel() {
        throw new TypeError('fixture cleanup reset', {cause: {code: 'ECONNRESET'}});
      }}};
      if (variant === 'wrong-status') return new Response(JSON.stringify({error: {code: 'SOURCE_BUSY'}}), {status: 500});
      if (variant === 'unknown-code') return new Response(JSON.stringify({error: {code: 'SOURCE_UNAVAILABLE'}}), {status: 503});
      if (variant === 'invalid-json') return new Response('malformed');
      return new Response(JSON.stringify({result: {...request, machineId: variant === 'wrong-node' ? 'node-2' : 'node-1',
        availability: 'available', location: {containerPath: '/datasets/images', readOnly: true}}}));
    };
    const sources = new HttpSourceReader({nodes: [{machineId: 'node-1', origin: 'https://node.example', credential}], fetch});
    const f = scope(), pending = training(sources).execute(actor, {machineId: 'node-1', sources: [source]}, {reads: f.reads});
    if (variant === 'reset') {assert.equal((await pending)[0].availability, 'available'); assert.equal(calls, 3);}
    else {await assert.rejects(pending); assert.equal(calls, 1); assert.deepEqual(f.waits, []);}
  }
});

test('real HTTP preserves SOURCE_BUSY to the common user API; normal browsing and lease writes are not retried', async t => {
  let calls = 0;
  const nodeOrigin = await listen(t, createSourceInspectionHandler({machineId: 'node-1', credential, reportError() {},
    sources: {async inspect() {calls++; throw busy();}}}));
  const sources = new HttpSourceReader({nodes: [{machineId: 'node-1', origin: nodeOrigin, credential}]});
  const origin = await listen(t, createDataReadHandler({authenticate: async () => actor, reportError() {},
    resolveDataRead: new ResolveDataRead({sources, access: {async requireRead() {}}})}));
  await assert.rejects(new DataClient({transport: new JsonHttpTransport({baseUrl: origin})}).resolveReadLocation(request), hasCode('SOURCE_BUSY'));
  assert.equal(calls, 1);
  const f = scope();
  await assert.rejects(training(sources).execute(actor, {machineId: 'node-1', sources: [source]}, {reads: f.reads}), hasCode('SOURCE_BUSY'));
  assert.equal(calls, 4); assert.deepEqual(f.waits, [250, 500]);
  let writes = 0;
  const leases = new HttpManagedDataLeaser({nodes: [{machineId: 'node-1', origin: nodeOrigin, credential}], fetch: async () => {
    writes++; return new Response(JSON.stringify({error: {code: 'SOURCE_BUSY'}}), {status: 503});
  }});
  await assert.rejects(leases.acquire({machineId: 'node-1', jobId: 'aaaaaaaa-1111-4111-8111-111111111111',
    source: {kind: 'warehouse', datasetId: 'images', version: 'a'.repeat(64)}}, {actor}), hasCode('MANAGED_DATA_LEASE_UNAVAILABLE'));
  assert.equal(writes, 1);
});

test('registration and ACL import preserve transient preflight errors without committing or retrying writes', async t => {
  let code = 'SOURCE_BUSY', writes = 0, reads = 0;
  const failRead = async () => {reads++; throw new TransientReadError(code, {cause: new Error('private fixture path')});};
  const registerSource = new RegisterManagedSource({clock: () => 1,
    registrations: {authorize() {}, register() {writes++;}}, configuredVersions: {find: () => ({ownerId: 'alice'})},
    sources: {inspect: failRead}});
  const imports = new ImportDataAccess({accountMapping: [{legacyId: 'alice', accountId: 'alice'}],
    legacyAccess: {exportAccess: failRead}, imports: {receiptForCommand: () => null, authorize() {}, apply() {writes++;},
      describe: () => ({datasetId: 'images', version: 'a'.repeat(64), bindings: [{machineId: 'node-1', kind: 'warehouse'}]})}});
  const settings = {authenticate: async () => actor, reportError() {}};
  const registerOrigin = await listen(t, createManagedRegistrationHandler({...settings, registerSource}));
  const importOrigin = await listen(t, createDataAccessImportHandler({...settings, imports}));
  for (code of ['SOURCE_BUSY', 'SOURCE_READ_TIMEOUT']) {
    for (const [url, body] of [[registerOrigin + REGISTER_MANAGED_SOURCE_ROUTE,
      {machineId: 'node-1', source: {kind: 'warehouse', datasetId: 'images', version: 'a'.repeat(64)}}],
    [importOrigin + DATA_ACCESS_IMPORT_ROUTES.apply,
      {resourceId: 'images', requestId: 'aaaaaaaa-1111-4111-8111-111111111111', planId: 'b'.repeat(64)}]]) {
      const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      assert.equal(response.status, 503); assert.deepEqual(await response.json(), {error: {code}});
    }
  }
  assert.equal(reads, 4); assert.equal(writes, 0);
});

test('native cache lock contention crosses Python and HTTP as busy, then retries the original data without copying', async t => {
  const f = await publishedFixture(t), reference = f.request('warehouse');
  const payload = join(f.directory, 'warehouse', 'ready', 'images', f.version, 'data', 'sample.txt');
  const before = await stat(payload);
  const locker = spawn(python, ['-B', '-c',
    'import fcntl,sys; f=open(sys.argv[1],"rb"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()',
    join(f.directory, 'warehouse', '.lock')], {stdio: ['pipe', 'pipe', 'pipe']});
  const exited = once(locker, 'exit');
  t.after(async () => {locker.stdin.end(); await exited;});
  await Promise.race([once(locker.stdout, 'data'), exited.then(() => {throw new Error('fixture locker exited before readiness');})]);
  // The native helper is supervised and receives the retry's remaining timeout.
  await assert.rejects(f.managed.inspect(reference, {actor, timeoutMs: 50}), error => error instanceof TransientReadError && error.code === 'SOURCE_READ_TIMEOUT');
  let calls = 0, observedBusy = false;
  const nodeOrigin = await listen(t, createSourceInspectionHandler({machineId: 'node-1', credential, reportError() {}, sources: {
    async inspect(input, context) {
      calls++;
      try {return await f.managed.inspect(input, context);}
      catch (error) {observedBusy = error instanceof TransientReadError && error.code === 'SOURCE_BUSY'; locker.stdin.end(); await exited; throw error;}
    },
  }}));
  const sources = new HttpSourceReader({nodes: [{machineId: 'node-1', origin: nodeOrigin, credential}]});
  const result = await training(sources).execute(actor, {machineId: 'node-1', sources: [reference.source]});
  assert.equal(observedBusy, true); assert.equal(calls, 2);
  assert.equal(result[0].availability, 'available'); assert.deepEqual(result[0].source, reference.source);
  const after = await stat(payload);
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
});
