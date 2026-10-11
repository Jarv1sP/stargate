import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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
import http from 'node:http';
import {assembleLaunchAuthorization, assembleNodeSubmission, assembleTrainingSender} from '../src/bootstrap/training-send.mjs';
import {assembleDispatchReceipt} from '../src/bootstrap/dispatch-receipt.mjs';
import {HttpDispatchReceipts} from '../src/infrastructure/http-dispatch-receipts.mjs';
import {ReconcileTrainingDispatch} from '../src/application/reconcile-training-dispatch.mjs';
import {NODE_SUBMISSION_ROUTE} from '../src/contracts/node-submission.mjs';
import {LAUNCH_AUTHORIZATION_ROUTE, launchAuthorizationRequest} from '../src/contracts/launch-authorization.mjs';
import {assembleNodePreparation, assembleTaskPreparation} from '../src/bootstrap/node-preparation.mjs';
import {NODE_PREPARATION_ROUTES} from '../src/contracts/node-preparation.mjs';
import {assembleTrainingDispatchWorker, startTrainingDispatchWorker} from '../src/bootstrap/training-dispatch-worker.mjs';
import {assembleTrainingQueue} from '../src/bootstrap/training-queue.mjs';
import {GpuqPoolReader} from '../src/infrastructure/gpuq-pool-reader.mjs';
import {assembleTrainingCoordinator, startTrainingCoordinator} from '../src/bootstrap/training-coordinator.mjs';
import {assembleProjectInspection} from '../src/bootstrap/project-inspection.mjs';
import {assembleGpuPool} from '../src/bootstrap/gpu-pool.mjs';
import {createSourceInspectionHandler} from '../src/api/source-inspection-handler.mjs';
import {PROJECT_INSPECTION_ROUTE, PROJECT_RUNTIME_ROUTE} from '../src/contracts/project-inspection.mjs';
import {SOURCE_INSPECTION_ROUTE} from '../src/contracts/source-inspection.mjs';
import {GPU_POOL_ROUTE} from '../src/contracts/gpu-pool.mjs';

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

