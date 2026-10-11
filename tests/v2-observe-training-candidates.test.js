import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {createTrainingCatalogSchema, SqliteTrainingCatalog} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {createProjectRegistrationSchema} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {ObserveTrainingCandidates} from '../src/application/observe-training-candidates.mjs';
import {ApplicationError, TransientReadError} from '../src/domain/errors.mjs';
import {ResolveTrainingData} from '../src/application/resolve-training-data.mjs';

const release = 'a'.repeat(64), request = {project: {id: 'logical', release}, machines: {kind: 'any'}, resources: {minGpus: 1}, dataSources: []};
const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture(); t.after(() => f.close());
  createTrainingCatalogSchema(f.database); createProjectRegistrationSchema(f.database);
  f.database.exec(`UPDATE v2_machines SET cards=8; UPDATE v2_machine_grants SET max_cards=4;
    INSERT INTO v2_machines(id,cards) VALUES('node-2',4);
    INSERT INTO v2_machine_grants VALUES('alice','node-2',4);
    INSERT INTO v2_compute_policies VALUES('alice',4,0);
    INSERT INTO v2_projects(id,owner_id) VALUES('logical','alice')`);
  f.database.prepare('INSERT INTO v2_project_releases VALUES(?,?)').run('logical', release);
  const observations = new Map();
  for (const machineId of ['node-1','node-2']) {
    const uuid = randomUUID(), generation = 'b'.repeat(64);
    f.database.prepare('INSERT INTO v2_project_instances VALUES(?,?,?,?,?)').run('logical', machineId, 'training', uuid, generation);
    f.database.prepare('INSERT INTO v2_release_locations VALUES(?,?,?)').run('logical', release, machineId);
    observations.set(machineId, {accountId: 'alice', machineId, project: 'training', release, projectUUID: uuid,
      generation, environmentMode: 'oci', lifecycle: 'ACTIVE', runtimeVerified: false});
  }
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login(loginRequest);
  const actor = {id: 'alice', sessionId: f.database.prepare('SELECT id FROM v2_sessions').get().id}, calls = [];
  const runtimeCalls = [];
  const projects = {
    async inspect(reference) {calls.push(reference.machineId); return {...observations.get(reference.machineId)};},
    async verifyRuntime(reference) {
      runtimeCalls.push(reference.machineId);
      const {runtimeVerified, ...identity} = observations.get(reference.machineId);
      return {...identity, runtimeIdentityVerified: true, runtime: {kind: 'oci', identity: 'sha256:' + 'd'.repeat(64)}};
    },
  };
  const data = new ResolveTrainingData({access: {async requireRead() {}}, sources: {async inspect() {return {availability: 'available'};}}});
  const resources = {async validate() {return {};}, async execute() {return {eligible: true, allowedGpuCounts: [1], exclusiveFreeFitGpuCount: 1, waitingFor: null};}};
  const quota = {async balances(_actor, ids) {return ids.map(machineId => ({machineId, remainingGpus: 4}));}};
  const app = new ObserveTrainingCandidates({catalog: new SqliteTrainingCatalog({database: f.database}), projects, data, resources, quota});
  return {...f, actor, observations, calls, runtimeCalls, projects, data, resources, quota, app};
}

test('only exact registered active instances and runtime references survive without claiming GPU readiness', async t => {
  const f = await fixture(t), writes = f.database.prepare('SELECT total_changes() n').get().n;
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.candidates.map(row => row.machineId), ['node-1','node-2']);
  assert.ok(result.candidates.every(row => row.runtimeIdentityVerified === true && row.maxConfiguredGpus === 4));
  assert.ok(result.candidates.every(row => !Object.hasOwn(row, 'runtimeVerified')));
  assert.deepEqual(f.runtimeCalls, ['node-1', 'node-2']);
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, writes);
});

test('one unavailable node does not block another healthy project instance', async t => {
  const f = await fixture(t), original = f.projects.inspect;
  f.projects.inspect = async reference => {if (reference.machineId === 'node-1') throw new ApplicationError('PROJECT_NODE_UNAVAILABLE'); return original(reference);};
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.candidates.map(row => row.machineId), ['node-2']);
  assert.deepEqual(result.excluded, [{machineId: 'node-1', reason: 'node-unavailable'}]);
});

test('changed generation and archived metadata are excluded rather than silently adopted', async t => {
  const f = await fixture(t);
  f.observations.get('node-1').generation = 'c'.repeat(64);
  f.observations.get('node-2').lifecycle = 'ARCHIVED';
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.excluded.map(row => row.reason), ['instance-changed','project-inactive']);
});

