import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dispatchFixture} from './helpers/v2-dispatch-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingCatalogSchema} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {createProjectRegistrationSchema} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {SqliteTaskPreparation} from '../src/infrastructure/sqlite/task-preparation.mjs';
import {PrepareTaskLaunch} from '../src/application/prepare-task-launch.mjs';

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
  const contexts = new SqliteTaskPreparation({database: f.database});
  const input = contexts.read(f.jobId);
  const ready = {binding: input.binding, project, planDigest: 'd'.repeat(64),
    inputs: [{source: submission.dataSources[0]}, {source: submission.dataSources[1], leaseId: randomUUID()}]};
  return {...f, submission, project, contexts, ready};
}

test('preparation reads the fixed dispatch and exact inputs after logout with no database writes', async t => {
  const f = await fixture(t);
  f.database.exec('UPDATE v2_sessions SET revoked=1,expires_at_ms=0; PRAGMA query_only=ON');
  const changes = f.database.prepare('SELECT total_changes() n').get().n;
  const input = f.contexts.read(f.jobId);
  assert.deepEqual(input.project, f.project);
  assert.deepEqual(input.submission, f.submission);
  assert.equal(input.binding.dispatchId, f.prepared.dispatchId);
  assert.equal(input.binding.machineId, 'node-1'); assert.equal(input.binding.gpuCount, 2);
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, changes);
  assert.equal(f.database.isTransaction, false);
});

test('preparation requires a held original dispatch and cannot change target when its project disappears', async t => {
  const f = await fixture(t);
  f.database.exec("UPDATE v2_compute_claims SET state='RELEASED'");
  assert.throws(() => f.contexts.read(f.jobId), hasCode('COMPUTE_CLAIM_CHANGED'));
  f.database.exec("UPDATE v2_compute_claims SET state='HELD'; DELETE FROM v2_project_instances");
  assert.throws(() => f.contexts.read(f.jobId), hasCode('NODE_LAUNCH_PROJECT_CHANGED'));
  assert.equal(f.dispatches.delivery(f.prepared.dispatchId).machineId, 'node-1');
  f.dispatches.beginSend(f.jobId, f.now);
  assert.throws(() => f.contexts.read(f.jobId), hasCode('TRAINING_DISPATCH_NOT_PREPARED'));
});

test('revocation or cancellation during lookup prevents preparation and preserves the original hold', async t => {
  for (const [name, change, code] of [
    ['account', f => f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'"), 'TASK_NOT_AUTHORIZED'],
    ['data', f => f.database.exec("DELETE FROM v2_data_resources WHERE id='train'"), 'FORBIDDEN'],
    ['cancel', f => f.database.prepare('INSERT INTO v2_training_cancellations VALUES(?,?,?)').run(f.jobId, 'alice', f.now), 'TASK_NOT_AUTHORIZED'],
  ]) await t.test(name, async t => {
    const f = await fixture(t); let writes = 0;
    const app = new PrepareTaskLaunch({contexts: f.contexts, nodes: {
      async lookup() {change(f); return null;}, async prepare() {writes++; return f.ready;},
    }});
    await assert.rejects(app.execute(f.jobId), hasCode(code));
    assert.equal(writes, 0);
    assert.equal(f.dispatches.delivery(f.prepared.dispatchId).state, 'PREPARED');
    assert.equal(f.database.prepare('SELECT state FROM v2_compute_claims').get().state, 'HELD');
  });
});

test('a changed project instance during preparation is rejected; harmless display changes do not invalidate it', async t => {
  const f = await fixture(t); let writes = 0;
  const nodes = {async lookup() {return null;}, async prepare() {
    writes++; f.database.prepare('UPDATE v2_project_instances SET generation=?').run('e'.repeat(64)); return f.ready;
  }};
  const app = new PrepareTaskLaunch({contexts: f.contexts, nodes});
  await assert.rejects(app.execute(f.jobId), hasCode('TRAINING_CONTEXT_CHANGED'));
  assert.equal(writes, 1); assert.equal(f.dispatches.delivery(f.prepared.dispatchId).state, 'PREPARED');
  f.database.prepare('UPDATE v2_project_instances SET generation=?').run(f.project.generation);
  nodes.lookup = async () => {
    f.database.exec("UPDATE v2_accounts SET display_name='Alice renamed'; UPDATE v2_projects SET revision=revision+1");
    return f.ready;
  };
  assert.deepEqual(await app.execute(f.jobId), f.ready);
  assert.equal(writes, 1);
});

test('recovered preparation must refer to the same account, project and full input set', async t => {
  const f = await fixture(t); let ready = f.ready, writes = 0;
  const app = new PrepareTaskLaunch({contexts: f.contexts, nodes: {
    async lookup() {return ready;}, async prepare() {writes++; return f.ready;},
  }});
  for (const value of [
    {...f.ready, binding: {...f.ready.binding, accountId: 'bob'}},
    {...f.ready, binding: {...f.ready.binding, dispatchId: randomUUID()}},
    {...f.ready, project: {...f.ready.project, generation: 'e'.repeat(64)}},
  ]) {
    ready = value;
    await assert.rejects(app.execute(f.jobId), hasCode('NODE_PREPARATION_CONFLICT'));
  }
  ready = {...f.ready, inputs: f.ready.inputs.slice(1)};
  await assert.rejects(app.execute(f.jobId), hasCode('NODE_LAUNCH_INPUTS_CHANGED'));
  assert.equal(writes, 0);
  assert.equal(f.dispatches.delivery(f.prepared.dispatchId).state, 'PREPARED');
});
