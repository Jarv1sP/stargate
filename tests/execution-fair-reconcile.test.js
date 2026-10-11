import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';

const password='Fair-Reconcile-Fixture-Only-2026!';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){
  const deadline=Date.now()+1000;
  while(!predicate()&&Date.now()<deadline)await tick();
  assert.ok(predicate(),'fixture phase must complete before its bounded deadline');
}
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-fair-reconcile-')),database=join(dir,'db'),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,health:'ok',observeOnly:false,jobs:[]}}))}));
  const calls=[],blocks=new Map(),active=new Set(),counts=new Map(),peaks=new Map(),works=[];
  let service,custom;
  const bridge=async(machine,operation,args)=>{
    const id=args.job?.id;
    assert.ok(!active.has(id),'one reconciliation operation per fixed job');active.add(id);
    counts.set(machine,(counts.get(machine)||0)+1);peaks.set(machine,Math.max(peaks.get(machine)||0,counts.get(machine)));
    assert.ok(counts.get(machine)<=2,'at most two reconciliation operations per configured machine');
    if(operation==='sync'&&service.store.jobs.find(j=>j.id===id)?.dispatchPending===false){
      const persisted=JSON.parse(service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data);
      assert.equal(persisted.jobs.find(j=>j.id===id).dispatchPending,false,'attempt is durable before remote I/O');
    }
    calls.push({machine,operation,args:structuredClone(args)});
    try{
      if(custom)return await custom(machine,operation,args);
      if(blocks.has(id))await blocks.get(id).promise;
      return {nodeJobId:'J'+id,state:operation==='cancel'?'CANCELED':'PENDING',assignedIndices:[]};
    }finally{active.delete(id);counts.set(machine,counts.get(machine)-1);}
  };
  service=await PortalService.open(database,bootstrap,status,bridge);clearInterval(service.executionTimer);service.reconciling=true;
  const admin=await service.login('admin',password);
  const submit=async(machine=MACHINES[0].id)=>(await service.invoke(admin.token,'jobs.submit',{machine,cards:1,argv:['true'],key:randomUUID()})).result;
  const job=id=>service.store.jobs.find(j=>j.id===id);
  const old=async(machine=MACHINES[0].id)=>{const result=await submit(machine);Object.assign(job(result.id),{state:'PENDING',dispatchPending:false});service.save();return result;};
  const block=id=>{const response=deferred();blocks.set(id,response);return response;};
  const start=()=>{service.reconciling=false;const work=service.reconcile();works.push(work);return work;};
  t.after(async()=>{
    custom=undefined;for(const response of blocks.values())response.resolve();
    await Promise.allSettled(works);await service.tail;service.close();await rm(dir,{recursive:true,force:true});
  });
  return {service,admin,calls,counts,peaks,active,submit,old,job,block,start,setBridge:fn=>custom=fn};
}

for(const sameMachine of [false,true])test(`a late first dispatch bypasses a blocked ${sameMachine?'same':'other'} machine observation`,{timeout:3000},async t=>{
  const f=await fixture(t),old=await f.old(sameMachine?MACHINES[0].id:MACHINES[1].id),held=f.block(old.id),work=f.start();
  await tick();assert.equal(f.calls.length,1);
  const fresh=await f.submit();await tick();await tick();
  assert.equal(f.calls.filter(c=>c.args.job.id===fresh.id&&c.operation==='sync').length,1,'first sync occurs before the held old reply');
  assert.equal(f.job(fresh.id).state,'PENDING');assert.equal(f.job(fresh.id).dispatchPending,false);
  assert.ok(f.service.reconciling);assert.ok(f.active.has(old.id));
  assert.equal(usage(f.service.store.jobs,'builtin-admin'),2);held.resolve();await work;
});

test('urgent and observation lanes are bounded and both advance without duplicate job operations',{timeout:3000},async t=>{
  const f=await fixture(t),oldA=await f.old(),oldB=await f.old(),fresh=[];
  for(let n=0;n<4;n++)fresh.push(await f.submit());
  const gates=new Map([oldA,oldB,...fresh].map(job=>[job.id,f.block(job.id)]));
  const work=f.start();await tick();
  assert.equal(f.calls.length,2);assert.ok(f.active.has(oldA.id));assert.ok(f.active.has(fresh[0].id));
  for(let n=0;n<20;n++)f.service.reconcile().catch(()=>{});
  await tick();assert.equal(f.calls.length,2,'coalesced kicks never repeat active work');
  gates.get(fresh[0].id).resolve();await tick();await tick();
  assert.ok(f.active.has(fresh[1].id));assert.ok(f.active.has(oldA.id));
  gates.get(oldA.id).resolve();await tick();await tick();
  assert.ok(f.active.has(oldB.id),'old observations progress even with foreground backlog');
  assert.ok(f.active.has(fresh[1].id));assert.equal(f.peaks.get(MACHINES[0].id),2);
  for(const response of gates.values())response.resolve();await work;
  assert.equal(f.calls.length,6);assert.equal(new Set(f.calls.map(c=>c.args.job.id)).size,6);
  assert.ok([...f.counts.values()].every(count=>count===0));
});

