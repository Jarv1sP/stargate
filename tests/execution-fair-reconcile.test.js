import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';
import {trainingPlan} from './training-storage-fixture.mjs';

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
    if(operation==='projects.workspace'){
      assert.deepEqual(args,{project:'training',userId:'builtin-admin'});
      return {project:args.project,state:'AVAILABLE',workspace:{protocol:1,persistent:true}};
    }
    assert.ok(['sync','watch','logs','diagnostics','cancel','storage.lease.cancel','storage.training.prepare'].includes(operation),'workspace submissions do not prepare data or publish releases');
    if(operation==='storage.training.prepare')assert.equal(args.operation,'datasets.cancel','retired preparation workers can only be canceled');
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
  const submit=async(machine=MACHINES[0].id)=>(await service.invoke(admin.token,'jobs.submit',{machine,project:'training',cards:1,argv:['true'],key:randomUUID()})).result;
  const job=id=>service.store.jobs.find(j=>j.id===id);
  const old=async(machine=MACHINES[0].id)=>{const result=await submit(machine);Object.assign(job(result.id),{state:'PENDING',dispatchPending:false});service.save();return result;};
  // These records predate persistent workspaces. Never manufacture the retired
  // preparation state by submitting a modern job or reintroduce its API fields.
  const historical=(state='PREPARING_DATA')=>{
    const id=randomUUID(),machine=MACHINES[0].id,project={project:'training',release:'a'.repeat(64)},argv=['true'];
    const spec={id,userId:'builtin-admin',username:'admin',cards:1,argv,name:'train',minVramGiB:0,...project};
    const record={id,key:randomUUID(),digest:createHash('sha256').update(JSON.stringify([machine,1,0,argv,'train',project])).digest('hex'),
      spec,userId:spec.userId,username:spec.username,machine,cards:1,name:spec.name,...project,
      state,dispatchPending:true,createdAt:new Date().toISOString(),cancelRequested:false,
      ...(state==='PREPARING_DATA'?{datasets:[],dataPreparation:{datasets:[]}}:{dataPreparationHold:{state:'HELD',spec:structuredClone(spec)}})};
    service.store.jobs.push(record);service.save();return record;
  };
  const block=id=>{const response=deferred();blocks.set(id,response);return response;};
  const start=()=>{service.reconciling=false;const work=service.reconcile();works.push(work);return work;};
  t.after(async()=>{
    custom=undefined;for(const response of blocks.values())response.resolve();
    await Promise.allSettled(works);await service.tail;service.close();await rm(dir,{recursive:true,force:true});
  });
  return {service,admin,calls,counts,peaks,active,submit,old,historical,job,block,start,setBridge:fn=>custom=fn};
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
  assert.equal(f.calls.length,1);assert.equal(f.job(second.id).state,'FAILED');assert.match(f.job(second.id).error,/授权已改变/);
  assert.equal(f.job(second.id).notSubmitted,true);assert.equal(usage(f.service.store.jobs,'builtin-admin'),1);
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

test('retired preparation stays queryable and cancelable without automatic work or GPU quota',{timeout:3000},async t=>{
  const f=await fixture(t),job=f.historical(),before=structuredClone(job);
  const bytes=f.service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data;
  await f.start();await f.service.reconcile();assert.equal(f.calls.length,0);assert.deepEqual(job,before);
  assert.equal(usage(f.service.store.jobs,'builtin-admin'),0);assert.equal(usage(f.service.store.jobs,'builtin-admin',job.machine),0);
  f.setBridge(async(machine,operation,args)=>{
    assert.equal(machine,job.machine);assert.equal(operation,'watch');assert.deepEqual(args,{job:before.spec});
    return {state:'PENDING',schedulerState:'NOT_SUBMITTED'};
  });
  const view=(await f.service.invoke(f.admin.token,'jobs.watch',{jobId:job.id})).result;
  assert.equal(view.id,job.id);assert.equal(view.state,'PREPARING_DATA');assert.match(view.queueReason,/取消.*重新提交/);
  assert.equal((await f.service.invoke(f.admin.token,'state')).state.jobs.find(row=>row.id===job.id).queueReason,view.queueReason);
  const logs=(await f.service.invoke(f.admin.token,'jobs.logs',{jobId:job.id})).result;
  assert.match(logs.text,/平台仍记录为旧准备阶段/);assert.equal(f.calls.length,1,'retired preparation logs never call the node write-capable logs operation');
  assert.deepEqual(job,before);assert.equal(f.service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data,bytes);
  f.setBridge(async(machine,operation,args)=>{
    assert.equal(machine,job.machine);assert.equal(operation,'storage.lease.cancel');assert.deepEqual(args.job,before.spec);
    return {state:'CANCELED',jobId:job.id,released:true};
  });
  f.service.reconciling=true;await f.service.invoke(f.admin.token,'jobs.cancel',{jobId:job.id});await f.start();
  assert.deepEqual(f.calls.map(call=>call.operation),['watch','storage.lease.cancel']);assert.equal(job.state,'CANCELED');
  assert.equal(job.cancelRequested,true);assert.equal(f.job(job.id),job);assert.equal(job.key,before.key);
  assert.deepEqual(job.spec,before.spec);assert.equal(job.digest,before.digest);assert.equal(usage(f.service.store.jobs,'builtin-admin'),0);
});