async function fixture(t, {prepare = true, select = true} = {}) {
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
  const selected = select ? dispatches.prepareForTask(jobId, {machineId: 'node-1', gpuCount: 2}, f.now) : null;
  const leaser = new ManagedDataLeaser({machineId: 'node-1', roots: data.roots, python});
  const request = {...data.request('warehouse'), jobId};
  const database = join(project.directory, 'node.sqlite'), node = new DatabaseSync(database); t.after(() => node.close());
  createNodeDispatchBindingsSchema(node);
  const bindings = new SqliteNodeDispatchBindings({database: node, machineId: 'node-1'});
  const executable = (await run(python, ['-c', 'import sys; print(sys.executable)'])).stdout.trim();
  const config = join(project.directory, 'runner.json');
  await writeFile(config, JSON.stringify({schema: 1, machineId: 'node-1', database, gpuqSocket: server.socketPath,
    controlRoot: server.controlRoot, gpuqArchive: fileURLToPath(new URL('../build/gpuq.pyz', import.meta.url)),
    root: project.root, basePath: project.basePath, managedRoots: data.roots}));
  const runner = [executable, '-I', '-B', fileURLToPath(new URL('../scripts/v2-training-runner.py', import.meta.url)), '--config', config];
  const compiler = new TrainingLaunchCompiler({runner,
    cwd: project.directory, resources: new ValidateTrainingResources({policy: new GpuqPolicy({python})}), launchSpec: new GpuqLaunchSpec({python})});
  let receipt, lease;
  if (prepare) {
    const prepared = await new ProjectRunPreparer({machineId: 'node-1', root: project.root, basePath: project.basePath, python})
      .prepare({...project.request, projectUUID: registered.projectUUID, generation: registered.generation, jobId}, context);
    lease = await leaser.acquire(request, context);
    receipt = await new PrepareNodeTraining({compiler, bindings}).execute({identity: dispatches.delivery(selected.dispatchId),
      submission, project: {id: 'project-1', run: prepared}, leases: [lease]}, {gpuUuids: ['GPU-0', 'GPU-1', 'GPU-2', 'GPU-3']});
  }
  const native = new GpuqManagedClient({socketPath: server.socketPath, python});
  const lookup = new LookupNodeDispatch({bindings, native: new GpuqReceiptReader({socketPath: server.socketPath, python})});
  const app = new SubmitNodeDispatch({bindings, receipts: lookup, admission: new SqliteLaunchAuthorization({database: f.database}), native});
  return {...f, project, data, node, server, runner, submission, jobId, selected, receipt, dispatches, native, app, bindings,
    context, leaser, request, lease, reference: selected ? {machineId: 'node-1', dispatchId: selected.dispatchId} : null};
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

const nodeKey = '1'.repeat(64), otherNodeKey = '2'.repeat(64), coordinatorKey = 'd'.repeat(64);
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

async function endpoints(t, f, {dropReply = false, holdAuthorizationReply = false, dropPreparationReply = false} = {}) {
  const observed = {authorizations: [], authorizationReplies: 0, sends: 0, preparations: 0};
  let releaseAuthorization;
  const authorizationReady = holdAuthorizationReply ? new Promise(resolve => {releaseAuthorization = resolve;}) : Promise.resolve();
  t.after(() => releaseAuthorization?.());
  const origin = await listen(t, assembleLaunchAuthorization({database: f.database, peers: [
    {machineId: 'node-1', credential: nodeKey}, {machineId: 'node-2', credential: otherNodeKey}], reportError() {}}));
  const shared = {database: f.node, machineId: 'node-1', credential: coordinatorKey, socketPath: f.server.socketPath, python, reportError() {}};
  const receipts = assembleDispatchReceipt(shared);
  const projects = assembleProjectInspection({...shared, root: f.project.root, basePath: f.project.basePath});
  const sources = createSourceInspectionHandler({...shared, sources: f.data.managed});
  const pool = assembleGpuPool(shared);
  const preparation = assembleNodePreparation({...shared, runner: f.runner, cwd: f.project.directory,
    root: f.project.root, basePath: f.project.basePath, roots: f.data.roots});
  const submit = assembleNodeSubmission({...shared, coordinator: {origin, credential: nodeKey,
    fetch: async (url, options) => {
      observed.authorizations.push(JSON.parse(options.body));
      const response = await fetch(url, options); observed.authorizationReplies++;
      await authorizationReady; return response;
    }}});
  const nodeOrigin = await listen(t, async (req, res) => {
    if ([PROJECT_INSPECTION_ROUTE, PROJECT_RUNTIME_ROUTE].includes(req.url)) return projects(req, res);
    if (req.url === SOURCE_INSPECTION_ROUTE) return sources(req, res);
    if (req.url === GPU_POOL_ROUTE) return pool(req, res);
    if (Object.values(NODE_PREPARATION_ROUTES).includes(req.url)) {
      if (req.url === NODE_PREPARATION_ROUTES.prepare) {
        observed.preparations++;
        if (dropPreparationReply) res.end = () => {req.socket.destroy();};
      }
      return preparation(req, res);
    }
    if (req.url !== NODE_SUBMISSION_ROUTE) return receipts(req, res);
    observed.sends++;
    if (dropReply) res.end = () => {req.socket.destroy();};
    return submit(req, res);
  });
  const nodes = [{machineId: 'node-1', origin: nodeOrigin, credential: coordinatorKey}];
  return {origin, nodeOrigin, observed, releaseAuthorization, sender: assembleTrainingSender({database: f.database, nodes}),
    prepare: assembleTaskPreparation({database: f.database, nodes}),
    worker: () => assembleTrainingDispatchWorker({database: f.database, nodes}),
    coordinator: () => assembleTrainingCoordinator({database: f.database, nodes, python}),
    recovery: new ReconcileTrainingDispatch({dispatches: f.dispatches, nodes: new HttpDispatchReceipts({nodes})})};
}

test('the coordinator automatically admits a queued task through node HTTP and sends it once after logout', {timeout: 20000}, async t => {
  const f = await fixture(t, {prepare: false, select: false}), h = await endpoints(t, f);
  const done = Promise.withResolvers(), observed = [];
  const original = f.database.prepare('SELECT payload_json FROM v2_training_requests WHERE job_id=?').get(f.jobId).payload_json;
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  const service = startTrainingCoordinator({...h.coordinator(), intervalMs: 10,
    onOutcome(result) {
      observed.push(result);
      if (result.kind === 'error') done.reject(result.error);
      if (result.phase === 'dispatch' && result.kind === 'accepted') done.resolve(result);
    }, reportError: done.reject});
  try {
    const result = await done.promise;
    assert.equal(result.jobId, f.jobId);
    assert.ok(observed.some(row => row.phase === 'admission' && row.kind === 'prepared' && row.jobId === f.jobId));
    assert.equal(h.observed.preparations, 1); assert.equal(h.observed.sends, 1);
    assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_dispatches').get().n, 1);
    assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_claims').get().n, 1);
    assert.equal(f.database.prepare('SELECT payload_json FROM v2_training_requests WHERE job_id=?').get(f.jobId).payload_json, original);
    assert.equal((await f.native.allocation({submitKey: result.dispatchId})).grant.max_gpu_count, result.dispatch.gpuCount);
  } finally {await service.stop();}
});

test('stopping immediately after admission leaves the original dispatch for a fresh coordinator to send', {timeout: 20000}, async t => {
  const f = await fixture(t, {prepare: false, select: false}), h = await endpoints(t, f), halted = Promise.withResolvers();
  let original, service;
  service = startTrainingCoordinator({...h.coordinator(), intervalMs: 10,
    onOutcome(result) {
      if (result.phase === 'admission' && result.kind === 'prepared') {
        original = result.dispatch; service.stop().then(halted.resolve, halted.reject);
      }
      if (result.kind === 'error') halted.reject(result.error);
    }, reportError: halted.reject});
  try {await halted.promise;} finally {await service.stop();}
  assert.equal(f.dispatches.delivery(original.dispatchId).state, 'PREPARED');
  assert.equal(h.observed.sends, 0);
  assert.equal(await f.native.allocation({submitKey: original.dispatchId}), null);
  const done = Promise.withResolvers();
  service = startTrainingCoordinator({...h.coordinator(), intervalMs: 10,
    onOutcome(result) {
      if (result.kind === 'error') done.reject(result.error);
      if (result.phase === 'dispatch' && result.kind === 'accepted') done.resolve(result);
    }, reportError: done.reject});
  try {
    const result = await done.promise;
    assert.equal(result.dispatchId, original.dispatchId); assert.equal(result.jobId, f.jobId);
    assert.equal(h.observed.preparations, 1); assert.equal(h.observed.sends, 1);
    assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_claims').get().n, 1);
  } finally {await service.stop();}
});

test('queued task selects through native pool RPC and the periodic worker prepares and sends it after logout', {timeout: 15000}, async t => {
  const f = await fixture(t, {prepare: false, select: false}), h = await endpoints(t, f);
  const pools = new GpuqPoolReader({machineId: 'node-1', socketPath: f.server.socketPath, python});
  const pool = await pools.inspect({machineId: 'node-1'});
  assert.equal(pool.dispatchEnabled, true); assert.equal(pool.freeGpuUuids.length, 4);
  const queue = assembleTrainingQueue({database: f.database, projects: f.project.reader, sources: f.data.managed, python,
    pools});
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_dispatches').get().n, 0);
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  const chosen = await queue.execute();
  assert.equal(chosen.outcomes[0].kind, 'prepared');
  const dispatch = chosen.outcomes[0].dispatch;
  const done = Promise.withResolvers(), worker = h.worker();
  const service = startTrainingDispatchWorker({worker, intervalMs: 10,
    onOutcome(result) {if (result.kind === 'error') done.reject(result.error); else if (result.kind === 'accepted') done.resolve(result);},
    reportError: done.reject});
  try {
    const outcome = await done.promise;
    assert.equal(outcome.dispatch.dispatchId, dispatch.dispatchId);
    assert.equal(outcome.dispatch.jobId, f.jobId);
    assert.equal(f.dispatches.delivery(dispatch.dispatchId).state, 'ACCEPTED');
    assert.equal((await f.native.allocation({submitKey: dispatch.dispatchId})).grant.max_gpu_count, dispatch.gpuCount);
    assert.equal(h.observed.preparations, 1); assert.equal(h.observed.sends, 1);
    assert.deepEqual((await queue.execute()).outcomes, []);
  } finally {await service.stop();}
});

test('fresh worker recovers lost preparation response from the original saved plan before one send', async t => {
  const f = await fixture(t, {prepare: false}), h = await endpoints(t, f, {dropPreparationReply: true});
  let worker = h.worker();
  try {
    const initial = await worker.poll(), outcomes = [...initial.outcomes, ...await worker.idle()];
    assert.equal(outcomes[0].error.code, 'NODE_PREPARATION_UNCONFIRMED');
  } finally {await worker.close();}
  const original = f.bindings.training(f.reference), lease = await f.leaser.lookup(f.request, f.context);
  assert.ok(original); assert.ok(lease);
  worker = h.worker();
  try {
    const next = await worker.poll(), outcomes = [...next.outcomes, ...await worker.idle()];
    assert.equal(outcomes[0].kind, 'accepted');
    assert.equal(f.bindings.training(f.reference).planDigest, original.planDigest);
    assert.equal((await f.leaser.lookup(f.request, f.context)).leaseId, lease.leaseId);
    assert.equal(h.observed.preparations, 1); assert.equal(h.observed.sends, 1);
  } finally {await worker.close();}
});

test('fresh worker queries an uncertain native send even after revocation, without sending or releasing again', async t => {
  const f = await fixture(t, {prepare: false}), h = await endpoints(t, f, {dropReply: true});
  let worker = h.worker();
  try {
    const initial = await worker.poll(), outcomes = [...initial.outcomes, ...await worker.idle()];
    assert.equal(outcomes[0].error.code, 'DISPATCH_SEND_UNCONFIRMED');
    assert.equal(f.dispatches.delivery(f.selected.dispatchId).state, 'UNKNOWN');
  } finally {await worker.close();}
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  worker = h.worker();
  try {
    const next = await worker.poll(), outcomes = [...next.outcomes, ...await worker.idle()];
    assert.equal(outcomes[0].kind, 'accepted');
    assert.equal(f.dispatches.delivery(f.selected.dispatchId).state, 'ACCEPTED');
    assert.equal(h.observed.preparations, 1); assert.equal(h.observed.sends, 1);
    assert.equal(f.database.prepare('SELECT reserved_gpu_count FROM v2_compute_claims').get().reserved_gpu_count, 2);
    assert.equal(f.database.prepare('SELECT state FROM v2_compute_claims').get().state, 'HELD');
  } finally {await worker.close();}
});

test('two real preparations share one dataset without sharing task leases or duplicating native jobs', async t => {
  const f = await fixture(t, {prepare: false}), h = await endpoints(t, f);
  const secondInput = {...structuredClone(f.submission), requestId: randomUUID(), name: '第二个训练'};
  const secondJob = new SqliteTrainingQueue({database: f.database}).enqueue(f.actor, secondInput, f.now).request.jobId;
  const second = f.dispatches.prepareForTask(secondJob, {machineId: 'node-1', gpuCount: 2}, f.now);
  const sample = join(f.data.directory, 'approved', 'sample.txt'), before = await stat(sample), worker = h.worker();
  try {
    const first = await worker.poll(), outcomes = [...first.outcomes, ...await worker.idle()];
    assert.equal(outcomes.length, 2); assert.ok(outcomes.every(row => row.kind === 'accepted'));
    const nativeIds = [f.selected, second].map(value => f.dispatches.delivery(value.dispatchId).nodeJobId);
    assert.equal(new Set(nativeIds).size, 2); assert.ok(nativeIds.every(value => /^J[a-f0-9]{12}$/.test(value)));
    const leases = [await f.leaser.lookup(f.request, f.context), await f.leaser.lookup({...f.request, jobId: secondJob}, f.context)];
    assert.notEqual(leases[0].leaseId, leases[1].leaseId);
    assert.deepEqual(leases.map(value => value.jobId), [f.jobId, secondJob]);
    assert.equal(f.node.prepare('SELECT count(*) n FROM v2_node_runtime_plans').get().n, 2);
    assert.equal(f.database.prepare('SELECT sum(reserved_gpu_count) n FROM v2_compute_claims').get().n, 4);
    await worker.poll(); await worker.idle();
    assert.equal(h.observed.preparations, 2); assert.equal(h.observed.sends, 2);
    const after = await stat(sample);
    assert.deepEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs]);
  } finally {await worker.close();}
});

