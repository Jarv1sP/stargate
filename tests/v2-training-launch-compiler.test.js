import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, writeFile, readFile, readdir, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {TrainingLaunchCompiler} from '../src/infrastructure/training-launch-compiler.mjs';
import {GpuqLaunchSpec} from '../src/infrastructure/gpuq-launch-spec.mjs';
import {GpuqPolicy} from '../src/infrastructure/gpuq-policy.mjs';
import {ValidateTrainingResources} from '../src/application/validate-training-resources.mjs';
import {PrepareNodeTraining} from '../src/application/prepare-node-training.mjs';
import {createNodeDispatchBindingsSchema, createNodeRuntimePlansSchema, SqliteNodeDispatchBindings} from '../src/infrastructure/sqlite/node-dispatch-bindings.mjs';
import {canonicalTrainingPayload, normalizeTrainingRequest} from '../src/domain/training-request.mjs';
import {parseTrainingSubmission} from '../src/contracts/training-submission.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {projectFixture} from './helpers/v2-project-fixture.mjs';
import {publishedFixture} from './helpers/v2-published-fixture.mjs';
import {ProjectRunPreparer} from '../src/infrastructure/project-run-preparer.mjs';
import {ManagedDataLeaser} from '../src/infrastructure/managed-data-leaser.mjs';
import {jsonProcess} from '../src/infrastructure/json-process.mjs';

const run = promisify(execFile), python = process.env.V2_PYTHON || 'python3';
const hash = value => createHash('sha256').update(value).digest('hex');
const pool = {gpuUuids: ['GPU-a', 'GPU-b', 'GPU-c', 'GPU-d']};
const helper = fileURLToPath(new URL('./helpers/v2-runtime-plan-reader.py', import.meta.url));
function updateHash(input) {
  input.identity.requestHash = hash(canonicalTrainingPayload(normalizeTrainingRequest(parseTrainingSubmission(input.submission))));
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'v2-training-plan-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const database = join(directory, 'node.sqlite'), db = new DatabaseSync(database);
  t.after(() => db.close()); createNodeDispatchBindingsSchema(db);
  const executable = (await run(python, ['-c', 'import sys; print(sys.executable)'])).stdout.trim();
  const wrapper = join(directory, 'fixture-wrapper.py');
  await writeFile(wrapper, 'raise AssertionError("fixture runner must never execute")\n');
  const runner = [executable, '-I', '-B', wrapper];
  const compiler = new TrainingLaunchCompiler({runner, cwd: directory,
    resources: new ValidateTrainingResources({policy: new GpuqPolicy({python})}), launchSpec: new GpuqLaunchSpec({python})});
  const bindings = new SqliteNodeDispatchBindings({database: db, machineId: 'node-1'});
  const app = new PrepareNodeTraining({compiler, bindings});
  const submission = trainingSubmission();
  submission.name = '  多卡训练 🧪  '; submission.description = '原目录直读\r\n不复制';
  submission.execution = {argv: ['python', 'train.py', '$(not-a-shell)', '中文'], workingDirectory: 'src',
    env: {Z: 'private-token', PATH: '/user/path', A: 'first'}};
  submission.resources.batch = {globalBatchSize: 64, microBatchSize: 4};
  submission.dataSources = [{kind: 'directory', sourceId: 'original'},
    {kind: 'warehouse', datasetId: 'images', version: 'd'.repeat(64)}];
  const identity = {dispatchId: randomUUID(), jobId: randomUUID(), accountId: 'alice', machineId: 'node-1', gpuCount: 2, requestHash: ''};
  const project = {id: submission.project.id, run: {accountId: 'alice', jobId: identity.jobId, machineId: 'node-1', project: 'training',
    projectUUID: randomUUID(), generation: 'b'.repeat(64), release: submission.project.release, lifecycle: 'ACTIVE',
    environmentMode: 'shared', runtimeIdentityVerified: true, runtime: {kind: 'base', identity: 'c'.repeat(64)}, runPrepared: true}};
  const leases = [{machineId: 'node-1', jobId: identity.jobId, accountId: 'alice', source: submission.dataSources[1], leaseId: randomUUID(), readOnly: true}];
  const input = {identity, submission, project, leases}; updateHash(input);
  const read = async (receipt, changes = {}) => JSON.parse((await run(python, ['-B', helper,
    changes.database ?? database, changes.machineId ?? identity.machineId, changes.dispatchId ?? identity.dispatchId,
    changes.planDigest ?? receipt.planDigest, ...(changes.runner ?? runner)])).stdout);
  return {directory, database, db, runner, compiler, bindings, app, input, read};
}

