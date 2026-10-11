import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {TrainingDispatchWorker} from '../src/application/training-dispatch-worker.mjs';
import {SqliteDispatchWork} from '../src/infrastructure/sqlite/dispatch-work.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {startTrainingDispatchWorker} from '../src/bootstrap/training-dispatch-worker.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';

function fixture(specs, options = {}) {
  const rows = specs.map(([machineId, state = 'PREPARED'], index) => ({dispatchId: randomUUID(), jobId: randomUUID(),
    machineId, state, sequence: index + 1, priority: 2}));
  const records = new Map(rows.map(row => [row.dispatchId, row]));
  const calls = {pages: [], prepared: [], sent: [], recovered: []};
  const work = {async pending(page) {
    calls.pages.push(page);
    return [...records.values()].filter(row => row.state !== 'ACCEPTED' && (!page.after || row.sequence > page.after.sequence))
      .slice(0, page.limit).map(row => ({...row}));
  }};
  const dispatches = {async delivery(id) {return structuredClone(records.get(id) ?? null);}};
  const prepare = {async execute(jobId) {calls.prepared.push(jobId);}};
  const send = {async execute(jobId) {
    calls.sent.push(jobId);
    const row = rows.find(row => row.jobId === jobId); row.state = 'ACCEPTED';
    return {kind: 'accepted', dispatch: {...row}};
  }};
  const reconcile = {async execute(dispatchId) {calls.recovered.push(dispatchId); return {kind: 'unconfirmed'};}};
  const worker = new TrainingDispatchWorker({work, dispatches, prepare, send, reconcile, ...options});
  return {rows, records, calls, work, dispatches, prepare, send, reconcile, worker};
}

test('slow node preparation leaves other nodes and its own receipt-query lane running', async () => {
  const f = fixture([['node-1'], ['node-1'], ['node-2'], ['node-1', 'UNKNOWN']]);
  const gate = Promise.withResolvers(), healthy = Promise.withResolvers(), recovered = Promise.withResolvers();
  const originalPrepare = f.prepare.execute, originalSend = f.send.execute;
  f.prepare.execute = async jobId => {await originalPrepare(jobId); if (jobId === f.rows[0].jobId) await gate.promise;};
  f.send.execute = async jobId => {const result = await originalSend(jobId); if (jobId === f.rows[2].jobId) healthy.resolve(); return result;};
  f.reconcile.execute = async id => {f.calls.recovered.push(id); recovered.resolve(); return {kind: 'unconfirmed'};};
  const first = await f.worker.poll();
  await Promise.all([healthy.promise, recovered.promise]);
  assert.equal(f.calls.prepared.includes(f.rows[1].jobId), false);
  assert.equal(f.rows[0].state, 'PREPARED'); assert.equal(f.rows[2].state, 'ACCEPTED');
  assert.deepEqual(f.calls.recovered, [f.rows[3].dispatchId]);
  gate.resolve();
  const outcomes = [...first.outcomes, ...await f.worker.idle()];
  assert.equal(outcomes.filter(row => row.kind === 'accepted').length, 3);
  assert.equal(f.calls.sent.length, 3); assert.equal(new Set(f.calls.sent).size, 3);
  await f.worker.close();
});

test('shared concurrency is bounded and waiting jobs start when an earlier operation ends', async () => {
  const f = fixture([['node-1'], ['node-2'], ['node-3']], {concurrency: 2});
  const gates = f.rows.map(() => Promise.withResolvers()), entered = f.rows.map(() => Promise.withResolvers());
  let running = 0, peak = 0;
  f.prepare.execute = async id => {
    const index = f.rows.findIndex(row => row.jobId === id);
    running++; peak = Math.max(peak, running); entered[index].resolve(); await gates[index].promise; running--;
  };
  await f.worker.poll(); await Promise.all(entered.slice(0, 2).map(value => value.promise));
  assert.equal(running, 2); assert.equal(f.rows[2].state, 'PREPARED');
  gates[0].resolve(); await entered[2].promise;
  assert.equal(running, 2); assert.equal(peak, 2);
  gates[1].resolve(); gates[2].resolve();
  await f.worker.idle(); assert.equal(f.calls.sent.length, 3);
  await f.worker.close();
});

test('one failed preparation does not stop the node lane or fabricate a terminal state', async () => {
  const f = fixture([['node-1'], ['node-1']]);
  f.prepare.execute = async id => {
    f.calls.prepared.push(id);
    if (id === f.rows[0].jobId) throw new ApplicationError('PROJECT_RUN_UNAVAILABLE');
  };
  const first = await f.worker.poll(), outcomes = [...first.outcomes, ...await f.worker.idle()];
  assert.equal(outcomes.find(row => row.kind === 'error').error.code, 'PROJECT_RUN_UNAVAILABLE');
  assert.equal(f.rows[0].state, 'PREPARED'); assert.equal(f.rows[1].state, 'ACCEPTED');
  assert.deepEqual(f.calls.sent, [f.rows[1].jobId]);
  await f.worker.close();
});

