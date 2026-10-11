import test from 'node:test';
import assert from 'node:assert/strict';
import {startTrainingCoordinator} from '../src/bootstrap/training-coordinator.mjs';

test('admission carries its cursor through pages without overlap while dispatch keeps polling', {timeout: 5000}, async () => {
  const held = Promise.withResolvers(), entered = Promise.withResolvers(), dispatchContinued = Promise.withResolvers(), cycled = Promise.withResolvers();
  const calls = [], outcomes = [], errors = [];
  let dispatchPolls = 0, closed = 0;
  const queue = {async execute(request) {
    calls.push(request);
    if (calls.length === 1) return {outcomes: [{jobId: 'first', kind: 'waiting'}], nextCursor: {priority: 2, sequence: 1}};
    if (calls.length === 2) {entered.resolve(); await held.promise;}
    if (calls.length === 3) cycled.resolve();
    return {outcomes: [], nextCursor: null};
  }};
  const worker = {async poll() {
    dispatchPolls++;
    if (dispatchPolls >= 4) dispatchContinued.resolve();
    return {outcomes: []};
  }, async close() {closed++; return [];}};
  const service = startTrainingCoordinator({queue, worker, intervalMs: 5, queuePageSize: 1,
    onOutcome: result => outcomes.push(result), reportError: error => errors.push(error)});
  try {
    await entered.promise; await dispatchContinued.promise;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].after, {priority: 2, sequence: 1});
    held.resolve(); await cycled.promise;
    assert.equal(calls[2].after, null);
    assert.deepEqual(outcomes, [{phase: 'admission', jobId: 'first', kind: 'waiting'}]);
    assert.deepEqual(errors, []);
  } finally {held.resolve(); await service.stop();}
  assert.equal(closed, 1); assert.equal(calls[0].signal.aborted, true);
});

test('an admission failure is reported without advancing the cursor or stopping dispatch', {timeout: 5000}, async () => {
  const done = Promise.withResolvers(), failure = new Error('fixture accounting unavailable'), reports = [], cursors = [];
  let dispatchPolls = 0;
  const queue = {async execute({after}) {
    cursors.push(after);
    if (cursors.length === 1) throw failure;
    return {outcomes: [{jobId: 'original', kind: 'prepared'}], nextCursor: null};
  }};
  const worker = {async poll() {dispatchPolls++; return {outcomes: []};}, async close() {return [];}};
  const service = startTrainingCoordinator({queue, worker, intervalMs: 5,
    onOutcome: result => done.resolve(result), reportError: (error, context) => reports.push({error, ...context})});
  try {
    const result = await done.promise;
    assert.equal(result.jobId, 'original'); assert.equal(result.phase, 'admission');
    assert.deepEqual(cursors.slice(0, 2), [null, null]);
    assert.deepEqual(reports, [{error: failure, phase: 'admission'}]);
    assert.ok(dispatchPolls >= 1);
  } finally {await service.stop();}
});

test('dispatch observations and discovery errors have their own reporting phase', {timeout: 5000}, async () => {
  const done = Promise.withResolvers(), failure = new Error('fixture dispatch discovery unavailable'), reports = [], observations = [];
  let polls = 0;
  const queue = {async execute() {return {outcomes: [], nextCursor: null};}};
  const worker = {async poll() {
    if (++polls === 1) throw failure;
    return {outcomes: [{dispatchId: 'original', kind: 'unconfirmed'}]};
  }, async close() {return [];}};
  const service = startTrainingCoordinator({queue, worker, intervalMs: 5,
    onOutcome: result => {observations.push(result); done.resolve();},
    reportError: (error, context) => reports.push({error, ...context})});
  try {
    await done.promise;
    assert.deepEqual(observations[0], {phase: 'dispatch', dispatchId: 'original', kind: 'unconfirmed'});
    assert.deepEqual(reports, [{error: failure, phase: 'dispatch'}]);
  } finally {await service.stop();}
});

test('stop is idempotent and awaits admission even when dispatch shutdown fails', async () => {
  const admission = Promise.withResolvers(), dispatch = Promise.withResolvers(), failure = new Error('fixture final discovery failure');
  let signal, stopped = false, closeCalls = 0;
  const queue = {async execute(request) {signal = request.signal; await admission.promise; return {outcomes: [], nextCursor: null};}};
  const worker = {async poll() {return {outcomes: []};}, async close() {closeCalls++; return dispatch.promise;}};
  const service = startTrainingCoordinator({queue, worker, onOutcome() {}, reportError() {}});
  const closing = service.stop();
  assert.equal(service.stop(), closing); assert.equal(signal.aborted, true);
  const rejected = assert.rejects(closing, error => error === failure).then(() => {stopped = true;});
  dispatch.reject(failure);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(stopped, false);
  admission.resolve(); await rejected;
  assert.equal(closeCalls, 1);
});

test('invalid loop configuration starts neither admission nor dispatch', () => {
  let calls = 0;
  const input = {queue: {execute() {calls++;}}, worker: {poll() {calls++;}}, onOutcome() {}, reportError() {}};
  assert.throws(() => startTrainingCoordinator({...input, queuePageSize: 0}), /admission page/);
  assert.throws(() => startTrainingCoordinator({...input, intervalMs: 0}), /worker interval/);
  assert.equal(calls, 0);
});