test('coordinator send journal crosses both HTTP directions and reaches one real native acceptance', async t => {
  const f = await fixture(t), h = await endpoints(t, f);
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  const result = await h.sender.execute(f.jobId);
  assert.equal(result.kind, 'accepted'); assert.equal(result.dispatch.state, 'ACCEPTED');
  assert.equal(result.dispatch.dispatchId, f.selected.dispatchId);
  assert.equal(h.observed.sends, 1); assert.equal(h.observed.authorizations.length, 1);
  const sent = h.observed.authorizations[0];
  assert.deepEqual(Object.keys(sent).sort(), ['binding', 'inputs', 'project']);
  assert.equal(Object.hasOwn(sent.binding, 'nativeDigest'), false);
  assert.equal(Object.hasOwn(sent.project, 'runtime'), false);
  assert.equal(JSON.stringify(sent).includes('argv'), false);
  assert.equal(sent.inputs[0].leaseId, f.lease.leaseId);
  assert.equal((await h.sender.execute(f.jobId)).kind, 'existing');
  assert.equal(h.observed.sends, 1);
  assert.equal((await f.native.allocation({submitKey: f.selected.dispatchId})).grant.max_gpu_count, 2);
});

test('unprepared task traverses HTTP project/lease/plan preparation before the original native send', async t => {
  const f = await fixture(t, {prepare: false}), h = await endpoints(t, f);
  assert.equal(f.bindings.training(f.reference), null);
  assert.equal(await f.leaser.lookup(f.request, f.context), null);
  const before = await stat(join(f.data.directory, 'approved', 'sample.txt'));
  const [first, concurrent] = await Promise.all([h.prepare.execute(f.jobId), h.prepare.execute(f.jobId)]);
  assert.deepEqual(first, concurrent);
  assert.equal(first.binding.dispatchId, f.selected.dispatchId);
  const lease = await f.leaser.lookup(f.request, f.context);
  assert.equal(first.inputs[0].leaseId, lease.leaseId);
  assert.deepEqual(await h.prepare.execute(f.jobId), first);
  const after = await stat(join(f.data.directory, 'approved', 'sample.txt'));
  assert.deepEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs]);
  assert.equal(f.node.prepare('SELECT count(*) n FROM v2_node_runtime_plans').get().n, 1);
  assert.equal((await h.sender.execute(f.jobId)).kind, 'accepted');
  assert.equal(h.observed.sends, 1);
});