test('a cancel arriving during sync waits for that job only and retains quota until its own confirmed reply',{timeout:3000},async t=>{
  const f=await fixture(t),old=await f.old(MACHINES[1].id),oldGate=f.block(old.id),fresh=await f.submit(),syncGate=f.block(fresh.id),cancelGate=f.block('cancel-fixture');
  f.setBridge(async(_machine,operation,args)=>{
    if(args.job.id===old.id){await oldGate.promise;return {state:'PENDING'};}
    if(operation==='sync'){await syncGate.promise;return {state:'RUNNING',assignedIndices:[0]};}
    await cancelGate.promise;return {state:'UNKNOWN',assignedIndices:[]};
  });
  const work=f.start();await tick();
  await f.service.invoke(f.admin.token,'jobs.cancel',{jobId:fresh.id});await tick();
  assert.equal(f.calls.filter(c=>c.operation==='cancel').length,0,'no concurrent cancel/sync for one job');
  assert.equal(usage(f.service.store.jobs,'builtin-admin'),2);syncGate.resolve();await tick();await tick();
  const cancel=f.calls.find(c=>c.operation==='cancel');assert.equal(cancel.args.job.id,fresh.id);
  assert.equal(f.job(old.id).cancelRequested,false);assert.ok(f.active.has(old.id),'another slow host remains independent');
  cancelGate.resolve();await tick();assert.equal(f.job(fresh.id).state,'UNKNOWN');assert.equal(usage(f.service.store.jobs,'builtin-admin'),2);
  oldGate.resolve();await work;
  f.setBridge(async(_machine,operation,args)=>({state:operation==='cancel'?'CANCELED':'PENDING',nodeJobId:'J'+args.job.id}));
  await f.service.reconcile();assert.equal(f.job(fresh.id).state,'CANCELED');assert.equal(usage(f.service.store.jobs,'builtin-admin'),1);
});

test('a pending foreground job rechecks current authority after its lane becomes available',{timeout:3000},async t=>{
  const f=await fixture(t),first=await f.submit(),second=await f.submit(),held=f.block(first.id),work=f.start();await tick();
  assert.equal(f.calls.length,1);assert.equal(f.job(second.id).dispatchPending,true);
  await f.service.enqueue(()=>{f.service.store.users.find(u=>u.id==='builtin-admin').enabled=false;f.service.save();});
  held.resolve();await work;
  assert.equal(f.calls.length,1);assert.equal(f.job(second.id).dispatchPending,true);assert.match(f.job(second.id).error,/授权已改变/);
  assert.equal(usage(f.service.store.jobs,'builtin-admin'),2);
});

test('lost first reply is not re-observed or replayed in the active pass',{timeout:3000},async t=>{
  const f=await fixture(t),old=await f.old(MACHINES[1].id),held=f.block(old.id),fresh=await f.submit();
  f.setBridge(async(_machine,_operation,args)=>{if(args.job.id===old.id){await held.promise;return {state:'PENDING'};}throw Error('first reply lost');});
  const work=f.start();await tick();await tick();
  for(let n=0;n<10;n++)f.service.reconcile().catch(()=>{});await tick();
  assert.equal(f.calls.filter(c=>c.args.job.id===fresh.id).length,1);assert.equal(f.job(fresh.id).dispatchPending,false);
  assert.equal(f.job(fresh.id).state,'SUBMITTING');assert.equal(f.job(fresh.id).error,'正在确认节点状态（自动重查中）');
  assert.equal(usage(f.service.store.jobs,'builtin-admin'),2);held.resolve();await work;
});

test('data preparation keeps its separate promotion turn before the durable first dispatch',{timeout:3000},async t=>{
  const f=await fixture(t),fresh=await f.submit(),job=f.job(fresh.id);
  Object.assign(job,{state:'PREPARING_DATA',datasets:[],dataPreparation:{datasets:[]}});f.service.save();
  await f.start();assert.equal(f.calls.length,0);assert.equal(job.state,'SUBMITTING');assert.equal(job.dispatchPending,true);
  assert.equal(usage(f.service.store.jobs,'builtin-admin'),1);
  await f.service.reconcile();assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'sync');
  assert.equal(job.state,'PENDING');assert.equal(job.dispatchPending,false);assert.equal(usage(f.service.store.jobs,'builtin-admin'),1);
});

