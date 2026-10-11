import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, stat, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {publishedFixture, python} from './helpers/v2-published-fixture.mjs';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {ManagedDataLeaser} from '../src/infrastructure/managed-data-leaser.mjs';
import {ManagedSourceReader} from '../src/infrastructure/managed-source-reader.mjs';
import {SqliteTaskAuthority} from '../src/infrastructure/sqlite/task-authority.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {AcquireManagedTaskLease} from '../src/application/acquire-managed-task-lease.mjs';

const hasCode = code => error => error.code === code;
test('real existing data lease is durable and idempotent without payload changes or host path exposure', async t => {
  const f = await publishedFixture(t), leaser = new ManagedDataLeaser({machineId: 'node-1', roots: f.roots, python});
  const request = {...f.request('cache'), jobId: randomUUID()}, context = {actor: {id: 'alice'}};
  const file = join(f.directory, 'cache', 'ready', 'images', f.version, 'data', 'sample.txt'), before = await stat(file);
  const lease = await leaser.acquire(request, context);
  assert.deepEqual(await leaser.acquire(request, context), lease);
  assert.equal(lease.jobId, request.jobId); assert.equal(lease.accountId, 'alice'); assert.equal(lease.readOnly, true);
  assert.equal(JSON.stringify(lease).includes(f.directory), false);
  assert.equal((await stat(file)).ino, before.ino); assert.equal(await readFile(file, 'utf8'), 'original sample');
  assert.equal((await readdir(join(f.directory, 'cache', '.leases', 'images', f.version))).length, 1);
});

test('metadata delegation does not grant lease writes; lease delegation is exact per configured version and kind', async t => {
  const f = await publishedFixture(t, {owners: ['legacy-owner']});
  const source = f.request('cache').source, warehouse = f.request('warehouse').source;
  const metadata = new ManagedSourceReader({machineId: 'node-1', roots: f.roots, python, coordinatorVersions: [source, warehouse]});
  assert.equal((await metadata.inspect(f.request('warehouse'), {actor: {id: 'alice'}})).availability, 'available');
  const leaser = new ManagedDataLeaser({machineId: 'node-1', roots: f.roots, python, coordinatorVersions: [warehouse], leaseVersions: [source]});
  const ownerFile = join(f.directory, 'cache', '.registry', 'images', 'dataset.json'), owners = await readFile(ownerFile, 'utf8');
  assert.equal((await leaser.acquire({...f.request('cache'), jobId: randomUUID()}, {actor: {id: 'alice'}})).accountId, 'alice');
  await assert.rejects(leaser.acquire({...f.request('warehouse'), jobId: randomUUID()}, {actor: {id: 'alice'}}), hasCode('FORBIDDEN'));
  assert.equal(await readFile(ownerFile, 'utf8'), owners);
});

test('request-side admin/delegation fields and wrong-node requests cannot acquire a lease', async t => {
  const f = await publishedFixture(t), leaser = new ManagedDataLeaser({machineId: 'node-1', roots: f.roots, python});
  const request = {...f.request('cache'), jobId: randomUUID()}, context = {actor: {id: 'alice'}};
  for (const extra of [{hostAdmin: true}, {leaseVersion: {dataset: 'images', version: f.version}}, {accountId: 'other'}]) {
    await assert.rejects(leaser.acquire({...request, ...extra}, context), hasCode('INVALID_REQUEST'));
  }
  await assert.rejects(leaser.acquire({...request, machineId: 'other'}, context), hasCode('SOURCE_NODE_MISMATCH'));
  await assert.rejects(leaser.acquire(request), hasCode('UNAUTHENTICATED'));
});

test('task authorization surrounds a real delegated lease acquisition and revocation does not silently release it', async t => {
  const f = await computeFixture(t), data = await publishedFixture(t, {owners: ['legacy-owner']});
  createTrainingQueueSchema(f.database);
  f.database.prepare("INSERT INTO v2_data_resources(id,kind,machine_id,source_id,version,visibility,owner_id) VALUES('managed','dataset',NULL,'images',?,'shared',NULL)").run(data.version);
  const input = trainingSubmission(); input.dataSources = [data.request('cache').source];
  const jobId = new SqliteTrainingQueue({database: f.database}).enqueue(f.actor, input, f.now).request.jobId;
  const leaser = new ManagedDataLeaser({machineId: 'node-1', roots: data.roots, python, leaseVersions: input.dataSources});
  const authority = new SqliteTaskAuthority({database: f.database});
  const app = new AcquireManagedTaskLease({authority, leaser});
  const result = await app.execute(jobId, data.request('cache'));
  assert.equal(result.accountId, 'alice'); assert.equal(result.jobId, jobId);
  const acquire = leaser.acquire.bind(leaser);
  leaser.acquire = async (...args) => {
    const lease = await acquire(...args);
    f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
    return lease;
  };
  const next = {...trainingSubmission(), dataSources: input.dataSources};
  const nextJobId = new SqliteTrainingQueue({database: f.database}).enqueue(f.actor, next, f.now).request.jobId;
  await assert.rejects(app.execute(nextJobId, data.request('cache')), hasCode('FORBIDDEN'));
  assert.equal((await readdir(join(data.directory, 'cache', '.leases', 'images', data.version))).length, 2);
});
