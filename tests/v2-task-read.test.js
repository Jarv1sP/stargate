import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {dispatchFixture} from './helpers/v2-dispatch-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {loginRequest} from './helpers/v2-session-fixture.mjs';
import {SqliteTaskReads} from '../src/infrastructure/sqlite/task-reads.mjs';
import {ReadTrainingTask} from '../src/application/read-training-task.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';
import {createNodeDispatchBindingsSchema, SqliteNodeDispatchBindings} from '../src/infrastructure/sqlite/node-dispatch-bindings.mjs';
import {assembleNodeTaskRead, assembleSqliteTaskRead} from '../src/bootstrap/task-read.mjs';
import {assembleSqliteSession} from '../src/bootstrap/sqlite-session.mjs';
import {HttpJobObserver} from '../src/infrastructure/http-job-observer.mjs';
import {TaskClient} from '../src/client/task-client.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {TASK_READ_ROUTE, NODE_JOB_OBSERVATION_ROUTE, parseTaskReadRequest, parseTaskReadResult, parseNodeJobObservation} from '../src/contracts/task-read.mjs';

const credential = 'c'.repeat(64), hasCode = code => error => error.code === code;
function submission() {
  return {...trainingSubmission(), name: 'ImageNet 两卡训练', description: '直接读取已有数据；保留训练输出'};
}
function observation(f) {
  return {receipt: {dispatchId: f.prepared.dispatchId, jobId: f.jobId, accountId: 'alice', machineId: 'node-1', gpuCount: 2,
    requestHash: f.database.prepare('SELECT payload_hash FROM v2_training_requests WHERE job_id=?').get(f.jobId).payload_hash, nodeJobId: 'J0123456789ab'},
    state: 'RUNNING', priority: 2, reason: null, latestAttempt: null, progress: null, latestEventId: 0};
}
async function fixture(t) {
  const f = await dispatchFixture(t, {submission: submission()});
  const state = {value: observation(f), failure: null, calls: [], during: async () => {}};
  const nodes = {async observe(reference) {
    state.calls.push(structuredClone(reference)); await state.during();
    if (state.failure) throw state.failure; return structuredClone(state.value);
  }};
  const tasks = new SqliteTaskReads({database: f.database}), app = new ReadTrainingTask({tasks, nodes, clock: () => f.now});
  const send = () => f.dispatches.beginSend(f.jobId, f.now);
  return {...f, state, tasks, app, nodes, send};
}
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}
async function publicServer(t, f, nodes = f.nodes) {
  let tasks, sessions;
  const modules = new Map(['client/task-client.mjs', 'client/session-client.mjs', 'client/http-transport.mjs', 'client/session.mjs', 'client/errors.mjs',
    'contracts/task-read.mjs', 'contracts/dispatch-receipt.mjs', 'contracts/session.mjs', 'contracts/errors.mjs']
    .map(name => ['/modules/' + name, new URL('../src/' + name, import.meta.url)]));
  const origin = await listen(t, async (req, res) => {
    if (req.url === '/') {res.writeHead(200, {'Content-Type': 'text/html'}); res.end('<!doctype html><title>Task SDK fixture</title>'); return;}
    if (modules.has(req.url)) {res.writeHead(200, {'Content-Type': 'text/javascript'}); res.end(await readFile(modules.get(req.url))); return;}
    return req.url.startsWith('/api/v2/session/') ? sessions(req, res) : tasks(req, res);
  });
  const options = {database: f.database, publicOrigin: origin, clock: () => f.now, reportError() {}};
  tasks = assembleSqliteTaskRead({...options, nodes}); sessions = assembleSqliteSession(options);
  const transport = new JsonHttpTransport({baseUrl: origin});
  await new SessionClient({transport, delivery: 'token'}).login(loginRequest);
  return {origin, transport, client: new TaskClient({transport})};
}

test('read returns original human task metadata and distinguishes preparation from native execution without writes', async t => {
  const f = await fixture(t), changes = f.database.prepare('SELECT total_changes() n').get().n;
  const result = await f.app.execute(f.actor, {jobId: f.jobId});
  assert.equal(result.task.name, submission().name); assert.equal(result.task.description, submission().description);
  assert.deepEqual(result.task.submitter, {accountId: 'alice', username: 'alice', displayName: 'Alice'});
  assert.equal(result.task.stage, 'PREPARED'); assert.deepEqual(result.observation, {kind: 'not-queried', node: null});
  assert.deepEqual(f.state.calls, []);
  assert.deepEqual(parseTaskReadResult(result), result);
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, changes);
  assert.equal(JSON.stringify(result).includes('train.py'), false);
});

