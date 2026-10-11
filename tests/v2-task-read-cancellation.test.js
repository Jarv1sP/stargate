import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {dispatchFixture} from './helpers/v2-dispatch-fixture.mjs';
import {loginRequest} from './helpers/v2-session-fixture.mjs';
import {createNodeDispatchBindingsSchema, SqliteNodeDispatchBindings} from '../src/infrastructure/sqlite/node-dispatch-bindings.mjs';
import {assembleNodeTaskRead, assembleSqliteTaskRead} from '../src/bootstrap/task-read.mjs';
import {assembleSqliteSession} from '../src/bootstrap/sqlite-session.mjs';
import {HttpJobObserver} from '../src/infrastructure/http-job-observer.mjs';
import {TaskClient} from '../src/client/task-client.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {createJsonRoutes} from '../src/api/json-http.mjs';
import {TaskReadLane} from '../src/application/task-read-lane.mjs';

const hasCode = code => error => error.code === code;
function deferred() {let resolve; const promise = new Promise(value => resolve = value); return {resolve, promise};}
async function bounded(promise) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('fixture did not settle within 3 seconds')), 3000);})]);}
  finally {clearTimeout(timer);}
}
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}
async function publicServer(t, f, nodes, readBounds) {
  let taskHandler, sessionHandler;
  const origin = await listen(t, (req, res) => req.url.startsWith('/api/v2/session/') ? sessionHandler(req, res) : taskHandler(req, res));
  const options = {database: f.database, publicOrigin: origin, clock: () => f.now, reportError: error => f.errors.push(error)};
  taskHandler = assembleSqliteTaskRead({...options, nodes, readBounds}); sessionHandler = assembleSqliteSession(options);
  const transport = new JsonHttpTransport({baseUrl: origin});
  await new SessionClient({transport, delivery: 'token'}).login(loginRequest);
  return {origin, client: new TaskClient({transport})};
}
async function remoteFixture(t) {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const directory = await mkdtemp(join(tmpdir(), 'v2-cancel-read-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const socketPath = join(directory, 'daemon.sock'), credential = 'c'.repeat(64);
  const database = new DatabaseSync(':memory:'); t.after(() => database.close()); createNodeDispatchBindingsSchema(database);
  const binding = {dispatchId: f.prepared.dispatchId, jobId: f.jobId, accountId: 'alice', machineId: 'node-1', gpuCount: 2,
    requestHash: f.database.prepare('SELECT payload_hash FROM v2_training_requests WHERE job_id=?').get(f.jobId).payload_hash,
    nativeDigest: 'b'.repeat(64), nativeOwner: 'native-owner', nativeName: 'native-name', nativeMaxGpus: 4};
  new SqliteNodeDispatchBindings({database, machineId: 'node-1'}).bind(binding);
  const requests = [], entered = deferred(), closed = deferred(), sockets = new Set();
  const state = {respond: false};
  const daemon = net.createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('close', () => {sockets.delete(socket); closed.resolve();});
    let raw = '';
    socket.on('data', chunk => {
      raw += chunk; if (!raw.endsWith('\n')) return;
      const request = JSON.parse(raw); requests.push(request); entered.resolve();
      if (state.respond) socket.end(JSON.stringify({request_id: request.request_id, ok: true, result: {
        job: {id: 'J0123456789ab', submit_key: binding.dispatchId, submit_digest: binding.nativeDigest,
          owner: binding.nativeOwner, name: binding.nativeName, gpu_count: 4, state: 'PENDING', priority: 2, state_reason: null},
        latest_attempt: null, progress: null, latest_event_id: 0,
      }}) + '\n');
    });
  });
  await new Promise(resolve => daemon.listen(socketPath, resolve));
  t.after(async () => {for (const socket of sockets) socket.destroy(); await new Promise(resolve => daemon.close(resolve));});
  const nodeOrigin = await listen(t, assembleNodeTaskRead({database, machineId: 'node-1', credential, socketPath,
    logRoot: directory, python: process.env.V2_PYTHON || 'python3', timeoutMs: 10000, readBounds: {totalLimit: 1, machineLimit: 1}, reportError: error => f.errors.push(error)}));
  const nodes = new HttpJobObserver({nodes: [{machineId: 'node-1', origin: nodeOrigin, credential}], timeoutMs: 10000});
  const api = await publicServer(t, f, nodes, {totalLimit: 1, machineLimit: 1});
  return {...f, ...api, directory, requests, entered, closed, state};
}

test('SDK cancellation reaches node HTTP and closes only the native query connection, without mutating training or retrying', async t => {
  const f = await remoteFixture(t), controller = new AbortController();
  const before = f.database.prepare('SELECT total_changes() n').get().n;
  const pending = f.client.read({jobId: f.jobId}, {signal: controller.signal});
  const canceled = assert.rejects(pending, hasCode('REQUEST_ABORTED'));
  await bounded(f.entered.promise); controller.abort(); await canceled;
  await bounded(f.closed.promise);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].op, 'job_observation');
  assert.deepEqual(f.requests[0].args, {submit_key: f.prepared.dispatchId});
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(f.dispatches.getForTask(f.jobId).state, 'SENDING');
  assert.equal(f.database.prepare('SELECT state FROM v2_compute_claims WHERE job_id=?').get(f.jobId).state, 'HELD');
  f.state.respond = true;
  const result = await f.client.read({jobId: f.jobId});
  assert.equal(result.observation.kind, 'observed');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.errors, []);
});

