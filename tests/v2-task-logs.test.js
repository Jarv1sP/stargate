import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, writeFile, appendFile, rename, stat, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {dispatchFixture} from './helpers/v2-dispatch-fixture.mjs';
import {publicServer, nativeNode, cli} from './helpers/v2-task-read-servers.mjs';
import {loginRequest} from './helpers/v2-session-fixture.mjs';
import {TaskClient} from '../src/client/task-client.mjs';
import {TaskLogReader} from '../src/client/task-log-reader.mjs';
import {ClientSession} from '../src/client/session.mjs';
import {TASK_LOGS_ROUTE, parseTaskLogRequest, parseTaskLogResult, parseLogChunk} from '../src/contracts/task-logs.mjs';
import {TaskReadLane} from '../src/application/task-read-lane.mjs';
import {ApiError} from '../src/client/errors.mjs';

const hasCode = code => error => error.code === code;
const initial = jobId => ({jobId, attemptId: null, fileId: null, offset: null, maxBytes: 65536});
async function fixture(t, options = {}) {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const node = await nativeNode(t, f, options), api = await publicServer(t, f, node.nodes);
  return {...f, ...api, ...node, apiOrigin: api.origin,
    logPath: join(node.native.logRoot, `${node.native.nodeJobId}-${node.native.attemptId}.log`)};
}

test('real logs traverse native reference, exact file, two HTTP boundaries and the shared SDK without state writes', async t => {
  const text = '第一轮训练 🙂\nepoch 3/10\n', f = await fixture(t, {logText: text});
  const before = await stat(f.logPath), changes = f.database.prepare('SELECT total_changes() n').get().n;
  const result = await f.client.logs(initial(f.jobId));
  assert.equal(result.log.kind, 'chunk');
  assert.equal(result.log.chunk.attemptId, f.native.attemptId);
  assert.equal(result.log.chunk.receipt.nodeJobId, f.native.nodeJobId);
  assert.equal(result.log.chunk.receipt.gpuCount, 2);
  assert.equal(Buffer.from(result.log.chunk.dataBase64, 'base64').toString(), text);
  assert.equal(result.task.stage, 'SENDING');
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, changes);
  assert.equal((await stat(f.logPath)).ino, before.ino); assert.equal((await stat(f.logPath)).mtimeMs, before.mtimeMs);
  for (const field of ['log_path', 'logRoot', 'nativeReceipt', 'private-never-executed', 'not-in-observation']) {
    assert.equal(JSON.stringify(result).includes(field), false);
  }
  const after = await f.client.logs({...initial(f.jobId), attemptId: result.log.chunk.attemptId, fileId: result.log.chunk.fileId, offset: result.log.chunk.nextOffset});
  assert.equal(after.log.chunk.dataBase64, ''); assert.equal(after.log.chunk.attemptState, 'RUNNING');
});

