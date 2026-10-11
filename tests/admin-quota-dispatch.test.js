import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';

const password='Admin-Quota-Dispatch-Fixture-2026!';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-admin-quota-dispatch-')),database=join(dir,'db'),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),calls=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(machine=>({id:machine.id,reachable:true,
    gpus:Array.from({length:machine.cards},(_,index)=>({index,memoryTotalMiB:32768})),
    gpuq:{connected:true,health:'ok',observeOnly:false,jobs:[],capabilities:['priority-policy-v1','preempt-idle-only-v1','priority-rank-v1','checkpoint-control-v1','console-placement-v1','console-sharing-v1']}}))}));
  let service,owner,alice;
  const bridge=async(machine,operation,args)=>{
    assert.equal(service.store.jobs.find(job=>job.id===args.job.id).dispatchPending,false,'durable attempt marker precedes remote I/O');
    calls.push({machine,operation,args:structuredClone(args)});
    if(service.lostReply)throw Error('reply lost');
    return {nodeJobId:'J0123456789ab',state:'PENDING',assignedIndices:[],queueReason:'waiting for available GPU'};
  };
  const open=async bootstrapPath=>{
    service=await PortalService.open(database,bootstrapPath,status,bridge);clearInterval(service.executionTimer);service.reconciling=true;
    owner=await service.login('admin',password);alice=await service.login('alice',password).catch(()=>null);
  };
  await open(bootstrap);
  const user=(await service.invoke(owner.token,'users.create',{username:'alice',password})).result;
  const machine=MACHINES[0];
  await service.invoke(owner.token,'policy.save',{userId:user.id,total:1,limits:{[machine.id]:1},policyVersion:0});
  await service.invoke(owner.token,'users.role',{userId:user.id,role:'admin'});alice=await service.login('alice',password);
  const submit=async(more={})=>(await service.invoke(alice.token,'jobs.submit',{machine:machine.id,cards:1,argv:['true'],key:randomUUID(),...more})).result;
  const step=async()=>{service.reconciling=false;try{await service.reconcile();}finally{service.reconciling=true;}};
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  return {get service(){return service},get owner(){return owner},user,machine,calls,submit,step,job:id=>service.store.jobs.find(job=>job.id===id),
    demote:()=>service.invoke(owner.token,'users.role',{userId:user.id,role:'member'}),
    reopen:async()=>{service.close();await open();}};
}

test('first dispatch uses current member quota after demotion, then releases the next reservation only after confirmation',async t=>{
  const f=await fixture(t),a=await f.submit(),b=await f.submit();
  assert.equal(f.job(a.id).dispatchPending,true);assert.equal(Object.hasOwn(a,'dispatchPending'),false);
  await f.demote();await f.step();
  assert.equal(f.calls.length,0);assert.match(f.job(a.id).error,/等待个人可用卡数额度/);
  assert.equal(f.job(a.id).state,'SUBMITTING');assert.equal(f.job(b.id).dispatchPending,true);
  await f.service.invoke(f.owner.token,'jobs.cancel',{jobId:b.id});
  // A cancellation does not prove a possibly running native consumer ended.
  assert.equal(usage(f.service.store.jobs,f.user.id),2);
  f.job(b.id).state='CANCELED';f.service.save();
  await f.step();assert.equal(f.job(a.id).state,'PENDING');assert.equal(f.calls.filter(call=>call.operation==='sync').length,1);
  assert.equal(f.calls.find(call=>call.operation==='sync').args.job.id,a.id);
});

test('first dispatch rejects stale administrator-only priority without changing the immutable request',async t=>{
  const f=await fixture(t),a=await f.submit({priority:'high'}),before=structuredClone(f.job(a.id).spec);
  await f.demote();await f.step();
  assert.equal(f.calls.length,0);assert.match(f.job(a.id).error,/管理员角色已改变/);
  assert.equal(f.job(a.id).dispatchPending,true);assert.deepEqual(f.job(a.id).spec,before);
});

