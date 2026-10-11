import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createNodeFinalizationHandler} from '../src/api/node-finalization-handler.mjs';
import {HttpNodeCompletions} from '../src/infrastructure/http-node-completions.mjs';
import {NODE_COMPLETION_ROUTES, nodeCompletionResult} from '../src/contracts/node-completion.mjs';

const credential = 'a'.repeat(64);
async function fixture(t) {
  const binding = {dispatchId: randomUUID(), jobId: randomUUID(), machineId: 'node-1', accountId: 'alice',
    gpuCount: 2, requestHash: 'b'.repeat(64), nativeDigest: 'private-native-digest', nativeOwner: 'private-owner'};
  const local = {binding, planDigest: 'private-plan-digest', dataReleased: true, native: {job_id: 'J123abc',
    state: 'SUCCEEDED', native_version: 5, finished_at: 10, sealed_at: 11}};
  const calls = [], reference = {machineId: 'node-1', dispatchId: binding.dispatchId};
  let stored = null;
  const server = http.createServer(createNodeFinalizationHandler({machineId: 'node-1', credential, reportError() {},
    completions: {get(input) {assert.deepEqual(input, reference); calls.push('lookup'); return stored;}},
    finalize: {async execute(input) {assert.deepEqual(input, reference); calls.push('finalize'); stored = local; return stored;}}}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const origin = `http://127.0.0.1:${server.address().port}`, nodes = [{machineId: 'node-1', origin, credential}];
  return {reference, local, calls, nodes, origin, client: new HttpNodeCompletions({nodes})};
}

test('private node completion lookup is read-only and carries only the original identity and terminal proof', async t => {
  const f = await fixture(t);
  assert.equal(await f.client.lookup(f.reference), null);
  const completed = await f.client.finalize(f.reference);
  assert.deepEqual(completed, nodeCompletionResult(f.local));
  assert.deepEqual(await f.client.lookup(f.reference), completed);
  assert.deepEqual(f.calls, ['lookup', 'finalize', 'lookup']);
  assert.equal(JSON.stringify(completed).includes('private-'), false);
});

test('missing credentials, wrong node and injected source/status fields produce no cleanup', async t => {
  const f = await fixture(t);
  for (const [token, input, status] of [
    ['', f.reference, 401], ['f'.repeat(64), f.reference, 401],
    [credential, {...f.reference, machineId: 'node-2'}, 409],
    [credential, {...f.reference, dataReleased: true}, 400],
    [credential, {...f.reference, accountId: 'bob', source: '/private'}, 400],
  ]) {
    const reply = await fetch(f.origin + NODE_COMPLETION_ROUTES.finalize, {method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify(input)});
    assert.equal(reply.status, status); await reply.body.cancel();
  }
  assert.deepEqual(f.calls, []);
});

test('unconfirmed, malformed and foreign finalization replies make one request and never fall back', async t => {
  const f = await fixture(t), good = nodeCompletionResult(f.local);
  for (const value of [null, {...good, dataReleased: false}, {...good, state: 'RUNNING'},
    {...good, receipt: {...good.receipt, machineId: 'node-2'}}, {...good, receipt: {...good.receipt, dispatchId: randomUUID()}}]) {
    let calls = 0;
    const client = new HttpNodeCompletions({nodes: f.nodes, fetch: async () => {calls++; return new Response(JSON.stringify({result: value}));}});
    await assert.rejects(client.finalize(f.reference), error => error.code === 'NODE_COMPLETION_UNCONFIRMED');
    assert.equal(calls, 1);
  }
  assert.deepEqual(f.calls, []);
});