test('permissions changing during a node query invalidate the whole result and stop subsequent queries', async t => {
  const f = await fixture(t), original = f.projects.inspect;
  f.projects.inspect = async reference => {const value = await original(reference); f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-2'"); return value;};
  await assert.rejects(f.app.execute(f.actor, request), hasCode('TRAINING_CONTEXT_CHANGED'));
  assert.deepEqual(f.calls, ['node-1']);
});

test('display metadata and equivalent grant ordering do not invalidate effective candidate authorization', async t => {
  const f = await fixture(t), original = f.projects.inspect;
  f.projects.inspect = async reference => {
    const result = await original(reference);
    f.database.exec(`UPDATE v2_accounts SET display_name='新的显示名' WHERE id='alice';
      UPDATE v2_compute_policies SET revision=revision+1 WHERE account_id='alice';
      DELETE FROM v2_machine_grants WHERE account_id='alice';
      INSERT INTO v2_machine_grants VALUES('alice','node-2',4);
      INSERT INTO v2_machine_grants VALUES('alice','node-1',4)`);
    return result;
  };
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.candidates.map(row => row.machineId), ['node-1', 'node-2']);
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(f.calls, ['node-1', 'node-2']);
});

test('a real quota change still invalidates candidates during a node observation', async t => {
  const f = await fixture(t), original = f.projects.inspect;
  f.projects.inspect = async reference => {
    const result = await original(reference);
    f.database.exec("UPDATE v2_machine_grants SET max_cards=2 WHERE account_id='alice' AND machine_id='node-1'");
    return result;
  };
  await assert.rejects(f.app.execute(f.actor, request), hasCode('TRAINING_CONTEXT_CHANGED'));
  assert.deepEqual(f.calls, ['node-1']);
});

test('revocation masks a simultaneous node error and prevents stale eligibility', async t => {
  const f = await fixture(t);
  f.projects.inspect = async () => {f.database.exec('UPDATE v2_accounts SET enabled=0'); throw new ApplicationError('PROJECT_NODE_UNAVAILABLE');};
  await assert.rejects(f.app.execute(f.actor, request), hasCode('UNAUTHENTICATED'));
});

test('metadata without an instance binding makes no node request and is never marked ready', async t => {
  const f = await fixture(t); f.database.exec('DELETE FROM v2_project_instances');
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.candidates, []); assert.deepEqual(f.calls, []);
  assert.ok(result.excluded.every(row => row.reason === 'instance-not-registered'));
  assert.deepEqual(f.runtimeCalls, []);
});

test('a missing runtime excludes only that node and preserves another verified runtime', async t => {
  const f = await fixture(t), original = f.projects.verifyRuntime;
  f.projects.verifyRuntime = async reference => {
    if (reference.machineId === 'node-1') throw new ApplicationError('PROJECT_SOURCE_UNAVAILABLE');
    return original(reference);
  };
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.candidates.map(row => row.machineId), ['node-2']);
  assert.deepEqual(result.excluded, [{machineId: 'node-1', reason: 'runtime-unavailable'}]);
});

test('instance replacement and malformed runtime claims cannot pass on earlier metadata', async t => {
  const f = await fixture(t), original = f.projects.verifyRuntime;
  f.projects.verifyRuntime = async reference => {
    const result = await original(reference);
    return reference.machineId === 'node-1' ? {...result, generation: 'e'.repeat(64)} : {...result, runtimeIdentityVerified: false};
  };
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.excluded.map(row => row.reason), ['instance-changed', 'invalid-runtime-observation']);
});

test('runtime query rechecks registration and stops before querying a second node on drift', async t => {
  const f = await fixture(t), original = f.projects.verifyRuntime;
  f.projects.verifyRuntime = async reference => {
    const result = await original(reference);
    f.database.prepare('UPDATE v2_project_instances SET generation=? WHERE machine_id=?').run('e'.repeat(64), 'node-1');
    return result;
  };
  await assert.rejects(f.app.execute(f.actor, request), hasCode('TRAINING_CONTEXT_CHANGED'));
  assert.deepEqual(f.calls, ['node-1']);
  assert.deepEqual(f.runtimeCalls, ['node-1']);
});

test('account revocation during a failed runtime query aborts the whole observation', async t => {
  const f = await fixture(t);
  f.projects.verifyRuntime = async () => {
    f.database.exec('UPDATE v2_accounts SET enabled=0');
    throw new ApplicationError('PROJECT_SOURCE_UNAVAILABLE');
  };
  await assert.rejects(f.app.execute(f.actor, request), hasCode('UNAUTHENTICATED'));
  assert.deepEqual(f.calls, ['node-1']);
});

test('data missing on one machine excludes only that machine without preparing a copy', async t => {
  const f = await fixture(t);
  f.data.read.sources.inspect = async reference => reference.machineId === 'node-1'
    ? {availability: 'missing', reason: 'not-found'} : {availability: 'available'};
  const result = await f.app.execute(f.actor, {...request, dataSources: [{kind: 'directory', sourceId: 'images'}]});
  assert.deepEqual(result.excluded, [{machineId: 'node-1', reason: 'data-unavailable'}]);
  assert.deepEqual(result.candidates.map(row => row.machineId), ['node-2']);
  assert.deepEqual(result.candidates[0].dataReads[0].location, {containerPath: '/datasets/images', readOnly: true});
});