test('lost preparation reply recovers the saved plan without another preparation or new lease', async t => {
  const f = await fixture(t, {prepare: false}), h = await endpoints(t, f, {dropPreparationReply: true});
  await assert.rejects(h.prepare.execute(f.jobId), error => error.code === 'NODE_PREPARATION_UNCONFIRMED');
  const original = f.bindings.training(f.reference), lease = await f.leaser.lookup(f.request, f.context);
  assert.ok(original); assert.ok(lease);
  const recovered = await h.prepare.execute(f.jobId);
  assert.equal(recovered.planDigest, original.planDigest);
  assert.equal(recovered.inputs[0].leaseId, lease.leaseId);
  assert.equal(h.observed.preparations, 1);
  assert.equal(f.dispatches.delivery(f.selected.dispatchId).state, 'PREPARED');
  assert.equal(await f.native.allocation({submitKey: f.selected.dispatchId}), null);
});

test('lost HTTP send reply keeps UNKNOWN and recovers the original receipt without another send', async t => {
  const f = await fixture(t), h = await endpoints(t, f, {dropReply: true});
  await assert.rejects(h.sender.execute(f.jobId), error => error.code === 'DISPATCH_SEND_UNCONFIRMED');
  assert.equal(f.dispatches.delivery(f.selected.dispatchId).state, 'UNKNOWN');
  assert.equal((await h.sender.execute(f.jobId)).kind, 'existing');
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  const recovered = await h.recovery.execute(f.selected.dispatchId);
  assert.equal(recovered.kind, 'accepted'); assert.equal(recovered.dispatch.state, 'ACCEPTED');
  assert.equal(h.observed.sends, 1); assert.equal(h.observed.authorizations.length, 1);
  assert.equal(f.database.prepare('SELECT reserved_gpu_count FROM v2_compute_claims').get().reserved_gpu_count, 2);
});