test('private plan preserves exact task/project/data intent; native command contains only the fixed wrapper and plan reference', async t => {
  const f = await fixture(t), compiled = await f.compiler.compile(f.input, pool), plan = JSON.parse(compiled.planJson);
  assert.equal(compiled.planDigest, hash(compiled.planJson));
  assert.equal(plan.submission.name, '多卡训练 🧪');
  assert.equal(plan.submission.description, '原目录直读\n不复制');
  assert.deepEqual(plan.submission.execution, f.input.submission.execution);
  assert.deepEqual(plan.inputs, [{source: f.input.submission.dataSources[0]},
    {source: f.input.submission.dataSources[1], leaseId: f.input.leases[0].leaseId}]);
  assert.equal(plan.project.projectUUID, f.input.project.run.projectUUID);
  assert.deepEqual(plan.project.runtime, f.input.project.run.runtime);
  assert.deepEqual(compiled.built.submission.argv, [...f.runner, '--dispatch-id', f.input.identity.dispatchId, '--plan-digest', compiled.planDigest]);
  assert.deepEqual(compiled.built.submission.env, {});
  assert.equal(compiled.built.submission.cwd, f.directory);
  assert.equal(compiled.binding.gpuCount, 2); assert.equal(compiled.binding.nativeMaxGpus, 4);
  assert.equal(compiled.binding.nativeName, 'v2-' + f.input.identity.jobId);
  assert.notEqual(compiled.binding.nativeDigest, compiled.planDigest); assert.notEqual(compiled.binding.nativeDigest, f.input.identity.requestHash);
  assert.equal(JSON.stringify(compiled.built).includes('private-token'), false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_node_dispatch_bindings').get().n, 0);
});

test('exact plan and native digest survive Node to Python recovery; equivalent env order is idempotent and receipt stays private', async t => {
  const f = await fixture(t), receipt = await f.app.execute(f.input, pool);
  const baseline = (await f.read(receipt)).result;
  assert.deepEqual(baseline.binding, receipt.binding);
  assert.equal(baseline.plan.submission.execution.env.Z, 'private-token');
  assert.equal(baseline.plan.identity.jobId, f.input.identity.jobId);
  f.input.submission.execution.env = {A: 'first', PATH: '/user/path', Z: 'private-token'};
  f.input.leases.reverse();
  assert.deepEqual(await f.app.execute(f.input, pool), receipt);
  assert.deepEqual((await f.read(receipt)).result, baseline);
  assert.equal(JSON.stringify(receipt).includes('private-token'), false);
  assert.equal(JSON.stringify(f.bindings.get(f.input.identity)).includes('private-token'), false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_node_runtime_plans').get().n, 1);
  const changes = f.db.prepare('SELECT total_changes() n').get().n;
  await f.read(receipt);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('the fixed runner reads an actual compiler plan but refuses execution outside a GPUQ attempt', async t => {
  const f = await fixture(t), project = await projectFixture(t);
  const entrypoint = fileURLToPath(new URL('../scripts/v2-training-runner.py', import.meta.url));
  const configPath = join(f.directory, 'runner.json');
  const runner = [f.runner[0], '-I', '-B', entrypoint, '--config', configPath];
  await writeFile(configPath, JSON.stringify({schema: 1, machineId: 'node-1', database: f.database,
    gpuqSocket: join(f.directory, 'not-contacted.sock'), root: project.root, basePath: project.basePath,
    controlRoot: join(f.directory, 'not-created-control'), gpuqArchive: join(f.directory, 'not-opened.pyz')}));
  const compiler = new TrainingLaunchCompiler({runner, cwd: f.directory,
    resources: f.compiler.resources, launchSpec: f.compiler.launchSpec});
  const receipt = await new PrepareNodeTraining({compiler, bindings: f.bindings}).execute(f.input, pool);
  assert.deepEqual((await f.read(receipt, {runner})).result.binding, receipt.binding);
  const before = f.db.prepare('SELECT * FROM v2_node_runtime_plans').all();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GPUQ_')));
  await assert.rejects(run(runner[0], [...runner.slice(1), '--dispatch-id', receipt.binding.dispatchId, '--plan-digest', receipt.planDigest], {env}), error => {
    assert.equal(error.code, 125);
    assert.match(error.stderr, /NATIVE_EXECUTION_UNCONFIRMED/);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr.includes('private-token'), false);
    return true;
  });
  assert.deepEqual(f.db.prepare('SELECT * FROM v2_node_runtime_plans').all(), before);
  await assert.rejects(stat(join(f.directory, 'not-created-control')), {code: 'ENOENT'});
  assert.equal((await readdir(f.directory)).some(name => name === 'not-contacted.sock' || name === 'not-opened.pyz'), false);
});

test('mismatched task, selected node, registered project or lease never records or launches anything', async t => {
  const f = await fixture(t);
  const edits = [v => {v.submission.execution.argv.push('--changed');}, v => {v.identity.requestHash = 'f'.repeat(64);},
    v => {v.project.id = 'other-project';}, v => {v.project.run.accountId = 'bob';}, v => {v.project.run.jobId = randomUUID();},
    v => {v.project.run.machineId = 'node-2';}, v => {v.project.run.release = 'e'.repeat(64);},
    v => {v.submission.machines = {kind: 'selected', ids: ['node-2']}; updateHash(v);},
    v => {v.leases = [];}, v => {v.leases[0].accountId = 'bob';}, v => {v.leases[0].jobId = randomUUID();},
    v => {v.leases[0].machineId = 'node-2';}, v => {v.leases[0].source = {...v.leases[0].source, kind: 'cache'};},
    v => {v.leases[0].source = {...v.leases[0].source, version: 'f'.repeat(64)};}];
  for (const edit of edits) {
    const input = structuredClone(f.input); edit(input);
    await assert.rejects(f.app.execute(input, pool), error => ['NODE_RUNTIME_PLAN_IDENTITY_MISMATCH', 'NODE_RUNTIME_PLAN_LEASE_MISMATCH'].includes(error.code));
  }
  for (const table of ['v2_node_dispatch_bindings', 'v2_node_launch_specs', 'v2_node_runtime_plans']) {
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
});

test('raw-only plans need no fake data lease; duplicate mount paths and illegal elastic counts are rejected', async t => {
  const f = await fixture(t), input = structuredClone(f.input);
  input.submission.dataSources = [input.submission.dataSources[0]]; input.leases = []; updateHash(input);
  const compiled = await f.compiler.compile(input, pool);
  assert.deepEqual(JSON.parse(compiled.planJson).inputs, [{source: input.submission.dataSources[0]}]);
  await assert.rejects(f.compiler.compile({...input, identity: {...input.identity, gpuCount: 3}}, pool), e => e.code === 'NODE_INITIAL_GPU_COUNT_INVALID');
  input.submission.dataSources.push(input.submission.dataSources[0]); updateHash(input);
  await assert.rejects(f.compiler.compile(input, pool), e => e.code === 'TRAINING_DATA_PATH_CONFLICT');
  const wrongLease = structuredClone(f.input); wrongLease.leases.push(wrongLease.leases[0]);
  await assert.rejects(f.compiler.compile(wrongLease, pool), e => e.code === 'NODE_RUNTIME_PLAN_LEASE_MISMATCH');
});

test('compiler preserves checkpoint expansion, pinned placement and optional HAMi native policy instead of freezing initial allocation', async t => {
  const f = await fixture(t), elastic = structuredClone(f.input);
  elastic.submission.resources.autoScaleUp = true;
  elastic.submission.scheduling = {priority: 4, mode: 'preempt-save', yieldPolicy: 'save', checkpoint: 'epoch-v1', restart: 'on-preempt'};
  updateHash(elastic);
  const scaled = await f.compiler.compile(elastic, pool);
  assert.deepEqual(scaled.built.allowedGpuCounts, [1, 2, 4]);
  assert.equal(scaled.built.submission.min_gpu_count, 1);
  assert.equal(scaled.built.submission.gpu_count, 4); assert.equal(scaled.binding.gpuCount, 2);
  assert.equal(scaled.built.submission.auto_scale_up, true);
  assert.equal(scaled.built.submission.dispatch_mode, 'preempt-save');
  assert.equal(scaled.built.submission.yield_policy, 'save');
  assert.equal(scaled.built.submission.preempt_opt_in_only, true);
  const shared = structuredClone(f.input);
  shared.identity.gpuCount = 1;
  shared.submission.resources = {minGpus: 1, maxGpus: 1, elastic: false, autoScaleUp: false, placement: 'pinned', gpuUuids: ['GPU-c'],
    batch: null, sharing: {vramMiB: 2048, hami: {smPercent: 40}}};
  updateHash(shared);
  const packed = await f.compiler.compile(shared, pool);
  assert.equal(packed.built.submission.share_gpu, true); assert.equal(packed.built.submission.hami_core, true);
  assert.equal(packed.built.submission.vram_mb, 2048); assert.equal(packed.built.submission.sm_percent, 40);
  assert.deepEqual(packed.built.submission.requested_gpu_uuids, ['GPU-c']);
  assert.deepEqual(packed.built.submission.env, {});
  shared.submission.resources.gpuUuids = ['GPU-not-in-pool']; updateHash(shared);
  await assert.rejects(f.compiler.compile(shared, pool), e => e.code === 'INVALID_SCHEDULING_REQUEST');
});

test('runtime-plan write failure rolls back mapping and native spec; restart retry installs one immutable trio', async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER fail_plan BEFORE INSERT ON v2_node_runtime_plans BEGIN SELECT RAISE(ABORT,'fixture plan failure'); END");
  await assert.rejects(f.app.execute(f.input, pool), /fixture plan failure/);
  for (const table of ['v2_node_dispatch_bindings', 'v2_node_launch_specs', 'v2_node_runtime_plans']) {
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
  f.db.exec('DROP TRIGGER fail_plan');
  const receipt = await f.app.execute(f.input, pool);
  const reopened = new DatabaseSync(f.database);
  try {
    const second = new PrepareNodeTraining({compiler: f.compiler, bindings: new SqliteNodeDispatchBindings({database: reopened, machineId: 'node-1'})});
    assert.deepEqual(await second.execute(f.input, pool), receipt);
  } finally {reopened.close();}
  assert.equal((await f.read(receipt)).result.binding.dispatchId, receipt.binding.dispatchId);
});

test('reusing a dispatch cannot change project generation, runtime, lease or container command', async t => {
  const f = await fixture(t), receipt = await f.app.execute(f.input, pool), before = await f.read(receipt);
  for (const edit of [v => {v.project.run.projectUUID = randomUUID();}, v => {v.project.run.generation = 'f'.repeat(64);},
    v => {v.project.run.runtime.identity = 'f'.repeat(64);}, v => {v.leases[0].leaseId = randomUUID();},
    v => {v.submission.execution.argv.push('--new'); updateHash(v); }]) {
    const input = structuredClone(f.input); edit(input);
    await assert.rejects(f.app.execute(input, pool), e => e.code === 'NODE_DISPATCH_BINDING_CONFLICT');
    assert.deepEqual(await f.read(receipt), before);
  }
});

test('Python loader refuses missing, wrong-node, changed-wrapper and wrong-digest plans without initialization', async t => {
  const f = await fixture(t), receipt = await f.app.execute(f.input, pool);
  for (const changes of [{machineId: 'node-2'}, {dispatchId: randomUUID()}, {planDigest: 'f'.repeat(64)},
    {runner: [...f.runner, '--other-wrapper']}, {database: join(f.directory, 'missing.sqlite')}]) {
    assert.deepEqual(await f.read(receipt, changes), {error: 'NODE_RUNTIME_PLAN_UNAVAILABLE'});
  }
  assert.equal((await readdir(f.directory)).includes('missing.sqlite'), false);
  f.db.exec('DROP TABLE v2_node_runtime_plans');
  assert.deepEqual(await f.read(receipt), {error: 'NODE_RUNTIME_PLAN_UNAVAILABLE'});
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='v2_node_runtime_plans'").get(), undefined);
});

test('Python verifies persisted JSON bytes and the real native digest, not only a caller-supplied plan hash', async t => {
  const f = await fixture(t), receipt = await f.app.execute(f.input, pool);
  const row = f.db.prepare('SELECT * FROM v2_node_runtime_plans').get();
  f.db.prepare('UPDATE v2_node_runtime_plans SET plan_json=?').run(row.plan_json.replace('private-token', 'changed-value'));
  assert.deepEqual(await f.read(receipt), {error: 'NODE_RUNTIME_PLAN_UNAVAILABLE'});
  f.db.prepare('UPDATE v2_node_runtime_plans SET plan_json=?').run(row.plan_json);
  const launch = f.bindings.launch(f.input.identity);
  launch.submission.env.INJECTED = 'not part of native identity';
  f.db.prepare('UPDATE v2_node_launch_specs SET submission_json=?').run(JSON.stringify(launch.submission));
  assert.deepEqual(await f.read(receipt), {error: 'NODE_RUNTIME_PLAN_UNAVAILABLE'});
});

test('storage refuses a compiled plan whose binding or wrapper no longer matches before writing', async t => {
  const f = await fixture(t), compiled = await f.compiler.compile(f.input, pool);
  for (const change of [v => {v.planDigest = 'e'.repeat(64);}, v => {v.binding.accountId = 'bob';},
    v => {v.built.submission.argv.pop();}]) {
    const copy = structuredClone(compiled); change(copy);
    assert.throws(() => f.bindings.prepareTraining(copy), e => e.code === 'NODE_RUNTIME_PLAN_IDENTITY_MISMATCH');
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_node_dispatch_bindings').get().n, 0);
});

test('existing experimental stores require an explicit plan schema upgrade, with no constructor or read migration', async t => {
  const f = await fixture(t);
  f.db.exec('DROP TABLE v2_node_runtime_plans');
  const repository = new SqliteNodeDispatchBindings({database: f.db, machineId: 'node-1'});
  assert.equal(repository.get(f.input.identity), null);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='v2_node_runtime_plans'").get(), undefined);
  await assert.rejects(f.app.execute(f.input, pool), /no such table/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_node_dispatch_bindings').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_node_launch_specs').get().n, 0);
  createNodeRuntimePlansSchema(f.db);
  const receipt = await f.app.execute(f.input, pool);
  assert.equal((await f.read(receipt)).result.plan.identity.jobId, f.input.identity.jobId);
});

test('real prepared project and original warehouse lease compile, reopen and feed the runtime without copying or executing code', async t => {
  const f = await fixture(t), project = await projectFixture(t), data = await publishedFixture(t);
  const context = {actor: {id: 'alice'}}, observed = await project.reader.inspect(project.request, context);
  const jobId = f.input.identity.jobId;
  const prepared = await new ProjectRunPreparer({machineId: 'node-1', root: project.root, basePath: project.basePath, python})
    .prepare({...project.request, jobId, projectUUID: observed.projectUUID, generation: observed.generation}, context);
  const leaser = new ManagedDataLeaser({machineId: 'node-1', roots: data.roots, python});
  const request = {...data.request('warehouse'), jobId}, lease = await leaser.acquire(request, context);
  f.input.project.run = prepared;
  f.input.submission.project.release = prepared.release;
  f.input.submission.dataSources = [{kind: 'directory', sourceId: 'original'}, request.source];
  f.input.leases = [lease]; updateHash(f.input);
  const claimPath = join(project.root, 'projects-v2', '.run-claims', jobId + '.json');
  const claimBefore = await readFile(claimPath, 'utf8'), before = await stat(claimPath);
  const receipt = await f.app.execute(f.input, pool);
  const {result} = await jsonProcess({program: python,
    args: ['-B', fileURLToPath(new URL('./helpers/v2-runtime-plan-inputs.py', import.meta.url))],
    input: {database: f.database, runner: f.runner, dispatchId: f.input.identity.dispatchId, planDigest: receipt.planDigest,
      root: project.root, basePath: project.basePath, directories: {original: join(data.directory, 'approved')}, roots: data.roots}});
  assert.equal(result.release, prepared.release);
  assert.deepEqual(result.command, f.input.submission.execution);
  assert.deepEqual(result.reads.map(({target, sample}) => ({target, sample})),
    [{target: '/datasets/original', sample: 'original sample'}, {target: '/data2/images', sample: 'original sample'}]);
  assert.equal(result.reads[0].inode, (await stat(join(data.directory, 'approved'))).ino);
  assert.deepEqual(await leaser.lookup(request, context), lease);
  assert.equal(await readFile(claimPath, 'utf8'), claimBefore);
  assert.equal((await stat(claimPath)).mtimeMs, before.mtimeMs);
});
