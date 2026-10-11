import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {createLaunchAuthorizationHandler} from '../src/api/launch-authorization-handler.mjs';
import {createMachineAuthenticator} from '../src/api/node-authenticator.mjs';
import {HttpLaunchAuthorization} from '../src/infrastructure/http-launch-authorization.mjs';
import {HttpNodeSubmissions} from '../src/infrastructure/http-node-submissions.mjs';
import {parseLaunchAuthorization, parseLaunchApproval, launchAuthorizationRequest, LAUNCH_AUTHORIZATION_ROUTE} from '../src/contracts/launch-authorization.mjs';
import {parseNodeSubmissionResult} from '../src/contracts/node-submission.mjs';
import {SendTrainingDispatch} from '../src/application/send-training-dispatch.mjs';
import {dispatchFixture} from './helpers/v2-dispatch-fixture.mjs';

const credential = 'c'.repeat(64), hasCode = code => error => error.code === code;
function command() {
  return {binding: {dispatchId: randomUUID(), jobId: randomUUID(), accountId: 'alice', machineId: 'node-1', gpuCount: 2, requestHash: 'a'.repeat(64)},
    project: {id: 'logical', project: 'training', release: 'b'.repeat(64), projectUUID: randomUUID(), generation: 'c'.repeat(64)}, inputs: []};
}
const approval = binding => ({...binding, scope: 'launch-ready', grantId: binding.dispatchId});
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('launch wire contains only fixed identities and original source/lease references', () => {
  const input = command();
  input.inputs = [{source: {kind: 'directory', sourceId: 'raw'}},
    {source: {kind: 'cache', datasetId: 'images', version: 'd'.repeat(64)}, leaseId: randomUUID()}];
  assert.deepEqual(parseLaunchAuthorization(input), input);
  assert.deepEqual(launchAuthorizationRequest({...input, binding: {...input.binding, nativeDigest: 'private'},
    project: {...input.project, runtime: {kind: 'base', identity: 'private'}}}), input);
  for (const value of [{...input, argv: ['bad']}, {...input, inputs: [{source: input.inputs[1].source}]},
    {...input, project: {...input.project, hostPath: '/private'}}, {...input, binding: {...input.binding, senderToken: 'private'}}]) {
    assert.throws(() => parseLaunchAuthorization(value), hasCode('INVALID_REQUEST'));
  }
  assert.deepEqual(parseLaunchApproval(approval(input.binding)), approval(input.binding));
  for (const value of [{...approval(input.binding), scope: 'initial-quota'}, {...approval(input.binding), grantId: randomUUID()},
    {...approval(input.binding), env: {}}]) assert.throws(() => parseLaunchApproval(value), hasCode('INVALID_API_RESPONSE'));
  assert.throws(() => parseNodeSubmissionResult({kind: 'accepted', receipt: null}), hasCode('INVALID_API_RESPONSE'));
});

test('peer configurations cannot share credentials or ambiguously identify machines', async () => {
  const peers = [{machineId: 'node-1', credential}];
  assert.throws(() => createMachineAuthenticator([...peers, {machineId: 'node-2', credential}]), /Ambiguous/);
  assert.throws(() => createMachineAuthenticator([...peers, {machineId: 'node-1', credential: 'd'.repeat(64)}]), /Ambiguous/);
  const authenticate = createMachineAuthenticator(peers);
  assert.deepEqual(await authenticate({headers: {authorization: 'Bearer ' + credential}}), {machineId: 'node-1'});
  await assert.rejects(authenticate({headers: {authorization: 'Bearer ' + 'd'.repeat(64)}}), hasCode('UNAUTHENTICATED'));
});