test('browser and CLI follow the same fixed attempt, retaining split UTF-8 and exact output bytes', async t => {
  const text = '开始🙂\n结束\n', f = await fixture(t, {logText: text, terminal: true});
  const reader = new TaskLogReader({client: f.client, jobId: f.jobId, from: 'start', maxBytes: 1});
  const parts = [];
  for (;;) {const result = await reader.read(); parts.push(result.text); if (result.atEnd) break;}
  assert.equal(parts.join(''), text);
  assert.equal(reader.cursor.attemptId, f.native.attemptId);
  assert.equal(reader.cursor.offset, Buffer.byteLength(text)); reader.close();
  const browser = await chromium.launch({headless: true}); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(f.apiOrigin);
  const browserResult = await page.evaluate(async ({jobId, login}) => {
    const {TaskClient} = await import('/modules/client/task-client.mjs');
    const {TaskLogReader} = await import('/modules/client/task-log-reader.mjs');
    const {SessionClient} = await import('/modules/client/session-client.mjs');
    const {JsonHttpTransport} = await import('/modules/client/http-transport.mjs');
    const transport = new JsonHttpTransport({baseUrl: location.origin});
    await new SessionClient({transport, delivery: 'cookie'}).login(login);
    const reader = new TaskLogReader({client: new TaskClient({transport}), jobId, from: 'start', maxBytes: 2});
    const parts = [];
    for (;;) {const result = await reader.read(); parts.push(result.text); if (result.atEnd) break;}
    const cursor = reader.cursor; reader.close(); return {text: parts.join(''), cursor};
  }, {jobId: f.jobId, login: loginRequest});
  assert.equal(browserResult.text, text); assert.equal(browserResult.cursor.attemptId, f.native.attemptId);
  const folder = await mkdtemp(join(tmpdir(), 'v2-log-cli-')); t.after(() => rm(folder, {recursive: true, force: true}));
  const args = ['--url', f.apiOrigin, '--credentials', join(folder, 'credentials.sqlite')];
  const login = await cli([...args, 'login', '--username', 'alice', '--password-stdin'], loginRequest.password);
  assert.equal(login.code, 0, login.stderr);
  const output = await cli([...args, 'task-logs', '--job', f.jobId, '--start', '--follow', '--bytes', '2']);
  assert.equal(output.code, 0, output.stderr); assert.deepEqual(output.bytes, Buffer.from(text));
  const json = await cli([...args, 'task-logs', '--job', f.jobId, '--json', '--bytes', '4']);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(Buffer.from(JSON.parse(json.stdout).log.chunk.dataBase64, 'base64'), Buffer.from(text).subarray(-4));
  const binary = Buffer.from([0, 255, 254, 10]); await writeFile(f.logPath, binary);
  const raw = await cli([...args, 'task-logs', '--job', f.jobId, '--start']);
  assert.equal(raw.code, 0, raw.stderr); assert.deepEqual(raw.bytes, binary);
  assert.equal(f.dispatches.getForTask(f.jobId).state, 'SENDING');
});

test('append follows the original file while replacement and truncation preserve the last accepted cursor', async t => {
  const f = await fixture(t, {logText: 'first\n'}), reader = new TaskLogReader({client: f.client, jobId: f.jobId});
  const first = await reader.read(); assert.equal(first.text, 'first\n'); assert.equal(first.atEnd, false);
  const bound = reader.cursor;
  await appendFile(f.logPath, 'second\n');
  const next = await reader.read(); assert.equal(next.text, 'second\n'); assert.equal(reader.cursor.fileId, bound.fileId);
  const cursor = reader.cursor;
  await rename(f.logPath, f.logPath + '.old'); await writeFile(f.logPath, 'replacement\n');
  await assert.rejects(reader.read(), hasCode('TASK_LOG_CHANGED')); assert.deepEqual(reader.cursor, cursor);
  const fresh = new TaskLogReader({client: f.client, jobId: f.jobId});
  assert.equal((await fresh.read()).text, 'replacement\n');
  const after = fresh.cursor; await writeFile(f.logPath, '');
  await assert.rejects(fresh.read(), hasCode('TASK_LOG_CHANGED')); assert.deepEqual(fresh.cursor, after);
  reader.close(); fresh.close();
});

test('unobserved rounds, missing logs and unknown nodes never become new files or alternate attempts', async t => {
  const f = await fixture(t), result = await f.client.logs(initial(f.jobId));
  const absent = await f.client.logs({...initial(f.jobId), attemptId: 'A' + 'f'.repeat(32)});
  assert.equal(absent.log.kind, 'not-observed'); assert.equal(absent.log.chunk, null);
  await rename(f.logPath, f.logPath + '.removed');
  const missing = await f.client.logs({...initial(f.jobId), attemptId: result.log.chunk.attemptId, fileId: result.log.chunk.fileId, offset: result.log.chunk.nextOffset});
  assert.equal(missing.log.kind, 'unavailable');
  await assert.rejects(readFile(f.logPath), {code: 'ENOENT'});
  assert.equal(f.dispatches.getForTask(f.jobId).state, 'SENDING');
  assert.equal(f.database.prepare('SELECT state FROM v2_compute_claims WHERE job_id=?').get(f.jobId).state, 'HELD');
});

