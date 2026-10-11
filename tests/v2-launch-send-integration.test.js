import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawn, execFile} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {readFile, stat, writeFile} from 'node:fs/promises';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {projectFixture} from './helpers/v2-project-fixture.mjs';
import {publishedFixture} from './helpers/v2-published-fixture.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {createTrainingCatalogSchema} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {createProjectRegistrationSchema, SqliteProjectRegistrations} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {RegisterProjectRelease} from '../src/application/register-project-release.mjs';
import {ProjectRunPreparer} from '../src/infrastructure/project-run-preparer.mjs';
import {ManagedDataLeaser} from '../src/infrastructure/managed-data-leaser.mjs';
import {TrainingLaunchCompiler} from '../src/infrastructure/training-launch-compiler.mjs';
import {GpuqLaunchSpec} from '../src/infrastructure/gpuq-launch-spec.mjs';
import {GpuqPolicy} from '../src/infrastructure/gpuq-policy.mjs';
import {ValidateTrainingResources} from '../src/application/validate-training-resources.mjs';
import {PrepareNodeTraining} from '../src/application/prepare-node-training.mjs';
import {createNodeDispatchBindingsSchema, SqliteNodeDispatchBindings} from '../src/infrastructure/sqlite/node-dispatch-bindings.mjs';
import {SqliteLaunchAuthorization} from '../src/infrastructure/sqlite/launch-authorization.mjs';
import {GpuqManagedClient} from '../src/infrastructure/gpuq-managed-client.mjs';
import {GpuqReceiptReader} from '../src/infrastructure/gpuq-receipt-reader.mjs';
import {LookupNodeDispatch} from '../src/application/lookup-node-dispatch.mjs';
import {SubmitNodeDispatch} from '../src/application/submit-node-dispatch.mjs';

const python = process.env.V2_PYTHON || 'python3', run = promisify(execFile);
async function nativeServer(t) {
  const child = spawn(python, ['-B', fileURLToPath(new URL('./helpers/v2-empty-native-server.py', import.meta.url))], {stdio: ['pipe', 'pipe', 'pipe']});
  let errors = ''; child.stderr.on('data', chunk => errors += chunk);
  const done = once(child, 'exit');
  t.after(async () => {child.stdin.end(); const [code] = await done; assert.equal(code, 0, errors);});
  const lines = createInterface({input: child.stdout});
  const [line] = await Promise.race([once(lines, 'line'), done.then(() => {throw new Error(errors || 'native fixture exited');})]);
  return JSON.parse(line);
}

async function fixture(t) {
  const f = await computeFixture(t), project = await projectFixture(t), data = await publishedFixture(t), server = await nativeServer(t);
  f.ready(); createTrainingQueueSchema(f.database); createTrainingDispatchSchema(f.database);
  createTrainingCatalogSchema(f.database); createProjectRegistrationSchema(f.database);
  const context = {actor: f.actor};
  const registered = await new RegisterProjectRelease({registrations: new SqliteProjectRegistrations({database: f.database}), projects: project.reader})
    .execute(f.actor, {...project.request, projectId: 'project-1'});
  const submission = trainingSubmission();
  submission.project.release = project.release; submission.dataSources = [data.request('warehouse').source];
  f.database.prepare('INSERT INTO v2_data_resources(id,kind,machine_id,source_id,version,visibility,owner_id) VALUES(?,?,?,?,?,?,?)')
    .run('warehouse-images', 'dataset', null, 'images', data.version, 'private', 'alice');
  const jobId = new SqliteTrainingQueue({database: f.database}).enqueue(f.actor, submission, f.now).request.jobId;
  const dispatches = new SqliteTrainingDispatches({database: f.database});
  const selected = dispatches.prepareForTask(jobId, {machineId: 'node-1', gpuCount: 2}, f.now);
  const prepared = await new ProjectRunPreparer({machineId: 'node-1', root: project.root, basePath: project.basePath, python})
    .prepare({...project.request, projectUUID: registered.projectUUID, generation: registered.generation, jobId}, context);
  const leaser = new ManagedDataLeaser({machineId: 'node-1', roots: data.roots, python});
  const request = {...data.request('warehouse'), jobId}, lease = await leaser.acquire(request, context);
  const database = join(project.directory, 'node.sqlite'), node = new DatabaseSync(database); t.after(() => node.close());
  createNodeDispatchBindingsSchema(node);
  const bindings = new SqliteNodeDispatchBindings({database: node, machineId: 'node-1'});
  const executable = (await run(python, ['-c', 'import sys; print(sys.executable)'])).stdout.trim();
  const config = join(project.directory, 'runner.json');
  await writeFile(config, JSON.stringify({schema: 1, machineId: 'node-1', database, gpuqSocket: server.socketPath,
    controlRoot: server.controlRoot, gpuqArchive: fileURLToPath(new URL('../build/gpuq.pyz', import.meta.url)),
    root: project.root, basePath: project.basePath, managedRoots: data.roots}));
  const compiler = new TrainingLaunchCompiler({runner: [executable, '-I', '-B', fileURLToPath(new URL('../scripts/v2-training-runner.py', import.meta.url)), '--config', config],
    cwd: project.directory, resources: new ValidateTrainingResources({policy: new GpuqPolicy({python})}), launchSpec: new GpuqLaunchSpec({python})});
  const receipt = await new PrepareNodeTraining({compiler, bindings}).execute({identity: dispatches.delivery(selected.dispatchId),
    submission, project: {id: 'project-1', run: prepared}, leases: [lease]}, {gpuUuids: ['GPU-0', 'GPU-1', 'GPU-2', 'GPU-3']});
  const native = new GpuqManagedClient({socketPath: server.socketPath, python});
  const lookup = new LookupNodeDispatch({bindings, native: new GpuqReceiptReader({socketPath: server.socketPath, python})});
  const app = new SubmitNodeDispatch({bindings, receipts: lookup, admission: new SqliteLaunchAuthorization({database: f.database}), native});
  return {...f, project, data, node, jobId, selected, receipt, dispatches, native, app, bindings,
    context, leaser, request, lease, reference: {machineId: 'node-1', dispatchId: selected.dispatchId}};
}