test('authorization accepts the full 100-source contract beyond the old 8 KiB transport limit', async t => {
  const input = command();
  input.inputs = Array.from({length: 100}, (_, index) => ({source: {kind: 'warehouse', datasetId: 'data-' + index, version: 'd'.repeat(64)}, leaseId: randomUUID()}));
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 8192);
  let calls = 0;
  const origin = await listen(t, createLaunchAuthorizationHandler({peers: [{machineId: 'node-1', credential}],
    authorization: {acquire(value) {calls++; assert.deepEqual(value, input); return approval(value.binding);}}, reportError() {}}));
  const client = new HttpLaunchAuthorization({machineId: 'node-1', origin, credential});
  assert.deepEqual(await client.acquire(input), approval(input.binding));
  const response = await fetch(origin + LAUNCH_AUTHORIZATION_ROUTE, {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + credential}, body: JSON.stringify({...input, padding: 'x'.repeat(65536)})});
  assert.equal(response.status, 400); assert.equal((await response.json()).error.field, 'body');
  assert.equal(calls, 1);
});

test('HTTP adapters reject wrong identities and never retry an uncertain write', async () => {
  const input = command(); let calls = 0;
  const auth = new HttpLaunchAuthorization({machineId: 'node-1', origin: 'https://coordinator.example', credential,
    fetch: async () => {calls++; return Response.json({result: approval({...input.binding, jobId: randomUUID()})});}});
  await assert.rejects(auth.acquire(input), hasCode('NODE_LAUNCH_AUTHORIZATION_UNAVAILABLE'));
  await assert.rejects(auth.acquire({...input, binding: {...input.binding, machineId: 'node-2'}}), hasCode('NODE_LAUNCH_NOT_AUTHORIZED'));
  assert.equal(calls, 1);
  const nodes = new HttpNodeSubmissions({nodes: [{machineId: 'node-1', origin: 'https://node.example', credential}],
    fetch: async () => {calls++; throw Object.assign(new Error('lost transport'), {code: 'ECONNRESET'});}});
  await assert.rejects(nodes.send({machineId: 'node-1', dispatchId: input.binding.dispatchId}), hasCode('DISPATCH_SEND_UNCONFIRMED'));
  assert.equal(calls, 2);
});

test('overlapping coordinator sends acquire one permit and late foreign evidence cannot update a different dispatch', async t => {
  const f = await dispatchFixture(t); let sends = 0;
  const sender = new SendTrainingDispatch({dispatches: f.dispatches, nodes: {async send(reference) {
    sends++; return {kind: 'unconfirmed', ...reference};
  }}});
  const results = await Promise.all([sender.execute(f.jobId), sender.execute(f.jobId)]);
  assert.equal(sends, 1);
  assert.deepEqual(results.map(row => row.kind).sort(), ['existing', 'unconfirmed']);
  assert.equal(f.dispatches.delivery(f.prepared.dispatchId).state, 'UNKNOWN');
  const other = await dispatchFixture(t);
  const wrong = new SendTrainingDispatch({dispatches: other.dispatches, nodes: {async send() {
    return {kind: 'accepted', receipt: {dispatchId: f.prepared.dispatchId, machineId: 'node-1'}};
  }}});
  await assert.rejects(wrong.execute(other.jobId), hasCode('DISPATCH_OBSERVATION_MISMATCH'));
  assert.equal(other.dispatches.delivery(other.prepared.dispatchId).state, 'UNKNOWN');
});

test('a wrong account or request hash in a matching dispatch receipt cannot leave a false acceptance', async t => {
  const f = await dispatchFixture(t);
  const binding = f.dispatches.delivery(f.prepared.dispatchId);
  const sender = new SendTrainingDispatch({dispatches: f.dispatches, nodes: {async send() {
    return {kind: 'accepted', receipt: {...binding, accountId: 'bob', nodeJobId: 'J0123456789ab'}};
  }}});
  await assert.rejects(sender.execute(f.jobId), hasCode('DISPATCH_OBSERVATION_MISMATCH'));
  const state = f.dispatches.delivery(f.prepared.dispatchId);
  assert.equal(state.state, 'UNKNOWN'); assert.equal(state.nodeJobId, null);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
});
