import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile, readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {publishedFixture, python} from './helpers/v2-published-fixture.mjs';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {assembleManagedDataLease} from '../src/bootstrap/managed-data-lease.mjs';
import {createManagedDataLeaseHandler} from '../src/api/managed-data-lease-handler.mjs';
import {HttpManagedDataLeaser} from '../src/infrastructure/http-managed-data-leaser.mjs';
import {ManagedDataLeaser} from '../src/infrastructure/managed-data-leaser.mjs';
import {AcquireManagedTaskLease} from '../src/application/acquire-managed-task-lease.mjs';
import {SqliteTaskAuthority} from '../src/infrastructure/sqlite/task-authority.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {MANAGED_LEASE_ACQUIRE_ROUTE as acquireRoute, MANAGED_LEASE_LOOKUP_ROUTE as lookupRoute} from '../src/contracts/managed-data-lease.mjs';

const credential = 'c'.repeat(64), hasCode = code => error => error.code === code;
const context = {actor: {id: 'alice'}};
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}
const remote = (origin, options = {}) => new HttpManagedDataLeaser({nodes: [{machineId: 'node-1', origin, credential}], ...options});
const leaseDirectory = (f, kind) => join(f.directory, kind, '.leases', 'images', f.version);
async function leaseSnapshot(f, kind) {
  const directory = leaseDirectory(f, kind), entries = await readdir(directory);
  return Promise.all(entries.sort().map(async name => {
    const path = join(directory, name);
    return {name, content: await readFile(path, 'utf8'), mtimeMs: (await stat(path)).mtimeMs};
  }));
}
function initializeQueue(f, data) {
  createTrainingQueueSchema(f.database);
  f.database.prepare(`INSERT INTO v2_data_resources(id,kind,machine_id,source_id,version,visibility,owner_id)
    VALUES('managed','dataset',NULL,'images',?,'shared',NULL)`).run(data.version);
}
function registerTask(f, data, kind) {
  const submission = {...trainingSubmission(), dataSources: [data.request(kind).source]};
  return new SqliteTrainingQueue({database: f.database}).enqueue(f.actor, submission, f.now).request.jobId;
}

test('task authority reaches real cache and warehouse leases through HTTP, with concurrent same-task idempotency', async t => {
  const f = await computeFixture(t), data = await publishedFixture(t, {owners: ['legacy-owner']});
  initializeQueue(f, data);
  const handler = assembleManagedDataLease({machineId: 'node-1', credential, roots: data.roots, python,
    leaseVersions: ['cache', 'warehouse'].map(kind => data.request(kind).source)});
  const origin = await listen(t, handler);
  const app = new AcquireManagedTaskLease({authority: new SqliteTaskAuthority({database: f.database}), leaser: remote(origin)});
  for (const kind of ['cache', 'warehouse']) {
    const jobId = registerTask(f, data, kind), request = data.request(kind);
    const payload = join(data.directory, kind, 'ready', 'images', data.version, 'data', 'sample.txt'), before = await stat(payload);
    assert.equal(await app.lookup(jobId, request), null);
    const [lease, concurrent] = await Promise.all([app.execute(jobId, request), app.execute(jobId, request)]);
    assert.deepEqual(concurrent, lease);
    assert.deepEqual(lease, {...request, accountId: 'alice', jobId, leaseId: lease.leaseId, readOnly: true});
    const snapshot = await leaseSnapshot(data, kind);
    assert.equal(snapshot.length, 1);
    assert.deepEqual(await app.lookup(jobId, request), lease);
    assert.deepEqual(await leaseSnapshot(data, kind), snapshot);
    assert.equal((await stat(payload)).ino, before.ino);
    assert.equal((await stat(payload)).mtimeMs, before.mtimeMs);
    assert.equal(await readFile(payload, 'utf8'), 'original sample');
    assert.equal(JSON.stringify(lease).includes(data.directory), false);
  }
});

test('lost acquire ACK leaves the real lease intact; a new client recovers by lookup without another write or node fallback', async t => {
  const f = await publishedFixture(t), request = {...f.request('cache'), jobId: randomUUID()}, calls = [];
  const handler = assembleManagedDataLease({machineId: 'node-1', credential, roots: f.roots, python});
  const origin = await listen(t, (req, res) => {
    calls.push(req.url);
    if (req.url === acquireRoute) res.end = () => {res.destroy(); return res;};
    return handler(req, res);
  });
  let otherCalls = 0;
  const other = await listen(t, (_req, res) => {otherCalls++; res.end('{}');});
  const nodes = [{machineId: 'node-1', origin, credential}, {machineId: 'node-2', origin: other, credential}];
  await assert.rejects(new HttpManagedDataLeaser({nodes}).acquire(request, context), hasCode('MANAGED_DATA_LEASE_UNAVAILABLE'));
  assert.deepEqual(calls, [acquireRoute]);
  const snapshot = await leaseSnapshot(f, 'cache'); assert.equal(snapshot.length, 1);
  const recovered = await new HttpManagedDataLeaser({nodes}).lookup(request, context);
  assert.equal(recovered.leaseId + '.json', snapshot[0].name);
  assert.equal(recovered.jobId, request.jobId);
  assert.deepEqual(await leaseSnapshot(f, 'cache'), snapshot);
  assert.equal(await remote(origin).lookup({...request, jobId: randomUUID()}, context), null);
  assert.deepEqual(calls, [acquireRoute, lookupRoute, lookupRoute]);
  assert.equal(otherCalls, 0);
});