test('exhausted data contention remains local and explicit while healthy candidates share the same retry budget', async t => {
  const f = await fixture(t), calls = [], scopes = [], original = f.data.execute.bind(f.data);
  f.data.execute = (...args) => {scopes.push(args[2].reads); return original(...args);};
  f.data.read.sources.inspect = async reference => {
    calls.push(reference.machineId);
    if (reference.machineId === 'node-1') throw new TransientReadError('SOURCE_BUSY');
    return {availability: 'available'};
  };
  const result = await f.app.execute(f.actor, {...request, dataSources: [{kind: 'directory', sourceId: 'images'}]});
  assert.deepEqual(result.excluded, [{machineId: 'node-1', reason: 'data-busy'}]);
  assert.deepEqual(result.candidates.map(row => row.machineId), ['node-2']);
  assert.deepEqual(calls, ['node-1', 'node-1', 'node-1', 'node-2']);
  assert.equal(scopes.length, 2); assert.equal(scopes[0], scopes[1]);
});

test('project drift during a busy data read aborts before waiting or re-observing any node', async t => {
  const f = await fixture(t), calls = [];
  f.data.read.sources.inspect = async reference => {
    calls.push(reference.machineId);
    f.database.prepare('UPDATE v2_project_instances SET generation=? WHERE machine_id=?').run('e'.repeat(64), reference.machineId);
    throw new TransientReadError('SOURCE_BUSY');
  };
  await assert.rejects(f.app.execute(f.actor, {...request, dataSources: [{kind: 'directory', sourceId: 'images'}]}), hasCode('TRAINING_CONTEXT_CHANGED'));
  assert.deepEqual(calls, ['node-1']);
});

test('final authorization rejects a data grant revoked while observing a later candidate', async t => {
  const f = await fixture(t);
  let revoked = false;
  f.data.access.requireRead = async (_actor, reference) => {
    if (revoked && reference.machineId === 'node-1') throw new ApplicationError('FORBIDDEN');
  };
  f.data.read.sources.inspect = async reference => {
    if (reference.machineId === 'node-2') revoked = true;
    return {availability: 'available'};
  };
  await assert.rejects(f.app.execute(f.actor, {...request, dataSources: [{kind: 'directory', sourceId: 'images'}]}), hasCode('FORBIDDEN'));
});

test('a node-local data grant is not required on every otherwise eligible machine', async t => {
  const f = await fixture(t), reads = [];
  f.data.access.requireRead = async (_actor, reference) => {
    if (reference.machineId === 'node-1') throw new ApplicationError('FORBIDDEN');
  };
  f.data.read.sources.inspect = async reference => {reads.push(reference.machineId); return {availability: 'available'};};
  const result = await f.app.execute(f.actor, {...request, dataSources: [{kind: 'directory', sourceId: 'images'}]});
  assert.deepEqual(result.candidates.map(row => row.machineId), ['node-2']);
  assert.deepEqual(result.excluded, [{machineId: 'node-1', reason: 'data-not-authorized'}]);
  assert.deepEqual(reads, ['node-2']);
});

test('pool failure excludes one node before project queries and preserves the next candidate', async t => {
  const f = await fixture(t);
  f.resources.execute = async (_validated, candidate) => {
    if (candidate.machineId === 'node-1') throw new ApplicationError('GPU_POOL_UNAVAILABLE');
    return {eligible: true, allowedGpuCounts: [1], exclusiveFreeFitGpuCount: null, waitingFor: 'free-capacity'};
  };
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.excluded, [{machineId: 'node-1', reason: 'resource-unavailable'}]);
  assert.deepEqual(f.calls, ['node-2']);
  assert.equal(result.candidates[0].resourceFit.waitingFor, 'free-capacity');
});

test('machine access revoked during a pool query prevents subsequent project inspection', async t => {
  const f = await fixture(t);
  f.resources.execute = async () => {
    f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
    return {eligible: true};
  };
  await assert.rejects(f.app.execute(f.actor, request), hasCode('TRAINING_CONTEXT_CHANGED'));
  assert.deepEqual(f.calls, []);
});

test('quota is observed after node checks and insufficient balance keeps the candidate waiting', async t => {
  const f = await fixture(t);
  f.quota.balances = async (_actor, ids) => {
    assert.deepEqual(f.runtimeCalls, ['node-1', 'node-2']);
    assert.deepEqual(ids, ['node-1', 'node-2']);
    return ids.map(machineId => ({machineId, remainingGpus: 0}));
  };
  const result = await f.app.execute(f.actor, request);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every(row => row.quotaFit.waitingFor === 'quota' && row.quotaFit.exclusiveFreeFitGpuCount === null));
});

test('incomplete quota observations cannot be treated as unused quota', async t => {
  const f = await fixture(t);
  f.quota.balances = async () => [];
  await assert.rejects(f.app.execute(f.actor, request), hasCode('COMPUTE_ACCOUNTING_UNREADY'));
  f.quota.balances = async () => {throw new ApplicationError('COMPUTE_ACCOUNTING_UNREADY');};
  await assert.rejects(f.app.execute(f.actor, request), hasCode('COMPUTE_ACCOUNTING_UNREADY'));
});