test('a later kick admits a promoted preparation without waiting for another host',{timeout:3000},async t=>{
  const f=await fixture(t),old=await f.old(MACHINES[1].id),held=f.block(old.id),fresh=await f.submit(),job=f.job(fresh.id);
  Object.assign(job,{state:'PREPARING_DATA',datasets:[],dataPreparation:{datasets:[]}});f.service.save();
  await tick();const work=f.start();await until(()=>job.state==='SUBMITTING');await tick();
  assert.equal(job.state,'SUBMITTING');assert.equal(job.dispatchPending,true);
  assert.equal(f.calls.filter(call=>call.args.job.id===fresh.id).length,0);
  f.service.reconcile().catch(()=>{});await tick();await tick();
  assert.equal(job.state,'PENDING');assert.equal(job.dispatchPending,false);assert.ok(f.active.has(old.id));
  assert.equal(f.calls.filter(call=>call.args.job.id===fresh.id).length,1);held.resolve();await work;
});

test('policy revision changes fence late results and closing never dispatches queued work',{timeout:3000},async t=>{
  const f=await fixture(t),first=await f.submit(),second=await f.submit(),held=f.block(first.id),work=f.start();await tick();
  await f.service.enqueue(()=>{f.job(first.id).policyRevision=1;f.service.save();});
  f.service.closing=true;held.resolve();await work;
  assert.equal(f.calls.length,1);assert.equal(f.job(first.id).state,'SUBMITTING');assert.equal(f.job(first.id).dispatchPending,false);
  assert.equal(f.job(second.id).dispatchPending,true);assert.equal(usage(f.service.store.jobs,'builtin-admin'),2);
});

test('maintenance blocks new dispatch and old polls but not cancellation or confirmed terminal hold cleanup',{timeout:3000},async t=>{
  const f=await fixture(t),old=await f.old(),fresh=await f.submit(),terminal=await f.old();
  await f.service.invoke(f.admin.token,'jobs.cancel',{jobId:old.id});
  Object.assign(f.job(terminal.id),{state:'FAILED',dataPreparationHold:{state:'HELD',spec:structuredClone(f.job(terminal.id).spec)}});f.service.save();
  f.service.maintenanceFor=()=>true;
  f.setBridge(async(_machine,operation,args)=>operation==='storage.lease.cancel'?{state:'CANCELED',jobId:args.job.id,released:true}:{state:'CANCELED'});
  await f.start();
  assert.deepEqual(f.calls.map(call=>call.operation).sort(),['cancel','storage.lease.cancel']);
  assert.equal(f.job(old.id).state,'CANCELED');assert.equal(f.job(terminal.id).dataPreparationHold.state,'RELEASED');
  assert.equal(f.job(fresh.id).state,'SUBMITTING');assert.equal(f.job(fresh.id).dispatchPending,true);
});

test('canceling a queued first dispatch sends only its original cancel and never starts it',{timeout:3000},async t=>{
  const f=await fixture(t),first=await f.submit(),second=await f.submit(),held=f.block(first.id),work=f.start();await tick();
  await f.service.invoke(f.admin.token,'jobs.cancel',{jobId:second.id});held.resolve();await work;
  const attempts=f.calls.filter(call=>call.args.job.id===second.id);
  assert.equal(attempts.length,1);assert.equal(attempts[0].operation,'cancel');
  assert.equal(f.job(second.id).state,'CANCELED');assert.equal(f.job(second.id).dispatchPending,true);
  assert.equal(f.job(first.id).cancelRequested,false);assert.equal(usage(f.service.store.jobs,'builtin-admin'),1);
});

test('a selection error rejects the pass without leaving reconciliation locked or starting work',{timeout:3000},async t=>{
  const f=await fixture(t),fresh=await f.submit();f.service.maintenanceFor=()=>{throw Error('fixture maintenance read failed');};
  await assert.rejects(f.start(),/fixture maintenance read failed/);
  assert.equal(f.calls.length,0);assert.equal(f.service.reconciling,false);assert.equal(f.job(fresh.id).dispatchPending,true);
  f.service.maintenanceFor=()=>false;await f.start();assert.equal(f.calls.length,1);assert.equal(f.job(fresh.id).state,'PENDING');
});