test('retired preparation never blocks new dispatch or another node observation',{timeout:3000},async t=>{
  const f=await fixture(t),old=await f.old(MACHINES[1].id),held=f.block(old.id),job=f.historical();
  const before=structuredClone(job),work=f.start();await until(()=>f.active.has(old.id));
  const fresh=await f.submit();await until(()=>f.job(fresh.id).state==='PENDING');
  for(let n=0;n<5;n++)f.service.reconcile().catch(()=>{});await tick();
  assert.deepEqual(job,before);assert.equal(f.job(fresh.id).dispatchPending,false);assert.ok(f.active.has(old.id));
  assert.equal(f.calls.filter(call=>call.args.job.id===job.id).length,0);
  assert.equal(f.calls.filter(call=>call.args.job.id===fresh.id).length,1);assert.equal(usage(f.service.store.jobs,'builtin-admin'),2);
  held.resolve();await work;assert.deepEqual(job,before);
});

test('retired preparation cancellation keeps the original physical hold spec after an unconfirmed reply',async t=>{
  const f=await fixture(t),job=f.historical(),logical={dataset:'images',version:'a'.repeat(64)},physical={dataset:'images-replica',version:logical.version};
  job.spec.datasets=[logical];job.dataPreparationHold={state:'INTENT',spec:{...structuredClone(job.spec),datasets:[physical]}};f.service.save();
  const spec=structuredClone(job.spec),held=structuredClone(job.dataPreparationHold.spec);let confirmed=false;
  f.setBridge(async(_machine,operation,args)=>{
    assert.deepEqual(args.job,held);
    if(operation==='watch')return {state:'PENDING',schedulerState:'NOT_SUBMITTED'};
    assert.equal(operation,'storage.lease.cancel');
    return {state:confirmed?'CANCELED':'UNKNOWN',jobId:job.id,released:confirmed};
  });
  await f.service.invoke(f.admin.token,'jobs.watch',{jobId:job.id});
  await f.service.invoke(f.admin.token,'jobs.cancel',{jobId:job.id});await f.start();
  assert.equal(job.state,'PREPARING_DATA');assert.equal(job.cancelRequested,true);assert.equal(job.dataPreparationHold.state,'INTENT');assert.deepEqual(job.spec,spec);
  confirmed=true;await f.service.reconcile();assert.equal(job.state,'CANCELED');await f.service.reconcile();
  assert.equal(job.dataPreparationHold.state,'RELEASED');assert.deepEqual(job.spec,spec);
  assert.equal(f.calls.every(call=>['watch','storage.lease.cancel'].includes(call.operation)),true);
});

