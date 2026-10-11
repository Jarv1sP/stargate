import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dispatchFixture} from './helpers/v2-dispatch-fixture.mjs';

const hasCode = code => error => error.code === code;

test('only an active sending dispatch obtains read-only quota authorization after logout', async t => {
  const f = await dispatchFixture(t), binding = f.dispatches.delivery(f.prepared.dispatchId);
  assert.throws(() => f.dispatches.authorizeInitialAllocation(binding), hasCode('NODE_LAUNCH_NOT_AUTHORIZED'));
  f.dispatches.beginSend(f.jobId, f.now);
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  const writes = f.database.prepare('SELECT total_changes() n').get().n;
  const result = f.dispatches.authorizeInitialAllocation(binding);
  assert.deepEqual(result, {scope: 'initial-quota', dispatchId: binding.dispatchId, jobId: f.jobId, accountId: 'alice',
    machineId: 'node-1', gpuCount: 2, requestHash: binding.requestHash, grantId: binding.dispatchId});
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, writes);
  assert.equal(Object.hasOwn(result, 'senderToken'), false);
});

test('node binding cannot change task, account, machine, count or original request digest', async t => {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const binding = f.dispatches.delivery(f.prepared.dispatchId);
  for (const change of [{dispatchId: randomUUID()}, {jobId: randomUUID()}, {accountId: 'bob'},
    {machineId: 'node-2'}, {gpuCount: 3}, {requestHash: '0'.repeat(64)}]) {
    assert.throws(() => f.dispatches.authorizeInitialAllocation({...binding, ...change}), hasCode('NODE_LAUNCH_NOT_AUTHORIZED'));
  }
});

test('unconfirmed and accepted attempts cannot obtain another initial sending authorization', async t => {
  const f = await dispatchFixture(t), permit = f.dispatches.beginSend(f.jobId, f.now);
  const binding = f.dispatches.delivery(f.prepared.dispatchId);
  f.dispatches.recordSendOutcome({dispatchId: binding.dispatchId, senderToken: permit.senderToken, nodeJobId: null});
  assert.throws(() => f.dispatches.authorizeInitialAllocation(binding), hasCode('NODE_LAUNCH_NOT_AUTHORIZED'));
  f.dispatches.recordSendOutcome({dispatchId: binding.dispatchId, senderToken: permit.senderToken, nodeJobId: 'J0123456789ab'});
  assert.throws(() => f.dispatches.authorizeInitialAllocation(binding), hasCode('NODE_LAUNCH_NOT_AUTHORIZED'));
});

test('released or reduced holds cannot be repaired during authorization', async t => {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const binding = f.dispatches.delivery(f.prepared.dispatchId);
  f.database.exec("UPDATE v2_compute_claims SET state='RELEASED'");
  assert.throws(() => f.dispatches.authorizeInitialAllocation(binding), hasCode('COMPUTE_CLAIM_CHANGED'));
  f.database.exec("UPDATE v2_compute_claims SET state='HELD',reserved_gpu_count=1");
  assert.throws(() => f.dispatches.authorizeInitialAllocation(binding), hasCode('COMPUTE_CLAIM_CHANGED'));
  assert.equal(f.database.prepare('SELECT reserved_gpu_count FROM v2_compute_claims').get().reserved_gpu_count, 1);
});

test('current limits, accounting readiness, machine access and account status remain authoritative', async t => {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const binding = f.dispatches.delivery(f.prepared.dispatchId);
  f.database.exec('UPDATE v2_compute_policies SET total_cards=1');
  assert.throws(() => f.dispatches.authorizeInitialAllocation(binding), hasCode('COMPUTE_QUOTA_EXCEEDED'));
  f.database.exec('UPDATE v2_compute_policies SET total_cards=4; UPDATE v2_compute_accounting SET ready=0');
  assert.throws(() => f.dispatches.authorizeInitialAllocation(binding), hasCode('COMPUTE_ACCOUNTING_UNREADY'));
  f.ready(); f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  assert.throws(() => f.dispatches.authorizeInitialAllocation(binding), hasCode('FORBIDDEN'));
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  assert.throws(() => f.dispatches.authorizeInitialAllocation(binding), hasCode('TASK_NOT_AUTHORIZED'));
});