test('internal lease routes reject user credentials, wrong node, injected configuration and raw directories before native work', async t => {
  let calls = 0;
  const unexpected = async () => {calls++; throw new Error('must not reach native code');};
  const origin = await listen(t, createManagedDataLeaseHandler({machineId: 'node-1', credential,
    leaser: {acquire: unexpected, lookup: unexpected}, reportError() {}}));
  const request = {machineId: 'node-1', jobId: randomUUID(), source: {kind: 'cache', datasetId: 'images', version: 'a'.repeat(64)}};
  const post = (route, body, token = credential) => fetch(origin + route, {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify(body)});
  for (const route of [acquireRoute, lookupRoute]) {
    assert.equal((await post(route, {request, accountId: 'alice'}, 'a'.repeat(64))).status, 401);
    assert.equal((await post(route, {request: {...request, machineId: 'node-2'}, accountId: 'alice'})).status, 409);
    for (const extra of [{hostPath: '/arbitrary'}, {leaseVersions: [request.source]}, {hostAdmin: true}, {accountId: 'bob'}]) {
      assert.equal((await post(route, {request: {...request, ...extra}, accountId: 'alice'})).status, 400);
    }
    assert.equal((await post(route, {request, accountId: 'alice', hostAdmin: true})).status, 400);
    assert.equal((await post(route, {request, accountId: '../alice'})).status, 400);
    assert.equal((await post(route, {request: {...request, jobId: 'invalid'}, accountId: 'alice'})).status, 400);
    const directoryReply = await post(route, {request: {...request, source: {kind: 'directory', sourceId: 'images'}}, accountId: 'alice'});
    assert.equal(directoryReply.status, 400);
    assert.deepEqual(await directoryReply.json(), {error: {code: 'INVALID_REQUEST', field: 'source.kind'}});
  }
  assert.equal((await post('/internal/v2/data-lease/release', {request, accountId: 'alice'})).status, 404);
  assert.equal(calls, 0);
});

test('native owner ACL remains in force across HTTP for acquire and lookup', async t => {
  const f = await publishedFixture(t), request = {...f.request('cache'), jobId: randomUUID()};
  const origin = await listen(t, assembleManagedDataLease({machineId: 'node-1', credential, roots: f.roots, python}));
  const client = remote(origin), lease = await client.acquire(request, context), before = await leaseSnapshot(f, 'cache');
  for (const operation of ['acquire', 'lookup']) {
    await assert.rejects(client[operation](request, {actor: {id: 'bob'}}), hasCode('FORBIDDEN'));
  }
  assert.deepEqual(await leaseSnapshot(f, 'cache'), before);
  assert.deepEqual(await client.lookup(request, context), lease);
});

test('two authorized readers never recover each other\'s lease even with the same task reference', async t => {
  const f = await publishedFixture(t, {owners: ['alice', 'bob']}), request = {...f.request('cache'), jobId: randomUUID()};
  const origin = await listen(t, assembleManagedDataLease({machineId: 'node-1', credential, roots: f.roots, python}));
  const client = remote(origin), other = {actor: {id: 'bob'}};
  const first = await client.acquire(request, context);
  assert.equal(await client.lookup(request, other), null);
  const second = await client.acquire(request, other);
  assert.equal(second.accountId, 'bob'); assert.notEqual(second.leaseId, first.leaseId);
  assert.deepEqual(await client.lookup(request, context), first);
  assert.deepEqual(await client.lookup(request, other), second);
  assert.equal((await leaseSnapshot(f, 'cache')).length, 2);
});