test('log requests reject path/identity injection and current access is checked around the read', async t => {
  const f = await fixture(t);
  for (const extra of [{logRoot: '/private'}, {path: '/private'}, {accountId: 'other'}, {machineId: 'other'}]) {
    await assert.rejects(f.transport.request(TASK_LOGS_ROUTE, {...initial(f.jobId), ...extra}), hasCode('INVALID_REQUEST'));
  }
  f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  await assert.rejects(f.client.logs(initial(f.jobId)), hasCode('FORBIDDEN'));
  f.database.exec("INSERT INTO v2_machine_grants VALUES('alice','node-1',4)");
  const original = f.nodes.logs.bind(f.nodes);
  f.nodes.logs = async (...args) => {
    const result = await original(...args);
    f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
    return result;
  };
  await assert.rejects(f.client.logs(initial(f.jobId)), hasCode('FORBIDDEN'));
  assert.equal(f.database.prepare('SELECT state FROM v2_compute_claims WHERE job_id=?').get(f.jobId).state, 'HELD');
});

function fakeClient(text = '训练🙂') {
  const jobId = randomUUID(), dispatchId = randomUUID(), session = new ClientSession(), bytes = Buffer.from(text), calls = [];
  const receipt = {jobId, dispatchId, accountId: 'alice', machineId: 'node-1', gpuCount: 1, requestHash: 'a'.repeat(64), nodeJobId: 'J0123456789ab'};
  const task = {jobId, name: 'fixture', description: '', submitter: {accountId: 'alice', username: 'alice', displayName: 'Alice'}, createdAtMs: 1,
    stage: 'ACCEPTED', dispatch: {dispatchId, machineId: 'node-1', gpuCount: 1, state: 'ACCEPTED', nodeJobId: receipt.nodeJobId}};
  const state = {kind: 'chunk', attemptState: 'EXITED_SUCCESS', failure: null, mutate: () => {}, wait: null};
  const client = new TaskClient({transport: {session, async request(route, input) {
    assert.equal(route, TASK_LOGS_ROUTE); calls.push({...input}); if (state.wait) await state.wait;
    if (state.failure) throw state.failure;
    const offset = input.offset ?? Math.max(0, bytes.length - input.maxBytes), data = bytes.subarray(offset, offset + input.maxBytes);
    const chunk = {receipt, attemptId: 'A' + 'b'.repeat(32), ordinal: 1, attemptState: state.attemptState, fileId: 'c'.repeat(64),
      offset, nextOffset: offset + data.length, observedSize: bytes.length, dataBase64: data.toString('base64')};
    const result = {task, log: {kind: state.kind, chunk: state.kind === 'chunk' ? chunk : null}}; state.mutate(result); return {result};
  }}});
  return {client, jobId, state, calls, session};
}

test('cursor survives unavailable reads and never silently changes round or file after binding', async () => {
  const f = fakeClient(), reader = new TaskLogReader({client: f.client, jobId: f.jobId, from: 'start', maxBytes: 1});
  const first = await reader.read(); assert.equal(first.text, '');
  const cursor = reader.cursor;
  f.state.kind = 'unavailable'; assert.equal((await reader.read()).text, ''); assert.deepEqual(reader.cursor, cursor);
  f.state.kind = 'chunk'; f.state.mutate = value => value.log.chunk.attemptId = 'A' + 'd'.repeat(32);
  await assert.rejects(reader.read(), hasCode('INVALID_API_RESPONSE')); assert.deepEqual(reader.cursor, cursor);
  f.state.mutate = () => {};
  const parts = [];
  for (;;) {const result = await reader.read(); parts.push(result.text); if (result.atEnd) break;}
  assert.equal(parts.join(''), '训练🙂');
  assert.ok(f.calls.slice(1).every(value => value.attemptId === cursor.attemptId && value.fileId === cursor.fileId));
  reader.close();
});

