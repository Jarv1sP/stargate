import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {GpuqManagedClient} from '../src/infrastructure/gpuq-managed-client.mjs';
import {GpuqLaunchSpec} from '../src/infrastructure/gpuq-launch-spec.mjs';

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'v2-managed-')), socketPath = join(folder, 'rpc.sock');
  const submitKey = randomUUID(), grantId = randomUUID(), calls = [];
  const state = {drop: false, code: null, result: undefined};
  const server = net.createServer(socket => {
    let body = ''; socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', chunk => {
      body += chunk; if (!body.endsWith('\n')) return;
      const request = JSON.parse(body); calls.push(request);
      if (state.drop) {socket.destroy(); return;}
      const grant = {grant_id: grantId, revision: request.op === 'set_allocation_grant' ? 2 : 1, max_gpu_count: request.args.max_gpu_count ?? 2};
      const result = state.result !== undefined ? state.result : request.op === 'submit_managed'
        ? {job_id: 'J0123456789ab', allocation: {mode: 'external-v1', grant}}
        : {job_id: 'J0123456789ab', submit_key: submitKey, mode: 'external-v1', grant};
      socket.end(JSON.stringify(state.code ? {request_id: request.request_id, ok: false, error: {code: state.code, message: 'secret-error-message'}}
        : {request_id: request.request_id, ok: true, result}) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => {await new Promise(resolve => server.close(resolve)); await rm(folder, {recursive: true, force: true});});
  const options = {socketPath, python: process.env.V2_PYTHON || 'python3'};
  return {submitKey, grantId, calls, state, options, client: new GpuqManagedClient(options)};
}

test('managed allocation calls use fixed native operations and keep exact grant identity', async t => {
  const f = await fixture(t);
  const submission = {submit_key: f.submitKey, gpu_count: 4, argv: ['fixture-only'], env: {PRIVATE: 'fixture'}};
  assert.equal((await f.client.submit({submission, grantId: f.grantId, maxGpus: 2})).grant.max_gpu_count, 2);
  assert.equal((await f.client.allocation({submitKey: f.submitKey})).grant.revision, 1);
  assert.equal((await f.client.updateAllocation({submitKey: f.submitKey, grantId: f.grantId, expectedRevision: 1, maxGpus: 4})).grant.revision, 2);
  assert.deepEqual(f.calls.map(row => row.op), ['submit_managed', 'allocation_status', 'set_allocation_grant']);
  assert.deepEqual(f.calls[0].args, {submission, grant_id: f.grantId, max_gpu_count: 2});
});

test('lost or internal-error mutation replies are unconfirmed and never retried or downgraded', async t => {
  const f = await fixture(t); f.state.drop = true;
  const command = {submission: {submit_key: f.submitKey}, grantId: f.grantId, maxGpus: 1};
  await assert.rejects(f.client.submit(command), error => error.code === 'NATIVE_OUTCOME_UNCONFIRMED');
  assert.equal(f.calls.length, 1);
  f.state.drop = false; f.state.code = 'INTERNAL';
  await assert.rejects(f.client.submit(command), error => error.code === 'NATIVE_OUTCOME_UNCONFIRMED');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(row => row.op === 'submit_managed'));
});

test('explicit native rejection remains distinct, without returning private error text', async t => {
  const f = await fixture(t); f.state.code = 'NOT_FOUND';
  await assert.rejects(f.client.submit({submission: {submit_key: f.submitKey}, grantId: f.grantId, maxGpus: 1}), error => {
    assert.equal(error.code, 'NATIVE_OPERATION_REJECTED'); assert.equal(error.nativeCode, 'NOT_FOUND');
    assert.equal(error.cause.stdout.includes('secret-error-message'), false); return true;
  });
  assert.equal(f.calls.length, 1);
});

test('read distinguishes absent submission, unmanaged task and managed task missing a grant', async t => {
  const f = await fixture(t); f.state.result = null;
  assert.equal(await f.client.allocation({submitKey: f.submitKey}), null);
  for (const mode of ['native', 'external-v1']) {
    f.state.result = {job_id: 'J0123456789ab', submit_key: f.submitKey, mode, grant: null};
    assert.deepEqual(await f.client.allocation({submitKey: f.submitKey}), f.state.result);
  }
});

test('bad identities and oversized managed wire requests make no native request', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.updateAllocation({submitKey: f.submitKey, grantId: f.grantId, expectedRevision: 0, maxGpus: 2}), error => error.code === 'INVALID_MANAGED_REQUEST');
  await assert.rejects(new GpuqManagedClient({...f.options, maxRequestBytes: 64}).submit({submission: {submit_key: f.submitKey}, grantId: f.grantId, maxGpus: 1}), error => error.code === 'INVALID_MANAGED_REQUEST');
  assert.equal(f.calls.length, 0);
});

test('prepared native digest is checked by the original hash implementation before any RPC mutation', async t => {
  const f = await fixture(t);
  const built = await new GpuqLaunchSpec({python: f.options.python}).build({submit_key: f.submitKey,
    name: 'fixed-wrapper', owner: 'alice', priority: 2, dispatch_mode: 'queue', checkpoint_capability: 'none', restart_policy: 'never',
    gpu_count: 1, placement: 'any', requested_gpu_uuids: [], argv: [process.execPath, '--version'], cwd: tmpdir(), env: {}}, {gpuUuids: ['GPU-a']});
  const command = {submission: built.submission, grantId: f.grantId, maxGpus: 1, expectedDigest: built.nativeDigest};
  await assert.rejects(f.client.submit({...command, submission: {...built.submission, argv: [...built.submission.argv, 'changed']}}), error => error.code === 'INVALID_MANAGED_REQUEST');
  await assert.rejects(f.client.submit({...command, expectedDigest: '0'.repeat(64)}), error => error.code === 'INVALID_MANAGED_REQUEST');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.client.submit(command)).grant.max_gpu_count, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, {submission: built.submission, grant_id: f.grantId, max_gpu_count: 1});
});