test('task revocation after a remote write rejects success and keeps protection; zero grants make no node request', async t => {
  const f = await computeFixture(t), data = await publishedFixture(t);
  initializeQueue(f, data);
  const jobId = registerTask(f, data, 'cache');
  let calls = 0, revoke = false;
  const native = new ManagedDataLeaser({machineId: 'node-1', roots: data.roots, python});
  const handler = createManagedDataLeaseHandler({machineId: 'node-1', credential, leaser: {
    async acquire(...args) {
      const lease = await native.acquire(...args);
      if (revoke) f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
      return lease;
    },
    lookup: (...args) => native.lookup(...args),
  }});
  const origin = await listen(t, (req, res) => {calls++; return handler(req, res);});
  const app = new AcquireManagedTaskLease({authority: new SqliteTaskAuthority({database: f.database}), leaser: remote(origin)});
  const request = data.request('cache');
  f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  await assert.rejects(app.execute(jobId, request), hasCode('FORBIDDEN'));
  await assert.rejects(app.lookup(jobId, request), hasCode('FORBIDDEN'));
  assert.equal(calls, 0);
  f.database.exec("INSERT INTO v2_machine_grants VALUES('alice','node-1',4)");
  revoke = true;
  await assert.rejects(app.execute(jobId, request), hasCode('FORBIDDEN'));
  const snapshot = await leaseSnapshot(data, 'cache'); assert.equal(snapshot.length, 1);
  await assert.rejects(app.lookup(jobId, request), hasCode('FORBIDDEN'));
  assert.equal(calls, 1);
  assert.deepEqual(await leaseSnapshot(data, 'cache'), snapshot);
});

test('remote errors, malformed or mismatched receipts are unknown, never absence or permission to resend', async t => {
  const request = {machineId: 'node-1', jobId: randomUUID(), source: {kind: 'cache', datasetId: 'images', version: 'a'.repeat(64)}};
  const receipt = {...request, accountId: 'alice', leaseId: randomUUID(), readOnly: true};
  const variants = [
    ['wrong task', {...receipt, jobId: randomUUID()}], ['wrong account', {...receipt, accountId: 'bob'}],
    ['wrong node', {...receipt, machineId: 'node-2'}], ['wrong kind', {...receipt, source: {...request.source, kind: 'warehouse'}}],
    ['wrong dataset', {...receipt, source: {...request.source, datasetId: 'other'}}],
    ['wrong version', {...receipt, source: {...request.source, version: 'b'.repeat(64)}}],
    ['writeable', {...receipt, readOnly: false}], ['host path', {...receipt, path: '/private/path'}],
    ['missing result', undefined], ['invalid lease ID', {...receipt, leaseId: 'broken'}],
    ['503', undefined], ['redirect', undefined], ['oversize', undefined], ['invalid JSON', undefined],
  ];
  for (const [variant, result] of variants) {
    await t.test(variant, async t => {
      let calls = 0;
      const origin = await listen(t, (_req, res) => {
        calls++;
        if (variant === '503') {res.writeHead(503); res.end('private diagnostic');}
        else if (variant === 'redirect') {res.writeHead(302, {Location: '/elsewhere'}); res.end();}
        else if (variant === 'oversize') res.end('x'.repeat(9000));
        else if (variant === 'invalid JSON') res.end('{');
        else res.end(JSON.stringify({result}));
      });
      for (const operation of ['acquire', 'lookup']) {
        await assert.rejects(remote(origin)[operation](request, context), hasCode('MANAGED_DATA_LEASE_UNAVAILABLE'));
      }
      assert.equal(calls, 2);
    });
  }
  const origin = await listen(t, (_req, res) => res.end(JSON.stringify({result: null})));
  await assert.rejects(remote(origin).acquire(request, context), hasCode('MANAGED_DATA_LEASE_UNAVAILABLE'));
  assert.equal(await remote(origin).lookup(request, context), null);
});

test('node validates its own receipt and does not expose malformed private data', async t => {
  const request = {machineId: 'node-1', jobId: randomUUID(), source: {kind: 'cache', datasetId: 'images', version: 'a'.repeat(64)}};
  const unexpected = async () => ({...request, accountId: 'alice', leaseId: randomUUID(), readOnly: true, path: '/private/native/path'});
  const origin = await listen(t, createManagedDataLeaseHandler({machineId: 'node-1', credential,
    leaser: {acquire: unexpected, lookup: unexpected}, reportError() {}}));
  for (const route of [acquireRoute, lookupRoute]) {
    const response = await fetch(origin + route, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${credential}`},
      body: JSON.stringify({request, accountId: 'alice'})});
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {error: {code: 'INTERNAL_ERROR'}});
  }
});

test('unknown-node and timed-out operations do not retry or change target', async t => {
  const request = {machineId: 'node-1', jobId: randomUUID(), source: {kind: 'cache', datasetId: 'images', version: 'a'.repeat(64)}};
  let calls = 0;
  const origin = await listen(t, () => {calls++;});
  const client = remote(origin, {timeoutMs: 100});
  for (const operation of ['acquire', 'lookup']) {
    await assert.rejects(client[operation]({...request, machineId: 'unknown'}, context), hasCode('MANAGED_DATA_LEASE_UNAVAILABLE'));
  }
  assert.equal(calls, 0);
  for (const operation of ['acquire', 'lookup']) {
    await assert.rejects(client[operation](request, context), hasCode('MANAGED_DATA_LEASE_UNAVAILABLE'));
  }
  assert.ok(calls <= 2);
});