test('node credential determines machine identity and the send route accepts no execution payload', async t => {
  const f = await fixture(t), h = await endpoints(t, f);
  const prepared = f.bindings.training(f.reference);
  const request = launchAuthorizationRequest({binding: prepared.binding, project: prepared.plan.project, inputs: prepared.plan.inputs});
  const post = (origin, route, value, credential) => fetch(origin + route, {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + credential}, body: JSON.stringify(value)});
  f.dispatches.beginSend(f.jobId, f.now);
  assert.equal((await post(h.origin, LAUNCH_AUTHORIZATION_ROUTE, request, coordinatorKey)).status, 401);
  assert.equal((await post(h.origin, LAUNCH_AUTHORIZATION_ROUTE, request, otherNodeKey)).status, 403);
  assert.equal((await post(h.origin, LAUNCH_AUTHORIZATION_ROUTE, {...request, hostPath: '/private'}, nodeKey)).status, 400);
  assert.equal((await post(h.nodeOrigin, NODE_SUBMISSION_ROUTE, f.reference, nodeKey)).status, 401);
  assert.equal((await post(h.nodeOrigin, NODE_SUBMISSION_ROUTE, {...f.reference, argv: ['unapproved']}, coordinatorKey)).status, 400);
  assert.equal((await post(h.nodeOrigin, NODE_SUBMISSION_ROUTE, {...f.reference, machineId: 'node-2'}, coordinatorKey)).status, 409);
  assert.equal(await f.native.allocation({submitKey: f.selected.dispatchId}), null);
});