test('a historical native observation keeps its physical spec through running, cancellation and terminal reads',async t=>{
  const f=await fixture(t),job=f.historical(),logical={dataset:'images',version:'a'.repeat(64)},physical={...logical,dataset:'images-replica'};
  job.spec.datasets=[logical];job.dataPreparationHold={state:'HELD',spec:{...structuredClone(job.spec),datasets:[physical]}};f.service.save();
  const original=structuredClone(job.spec),held=structuredClone(job.dataPreparationHold.spec),digest=job.digest,nodeJobId='J'+'a'.repeat(12),startedAt=Date.now()/1000-20;
  // This models a readonly native observation, not a new dispatch or a claim
  // that this inconsistent historical combination exists in production.
  let nativeState='RUNNING';
  const observation=()=>({protocol:'native-observation-v1',status:'CONFIRMED',jobId:job.id,userId:job.userId,nodeJobId,submitKey:job.id,
    specVerified:true,nativeVersion:1,state:nativeState,observedAt:Date.now()/1000,latestRetry:null,
    latestAttempt:{id:'A'+'b'.repeat(32),ordinal:1,state:nativeState,startedAt,...(nativeState==='CANCELED'?{finishedAt:Date.now()/1000,exitCode:-15}:{})}});
  f.setBridge(async(machine,operation,args)=>{
    assert.equal(machine,job.machine);assert.deepEqual(args.job,held,'all native calls use the original physical binding');
    if(operation==='logs')return {text:'original training log'};
    if(operation==='diagnostics')return {jobId:job.id,marker:'original diagnostics',nativeObservation:observation()};
    if(operation==='storage.lease.cancel')return {state:'CANCELED',jobId:job.id,released:true};
    if(operation==='cancel')nativeState='CANCELED';
    return {state:nativeState,nodeJobId,assignedIndices:nativeState==='RUNNING'?[0]:[],nativeObservation:observation()};
  });
  assert.equal((await f.service.invoke(f.admin.token,'jobs.watch',{jobId:job.id})).result.state,'RUNNING');
  assert.equal(job.state,'RUNNING');assert.equal(usage(f.service.store.jobs,job.userId),1);
  await f.start();assert.equal(f.calls.at(-1).operation,'sync');
  for(const state of ['RUNNING','CANCELED']){
    assert.equal((await f.service.invoke(f.admin.token,'jobs.logs',{jobId:job.id})).result.text,'original training log');
    assert.equal((await f.service.invoke(f.admin.token,'jobs.watch',{jobId:job.id})).result.state,state);
    assert.equal((await f.service.invoke(f.admin.token,'jobs.diagnostics',{jobId:job.id})).result.marker,'original diagnostics');
    if(state==='RUNNING'){
      f.service.reconciling=true;await f.service.invoke(f.admin.token,'jobs.cancel',{jobId:job.id});await f.start();
      assert.equal(f.calls.at(-1).operation,'cancel');assert.equal(job.state,'CANCELED');await f.service.reconcile();
      assert.equal(job.dataPreparationHold.state,'RELEASED');assert.equal(usage(f.service.store.jobs,job.userId),0);
    }
  }
  const completion=(await f.service.invoke(f.admin.token,'jobs.completion',{jobId:job.id})).result;
  assert.equal(completion.specSha256,createHash('sha256').update(JSON.stringify(original)).digest('hex'));
  assert.equal(completion.completed,false);assert.deepEqual(job.spec,original);assert.equal(job.digest,digest);
});

for(const operation of ['watch','sync'])test(`a changed historical native binding rejects a late ${operation} result`,async t=>{
  const f=await fixture(t),job=f.historical('RUNNING'),gate=f.block(job.id),original=structuredClone(job.spec);
  f.setBridge(async(_machine,kind)=>{
    assert.equal(kind,operation);await gate.promise;return {state:'SUCCEEDED',nodeJobId:'J'+'a'.repeat(12)};
  });
  const work=operation==='watch'?f.service.invoke(f.admin.token,'jobs.watch',{jobId:job.id}):f.start();
  await until(()=>f.active.has(job.id));
  job.dataPreparationHold.spec={...job.dataPreparationHold.spec,datasets:[{dataset:'changed-binding',version:'a'.repeat(64)}]};f.service.save();
  gate.resolve();const reply=await work;
  if(operation==='watch')assert.equal(reply.result.state,'UNKNOWN');
  assert.equal(job.state,'RUNNING');assert.deepEqual(job.spec,original);assert.equal(usage(f.service.store.jobs,job.userId),1);
});

for(const state of ['RUNNING','UNKNOWN'])test(`historical ${state} jobs retain their normal observations and GPU quota`,async t=>{
  const f=await fixture(t),job=f.historical(state),spec=structuredClone(job.spec);
  f.setBridge(async(_machine,operation,args)=>{
    assert.equal(operation,'sync');assert.deepEqual(args.job,spec);return {state};
  });
  await f.start();assert.equal(job.state,state);assert.equal(f.calls.length,1);assert.equal(usage(f.service.store.jobs,job.userId),1);
  assert.equal(job.dataPreparationHold.state,'HELD');assert.deepEqual(job.spec,spec);
  assert.equal(f.service.state(f.admin.principal).jobs.find(row=>row.id===job.id).queueReason,null);
});

