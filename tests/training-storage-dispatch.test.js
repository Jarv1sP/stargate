import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {trainingPlan,trainingSource} from './training-storage-fixture.mjs';
import {SUBMISSION_SAFE_WINDOW_MS} from '../execution.mjs';

const password='Training-Capacity-Dispatch-Fixture-2026!';
const ref={dataset:'training-data',version:'a'.repeat(64)},machine=MACHINES[0].id;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'training-storage-dispatch-'));
  const database=join(dir,'state.sqlite'),bootstrap=join(dir,'bootstrap.json'),status=join(dir,'status.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,health:'ok',observeOnly:false,jobs:[]}}))}));
  const calls=[],works=[];let service,watchGate,syncResult,availableBytes=2**40;
  const bridge=async(target,operation,args)=>{
    calls.push({machine:target,operation,args:structuredClone(args)});
    if(operation==='datasets.status')return {...ref,state:'READY'};
    if(operation==='datasets.training.status')return trainingSource(target,args);
    if(operation==='storage.training.plan'){
      return trainingPlan(target,args,{availableBytes});
    }
    if(operation==='watch'){
      if(watchGate)await watchGate.promise;
      return {state:'PENDING',schedulerState:'NOT_SUBMITTED',nodeJobId:null,latestAttempt:null,
        dispatchObservation:{protocol:'job-dispatch-observation-v1',jobId:args.job.id,userId:args.job.userId,
          submitKey:args.job.id,state:'NOT_SUBMITTED',requestFinished:true,observedAt:Date.now()/1000}};
    }
    if(operation==='sync'){
      const current=service.store.jobs.find(j=>j.id===args.job.id);
      assert.equal(current.dispatchPending,false);
      assert.equal(Object.hasOwn(args.job,'trainingStoragePlan'),false,'private capacity snapshot is not a native job field');
      return syncResult||{state:'PENDING',assignedIndices:[]};
    }
    if(operation==='cancel')return {state:'CANCELED',assignedIndices:[]};
    throw Error('Unexpected fixture RPC: '+operation);
  };
  service=await PortalService.open(database,bootstrap,status,bridge);
  clearInterval(service.executionTimer);service.reconciling=true;
  const admin=await service.login('admin',password);
  const submit=async()=>(await service.invoke(admin.token,'jobs.submit',{machine,cards:1,argv:['true'],key:randomUUID(),datasets:[ref]})).result;
  const start=()=>{service.reconciling=false;const work=service.reconcile();works.push(work);return work;};
  t.after(async()=>{watchGate?.resolve();await Promise.allSettled(works);await service.tail;service.close();await rm(dir,{recursive:true,force:true});});
  return {service,admin,calls,submit,start,job:id=>service.store.jobs.find(j=>j.id===id),
    capacity:value=>availableBytes=value,nodeReply:value=>syncResult=value,holdWatch:()=>watchGate=deferred()};
}

test('manual training rejects insufficient selected storage without a reservation or retargeting',async t=>{
  const f=await fixture(t);f.capacity(0);
  await assert.rejects(f.submit(),e=>e.status===409&&e.code==='SUBMISSION_REJECTED');
  assert.equal(f.service.store.jobs.length,0);
  assert.ok(f.calls.every(c=>c.machine===machine));
  assert.equal(f.calls.some(c=>['sync','datasets.prepare'].includes(c.operation)),false);
});

test('first dispatch avoids duplicate capacity reads and preserves a definitive node storage refusal',async t=>{
  const f=await fixture(t),reply=await f.submit(),job=f.job(reply.id);
  assert.equal(Object.hasOwn(reply,'trainingStoragePlan'),false);
  assert.equal(job.trainingStoragePlan.fits,true);
  f.capacity(0);f.nodeReply({state:'FAILED',notSubmitted:true,failureCode:'STORAGE_FULL',error:'目标磁盘容量不足',assignedIndices:[]});
  await f.start();
  assert.equal(job.dispatchPending,false);assert.equal(job.state,'FAILED');
  assert.equal(job.notSubmitted,true);assert.equal(job.failureCode,'STORAGE_FULL');assert.match(job.error,/容量不足/);
  assert.equal(f.calls.filter(c=>c.operation==='sync').length,1);
  assert.equal(f.calls.filter(c=>c.operation==='storage.training.plan').length,1);
});

test('cancellation before first dispatch prevents sync without another capacity read',async t=>{
  const f=await fixture(t),reply=await f.submit();
  const canceled=await f.service.invoke(f.admin.token,'jobs.cancel',{jobId:reply.id});
  assert.equal(canceled.result.cancelRequested,true);
  await f.start();
  assert.equal(f.job(reply.id).state,'CANCELED');assert.equal(f.job(reply.id).dispatchPending,true);
  assert.equal(f.calls.some(c=>c.operation==='sync'),false);
  assert.equal(f.calls.filter(c=>c.operation==='cancel').length,1);
  assert.equal(f.calls.filter(c=>c.operation==='storage.training.plan').length,1);
});

test('a changed immutable job spec fences an absence reply before native redispatch',async t=>{
  const f=await fixture(t),reply=await f.submit(),job=f.job(reply.id);
  job.dispatchPending=false;job.dispatchFinishedAt=new Date(Date.now()-SUBMISSION_SAFE_WINDOW_MS-1000).toISOString();
  const gate=f.holdWatch(),work=f.start();await tick();
  await f.service.enqueue(()=>{f.job(reply.id).spec.argv=['changed'];f.service.save();});
  gate.resolve();await work;
  assert.equal(f.job(reply.id).dispatchPending,false);assert.equal(f.job(reply.id).state,'SUBMITTING');
  assert.deepEqual(f.calls.filter(c=>c.operation==='watch').map(c=>c.args.job.argv),[['true']]);
  assert.equal(f.job(reply.id).submissionReconciliation,undefined);
  assert.equal(f.calls.some(c=>c.operation==='sync'),false);
});

test('legacy unmarked jobs keep their original first-dispatch protocol',async t=>{
  const f=await fixture(t),reply=await f.submit(),job=f.job(reply.id);
  delete job.trainingStoragePlan;f.service.save();f.calls.length=0;
  await f.start();
  assert.deepEqual(f.calls.map(c=>c.operation),['sync']);
  assert.equal(job.state,'PENDING');assert.equal(job.dispatchPending,false);
});