function cli(f, args, input = '') {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/v2-client.mjs', import.meta.url)),
    '--url', f.origin, '--credentials', join(f.directory, 'credentials.sqlite'), ...args], {stdio: ['pipe', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const done = once(child, 'close').then(([code, signal]) => ({code, signal, stdout, stderr}));
  child.stdin.end(input);
  return {child, done};
}

for (const operation of ['task', 'task-logs']) test(`SIGINT of CLI ${operation} detaches the read through both servers and leaves the original dispatch intact`, async t => {
  const f = await remoteFixture(t);
  const login = await cli(f, ['login', '--username', 'alice', '--password-stdin'], loginRequest.password).done;
  assert.equal(login.code, 0, login.stderr);
  const command = cli(f, [operation, '--job', f.jobId, ...(operation === 'task-logs' ? ['--follow'] : [])]);
  t.after(() => {if (command.child.exitCode === null && command.child.signalCode === null) command.child.kill('SIGKILL');});
  await bounded(f.entered.promise);
  command.child.kill('SIGINT');
  const canceled = await bounded(command.done);
  assert.equal(canceled.signal, 'SIGINT'); assert.equal(canceled.stdout, '');
  await bounded(f.closed.promise);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].op, operation === 'task' ? 'job_observation' : 'attempt_log_reference');
  assert.equal(f.dispatches.getForTask(f.jobId).state, 'SENDING');
  assert.deepEqual(f.errors, []);
});

test('log cancellation uses the same read-only cleanup and never calls native task cancellation', async t => {
  const f = await remoteFixture(t), controller = new AbortController();
  const request = {jobId: f.jobId, attemptId: null, fileId: null, offset: null, maxBytes: 65536};
  const pending = f.client.logs(request, {signal: controller.signal});
  const canceled = assert.rejects(pending, hasCode('REQUEST_ABORTED'));
  await bounded(f.entered.promise); controller.abort(); await canceled; await bounded(f.closed.promise);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].op, 'attempt_log_reference');
  assert.deepEqual(f.requests[0].args, {submit_key: f.prepared.dispatchId, attempt_id: null});
  assert.equal(f.dispatches.getForTask(f.jobId).state, 'SENDING'); assert.deepEqual(f.errors, []);
});

test('API deadline and capacity errors stay distinct and do not free a still-running read or GPU claim', async t => {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const gate = deferred(); let calls = 0;
  t.after(() => gate.resolve(null));
  const nodes = {observe() {return ++calls === 1 ? gate.promise : Promise.resolve(null);}};
  const api = await publicServer(t, f, nodes, {totalLimit: 1, machineLimit: 1, timeoutMs: 50});
  await assert.rejects(api.client.read({jobId: f.jobId}), error => error.code === 'TASK_READ_TIMEOUT' && error.status === 504);
  await assert.rejects(api.client.read({jobId: f.jobId}), error => error.code === 'TASK_READ_BUSY' && error.status === 429);
  assert.equal(calls, 1);
  assert.equal(f.database.prepare('SELECT state FROM v2_compute_claims WHERE job_id=?').get(f.jobId).state, 'HELD');
  gate.resolve(null); await delay(0);
  assert.equal((await api.client.read({jobId: f.jobId})).observation.kind, 'not-observed');
  assert.equal(calls, 2);
});

test('ordinary request-body completion does not cancel reads and non-read routes never receive a disconnect signal', async t => {
  const started = deferred(), gate = deferred(), finished = deferred();
  let writes = 0, context;
  const handler = createJsonRoutes({authenticate: async () => ({}), statuses: {}, reportError() {}, routes: new Map([
    ['/write', {parse: value => value, useCase: {async execute(_actor, _input, options) {
      context = options; started.resolve(); await gate.promise; writes++; finished.resolve(); return {written: true};
    }}}],
    ['/read', {readOnly: true, parse: value => value, useCase: {async execute(_actor, _input, {signal}) {
      await delay(20); assert.equal(signal.aborted, false); return {read: true};
    }}}],
  ])});
  const origin = await listen(t, handler), controller = new AbortController();
  const pending = fetch(origin + '/write', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}', signal: controller.signal});
  const canceled = assert.rejects(pending, error => error.name === 'AbortError');
  await started.promise; controller.abort(); await canceled;
  gate.resolve(); await finished.promise;
  assert.equal(writes, 1); assert.equal(context, undefined);
  const result = await fetch(origin + '/read', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), {result: {read: true}});
});

test('already-canceled node HTTP reads make no fetch and matching busy/timeout replies retry only the original observation', async () => {
  const reference = {machineId: 'node-1', dispatchId: 'aaaaaaaa-1111-4111-8111-111111111111'};
  const nodes = [{machineId: 'node-1', origin: 'https://node.example', credential: 'c'.repeat(64)}];
  let calls = 0;
  const direct = new HttpJobObserver({nodes, fetch: async () => {calls++; return new Response(JSON.stringify({result: null}));}});
  const controller = new AbortController(), reason = new Error('already canceled'); controller.abort(reason);
  await assert.rejects(direct.observe(reference, {signal: controller.signal}), error => error === reason);
  assert.equal(calls, 0);
  for (const [status, code, retry] of [[429, 'TASK_READ_BUSY', true], [504, 'TASK_READ_TIMEOUT', true],
    [500, 'TASK_READ_BUSY', false], [403, 'TASK_READ_BUSY', false], [503, 'GPUQ_JOB_UNAVAILABLE', false]]) {
    const sent = [];
    const observer = new HttpJobObserver({nodes, fetch: async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return sent.length === 1 ? new Response(JSON.stringify({error: {code}}), {status}) : new Response(JSON.stringify({result: null}));
    }});
    const lane = new TaskReadLane({nodes: observer});
    if (retry) assert.equal(await lane.observe(reference), null);
    else await assert.rejects(lane.observe(reference), hasCode('NODE_JOB_UNAVAILABLE'));
    assert.deepEqual(sent, retry ? [reference, reference] : [reference]);
  }
});