test('recorded, queued and canceled-before-send tasks remain readable without inventing a native job', async t => {
  const f = await fixture(t), jobId = f.job();
  assert.equal((await f.app.execute(f.actor, {jobId})).task.stage, 'RECORDED');
  const pending = f.queue.enqueue(f.actor, submission(), f.now).request.jobId;
  assert.equal((await f.app.execute(f.actor, {jobId: pending})).task.stage, 'QUEUED');
  f.queue.cancel(f.actor, pending, f.now);
  const canceled = await f.app.execute(f.actor, {jobId: pending});
  assert.equal(canceled.task.stage, 'CANCELED'); assert.equal(canceled.task.dispatch, null);
  assert.deepEqual(f.state.calls, []);
});

test('SENDING and UNKNOWN can observe the original node without accepting, resending or settling the dispatch', async t => {
  const f = await fixture(t), sending = f.send();
  for (const state of ['SENDING', 'UNKNOWN', 'ACCEPTED']) {
    if (state !== 'SENDING') f.dispatches.recordSendOutcome({dispatchId: f.prepared.dispatchId, senderToken: sending.senderToken,
      nodeJobId: state === 'UNKNOWN' ? null : f.state.value.receipt.nodeJobId});
    const before = f.database.prepare('SELECT total_changes() n').get().n;
    const result = await f.app.execute(f.actor, {jobId: f.jobId});
    assert.equal(result.task.stage, state); assert.equal(result.observation.kind, 'observed');
    assert.equal(result.observation.node.state, 'RUNNING');
    assert.deepEqual(f.state.calls.at(-1), {machineId: 'node-1', dispatchId: f.prepared.dispatchId});
    assert.equal(f.dispatches.getForTask(f.jobId).state, state);
    assert.equal(f.database.prepare('SELECT total_changes() n').get().n, before);
  }
  assert.equal(f.state.calls.length, 3);
  assert.equal(f.database.prepare('SELECT state FROM v2_compute_claims WHERE job_id=?').get(f.jobId).state, 'HELD');
});

test('null and unavailable are observations, never a task failure, absence proof, refund or a second send', async t => {
  const f = await fixture(t); f.send();
  f.state.value = null;
  assert.equal((await f.app.execute(f.actor, {jobId: f.jobId})).observation.kind, 'not-observed');
  f.state.failure = new ApplicationError('NODE_JOB_UNAVAILABLE');
  assert.equal((await f.app.execute(f.actor, {jobId: f.jobId})).observation.kind, 'unavailable');
  assert.equal(f.state.calls.length, 2); assert.equal(f.dispatches.getForTask(f.jobId).state, 'SENDING');
  assert.equal(f.database.prepare('SELECT state FROM v2_compute_claims WHERE job_id=?').get(f.jobId).state, 'HELD');
});

test('current session, task ownership and machine access are required before a node query', async t => {
  for (const change of ['other-owner', 'revoked', 'machine', 'disabled']) {
    const f = await fixture(t); f.send();
    if (change === 'other-owner') {
      f.database.exec("INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob')");
      f.database.prepare('UPDATE v2_training_requests SET account_id=? WHERE job_id=?').run('bob', f.jobId);
    }
    if (change === 'revoked') f.database.exec('UPDATE v2_sessions SET revoked=1');
    if (change === 'machine') f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
    if (change === 'disabled') f.database.exec("UPDATE v2_machines SET enabled=0 WHERE id='node-1'");
    await assert.rejects(f.app.execute(f.actor, {jobId: f.jobId}), hasCode(change === 'revoked' ? 'UNAUTHENTICATED' : 'FORBIDDEN'));
    assert.deepEqual(f.state.calls, []);
  }
});