test('real prepared inputs and coordinator authorization reach native acceptance once, without another preparation or capacity scan', async t => {
  const f = await fixture(t);
  await assert.rejects(f.app.execute(f.reference), error => error.code === 'NODE_LAUNCH_NOT_AUTHORIZED');
  const permit = f.dispatches.beginSend(f.jobId, f.now);
  const claim = join(f.project.root, 'projects-v2', '.run-claims', f.jobId + '.json');
  const before = {bytes: await readFile(claim, 'utf8'), mtime: (await stat(claim)).mtimeMs};
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  const first = await f.app.execute(f.reference);
  assert.equal(first.kind, 'accepted'); assert.equal(first.receipt.jobId, f.jobId); assert.equal(first.receipt.gpuCount, 2);
  f.dispatches.recordSendOutcome({dispatchId: f.selected.dispatchId, senderToken: permit.senderToken, nodeJobId: first.receipt.nodeJobId});
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  assert.deepEqual(await f.app.execute(f.reference), first);
  assert.equal((await f.native.allocation({submitKey: f.selected.dispatchId})).grant.max_gpu_count, 2);
  assert.deepEqual(await f.leaser.lookup(f.request, f.context), f.lease);
  assert.deepEqual({bytes: await readFile(claim, 'utf8'), mtime: (await stat(claim)).mtimeMs}, before);
  assert.equal(f.database.prepare('SELECT reserved_gpu_count FROM v2_compute_claims').get().reserved_gpu_count, 2);
});

test('a permission change or mismatched stored native command cannot mutate the native scheduler', async t => {
  const f = await fixture(t); f.dispatches.beginSend(f.jobId, f.now);
  f.database.exec("DELETE FROM v2_data_resources WHERE id='warehouse-images'");
  await assert.rejects(f.app.execute(f.reference), error => error.code === 'FORBIDDEN');
  assert.equal(await f.native.allocation({submitKey: f.selected.dispatchId}), null);
  f.database.prepare('INSERT INTO v2_data_resources(id,kind,machine_id,source_id,version,visibility,owner_id) VALUES(?,?,?,?,?,?,?)')
    .run('warehouse-images', 'dataset', null, 'images', f.data.version, 'private', 'alice');
  const stored = f.bindings.launch(f.reference).submission;
  stored.env.CHANGED = 'never sent';
  f.node.prepare('UPDATE v2_node_launch_specs SET submission_json=?').run(JSON.stringify(stored));
  await assert.rejects(f.app.execute(f.reference), error => error.code === 'INVALID_MANAGED_REQUEST');
  assert.equal(await f.native.allocation({submitKey: f.selected.dispatchId}), null);
  assert.equal(f.dispatches.delivery(f.selected.dispatchId).state, 'SENDING');
});
