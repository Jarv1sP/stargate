import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {dispatchFixture} from './helpers/v2-dispatch-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {publicServer, nativeNode, cli} from './helpers/v2-task-read-servers.mjs';
import {loginRequest} from './helpers/v2-session-fixture.mjs';
import {ReadTrainingTask} from '../src/application/read-training-task.mjs';
import {SqliteTaskReads} from '../src/infrastructure/sqlite/task-reads.mjs';
import {taskDiagnosticFindings, taskDiagnosticUnknowns} from '../src/domain/task-diagnostics.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';
import {TASK_DIAGNOSTICS_ROUTE, DIAGNOSTIC_UNKNOWNS, parseNodeDiagnostics, parseTaskDiagnosticResult} from '../src/contracts/task-diagnostics.mjs';
import {formatTaskDiagnostics} from '../src/client/task-diagnostic-format.mjs';
import {TaskReadLane} from '../src/application/task-read-lane.mjs';

const hasCode = code => error => error.code === code;
const codes = value => value.map(row => row.code);
const page = (items = []) => ({items, total: items.length, truncated: false});
function diagnostic() {
  const jobId = randomUUID(), dispatchId = randomUUID(), receipt = {jobId, dispatchId, accountId: 'alice', machineId: 'node-1',
    gpuCount: 4, requestHash: 'a'.repeat(64), nodeJobId: 'J0123456789ab'};
  const node = {receipt, state: 'PENDING', priority: 2, reason: null, latestAttempt: null, progress: null, latestEventId: 0,
    resources: {request: {minGpus: 3, maxGpus: 8, allowedGpuCounts: [4, 8]},
      allocation: {mode: 'external-v1', grant: {id: dispatchId, revision: 1, maxGpuCount: 3, initialMaxGpuCount: 4}},
      leases: page(), reservations: page(), pendingActions: page(), scalePlan: null}};
  const task = {jobId, name: '诊断测试', description: '', submitter: {accountId: 'alice', username: 'alice', displayName: 'Alice'},
    createdAtMs: 1, stage: 'ACCEPTED', dispatch: {dispatchId, machineId: 'node-1', gpuCount: 4, state: 'ACCEPTED', nodeJobId: receipt.nodeJobId}};
  return {task, kind: 'observed', node, quota: {machineId: 'node-1', state: 'HELD', initialGpuCount: 4, reservedGpuCount: 4}};
}
function result(value) {
  return {task: value.task, diagnostics: {kind: value.kind, node: value.node}, quota: value.quota,
    findings: taskDiagnosticFindings(value), unknowns: taskDiagnosticUnknowns(value.task)};
}

test('a raw grant count above the declared minimum is still insufficient when it covers no legal world size', () => {
  const value = diagnostic(), findings = taskDiagnosticFindings(value);
  assert.deepEqual(codes(findings), ['PLATFORM_QUOTA_HELD', 'NATIVE_WAIT_REASON_UNKNOWN', 'NO_LEGAL_GRANTED_GPU_COUNT', 'NATIVE_RESOURCE_RECORDS_EMPTY']);
  assert.deepEqual(parseTaskDiagnosticResult(result(value)).diagnostics.node.resources.request.allowedGpuCounts, [4, 8]);
  value.node.resources.allocation.grant.maxGpuCount = 4;
  assert.equal(codes(taskDiagnosticFindings(value)).includes('NO_LEGAL_GRANTED_GPU_COUNT'), false);
});

test('missing, unknown initial and mismatched allocation grants are distinct observations', () => {
  const value = diagnostic(); value.node.resources.allocation.grant = null;
  assert.ok(codes(taskDiagnosticFindings(value)).includes('ALLOCATION_GRANT_MISSING'));
  value.node.resources.allocation.mode = 'native';
  assert.equal(codes(taskDiagnosticFindings(value)).includes('ALLOCATION_GRANT_MISSING'), false);
  const changed = diagnostic(); changed.node.resources.allocation.grant.id = 'different-grant';
  changed.node.resources.allocation.grant.initialMaxGpuCount = null;
  assert.ok(codes(taskDiagnosticFindings(changed)).includes('ALLOCATION_GRANT_ID_MISMATCH'));
  assert.ok(codes(taskDiagnosticFindings(changed)).includes('INITIAL_GRANT_UNCONFIRMED'));
  changed.node.resources.allocation.grant.initialMaxGpuCount = 2;
  assert.ok(codes(taskDiagnosticFindings(changed)).includes('INITIAL_GRANT_MISMATCH'));
});

test('settled tasks show released resources and do not mistake the sealed zero grant for a startup problem', () => {
  const value = diagnostic();
  value.task.stage = 'SUCCEEDED'; value.node.state = 'SUCCEEDED'; value.quota.state = 'RELEASED';
  value.node.resources.allocation.grant.maxGpuCount = 0;
  const output = parseTaskDiagnosticResult(result(value));
  assert.ok(codes(output.findings).includes('TASK_RESOURCES_RELEASED'));
  assert.equal(codes(output.findings).includes('NO_LEGAL_GRANTED_GPU_COUNT'), false);
  assert.equal(output.unknowns.includes('storage-lease-release'), false);
  assert.match(formatTaskDiagnostics(output).join('\n'), /数据租约和平台额度已释放/);
  assert.equal(formatTaskDiagnostics(output).at(-1).includes('数据租约清理'), false);
  value.kind = 'unavailable'; value.node = null;
  assert.ok(codes(parseTaskDiagnosticResult(result(value)).findings).includes('TASK_RESOURCES_RELEASED'));
});