test('log reader rejects concurrent advancement, closed viewers and changed client identities before accepting bytes', async () => {
  const f = fakeClient(); let release;
  f.state.wait = new Promise(resolve => release = resolve);
  const reader = new TaskLogReader({client: f.client, jobId: f.jobId, from: 'start'}), original = reader.cursor;
  const pending = reader.read(), closed = assert.rejects(pending, hasCode('LOG_READER_CLOSED'));
  await assert.rejects(reader.read(), hasCode('LOG_READ_IN_PROGRESS'));
  reader.close(); release(); await closed; assert.deepEqual(reader.cursor, original);
  const second = new TaskLogReader({client: f.client, jobId: f.jobId}); f.session.replace();
  const count = f.calls.length;
  await assert.rejects(second.read(), hasCode('SESSION_CHANGED')); assert.equal(f.calls.length, count);
});

test('caller cancellation and a lost reply leave the byte cursor and decoder unchanged', async () => {
  const f = fakeClient(), reader = new TaskLogReader({client: f.client, jobId: f.jobId, from: 'start', maxBytes: 1});
  await reader.read(); const cursor = reader.cursor;
  f.state.failure = new ApiError('NETWORK_UNAVAILABLE');
  await assert.rejects(reader.read(), hasCode('NETWORK_UNAVAILABLE')); assert.deepEqual(reader.cursor, cursor);
  f.state.failure = null; const controller = new AbortController();
  f.state.mutate = () => controller.abort();
  await assert.rejects(reader.read({signal: controller.signal}), hasCode('REQUEST_ABORTED')); assert.deepEqual(reader.cursor, cursor);
  f.state.mutate = () => {}; const parts = [];
  for (;;) {const result = await reader.read(); parts.push(result.text); if (result.atEnd) break;}
  assert.equal(parts.join(''), '训练🙂'); reader.close();
});

test('empty current end, LOST and STUCK do not assert the producer stopped', async () => {
  for (const attemptState of ['RUNNING', 'DRAINING', 'LOST', 'STUCK']) {
    const f = fakeClient(''); f.state.attemptState = attemptState;
    const reader = new TaskLogReader({client: f.client, jobId: f.jobId});
    const result = await reader.read(); assert.equal(result.text, ''); assert.equal(result.atEnd, false); reader.close();
  }
});

test('log schema rejects malformed bytes and cursors before they can advance a viewer', async () => {
  const f = fakeClient('abc'), result = await f.client.logs(initial(f.jobId));
  assert.deepEqual(parseTaskLogResult(result), result);
  for (const mutate of [v => {v.dataBase64 = '***';}, v => {v.dataBase64 = 'YWJj===';}, v => {v.nextOffset++;},
    v => {v.observedSize = -1;}, v => {v.logPath = '/private';}]) {
    const chunk = structuredClone(result.log.chunk); mutate(chunk);
    assert.throws(() => parseLogChunk(chunk), hasCode('INVALID_API_RESPONSE'));
  }
  for (const change of [{offset: 1}, {maxBytes: 0}, {maxBytes: 65537}, {attemptId: '../other'}, {fileId: 'c'.repeat(64)}]) {
    assert.throws(() => parseTaskLogRequest({...initial(f.jobId), ...change}), hasCode('INVALID_REQUEST'));
  }
});

test('status and log operations share one read lane rather than independent capacity pools', async () => {
  let resolve; const blocked = new Promise(value => resolve = value);
  const lane = new TaskReadLane({totalLimit: 1, machineLimit: 1, nodes: {observe: () => blocked, logs: async () => 'log'}});
  const pending = lane.observe({machineId: 'node-1', dispatchId: 'same'});
  await assert.rejects(lane.logs({machineId: 'node-1', dispatchId: 'same'}), hasCode('TASK_READ_BUSY'));
  resolve('state'); await pending;
  assert.equal(await lane.logs({machineId: 'node-1', dispatchId: 'same'}), 'log');
});
