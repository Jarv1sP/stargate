import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './maintenance-fixture.mjs';
import {MACHINES} from '../dist/model.js';

const machine=MACHINES[0].id;
function queued(f,{cancelRequested=false}={}){
  const id=randomUUID(),spec={id,userId:f.owner.id,username:f.owner.username,name:'中文任务',machine,argv:['true']};
  const job={id,userId:f.owner.id,username:f.owner.username,submitterName:'归档用户',name:'中文任务',description:'显示不改变执行身份',machine,cards:1,state:'SUBMITTING',dispatchPending:true,spec,cancelRequested};
  f.service.store.jobs.push(job);
  f.service.gpuq.stale=false;
  const host=f.service.gpuq.hosts.find(h=>h.id===machine);
  host.reachable=true;host.gpuq.connected=true;host.gpuq.capabilities=['console-task-display-v1'];
  return job;
}
test('reconcile sends native labels beside the unchanged spec through the installed bridge',async t=>{
  const f=await fixture(t),job=queued(f),before=structuredClone(job.spec);
  await f.service.reconcile();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'sync');
  assert.deepEqual(f.calls[0].args.job,before);assert.deepEqual(job.spec,before);
  assert.deepEqual(f.calls[0].args.metadata,{name:job.name,description:job.description,submitter:{name:job.submitterName,username:job.username}});
});
test('final maintenance bridge gate rejects reconciliation after a stale early maintenance observation',async t=>{
  const f=await fixture(t),job=queued(f),before=structuredClone(job.spec);
  await f.call('set',{scope:'all',enabled:true,revision:0,reason:'fixture last-moment maintenance'},f.admin.token);
  // Simulate maintenance turning on after reconcile's early snapshot. The
  // installed bridge must reread durable state, not invoke its old closure.
  f.service.maintenanceFor=()=>null;
  await f.service.reconcile();
  assert.deepEqual(f.calls,[]);assert.equal(job.state,'SUBMITTING');assert.deepEqual(job.spec,before);
  assert.ok(job.error);assert.equal(f.service.db.prepare('SELECT data FROM operational_maintenance WHERE id=1').get().data.includes('fixture last-moment maintenance'),true);
});
test('maintenance cancellation still crosses the trusted bridge with immutable execution identity',async t=>{
  const f=await fixture(t),job=queued(f,{cancelRequested:true}),before=structuredClone(job.spec);
  await f.call('set',{scope:'all',enabled:true,revision:0,reason:'fixture cancel remains available'},f.admin.token);
  await f.service.reconcile();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'cancel');assert.deepEqual(f.calls[0].args.job,before);assert.deepEqual(job.spec,before);
});