test('terminal state, older round leases and exit 137 never become an OOM verdict or resource release proof', () => {
  const value = diagnostic(); value.node.state = 'FAILED';
  value.node.latestAttempt = {id: 'A-new', ordinal: 2, state: 'EXITED_FAILURE', assignedGpus: [], exitCode: 137, failureReason: null};
  value.node.progress = {reported: false, stale: false, error: null, heartbeatAgeSeconds: null, progressAgeSeconds: null, snapshot: null};
  value.node.resources.leases = page([{gpuUuid: 'GPU-0', gpuIndex: 0, attemptId: 'A-old'}]);
  const output = result(value), findings = codes(output.findings);
  assert.ok(findings.includes('NATIVE_JOB_FAILED')); assert.ok(findings.includes('ATTEMPT_NONZERO_EXIT'));
  assert.ok(findings.includes('TERMINAL_WITH_RESOURCE_RECORDS')); assert.ok(findings.includes('OLDER_ATTEMPT_LEASES'));
  assert.equal(findings.some(code => /OOM|FREED|HEALTHY/.test(code)), false);
  assert.ok(output.unknowns.includes('kernel-counters')); assert.ok(output.unknowns.includes('storage-lease-release'));
  assert.match(formatTaskDiagnostics(parseTaskDiagnosticResult(output)).join('\n'), /不能单凭退出码认定 OOM/);
  value.node.resources.leases = page();
  assert.ok(codes(taskDiagnosticFindings(value)).includes('NATIVE_RESOURCE_RECORDS_EMPTY'));
  assert.match(formatTaskDiagnostics(result(value)).join('\n'), /不证明进程和数据租约已清理/);
});

test('pending actions and truncated details are explicit without exposing action payload or tokens', () => {
  const value = diagnostic();
  value.node.resources.pendingActions = {items: [{id: 'action-1', attemptId: null, type: 'START_UNIT', attemptCount: 2,
    availableAtSeconds: 100, errorRecorded: true, claimRecorded: true}], total: 20, truncated: true};
  const output = parseTaskDiagnosticResult(result(value));
  assert.ok(codes(output.findings).includes('NATIVE_ACTIONS_PENDING'));
  assert.ok(codes(output.findings).includes('NATIVE_ACTION_ERROR_RECORDED'));
  assert.ok(codes(output.findings).includes('EVIDENCE_TRUNCATED'));
  const invalid = structuredClone(output.diagnostics.node); invalid.resources.pendingActions.truncated = false;
  assert.throws(() => parseNodeDiagnostics(invalid), hasCode('INVALID_API_RESPONSE'));
  invalid.resources.pendingActions.truncated = true; invalid.resources.pendingActions.items[0].claimToken = 'private';
  assert.throws(() => parseNodeDiagnostics(invalid), hasCode('INVALID_API_RESPONSE'));
});

test('platform holds before dispatch are visible without a node call, and current reservation is not confused with initial count', async t => {
  const f = await dispatchFixture(t), calls = [];
  const jobId = f.queue.enqueue(f.actor, trainingSubmission(), f.now).request.jobId;
  f.claims.claim(f.actor, {jobId, machineId: 'node-2', gpuCount: 1}, f.now);
  const app = new ReadTrainingTask({tasks: new SqliteTaskReads({database: f.database}), nodes: {diagnostics: async value => {calls.push(value);}}, clock: () => f.now});
  const before = f.database.prepare('SELECT total_changes() n').get().n;
  const output = await app.diagnostics(f.actor, {jobId});
  assert.equal(output.task.stage, 'QUEUED'); assert.equal(output.diagnostics.kind, 'not-queried');
  assert.deepEqual(output.quota, {machineId: 'node-2', state: 'HELD', initialGpuCount: 1, reservedGpuCount: 1});
  assert.deepEqual(calls, []); assert.equal(f.database.prepare('SELECT total_changes() n').get().n, before);
  assert.deepEqual(parseTaskDiagnosticResult(output), output);
  const changed = result(diagnostic()); changed.quota.reservedGpuCount = 2;
  assert.equal(parseTaskDiagnosticResult(changed).quota.initialGpuCount, 4);
});