test('mismatched grant replies cannot confirm mutation results', async t => {
  const f = await fixture(t);
  f.state.result = {job_id: 'J0123456789ab', submit_key: f.submitKey, mode: 'external-v1',
    grant: {grant_id: randomUUID(), revision: 2, max_gpu_count: 4}};
  await assert.rejects(f.client.updateAllocation({submitKey: f.submitKey, grantId: f.grantId, expectedRevision: 1, maxGpus: 4}), error => error.code === 'NATIVE_OUTCOME_UNCONFIRMED');
  f.state.result.grant.grant_id = f.grantId; f.state.result.grant.max_gpu_count = 3;
  await assert.rejects(f.client.updateAllocation({submitKey: f.submitKey, grantId: f.grantId, expectedRevision: 1, maxGpus: 4}), error => error.code === 'NATIVE_OUTCOME_UNCONFIRMED');
});

function completed(f) {
  return {protocol: 'managed-completion-v1', job_id: 'J0123456789ab', submit_key: f.submitKey,
    submit_digest: 'a'.repeat(64), grant_id: f.grantId, grant_revision: 2, state: 'SUCCEEDED', native_version: 4,
    finished_at: 20, sealed_at: 21, latest_attempt: {id: 'A' + 'b'.repeat(32), ordinal: 1,
      state: 'EXITED_SUCCESS', exit_code: 0}};
}

test('completion and receipt lookup cross the real Python bridge with only original references', async t => {
  const f = await fixture(t), receipt = completed(f); f.state.result = receipt;
  assert.deepEqual(await f.client.complete({submitKey: f.submitKey, grantId: f.grantId, expectedDigest: receipt.submit_digest}), receipt);
  assert.deepEqual(await f.client.completion({submitKey: f.submitKey}), receipt);
  assert.deepEqual(f.calls.map(row => row.op), ['complete_managed', 'managed_completion']);
  assert.deepEqual(f.calls[0].args, {submit_key: f.submitKey, grant_id: f.grantId, submit_digest: receipt.submit_digest});
  assert.deepEqual(f.calls[1].args, {submit_key: f.submitKey});
});

test('lost completion reply is recovered by query, while absent receipt stays unknown', async t => {
  const f = await fixture(t); f.state.drop = true;
  await assert.rejects(f.client.complete({submitKey: f.submitKey, grantId: f.grantId, expectedDigest: 'a'.repeat(64)}),
    error => error.code === 'NATIVE_OUTCOME_UNCONFIRMED');
  assert.equal(f.calls.length, 1);
  f.state.drop = false; f.state.result = null;
  assert.equal(await f.client.completion({submitKey: f.submitKey}), null);
  f.state.result = completed(f);
  assert.deepEqual(await f.client.completion({submitKey: f.submitKey}), f.state.result);
  assert.deepEqual(f.calls.map(row => row.op), ['complete_managed', 'managed_completion', 'managed_completion']);
});

test('foreign or malformed completion evidence cannot authorize subsequent cleanup', async t => {
  const f = await fixture(t), receipt = completed(f);
  for (const result of [null, {...receipt, grant_id: randomUUID()}, {...receipt, submit_key: randomUUID()},
    {...receipt, submit_digest: 'c'.repeat(64)}, {...receipt, state: 'LOST'}, {...receipt, grant_revision: 0},
    {...receipt, latest_attempt: null}, {...receipt, latest_attempt: {...receipt.latest_attempt, exit_code: 1}},
    {...receipt, latest_attempt: {...receipt.latest_attempt, ordinal: 0}}, {...receipt, argv: ['unexpected']},
  ]) {
    f.state.result = result;
    await assert.rejects(f.client.complete({submitKey: f.submitKey, grantId: f.grantId, expectedDigest: receipt.submit_digest}),
      error => error.code === 'NATIVE_OUTCOME_UNCONFIRMED');
  }
  f.state.result = {...receipt, protocol: 'unrecognized'};
  await assert.rejects(f.client.completion({submitKey: f.submitKey}), error => error.code === 'NATIVE_COMPLETION_UNAVAILABLE');
  f.state.result = {...receipt, state: 'CANCELED', latest_attempt: null, finished_at: null};
  assert.deepEqual(await f.client.completion({submitKey: f.submitKey}), f.state.result);
});

test('invalid completion identity fails before RPC and private native errors stay private', async t => {
  const f = await fixture(t);
  for (const command of [{submitKey: 'bad', grantId: f.grantId, expectedDigest: 'a'.repeat(64)},
    {submitKey: f.submitKey, grantId: 'bad', expectedDigest: 'a'.repeat(64)},
    {submitKey: f.submitKey, grantId: f.grantId, expectedDigest: 'bad'}]) {
    await assert.rejects(f.client.complete(command), error => error.code === 'INVALID_MANAGED_REQUEST');
  }
  assert.equal(f.calls.length, 0);
  f.state.code = 'COMPLETION_UNCONFIRMED';
  await assert.rejects(f.client.complete({submitKey: f.submitKey, grantId: f.grantId, expectedDigest: 'a'.repeat(64)}), error => {
    assert.equal(error.code, 'NATIVE_OUTCOME_UNCONFIRMED');
    assert.equal(error.cause.stdout.includes('secret-error-message'), false); return true;
  });
  assert.equal(f.calls.length, 1);
});
