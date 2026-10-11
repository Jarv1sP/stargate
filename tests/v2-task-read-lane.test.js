import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {getEventListeners} from 'node:events';
import {TaskReadLane} from '../src/application/task-read-lane.mjs';
import {ApplicationError, TransientReadError} from '../src/domain/errors.mjs';

const hasCode = code => error => error.code === code;
const ref = machineId => ({machineId, dispatchId: 'original-dispatch'});
function deferred() {let resolve; const promise = new Promise(value => resolve = value); return {promise, resolve};}

test('read lane enforces per-node and total limits, then releases only completed work', async () => {
  const waiting = new Map(), calls = [];
  const lane = new TaskReadLane({totalLimit: 2, machineLimit: 1, nodes: {observe(reference) {
    calls.push(reference); const work = deferred(); waiting.set(reference.machineId, work); return work.promise;
  }}});
  const a = lane.observe(ref('a'));
  await assert.rejects(lane.observe(ref('a')), hasCode('TASK_READ_BUSY'));
  const b = lane.observe(ref('b'));
  await assert.rejects(lane.observe(ref('c')), hasCode('TASK_READ_BUSY'));
  waiting.get('a').resolve('a'); assert.equal(await a, 'a');
  const c = lane.observe(ref('c'));
  waiting.get('b').resolve('b'); waiting.get('c').resolve('c');
  assert.deepEqual(await Promise.all([b, c]), ['b', 'c']);
  assert.deepEqual(calls.map(row => row.machineId), ['a', 'b', 'c']);
});

test('pre-aborted reads settle immediately without I/O or permit consumption and successful reads detach listeners', async () => {
  let calls = 0;
  const lane = new TaskReadLane({totalLimit: 1, machineLimit: 1, nodes: {async observe() {calls++; return 'read';}}});
  const controller = new AbortController(), reason = new ApplicationError('TASK_READ_ABORTED'); controller.abort(reason);
  await assert.rejects(lane.observe(ref('a'), {signal: controller.signal}), error => error === reason);
  assert.equal(calls, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const active = new AbortController();
  assert.equal(await lane.observe(ref('a'), {signal: active.signal}), 'read');
  assert.equal(getEventListeners(active.signal, 'abort').length, 0);
  active.abort(reason); assert.equal(calls, 1);
});

test('timeout returns promptly but an adapter ignoring cancellation retains its permit until it really settles', async () => {
  const pending = deferred(); let calls = 0;
  const lane = new TaskReadLane({totalLimit: 1, machineLimit: 1, timeoutMs: 25, nodes: {observe() {return ++calls === 1 ? pending.promise : Promise.resolve('ready');}}});
  const controller = new AbortController();
  await assert.rejects(lane.observe(ref('a'), {signal: controller.signal}), hasCode('TASK_READ_TIMEOUT'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(lane.observe(ref('a')), hasCode('TASK_READ_BUSY'));
  assert.equal(calls, 1);
  pending.resolve('late result must be discarded'); await delay(0);
  assert.equal(await lane.observe(ref('a')), 'ready'); assert.equal(calls, 2);
});

test('caller cancellation propagates to the underlying read and does not release a still-running adapter', async () => {
  const pending = deferred(), controller = new AbortController(); let signal;
  const lane = new TaskReadLane({totalLimit: 1, machineLimit: 1, nodes: {observe(_ref, options) {signal = options.signal; return pending.promise;}}});
  const reason = new ApplicationError('TASK_READ_ABORTED'), result = lane.observe(ref('a'), {signal: controller.signal});
  const rejected = assert.rejects(result, error => error === reason);
  controller.abort(reason); await rejected;
  assert.equal(signal.reason, reason);
  await assert.rejects(lane.observe(ref('a')), hasCode('TASK_READ_BUSY'));
  pending.resolve(null); await delay(0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('only one classified retry uses the unchanged original reference and remaining timeout', async () => {
  const input = ref('a'), calls = []; let now = 0, checks = 0;
  const lane = new TaskReadLane({clock: () => now, nodes: {async observe(reference, options) {
    calls.push({reference: {...reference}, timeoutMs: options.timeoutMs});
    if (calls.length === 1) {
      input.dispatchId = 'caller-mutated'; reference.machineId = 'adapter-mutated'; now = 30000;
      throw new TransientReadError('NODE_JOB_UNAVAILABLE');
    }
    return 'ready';
  }}});
  assert.equal(await lane.observe(input, {check: async () => checks++}), 'ready');
  assert.deepEqual(calls, [{reference: ref('a'), timeoutMs: 27000}, {reference: ref('a'), timeoutMs: 10000}]);
  assert.equal(checks, 2);
  let failures = 0;
  const unavailable = new TaskReadLane({nodes: {async observe() {failures++; throw new TransientReadError('NODE_JOB_UNAVAILABLE');}}});
  await assert.rejects(unavailable.observe(ref('a')), hasCode('NODE_JOB_UNAVAILABLE'));
  assert.equal(failures, 2);
});

test('authorization changes, cancellation during backoff and non-transient failures are never replayed', async () => {
  let calls = 0;
  const lane = new TaskReadLane({nodes: {async observe() {calls++; throw new TransientReadError('NODE_JOB_UNAVAILABLE');}}});
  await assert.rejects(lane.observe(ref('a'), {check: async () => {throw new ApplicationError('FORBIDDEN');}}), hasCode('FORBIDDEN'));
  assert.equal(calls, 1);
  const controller = new AbortController(), reason = new ApplicationError('TASK_READ_ABORTED');
  const pending = lane.observe(ref('a'), {signal: controller.signal, check: async () => {setTimeout(() => controller.abort(reason), 10);}});
  await assert.rejects(pending, error => error === reason); await delay(0);
  assert.equal(calls, 2);
  let direct = 0;
  const invalid = new TaskReadLane({nodes: {async observe() {direct++; throw new ApplicationError('NODE_JOB_UNAVAILABLE');}}});
  await assert.rejects(invalid.observe(ref('a')), hasCode('NODE_JOB_UNAVAILABLE'));
  assert.equal(direct, 1);
});

test('node-local lanes can explicitly disable retry; invalid bounds fail before any work', async () => {
  let calls = 0;
  const nodes = {async observe() {calls++; throw new TransientReadError('NODE_JOB_UNAVAILABLE');}};
  const lane = new TaskReadLane({nodes, maxAttempts: 1});
  await assert.rejects(lane.observe(ref('a')), hasCode('NODE_JOB_UNAVAILABLE'));
  assert.equal(calls, 1);
  for (const options of [{totalLimit: 0}, {machineLimit: -1}, {timeoutMs: 0}, {maxAttempts: 3}]) {
    assert.throws(() => new TaskReadLane({nodes, ...options}), /bounds/);
  }
});

test('a late success cannot bypass the elapsed deadline while the event loop has not run the timeout callback', async () => {
  let now = 0;
  const lane = new TaskReadLane({clock: () => now, timeoutMs: 100,
    nodes: {async observe() {now = 101; return 'late';}}});
  await assert.rejects(lane.observe(ref('a')), hasCode('TASK_READ_TIMEOUT'));
});