test('real native/HTTP/API diagnostics preserve retained leases and agree across browser, SDK and CLI without mutations', async t => {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const node = await nativeNode(t, f, {terminal: true, exitCode: 137, retainLeases: true});
  const api = await publicServer(t, f, node.nodes);
  const before = f.database.prepare('SELECT total_changes() n').get().n;
  const output = await api.client.diagnostics({jobId: f.jobId});
  assert.equal(output.diagnostics.kind, 'observed'); assert.equal(output.diagnostics.node.state, 'FAILED');
  assert.equal(output.diagnostics.node.resources.leases.total, 2); assert.equal(output.quota.state, 'HELD');
  assert.ok(codes(output.findings).includes('TERMINAL_WITH_RESOURCE_RECORDS'));
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(f.dispatches.getForTask(f.jobId).state, 'SENDING');
  const browser = await chromium.launch({headless: true}); t.after(() => browser.close());
  const web = await browser.newPage(); await web.goto(api.origin);
  const shown = await web.evaluate(async ({login, jobId}) => {
    const {TaskClient} = await import('/modules/client/task-client.mjs');
    const {SessionClient} = await import('/modules/client/session-client.mjs');
    const {JsonHttpTransport} = await import('/modules/client/http-transport.mjs');
    const transport = new JsonHttpTransport({baseUrl: location.origin});
    await new SessionClient({transport, delivery: 'cookie'}).login(login);
    return new TaskClient({transport}).diagnostics({jobId});
  }, {login: loginRequest, jobId: f.jobId});
  assert.deepEqual(shown, output);
  const folder = await mkdtemp(join(tmpdir(), 'v2-diag-cli-')); t.after(() => rm(folder, {recursive: true, force: true}));
  const args = ['--url', api.origin, '--credentials', join(folder, 'credentials.sqlite')];
  const login = await cli([...args, 'login', '--username', 'alice', '--password-stdin'], loginRequest.password);
  assert.equal(login.code, 0, login.stderr);
  const json = await cli([...args, 'task-diagnostics', '--job', f.jobId, '--json']);
  assert.equal(json.code, 0, json.stderr); assert.deepEqual(JSON.parse(json.stdout), output);
  const text = await cli([...args, 'task-diagnostics', '--job', f.jobId]);
  assert.equal(text.code, 0, text.stderr); assert.match(text.stdout, /租约 2/); assert.match(text.stdout, /未采集/);
  assert.doesNotMatch(text.stdout, /undefined|GPU 已释放/);
});

test('revocation after a diagnostic query masks its returned data and its transport error', async t => {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const tasks = new SqliteTaskReads({database: f.database}); let calls = 0;
  const app = new ReadTrainingTask({tasks, clock: () => f.now, nodes: {async diagnostics() {
    calls++; f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
    throw new ApplicationError('NODE_JOB_UNAVAILABLE');
  }}});
  await assert.rejects(app.diagnostics(f.actor, {jobId: f.jobId}), hasCode('FORBIDDEN'));
  await assert.rejects(app.diagnostics(f.actor, {jobId: f.jobId}), hasCode('FORBIDDEN'));
  assert.equal(calls, 1); assert.equal(f.database.prepare('SELECT state FROM v2_compute_claims WHERE job_id=?').get(f.jobId).state, 'HELD');
});

test('public diagnostics cannot accept a foreign machine or host selector and missing evidence stays unknown', async t => {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  let calls = 0;
  const api = await publicServer(t, f, {diagnostics: async () => {calls++; return null;}});
  for (const extra of [{machineId: 'other'}, {hostPath: '/private'}, {nodeJobId: 'other'}, {accountId: 'other'}]) {
    await assert.rejects(api.transport.request(TASK_DIAGNOSTICS_ROUTE, {jobId: f.jobId, ...extra}), hasCode('INVALID_REQUEST'));
  }
  assert.equal(calls, 0);
  const output = await api.client.diagnostics({jobId: f.jobId});
  assert.equal(output.diagnostics.kind, 'not-observed'); assert.ok(codes(output.findings).includes('NATIVE_NOT_OBSERVED'));
  assert.equal(output.quota.state, 'HELD');
});

test('diagnostic schema rejects fabricated counters, wrong task identities and supposed known kernel evidence', () => {
  const source = result(diagnostic());
  for (const change of [v => {v.diagnostics.node.resources.leases.total = -1;},
    v => {v.diagnostics.node.receipt.accountId = 'bob';}, v => {v.unknowns = [];},
    v => {v.diagnostics.node.resources.oomKills = 0;}, v => {v.findings.push({code: 'GPU_FREED', level: 'info'});}]) {
    const value = structuredClone(source); change(value);
    assert.throws(() => parseTaskDiagnosticResult(value), hasCode('INVALID_API_RESPONSE'));
  }
});

test('diagnostics share the existing read lane with status and log operations', async () => {
  let done;
  const pending = new Promise(resolve => done = resolve);
  const lane = new TaskReadLane({totalLimit: 1, machineLimit: 1, nodes: {observe: () => pending, diagnostics: async () => 'diagnostic'}});
  const first = lane.observe({machineId: 'node-1', dispatchId: 'same'});
  await assert.rejects(lane.diagnostics({machineId: 'node-1', dispatchId: 'same'}), hasCode('TASK_READ_BUSY'));
  done(null); await first;
  assert.equal(await lane.diagnostics({machineId: 'node-1', dispatchId: 'same'}), 'diagnostic');
});