test('display/limits changes do not revoke existing task reads; real account or machine revocation masks a simultaneous node failure', async t => {
  const f = await fixture(t); f.send();
  f.state.during = async () => {
    f.database.exec("UPDATE v2_accounts SET display_name='新的显示名'; UPDATE v2_machine_grants SET max_cards=1; UPDATE v2_compute_policies SET total_cards=0,revision=revision+1");
    f.database.prepare('UPDATE v2_training_requests SET task_name=?,description=? WHERE job_id=?').run('更新后的任务名', '更新后的说明', f.jobId);
  };
  const updated = await f.app.execute(f.actor, {jobId: f.jobId});
  assert.equal(updated.observation.kind, 'observed'); assert.equal(updated.task.name, '更新后的任务名');
  assert.equal(updated.task.description, '更新后的说明'); assert.equal(updated.task.submitter.displayName, 'Alice');
  assert.equal(f.state.calls.length, 1);
  f.state.failure = new ApplicationError('NODE_JOB_UNAVAILABLE');
  f.state.during = async () => {f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");};
  await assert.rejects(f.app.execute(f.actor, {jobId: f.jobId}), hasCode('FORBIDDEN'));
  assert.equal(f.state.calls.length, 2);
});

test('an active administrator can observe another account task but cannot continue after its own session is revoked', async t => {
  const f = await fixture(t); f.send();
  f.database.exec("INSERT INTO v2_accounts(id,username,display_name,role) VALUES('operator','operator','管理员','admin')");
  const session = {...f.database.prepare('SELECT * FROM v2_sessions WHERE id=?').get(f.actor.sessionId),
    id: randomUUID(), account_id: 'operator', token_hash: 'e'.repeat(64)};
  const fields = Object.keys(session);
  f.database.prepare(`INSERT INTO v2_sessions(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(...Object.values(session));
  const actor = {id: 'operator', sessionId: session.id};
  assert.equal((await f.app.execute(actor, {jobId: f.jobId})).task.submitter.accountId, 'alice');
  f.state.during = async () => f.database.prepare('UPDATE v2_sessions SET revoked=1 WHERE id=?').run(session.id);
  await assert.rejects(f.app.execute(actor, {jobId: f.jobId}), hasCode('UNAUTHENTICATED'));
  assert.equal(f.state.calls.length, 2);
});

test('client identity replacement discards an in-flight task reply without repeating the observation', async t => {
  const f = await fixture(t); f.send(); const api = await publicServer(t, f);
  let entered, release;
  const started = new Promise(resolve => entered = resolve), waiting = new Promise(resolve => release = resolve);
  f.state.during = async () => {entered(); await waiting;};
  const pending = api.client.read({jobId: f.jobId});
  const denied = assert.rejects(pending, hasCode('SESSION_CHANGED'));
  await started;
  api.transport.session.replace(); release();
  await denied;
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.dispatches.getForTask(f.jobId).state, 'SENDING');
});

test('wrong task identity or a conflicting native job cannot be displayed; matching late acceptance remains valid', async t => {
  const f = await fixture(t), sending = f.send(), original = observation(f);
  for (const key of ['jobId', 'accountId', 'requestHash', 'dispatchId', 'machineId', 'gpuCount']) {
    f.state.value = structuredClone(original); f.state.value.receipt[key] = key === 'gpuCount' ? 1 : 'changed';
    await assert.rejects(f.app.execute(f.actor, {jobId: f.jobId}), hasCode('TASK_OBSERVATION_MISMATCH'));
  }
  f.state.value = original;
  f.state.during = async () => f.dispatches.recordSendOutcome({dispatchId: f.prepared.dispatchId, senderToken: sending.senderToken, nodeJobId: original.receipt.nodeJobId});
  const confirmed = await f.app.execute(f.actor, {jobId: f.jobId});
  assert.equal(confirmed.task.stage, 'ACCEPTED'); assert.equal(confirmed.observation.kind, 'observed');
  f.state.during = async () => {}; f.state.value.receipt.nodeJobId = 'Jdifferent';
  await assert.rejects(f.app.execute(f.actor, {jobId: f.jobId}), hasCode('TASK_OBSERVATION_MISMATCH'));
});

test('public request accepts only a platform task ID and never native IDs, paths, caller identity or a machine override', async t => {
  const f = await fixture(t); f.send(); const api = await publicServer(t, f);
  for (const added of [{nodeJobId: 'J0123456789ab'}, {accountId: 'bob'}, {machineId: 'node-2'}, {path: '/arbitrary'}]) {
    await assert.rejects(api.transport.request(TASK_READ_ROUTE, {jobId: f.jobId, ...added}), hasCode('INVALID_REQUEST'));
  }
  assert.throws(() => parseTaskReadRequest({jobId: 'J0123456789ab'}), hasCode('INVALID_REQUEST'));
  assert.deepEqual(f.state.calls, []);
  assert.equal((await api.client.read({jobId: f.jobId})).task.name, submission().name);
  assert.equal(f.state.calls.length, 1);
});

async function nativeNode(t, f) {
  const helper = fileURLToPath(new URL('./helpers/v2-job-observation-server.py', import.meta.url));
  const child = spawn(process.env.V2_PYTHON || 'python3', ['-B', helper], {stdio: ['pipe', 'pipe', 'pipe']});
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  const exited = once(child, 'exit');
  t.after(async () => {child.stdin.end(); await exited;});
  const lines = createInterface({input: child.stdout});
  const ready = once(lines, 'line');
  child.stdin.write(JSON.stringify({dispatchId: f.prepared.dispatchId}) + '\n');
  const [line] = await Promise.race([ready, exited.then(() => {throw new Error(stderr || 'native fixture exited before readiness');})]);
  const native = JSON.parse(line), database = new DatabaseSync(':memory:');
  t.after(() => database.close()); createNodeDispatchBindingsSchema(database);
  const binding = {dispatchId: f.prepared.dispatchId, jobId: f.jobId, accountId: 'alice', machineId: 'node-1', gpuCount: 2,
    requestHash: observation(f).receipt.requestHash, nativeDigest: native.nativeDigest, nativeMaxGpus: native.nativeMaxGpus,
    nativeOwner: native.nativeOwner, nativeName: native.nativeName};
  new SqliteNodeDispatchBindings({database, machineId: 'node-1'}).bind(binding);
  const origin = await listen(t, assembleNodeTaskRead({database, machineId: 'node-1', credential, socketPath: native.socketPath,
    python: process.env.V2_PYTHON || 'python3', reportError() {}}));
  return {native, origin, nodes: new HttpJobObserver({nodes: [{machineId: 'node-1', origin, credential}]})};
}
async function cli(args, input = '') {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/v2-client.mjs', import.meta.url)), ...args], {stdio: ['pipe', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const exited = once(child, 'exit'); child.stdin.end(input);
  const [code] = await exited;
  return {code, stdout, stderr};
}

test('real native SQLite/socket, node HTTP, public API, browser SDK and CLI agree without mutating the task', async t => {
  const f = await fixture(t); f.send();
  const node = await nativeNode(t, f), api = await publicServer(t, f, node.nodes);
  const nodeResult = await api.client.read({jobId: f.jobId});
  assert.equal(nodeResult.task.name, submission().name);
  assert.equal(nodeResult.observation.kind, 'observed');
  assert.equal(nodeResult.observation.node.receipt.nodeJobId, node.native.nodeJobId);
  assert.equal(nodeResult.observation.node.latestAttempt.ordinal, 1);
  assert.deepEqual(nodeResult.observation.node.latestAttempt.assignedGpus, [{uuid: 'GPU-0', index: 0}, {uuid: 'GPU-1', index: 1}]);
  assert.equal(nodeResult.observation.node.progress.snapshot.epochsCompleted, 3);
  assert.equal(nodeResult.observation.node.progress.heartbeatAgeSeconds, 10);
  const text = JSON.stringify(nodeResult);
  for (const privateValue of ['private-never-executed', 'not-in-observation', 'unit_token', 'control_dir', 'socketPath']) assert.equal(text.includes(privateValue), false);
  const browser = await chromium.launch({headless: true}); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(api.origin);
  const browserResult = await page.evaluate(async ({request, login}) => {
    const {JsonHttpTransport} = await import('/modules/client/http-transport.mjs');
    const {SessionClient} = await import('/modules/client/session-client.mjs');
    const {TaskClient} = await import('/modules/client/task-client.mjs');
    const transport = new JsonHttpTransport({baseUrl: location.origin});
    await new SessionClient({transport, delivery: 'cookie'}).login(login);
    globalThis.taskClient = new TaskClient({transport});
    return globalThis.taskClient.read(request);
  }, {request: {jobId: f.jobId}, login: loginRequest});
  assert.deepEqual(browserResult, nodeResult);
  const folder = await mkdtemp(join(tmpdir(), 'v2-task-cli-')); t.after(() => rm(folder, {recursive: true, force: true}));
  const args = ['--url', api.origin, '--credentials', join(folder, 'credentials.sqlite')];
  const login = await cli([...args, 'login', '--username', 'alice', '--password-stdin'], loginRequest.password);
  assert.equal(login.code, 0, login.stderr);
  const command = await cli([...args, 'task', '--job', f.jobId]);
  assert.equal(command.code, 0, command.stderr); assert.deepEqual(JSON.parse(command.stdout), nodeResult);
  const before = f.database.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(await api.client.read({jobId: f.jobId}), nodeResult);
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(f.dispatches.getForTask(f.jobId).state, 'SENDING');
  f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  const denied = await page.evaluate(async jobId => {
    try {await globalThis.taskClient.read({jobId});} catch (error) {return error.code;}
  }, f.jobId);
  assert.equal(denied, 'FORBIDDEN');
  await assert.rejects(api.client.read({jobId: f.jobId}), hasCode('FORBIDDEN'));
});

test('node observations reject wrong service credentials and injected native selectors', async t => {
  const f = await fixture(t), node = await nativeNode(t, f);
  for (const [input, token, status] of [
    [{machineId: 'node-1', dispatchId: f.prepared.dispatchId}, 'a'.repeat(64), 401],
    [{machineId: 'node-2', dispatchId: f.prepared.dispatchId}, credential, 409],
    [{machineId: 'node-1', dispatchId: f.prepared.dispatchId, jobId: node.native.nodeJobId}, credential, 400],
  ]) {
    const response = await fetch(node.origin + NODE_JOB_OBSERVATION_ROUTE, {method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token}, body: JSON.stringify(input)});
    assert.equal(response.status, status); await response.body.cancel();
  }
  assert.equal(await node.nodes.observe({machineId: 'node-1', dispatchId: randomUUID()}), null);
});

test('shared response contract rejects private fields, mixed identity and malformed progress; returned objects are detached', async t => {
  const f = await fixture(t); f.send();
  const result = await f.app.execute(f.actor, {jobId: f.jobId});
  const original = structuredClone(result), parsed = parseTaskReadResult(result);
  parsed.task.submitter.displayName = 'changed'; parsed.observation.node.receipt.accountId = 'changed';
  assert.deepEqual(result, original);
  for (const edit of [value => {value.task.command = ['private'];}, value => {value.observation.node.receipt.accountId = 'bob';},
    value => {value.task.dispatch.nodeJobId = 'not-accepted';}, value => {value.observation.node.state = 'MADE_UP';},
    value => {value.observation.node.progress = {reported: true};}]) {
    const value = structuredClone(result); edit(value);
    assert.throws(() => parseTaskReadResult(value), hasCode('INVALID_API_RESPONSE'));
  }
  assert.throws(() => parseNodeJobObservation({...result.observation.node, hostPath: '/private'}), hasCode('INVALID_API_RESPONSE'));
});

test('node transport errors and malformed observations stay unavailable, with one query and no fallback', async t => {
  const f = await fixture(t); f.send();
  for (const variant of ['offline', 'wrong-node', 'wrong-dispatch', 'bad-progress', 'invalid-json', 'forbidden', 'large']) {
    let calls = 0;
    const fetch = async () => {
      calls++;
      if (variant === 'offline') throw new TypeError('connection failed', {cause: {code: 'ECONNREFUSED'}});
      if (variant === 'invalid-json') return new Response('invalid JSON');
      if (variant === 'forbidden') return new Response(JSON.stringify({error: {code: 'FORBIDDEN'}}), {status: 403});
      if (variant === 'large') return new Response('x'.repeat(2 * 1024 * 1024 + 1));
      const value = observation(f);
      if (variant === 'wrong-node') value.receipt.machineId = 'node-2';
      if (variant === 'wrong-dispatch') value.receipt.dispatchId = randomUUID();
      if (variant === 'bad-progress') value.progress = {reported: true};
      return new Response(JSON.stringify({result: value}));
    };
    const app = new ReadTrainingTask({tasks: f.tasks,
      nodes: new HttpJobObserver({nodes: [{machineId: 'node-1', origin: 'https://node.example', credential}], fetch}), clock: () => f.now});
    const before = f.database.prepare('SELECT total_changes() n').get().n;
    assert.equal((await app.execute(f.actor, {jobId: f.jobId})).observation.kind, 'unavailable');
    assert.equal(calls, 1); assert.equal(f.database.prepare('SELECT total_changes() n').get().n, before);
  }
});
