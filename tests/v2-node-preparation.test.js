import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PrepareNodeWorkload} from '../src/application/prepare-node-workload.mjs';
import {PrepareTaskLaunch} from '../src/application/prepare-task-launch.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';
import {parseNodePreparation, nodePreparationResult, parseNodePreparationResult} from '../src/contracts/node-preparation.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';

const hasCode = code => error => error.code === code;
function fixture() {
  const submission = trainingSubmission();
  submission.dataSources = [{kind: 'directory', sourceId: 'raw'}, {kind: 'warehouse', datasetId: 'images', version: 'a'.repeat(64)}];
  const input = parseNodePreparation({binding: {dispatchId: randomUUID(), jobId: randomUUID(), accountId: 'alice',
    machineId: 'node-1', gpuCount: 2, requestHash: 'b'.repeat(64)}, submission,
    project: {id: submission.project.id, release: submission.project.release, project: 'training', projectUUID: randomUUID(), generation: 'c'.repeat(64)}});
  const calls = {projects: 0, lookups: 0, acquired: 0, compiled: 0}, state = {record: null, lease: null, failCompile: false};
  const bindings = {async training() {return state.record;}, async prepareTraining(compiled) {state.record = compiled;}};
  const projects = {async prepare(request, {actor}) {calls.projects++; return {...request, accountId: actor.id};}};
  const leaser = {async lookup() {calls.lookups++; return state.lease;}, async acquire(request, {actor}) {
    calls.acquired++; state.lease = {...request, accountId: actor.id, leaseId: randomUUID(), readOnly: true}; return state.lease;
  }};
  const compiler = {intent(identity, request) {return structuredClone({identity, request});},
    async compilePrepared(intent, prepared) {
      calls.compiled++;
      if (state.failCompile) throw new Error('compile interrupted');
      assert.equal(prepared.leases.length, 1);
      return {binding: intent.identity, planDigest: 'd'.repeat(64), plan: {project: {...input.project},
        inputs: [{source: intent.request.dataSources[0]}, {source: intent.request.dataSources[1], leaseId: prepared.leases[0].leaseId}]}};
    }};
  const pools = {async inspect() {return {};}};
  return {input, calls, state, projects, leaser, compiler, bindings,
    app: new PrepareNodeWorkload({compiler, bindings, projects, leaser, pools})};
}

test('concurrent same-intent preparation does each write once, and a saved plan skips all preparation', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.app.execute(f.input), f.app.execute(structuredClone(f.input))]);
  assert.deepEqual(first, second);
  assert.deepEqual(f.calls, {projects: 1, lookups: 1, acquired: 1, compiled: 1});
  first.project.project = 'caller-mutated';
  assert.equal(second.project.project, 'training');
  assert.equal((await f.app.execute(f.input)).project.project, 'training');
  assert.deepEqual(f.calls, {projects: 1, lookups: 1, acquired: 1, compiled: 1});
});

test('conflicting in-flight project cannot join an earlier promise; caller mutation does not leak a pending entry', async () => {
  const f = fixture(); let release;
  const gate = new Promise(resolve => {release = resolve;});
  const prepare = f.projects.prepare;
  f.projects.prepare = async (...args) => {await gate; return prepare(...args);};
  const original = structuredClone(f.input), pending = f.app.execute(f.input);
  await assert.rejects(f.app.execute({...original, project: {...original.project, generation: 'e'.repeat(64)}}), hasCode('NODE_PREPARATION_CONFLICT'));
  f.input.binding.dispatchId = randomUUID();
  release();
  assert.equal((await pending).binding.dispatchId, original.binding.dispatchId);
  // If cleanup used the caller-mutated ID, this would incorrectly reuse the old promise.
  f.state.record = null;
  await f.app.execute(original);
  assert.equal(f.calls.projects, 2); assert.equal(f.calls.acquired, 1);
});

test('partial failure keeps existing project/lease and resumes from the original lease lookup', async () => {
  const f = fixture(); f.state.failCompile = true;
  await assert.rejects(f.app.execute(f.input), /compile interrupted/);
  assert.equal(f.calls.acquired, 1); assert.equal(f.state.record, null);
  const originalLease = {...f.state.lease};
  f.state.failCompile = false;
  const result = await f.app.execute(f.input);
  assert.equal(result.inputs[1].leaseId, originalLease.leaseId);
  assert.deepEqual(f.state.lease, originalLease);
  assert.equal(f.calls.acquired, 1); assert.equal(f.calls.lookups, 2);
});

test('lease failure does not retry, publish a plan or touch raw-directory lease APIs', async () => {
  const f = fixture();
  f.leaser.acquire = async request => {
    f.calls.acquired++; assert.equal(request.source.kind, 'warehouse'); throw new ApplicationError('MANAGED_DATA_LEASE_UNAVAILABLE');
  };
  await assert.rejects(f.app.execute(f.input), hasCode('MANAGED_DATA_LEASE_UNAVAILABLE'));
  assert.equal(f.calls.acquired, 1); assert.equal(f.calls.compiled, 0); assert.equal(f.state.record, null);
});

test('preparation wire rejects host selectors and returns only reference evidence', () => {
  const f = fixture();
  for (const value of [{...f.input, argv: ['host-command']}, {...f.input, project: {...f.input.project, root: '/host'}},
    {...f.input, binding: {...f.input.binding, accountId: '../foreign'}}]) {
    assert.throws(() => parseNodePreparation(value), hasCode('INVALID_REQUEST'));
  }
  const result = nodePreparationResult({binding: {...f.input.binding, nativeDigest: 'private'},
    project: {...f.input.project, runtime: {kind: 'base', identity: 'private'}},
    inputs: [{source: {kind: 'directory', sourceId: 'raw'}}], planDigest: 'd'.repeat(64)});
  assert.equal(Object.hasOwn(result.binding, 'nativeDigest'), false);
  assert.equal(Object.hasOwn(result.project, 'runtime'), false);
  assert.throws(() => parseNodePreparationResult({...result, submission: f.input.submission}), hasCode('INVALID_API_RESPONSE'));
});

test('coordinator recovers after a lost preparation reply and rechecks current permissions without sending', async () => {
  const f = fixture(); let ready = null, authorized = true, writes = 0;
  const contexts = {read() {if (!authorized) throw new ApplicationError('FORBIDDEN'); return structuredClone(f.input);}};
  const nodes = {async lookup() {return ready;}, async prepare(input) {
    writes++; ready = nodePreparationResult(await f.app.execute(input)); throw new ApplicationError('NODE_PREPARATION_UNCONFIRMED');
  }};
  const app = new PrepareTaskLaunch({contexts, nodes});
  await assert.rejects(app.execute(f.input.binding.jobId), hasCode('NODE_PREPARATION_UNCONFIRMED'));
  assert.deepEqual(await app.execute(f.input.binding.jobId), ready); assert.equal(writes, 1);
  nodes.lookup = async () => {authorized = false; return ready;};
  await assert.rejects(app.execute(f.input.binding.jobId), hasCode('FORBIDDEN'));
  assert.equal(writes, 1);
});