for(const change of ['disabled','grant'])test(`first dispatch rechecks ${change} before any node attempt`,async t=>{
  const f=await fixture(t),a=await f.submit();await f.demote();
  if(change==='disabled')await f.service.invoke(f.owner.token,'users.enabled',{userId:f.user.id,enabled:false});
  else{
    // Ordinary policy editing refuses to undercut reserved work. Inject only
    // this isolated DB fixture to exercise a persisted external revocation.
    f.service.store.users.find(user=>user.id===f.user.id).limits={};f.service.save();
  }
  await f.step();assert.equal(f.calls.length,0);assert.equal(f.job(a.id).dispatchPending,true);
  assert.match(f.job(a.id).error,/账号或机器授权已改变/);
});

test('attempt persistence failure sends nothing; reopen keeps the original pending identity',async t=>{
  const f=await fixture(t),a=await f.submit(),spec=structuredClone(f.job(a.id).spec);
  f.service.db.exec(`CREATE TRIGGER reject_dispatch BEFORE UPDATE ON portal_state WHEN instr(NEW.data,'"dispatchPending":false')>0 BEGIN SELECT RAISE(ABORT,'dispatch persistence failure'); END`);
  await f.step();assert.equal(f.calls.length,0);assert.equal(f.job(a.id).dispatchPending,true);
  f.service.db.exec('DROP TRIGGER reject_dispatch');await f.reopen();assert.equal(f.job(a.id).dispatchPending,true);
  await f.step();assert.equal(f.job(a.id).state,'PENDING');assert.deepEqual(f.job(a.id).spec,spec);
  assert.equal(f.calls.length,1);assert.equal(Object.hasOwn(f.calls[0].args.job,'dispatchPending'),false);
});

test('a slow first node reply does not hold the account mutation queue or replay the attempt',async t=>{
  const f=await fixture(t),a=await f.submit(),bridge=f.service.bridge;
  let entered,release;
  const started=new Promise(resolve=>entered=resolve),response=new Promise(resolve=>release=resolve);
  f.service.bridge=async(...args)=>{entered();await response;return bridge(...args);};
  const work=f.step();await started;
  assert.equal(f.job(a.id).dispatchPending,false);
  await f.demote();assert.equal(f.service.store.get(f.user.id).role,'member');
  assert.equal(f.calls.length,0);
  release();await work;assert.equal(f.calls.length,1);assert.equal(f.job(a.id).state,'PENDING');
  assert.equal(f.job(a.id).cancelRequested,false);
});

test('lost first reply and later demotion only observe the original UUID after reopen',async t=>{
  const f=await fixture(t),a=await f.submit({priority:'high'}),spec=structuredClone(f.job(a.id).spec);
  f.service.lostReply=true;await f.step();assert.equal(f.calls.length,1);assert.equal(f.job(a.id).dispatchPending,false);
  assert.equal(f.job(a.id).state,'SUBMITTING');assert.equal(f.job(a.id).error,'正在确认节点状态（自动重查中）');
  await f.demote();await f.reopen();f.job(a.id).submissionReconciliation.nextCheckAt=new Date(0).toISOString();await f.step();
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].operation,'watch');assert.deepEqual(f.calls[1].args.job,spec);
  assert.equal(f.job(a.id).state,'PENDING');assert.equal(usage(f.service.store.jobs,f.user.id),1);
});

test('legacy unmarked work is observed conservatively rather than retroactively treated as never dispatched',async t=>{
  const f=await fixture(t),a=await f.submit({priority:'high'});delete f.job(a.id).dispatchPending;f.service.save();
  await f.demote();
  // Legacy records intentionally have no marker; this simulated bridge checks
  // identity, not the new-record admission marker.
  f.service.bridge=async(machine,operation,args)=>{f.calls.push({machine,operation,args:structuredClone(args)});return {state:'RUNNING',nodeJobId:'J0123456789ab',assignedIndices:[0]};};
  await f.step();assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'watch');assert.equal(f.job(a.id).state,'RUNNING');
});