test('historical preparation workers without a data hold retry until confirmed and keep their original records',async t=>{
  const f=await fixture(t),job=f.historical('CANCELED'),ref={dataset:'images',version:'a'.repeat(64)};
  delete job.dataPreparationHold;job.spec.datasets=[ref];
  const request={userId:job.userId,hostAdmin:false,datasets:[ref],datasetReadMode:'cache',projectFootprint:null,
    datasetFootprints:[{...ref,bytes:30,files:2,directories:0,manifestBytes:100}]};
  job.trainingStoragePlan=trainingPlan(job.machine,request);job.trainingPreparations=[{job:structuredClone(job.spec),planRequest:request,
    preparation:{protocol:1,id:randomUUID(),kind:'dataset',sourceMachine:job.machine,targetMachine:job.machine,logicalReference:ref,reference:ref}}];
  job.error='original training error';f.service.save();const original=structuredClone(job.trainingPreparations);let confirmed=false;
  f.setBridge(async(machine,operation,args)=>{
    assert.equal(machine,job.machine);assert.equal(operation,'storage.training.prepare');assert.equal(args.operation,'datasets.cancel');
    assert.deepEqual({job:args.job,planRequest:args.planRequest,preparation:args.preparation},original[0]);
    return {state:confirmed?'CANCELED':'UNKNOWN',confirmedStopped:confirmed};
  });
  await f.start();assert.equal(job.trainingPreparationsReleased,undefined);assert.deepEqual(job.trainingPreparations,original);
  confirmed=true;await f.service.reconcile();assert.equal(job.trainingPreparationsReleased,true);
  await f.service.reconcile();assert.equal(f.calls.length,2);assert.deepEqual(job.trainingPreparations,original);assert.equal(job.error,'original training error');
  const view=f.service.state(f.admin.principal).jobs.find(row=>row.id===job.id);
  assert.equal(Object.hasOwn(view,'trainingPreparationsReleased'),false);assert.equal(Object.hasOwn(view,'trainingPreparations'),false);
});

test('policy revision changes fence late results and closing never dispatches queued work',{timeout:3000},async t=>{
  const f=await fixture(t),first=await f.submit(),second=await f.submit(),held=f.block(first.id),work=f.start();await tick();
  await f.service.enqueue(()=>{f.job(first.id).policyRevision=1;f.service.save();});
  f.service.closing=true;held.resolve();await work;
  assert.equal(f.calls.length,1);assert.equal(f.job(first.id).state,'SUBMITTING');assert.equal(f.job(first.id).dispatchPending,false);
  assert.equal(f.job(second.id).dispatchPending,true);assert.equal(usage(f.service.store.jobs,'builtin-admin'),2);
});

test('maintenance blocks new dispatch and old polls but not cancellation or confirmed terminal hold cleanup',{timeout:3000},async t=>{
  const f=await fixture(t),old=await f.old(),fresh=await f.submit(),terminal=f.historical('FAILED');
  await f.service.invoke(f.admin.token,'jobs.cancel',{jobId:old.id});
  f.service.maintenanceFor=()=>true;
  f.setBridge(async(_machine,operation,args)=>operation==='storage.lease.cancel'?{state:'CANCELED',jobId:args.job.id,released:true}:{state:'CANCELED'});
  await f.start();
  assert.deepEqual(f.calls.map(call=>call.operation).sort(),['cancel','storage.lease.cancel']);
  assert.equal(f.job(old.id).state,'CANCELED');assert.equal(f.job(terminal.id).dataPreparationHold.state,'RELEASED');
  assert.equal(f.job(fresh.id).state,'SUBMITTING');assert.equal(f.job(fresh.id).dispatchPending,true);
});