test('a newly discovered higher priority job overtakes deferred lower priority work', async () => {
  const f = fixture([['node-1'], ['node-1']]), gate = Promise.withResolvers();
  f.rows[1].priority = 0;
  f.prepare.execute = async id => {if (id === f.rows[0].jobId) await gate.promise;};
  await f.worker.poll();
  const high = {...f.rows[1], jobId: randomUUID(), dispatchId: randomUUID(), sequence: 3, priority: 4};
  f.rows.push(high); f.records.set(high.dispatchId, high);
  await f.worker.poll();
  gate.resolve(); await f.worker.idle();
  assert.deepEqual(f.calls.sent, [f.rows[0].jobId, high.jobId, f.rows[1].jobId]);
  await f.worker.close();
});

test('an in-flight send cannot also occupy a recovery lane on the next poll', async () => {
  const f = fixture([['node-1']]), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const send = f.send.execute;
  f.send.execute = async id => {f.rows[0].state = 'SENDING'; entered.resolve(); await gate.promise; return send(id);};
  await f.worker.poll(); await entered.promise;
  await f.worker.poll();
  assert.deepEqual(f.calls.recovered, []); assert.equal(f.calls.prepared.length, 1);
  gate.resolve(); await f.worker.idle();
  assert.equal(f.calls.sent.length, 1); assert.equal(f.rows[0].state, 'ACCEPTED');
  await f.worker.close();
});

test('uncertain sends are only queried in later polls, never prepared or sent a second time', async () => {
  const f = fixture([['node-1']]);
  f.send.execute = async jobId => {
    f.calls.sent.push(jobId); f.rows[0].state = 'UNKNOWN'; throw new ApplicationError('DISPATCH_SEND_UNCONFIRMED');
  };
  await f.worker.poll(); await f.worker.idle();
  await f.worker.poll(); await f.worker.idle();
  assert.deepEqual(f.calls.prepared, [f.rows[0].jobId]);
  assert.deepEqual(f.calls.sent, [f.rows[0].jobId]);
  assert.deepEqual(f.calls.recovered, [f.rows[0].dispatchId]);
  assert.equal(f.rows[0].state, 'UNKNOWN');
  await f.worker.close();
});

test('discovery keeps paging while a node is busy and retains its deferred jobs', async () => {
  const f = fixture([['node-1'], ['node-1'], ['node-2']], {pageSize: 1});
  const gate = Promise.withResolvers(), healthy = Promise.withResolvers();
  f.prepare.execute = async id => {
    f.calls.prepared.push(id);
    if (id === f.rows[0].jobId) await gate.promise;
    if (id === f.rows[2].jobId) healthy.resolve();
  };
  await f.worker.poll(); await f.worker.poll(); await f.worker.poll(); await healthy.promise;
  assert.deepEqual(f.calls.pages.map(page => page.after?.sequence ?? null), [null, 1, 2]);
  assert.equal(f.calls.prepared.includes(f.rows[1].jobId), false);
  gate.resolve(); await f.worker.idle();
  assert.deepEqual(new Set(f.calls.sent), new Set(f.rows.map(row => row.jobId)));
  await f.worker.close();
});

test('close waits for the original preparation and starts neither its send nor queued work', async () => {
  const f = fixture([['node-1'], ['node-1']]);
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.prepare.execute = async id => {f.calls.prepared.push(id); entered.resolve(); await gate.promise;};
  await f.worker.poll(); await entered.promise;
  let stopped = false;
  const closing = f.worker.close().then(outcomes => {stopped = true; return outcomes;});
  await Promise.resolve(); assert.equal(stopped, false);
  gate.resolve();
  assert.equal((await closing)[0].kind, 'deferred');
  assert.equal(f.calls.sent.length, 0); assert.equal(f.calls.prepared.length, 1);
  await f.worker.poll();
  assert.equal(f.calls.pages.length, 1);
  assert.ok(f.rows.every(row => row.state === 'PREPARED'));
});

test('close does not interrupt a send already in progress or discard its acceptance', async () => {
  const f = fixture([['node-1']]), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const send = f.send.execute;
  f.send.execute = async id => {entered.resolve(); await gate.promise; return send(id);};
  await f.worker.poll(); await entered.promise;
  const stopped = f.worker.close();
  gate.resolve();
  assert.equal((await stopped)[0].kind, 'accepted'); assert.equal(f.rows[0].state, 'ACCEPTED');
});

test('concurrent discovery is coalesced, and closing during discovery starts no work', async () => {
  const f = fixture([['node-1']]), page = Promise.withResolvers(); let reads = 0;
  f.work.pending = async () => {reads++; return page.promise;};
  const first = f.worker.poll(), second = f.worker.poll(), closing = f.worker.close();
  assert.equal(first, second); assert.equal(reads, 1);
  page.resolve(f.rows); await Promise.all([first, second, closing]);
  assert.equal(f.calls.prepared.length, 0); assert.equal(f.calls.sent.length, 0);
});