test('revoked data authorization over HTTP blocks native writes and cannot silently requeue the send', async t => {
  const f = await fixture(t), h = await endpoints(t, f);
  f.database.exec("DELETE FROM v2_data_resources WHERE id='warehouse-images'");
  await assert.rejects(h.sender.execute(f.jobId), error => error.code === 'FORBIDDEN');
  assert.equal(await f.native.allocation({submitKey: f.selected.dispatchId}), null);
  assert.equal(f.dispatches.delivery(f.selected.dispatchId).state, 'UNKNOWN');
  assert.equal((await h.sender.execute(f.jobId)).kind, 'existing');
  assert.equal(h.observed.sends, 1);
});

test('caller disconnect after authorization does not cancel or duplicate the original in-flight send', async t => {
  const f = await fixture(t), h = await endpoints(t, f, {holdAuthorizationReply: true});
  const permit = f.dispatches.beginSend(f.jobId, f.now);
  const request = http.request(h.nodeOrigin + NODE_SUBMISSION_ROUTE, {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + coordinatorKey}});
  request.on('error', () => {});
  request.end(JSON.stringify(f.reference));
  const deadline = Date.now() + 4000;
  while (!h.observed.authorizationReplies && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.observed.authorizationReplies, 1);
  request.destroy();
  f.dispatches.recordSendOutcome({dispatchId: f.selected.dispatchId, senderToken: permit.senderToken, nodeJobId: null});
  // This original operation was authorized before the reply loss. It may still
  // finish; UNKNOWN denies another sender, not the in-flight native operation.
  h.releaseAuthorization();
  let native;
  const finishDeadline = Date.now() + 4000;
  do {
    native = await f.native.allocation({submitKey: f.selected.dispatchId});
    if (!native) await new Promise(resolve => setTimeout(resolve, 10));
  } while (!native && Date.now() < finishDeadline);
  assert.ok(native);
  assert.equal(h.observed.sends, 1);
  assert.equal(f.dispatches.delivery(f.selected.dispatchId).state, 'UNKNOWN');
  assert.equal((await h.recovery.execute(f.selected.dispatchId)).kind, 'accepted');
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