for(const state of ['INTENT','HELD','HANDED_OFF'])test(`historical ${state} cleanup uses the observation lane once while new work advances`,{timeout:3000},async t=>{
  const f=await fixture(t),terminal=f.historical('FAILED'),fresh=await f.submit(),gate=f.block(terminal.id);
  terminal.dataPreparationHold.state=state;f.service.save();
  const spec=structuredClone(terminal.dataPreparationHold.spec);
  f.setBridge(async(machine,operation,args)=>{
    if(operation==='storage.lease.cancel'){
      assert.equal(machine,terminal.machine);assert.deepEqual(args,{job:spec});await gate.promise;
      return {state:'CANCELED',jobId:terminal.id,released:true};
    }
    assert.equal(operation,'sync');assert.equal(args.job.id,fresh.id);return {state:'PENDING'};
  });
  const work=f.start();await until(()=>f.job(fresh.id).state==='PENDING');
  for(let n=0;n<10;n++)f.service.reconcile().catch(()=>{});
  await tick();assert.equal(f.calls.length,2);assert.equal(f.active.has(terminal.id),true);
  assert.equal(f.peaks.get(terminal.machine),2);assert.equal(terminal.dataPreparationHold.state,state);
  gate.resolve();await work;assert.equal(terminal.dataPreparationHold.state,'RELEASED');
  await f.service.reconcile();assert.equal(f.calls.filter(call=>call.operation==='storage.lease.cancel').length,1);
  assert.equal(terminal.state,'FAILED');assert.deepEqual(terminal.spec,spec);
});

for(const failure of ['timeout','unknown','unreleased','wrong-job'])test(`historical cleanup ${failure} keeps the hold and original training error for retry`,async t=>{
  const f=await fixture(t),terminal=f.historical('FAILED'),spec=structuredClone(terminal.dataPreparationHold.spec);
  terminal.error='training exit 17';f.service.save();
  const before=structuredClone(terminal);
  f.setBridge(async(machine,operation,args)=>{
    assert.equal(machine,terminal.machine);assert.equal(operation,'storage.lease.cancel');assert.deepEqual(args,{job:spec});
    if(failure==='timeout')throw Error('cleanup reply lost');
    return {state:failure==='unknown'?'UNKNOWN':'CANCELED',jobId:failure==='wrong-job'?randomUUID():terminal.id,released:failure!=='unreleased'};
  });
  await f.start();assert.deepEqual(terminal,before);
  const persisted=JSON.parse(f.service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data);
  assert.deepEqual(persisted.jobs.find(job=>job.id===terminal.id),before);
  f.setBridge(async(_machine,_operation,args)=>({state:'CANCELED',jobId:args.job.id,released:true}));
  await f.service.reconcile();assert.equal(f.calls.length,2);
  assert.deepEqual(terminal,{...before,dataPreparationHold:{...before.dataPreparationHold,state:'RELEASED'}});
});

test('failed cleanup persistence rolls back the hold and retries the same node cancellation',async t=>{
  const f=await fixture(t),terminal=f.historical('FAILED'),before=structuredClone(terminal);
  f.service.db.exec(`CREATE TRIGGER fail_cleanup BEFORE UPDATE ON portal_state WHEN instr(NEW.data,'"state":"RELEASED"')>0 BEGIN SELECT RAISE(ABORT,'cleanup save failure'); END`);
  f.setBridge(async(_machine,operation,args)=>{
    assert.equal(operation,'storage.lease.cancel');assert.deepEqual(args,{job:before.dataPreparationHold.spec});
    return {state:'CANCELED',jobId:terminal.id,released:true};
  });
  await f.start();assert.deepEqual(terminal,before);
  const persisted=JSON.parse(f.service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data);
  assert.deepEqual(persisted.jobs.find(job=>job.id===terminal.id),before);
  f.service.db.exec('DROP TRIGGER fail_cleanup');await f.service.reconcile();
  assert.equal(f.calls.length,2);assert.equal(terminal.dataPreparationHold.state,'RELEASED');
});

test('closing does not start queued historical cleanup or commit a late cleanup reply',async t=>{
  const f=await fixture(t),first=f.historical('FAILED'),second=f.historical('FAILED'),gate=f.block(first.id);
  f.setBridge(async(_machine,operation,args)=>{
    assert.equal(operation,'storage.lease.cancel');assert.equal(args.job.id,first.id);await gate.promise;
    return {state:'CANCELED',jobId:first.id,released:true};
  });
  const work=f.start();await until(()=>f.active.has(first.id));
  f.service.closing=true;gate.resolve();await work;await f.service.reconcile();
  assert.equal(f.calls.length,1);assert.equal(first.dataPreparationHold.state,'HELD');assert.equal(second.dataPreparationHold.state,'HELD');
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