test('stale discovery cannot resend accepted records or prepare a missing dispatch', async () => {
  const f = fixture([['node-1'], ['node-2']]);
  f.work.pending = async () => f.rows.map(row => ({...row, state: 'PREPARED'}));
  f.rows[0].state = 'ACCEPTED'; f.records.delete(f.rows[1].dispatchId);
  const first = await f.worker.poll(), outcomes = [...first.outcomes, ...await f.worker.idle()];
  assert.deepEqual(outcomes.map(row => row.kind).sort(), ['accepted', 'missing']);
  assert.equal(f.calls.sent.length, 0); assert.equal(f.calls.prepared.length, 0);
  await f.worker.close();
});

test('discovery failure during shutdown still waits for the original preparation to finish', async () => {
  const f = fixture([['node-1']]), gate = Promise.withResolvers(), entered = Promise.withResolvers(), page = Promise.withResolvers();
  f.prepare.execute = async () => {entered.resolve(); await gate.promise;};
  await f.worker.poll(); await entered.promise;
  f.work.pending = async () => page.promise;
  const polling = assert.rejects(f.worker.poll(), /fixture database unavailable/);
  let stopped = false;
  const closing = assert.rejects(f.worker.close(), /fixture database unavailable/).then(() => {stopped = true;});
  page.reject(new Error('fixture database unavailable'));
  await polling;
  assert.equal(stopped, false);
  gate.resolve(); await closing;
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.rows[0].state, 'PREPARED');
  assert.equal((await f.worker.close())[0].kind, 'deferred');
});

test('periodic runner reports task errors and stops polling without canceling training', {timeout: 5000}, async t => {
  const f = fixture([['node-1']]), reported = Promise.withResolvers(), outcomes = [], errors = [];
  f.prepare.execute = async () => {throw new Error('fixture preparation failure');};
  const service = startTrainingDispatchWorker({worker: f.worker, intervalMs: 10,
    onOutcome: outcome => {outcomes.push(outcome); reported.resolve();}, reportError: error => errors.push(error)});
  t.after(() => service.stop());
  await reported.promise; await service.stop();
  assert.equal(outcomes[0].kind, 'error'); assert.match(outcomes[0].error.message, /fixture preparation/);
  assert.deepEqual(errors, []); assert.equal(f.rows[0].state, 'PREPARED');
  const count = f.calls.pages.length;
  await f.worker.poll(); assert.equal(f.calls.pages.length, count);
});

test('SQLite work discovery is read-only, ordered, restartable and includes uncertain work after revocation', async t => {
  const f = await computeFixture(t); f.ready();
  createTrainingQueueSchema(f.database); createTrainingDispatchSchema(f.database);
  const queue = new SqliteTrainingQueue({database: f.database}), dispatches = new SqliteTrainingDispatches({database: f.database});
  const jobs = [];
  for (const priority of [0, 4, 2, 3]) {
    const submission = trainingSubmission(); submission.scheduling.priority = priority;
    const job = queue.enqueue(f.actor, submission, f.now).request.jobId;
    jobs.push(dispatches.prepareForTask(job, {machineId: 'node-1', gpuCount: 1}, f.now));
  }
  const sending = dispatches.beginSend(jobs[1].jobId, f.now);
  dispatches.beginSend(jobs[2].jobId, f.now);
  const accepted = dispatches.beginSend(jobs[3].jobId, f.now);
  dispatches.recordSendOutcome({dispatchId: accepted.dispatch.dispatchId, senderToken: accepted.senderToken, nodeJobId: 'J0123456789ab'});
  dispatches.recordSendOutcome({dispatchId: sending.dispatch.dispatchId, senderToken: sending.senderToken, nodeJobId: null});
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  f.database.prepare('INSERT INTO v2_training_cancellations VALUES(?,?,?)').run(jobs[1].jobId, 'alice', f.now);
  const database = new DatabaseSync(f.database.prepare('PRAGMA database_list').get().file, {readOnly: true});
  t.after(() => database.close());
  const work = new SqliteDispatchWork({database});
  const first = work.pending({limit: 2, after: null});
  assert.deepEqual(first.map(row => row.state), ['UNKNOWN', 'SENDING']);
  assert.deepEqual(first.map(row => row.priority), [4, 2]);
  const last = first.at(-1), second = work.pending({limit: 2, after: {priority: last.priority, sequence: last.sequence}});
  assert.equal(second.length, 1); assert.equal(second[0].dispatchId, jobs[0].dispatchId);
  assert.equal(Object.hasOwn(first[0], 'senderToken'), false); assert.equal(Object.hasOwn(first[0], 'submission'), false);
  assert.equal(database.prepare('SELECT total_changes() n').get().n, 0);
  assert.equal(f.database.prepare("SELECT count(*) n FROM v2_compute_claims WHERE state='HELD'").get().n, 4);
});
