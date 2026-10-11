import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dispatchFixture} from './helpers/v2-dispatch-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingCatalogSchema} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {createProjectRegistrationSchema} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {SqliteLaunchAuthorization} from '../src/infrastructure/sqlite/launch-authorization.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const submission = trainingSubmission();
  submission.dataSources = [{kind: 'directory', sourceId: 'images'}, {kind: 'warehouse', datasetId: 'train', version: 'f'.repeat(64)}];
  const f = await dispatchFixture(t, {submission});
  createTrainingCatalogSchema(f.database); createProjectRegistrationSchema(f.database);
  f.database.exec("INSERT INTO v2_projects(id,owner_id) VALUES('project-1','alice')");
  f.database.prepare('INSERT INTO v2_project_releases VALUES(?,?)').run('project-1', submission.project.release);
  f.database.prepare('INSERT INTO v2_release_locations VALUES(?,?,?)').run('project-1', submission.project.release, 'node-1');
  const project = {id: 'project-1', project: 'training', release: submission.project.release, projectUUID: randomUUID(), generation: 'b'.repeat(64)};
  f.database.prepare('INSERT INTO v2_project_instances VALUES(?,?,?,?,?)').run('project-1', 'node-1', project.project, project.projectUUID, project.generation);
  f.database.prepare('INSERT INTO v2_data_resources(id,kind,machine_id,source_id,version,visibility,owner_id) VALUES(?,?,?,?,?,?,?)')
    .run('train', 'dataset', null, 'train', 'f'.repeat(64), 'private', 'alice');
  const permit = f.dispatches.beginSend(f.jobId, f.now);
  const binding = f.dispatches.delivery(permit.dispatch.dispatchId);
  const command = {binding, project, inputs: [{source: submission.dataSources[0]}, {source: submission.dataSources[1], leaseId: randomUUID()}]};
  return {...f, command, submission, permit, authorization: new SqliteLaunchAuthorization({database: f.database})};
}

test('prepared references, current project/data permission and held quota authorize in one readonly transaction after logout', async t => {
  const f = await fixture(t);
  f.database.exec('UPDATE v2_sessions SET revoked=1,expires_at_ms=0; PRAGMA query_only=ON');
  const before = f.database.prepare('SELECT total_changes() n').get().n;
  const approved = f.authorization.acquire(f.command);
  assert.deepEqual(approved, {scope: 'launch-ready', dispatchId: f.command.binding.dispatchId, jobId: f.jobId,
    accountId: 'alice', machineId: 'node-1', gpuCount: 2, requestHash: f.command.binding.requestHash, grantId: f.command.binding.dispatchId});
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(f.database.isTransaction, false);
  // No filesystem, native, observer, preparation or lease writer is part of this authority.
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_claims').get().n, 1);
});

test('changed project identity, release location, archive or ownership cannot start', async t => {
  const f = await fixture(t);
  for (const change of [{id: 'other'}, {project: 'other'}, {release: 'e'.repeat(64)}, {projectUUID: randomUUID()}, {generation: 'c'.repeat(64)}]) {
    assert.throws(() => f.authorization.acquire({...f.command, project: {...f.command.project, ...change}}), hasCode('NODE_LAUNCH_PROJECT_CHANGED'));
  }
  f.database.exec('UPDATE v2_projects SET archived=1');
  assert.throws(() => f.authorization.acquire(f.command), hasCode('PROJECT_ARCHIVED'));
  f.database.exec('UPDATE v2_projects SET archived=0; DELETE FROM v2_release_locations');
  assert.throws(() => f.authorization.acquire(f.command), hasCode('NODE_LAUNCH_PROJECT_CHANGED'));
  f.database.exec("INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob'); UPDATE v2_projects SET owner_id='bob'");
  assert.throws(() => f.authorization.acquire(f.command), hasCode('FORBIDDEN'));
});

test('data scope cannot be omitted or changed and every managed input needs its original lease reference', async t => {
  const f = await fixture(t), changed = structuredClone(f.command);
  for (const inputs of [[], f.command.inputs.slice(1), [...f.command.inputs].reverse(),
    [f.command.inputs[0], {source: f.command.inputs[1].source}],
    [f.command.inputs[0], {...f.command.inputs[1], source: {...f.command.inputs[1].source, version: 'c'.repeat(64)}}]]) {
    assert.throws(() => f.authorization.acquire({...f.command, inputs}), hasCode('NODE_LAUNCH_INPUTS_CHANGED'));
  }
  // Object key order is not another data identity or a reason to reject admission.
  changed.inputs[1].source = {version: 'f'.repeat(64), datasetId: 'train', kind: 'warehouse'};
  assert.equal(f.authorization.acquire(changed).scope, 'launch-ready');
});

test('current data permissions are required for raw and managed sources, even for administrators', async t => {
  const f = await fixture(t);
  f.database.exec("INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob'); UPDATE v2_data_resources SET owner_id='bob' WHERE id='train'");
  assert.throws(() => f.authorization.acquire(f.command), hasCode('FORBIDDEN'));
  f.database.exec("UPDATE v2_accounts SET role='admin' WHERE id='alice'");
  assert.throws(() => f.authorization.acquire(f.command), hasCode('FORBIDDEN'));
  f.database.exec("INSERT INTO v2_data_readers(resource_id,account_id) VALUES('train','alice')");
  assert.equal(f.authorization.acquire(f.command).scope, 'launch-ready');
  f.database.exec("UPDATE v2_data_resources SET visibility='private',owner_id='bob' WHERE id='images'");
  assert.throws(() => f.authorization.acquire(f.command), hasCode('FORBIDDEN'));
});

test('late revocation or uncertain delivery cannot obtain another launch approval or repair the hold', async t => {
  const f = await fixture(t);
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  assert.throws(() => f.authorization.acquire(f.command), hasCode('TASK_NOT_AUTHORIZED'));
  f.database.exec("UPDATE v2_accounts SET enabled=1 WHERE id='alice'; UPDATE v2_compute_claims SET state='RELEASED'");
  assert.throws(() => f.authorization.acquire(f.command), hasCode('COMPUTE_CLAIM_CHANGED'));
  f.database.exec("UPDATE v2_compute_claims SET state='HELD'");
  f.dispatches.recordSendOutcome({dispatchId: f.command.binding.dispatchId, senderToken: f.permit.senderToken, nodeJobId: null});
  assert.throws(() => f.authorization.acquire(f.command), hasCode('NODE_LAUNCH_NOT_AUTHORIZED'));
  assert.equal(f.database.prepare('SELECT reserved_gpu_count FROM v2_compute_claims').get().reserved_gpu_count, 2);
});
