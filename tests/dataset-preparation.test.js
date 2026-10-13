import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as preparation from '../dataset-preparation.mjs';
import {usage,publicJob} from '../execution.mjs';
import {MACHINES} from '../dist/model.js';
import {trainingPlan} from './training-storage-fixture.mjs';

const {releaseDataPreparation}=preparation,machine=MACHINES[0].id;
const logical={dataset:'sample',version:'a'.repeat(64)};
const physical={dataset:'private-cache',version:logical.version,mountAs:logical.dataset};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

// Seed an authentic historical record, including original physical bindings.
// Cleanup must not call a retired preparation flow to recreate these records.
function fixture({state='FAILED',hold='HELD',worker=false}={}){
  const user={id:'demo-user-1',username:'alice',role:'member',enabled:true,total:1,limits:{[machine]:1}};
  const id=randomUUID(),project={project:'paper',release:'b'.repeat(64)};
  const spec={id,userId:user.id,username:user.username,cards:1,argv:['python','train.py'],name:'train',...project,datasets:[logical]};
  const request={userId:user.id,hostAdmin:false,datasets:[logical],datasetReadMode:'cache',projectFootprint:null,
    datasetFootprints:[{...logical,bytes:8,files:1,directories:0,manifestBytes:100}]};
  const job={id,key:randomUUID(),userId:user.id,machine,cards:1,spec,digest:'original-digest',...project,
    datasets:[logical],state,cancelRequested:false,error:'original training failure',
    ...(hold?{dataPreparationHold:{state:hold,spec:{...structuredClone(spec),datasets:[physical]}}}:{})};
  if(worker){
    job.trainingStoragePlan=trainingPlan(machine,request);
    job.trainingPreparations=[{job:structuredClone(spec),planRequest:request,preparation:{
      protocol:1,id:randomUUID(),kind:'dataset',sourceMachine:machine,targetMachine:machine,
      logicalReference:logical,reference:{dataset:physical.dataset,version:physical.version},
    }}];
  }
  const jobs=[job],calls=[],saves=[];let tail=Promise.resolve(),inQueue=false,handler;
  const service={store:{jobs,get:id=>{assert.equal(id,user.id);return structuredClone(user);}},
    enqueue(fn){const result=tail.then(async()=>{inQueue=true;try{return await fn();}finally{inQueue=false;}});tail=result.catch(()=>{});return result;},
    save(){if(service.saveFailure)throw Error('save failed');saves.push(structuredClone(jobs));},
    bridge:async(target,operation,args)=>{
      assert.equal(inQueue,false,'node I/O must not hold the mutation queue');
      assert.equal(target,machine);calls.push({machine:target,operation,args:structuredClone(args)});
      if(handler)return handler(target,operation,args);
      if(operation==='storage.lease.cancel')return {jobId:args.job.id,state:'CANCELED',released:true};
      assert.equal(operation,'storage.training.prepare');assert.equal(args.operation,'datasets.cancel');
      return {state:'CANCELED',confirmedStopped:true};
    }};
  return {service,user,job,jobs,calls,saves,setHandler:fn=>handler=fn};
}

test('retired preparation has no start or promote entry point',()=>{
  assert.deepEqual(Object.keys(preparation),['releaseDataPreparation']);
});

for(const initial of ['INTENT','HELD','HANDED_OFF'])test('historical '+initial+' releases the original physical hold once without changing logical history',async()=>{
  for(const state of ['FAILED','CANCELED','SUCCEEDED']){
    const f=fixture({state,hold:initial}),before=structuredClone(f.job),spec=structuredClone(f.job.dataPreparationHold.spec);
    await releaseDataPreparation(f.service,f.job);
    assert.deepEqual(f.calls,[{machine,operation:'storage.lease.cancel',args:{job:spec}}]);
    assert.deepEqual(f.job,{...before,dataPreparationHold:{...before.dataPreparationHold,state:'RELEASED'}});
    assert.deepEqual(f.job.datasets,[logical]);assert.deepEqual(f.job.spec.datasets,[logical]);
    assert.doesNotMatch(JSON.stringify(publicJob(f.job)),/private-cache|dataPreparationHold/);
    await releaseDataPreparation(f.service,f.job);assert.equal(f.calls.length,1);
    assert.equal(usage(f.jobs,f.user.id),0);
  }
});

for(const failure of ['timeout','unknown','wrong-job','not-released'])test('cleanup '+failure+' retains the original hold and error until its matching confirmation',async()=>{
  const f=fixture({hold:'INTENT'}),before=structuredClone(f.job);
  f.setHandler((_machine,_operation,args)=>{
    if(failure==='timeout')throw Error('reply lost');
    return {jobId:failure==='wrong-job'?randomUUID():args.job.id,state:failure==='unknown'?'UNKNOWN':'CANCELED',released:failure!=='not-released'};
  });
  await assert.rejects(releaseDataPreparation(f.service,f.job));assert.deepEqual(f.job,before);assert.deepEqual(f.saves,[]);
  f.setHandler(null);await releaseDataPreparation(f.service,f.job);
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);
  assert.equal(f.job.dataPreparationHold.state,'RELEASED');assert.equal(f.job.error,before.error);
});

test('historical preparation and every unconfirmed execution state never release workers or leases',async()=>{
  for(const state of ['PREPARING_DATA','SUBMITTING','PENDING','STARTING','RUNNING','PREEMPTING','UNKNOWN','LOST']){
    const f=fixture({state,worker:true}),before=structuredClone(f.job);
    for(let n=0;n<3;n++)await releaseDataPreparation(f.service,f.job);
    assert.deepEqual(f.job,before);assert.deepEqual(f.calls,[]);assert.deepEqual(f.saves,[]);
    if(state==='PREPARING_DATA')assert.equal(usage(f.jobs,f.user.id),0);
  }
});

test('closing, absent protection and already released protection do no RPC',async()=>{
  for(const options of [{hold:null},{hold:'RELEASED'},{hold:'HELD',closing:true}]){
    const f=fixture(options);f.service.closing=options.closing;
    const before=structuredClone(f.job);await releaseDataPreparation(f.service,f.job);
    assert.deepEqual(f.calls,[]);assert.deepEqual(f.saves,[]);assert.deepEqual(f.job,before);
  }
});

test('worker-only historical records retain their fixed bindings and persist cleanup once',async()=>{
  const f=fixture({worker:true,hold:null}),before=structuredClone(f.job);
  await releaseDataPreparation(f.service,f.job);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'storage.training.prepare');
  assert.deepEqual(f.calls[0].args,{...before.trainingPreparations[0],operation:'datasets.cancel',
    args:{userId:f.user.id,hostAdmin:false,...before.trainingPreparations[0].preparation.reference}});
  assert.deepEqual(f.job,{...before,trainingPreparationsReleased:true});
  assert.equal(Object.hasOwn(publicJob(f.job),'trainingPreparationsReleased'),false);
  assert.equal(Object.hasOwn(publicJob(f.job),'trainingPreparations'),false);
  await releaseDataPreparation(f.service,f.job);assert.equal(f.calls.length,1);
});

test('unconfirmed worker stop keeps the data hold and retries only its original preparation',async()=>{
  const f=fixture({worker:true}),before=structuredClone(f.job);
  f.setHandler(()=>({state:'CANCELED',confirmedStopped:false}));
  await assert.rejects(releaseDataPreparation(f.service,f.job),/停止尚未确认/);
  assert.deepEqual(f.job,before);assert.equal(f.calls.length,1);
  f.setHandler(null);await releaseDataPreparation(f.service,f.job);
  assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.calls[2].operation,'storage.lease.cancel');
  assert.equal(f.job.trainingPreparationsReleased,true);assert.equal(f.job.dataPreparationHold.state,'RELEASED');
  await releaseDataPreparation(f.service,f.job);assert.equal(f.calls.length,3);
});

test('worker confirmation persists before hold cleanup and each failed save can recover by original identity',async()=>{
  for(const worker of [false,true]){
    const f=fixture({worker}),before=structuredClone(f.job);f.service.saveFailure=true;
    await assert.rejects(releaseDataPreparation(f.service,f.job),/save failed/);
    assert.deepEqual(f.job,before);assert.equal(f.calls.length,1);assert.deepEqual(f.saves,[]);
    f.service.saveFailure=false;await releaseDataPreparation(f.service,f.job);
    assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.job.dataPreparationHold.state,'RELEASED');
    if(worker){assert.equal(f.calls.length,3);assert.equal(f.saves[0][0].trainingPreparationsReleased,true);assert.equal(f.saves[0][0].dataPreparationHold.state,'HELD');}
  }
});

test('late cleanup cannot confirm or cancel a newly appended preparation',async()=>{
  const f=fixture({worker:true}),entered=deferred(),reply=deferred();
  f.setHandler(async()=>{entered.resolve();await reply.promise;return {state:'CANCELED',confirmedStopped:true};});
  const work=releaseDataPreparation(f.service,f.job);await entered.promise;
  const added=structuredClone(f.job.trainingPreparations[0]);added.preparation.id=randomUUID();
  await f.service.enqueue(()=>{f.job.trainingPreparations.push(added);});
  reply.resolve();await work;
  assert.equal(f.calls.length,1);assert.equal(f.job.trainingPreparationsReleased,undefined);
  assert.equal(f.job.dataPreparationHold.state,'HELD');assert.deepEqual(f.job.trainingPreparations[1],added);
  f.setHandler(null);await releaseDataPreparation(f.service,f.job);
  assert.equal(f.calls.length,4);assert.deepEqual(f.calls.slice(1,3).map(c=>c.args.preparation.id),f.job.trainingPreparations.map(p=>p.preparation.id));
  assert.equal(f.job.trainingPreparationsReleased,true);assert.equal(f.job.dataPreparationHold.state,'RELEASED');
});

test('late hold cleanup cannot release a changed physical binding or a nonterminal task',async()=>{
  for(const change of [f=>{f.job.dataPreparationHold.spec.datasets=[{...physical,dataset:'new-binding'}];},
    f=>{f.job.state='UNKNOWN';},f=>{f.service.closing=true;}]){
    const f=fixture(),entered=deferred(),reply=deferred();
    f.setHandler(async(_machine,_operation,args)=>{entered.resolve();await reply.promise;return {jobId:args.job.id,state:'CANCELED',released:true};});
    const work=releaseDataPreparation(f.service,f.job);await entered.promise;
    await f.service.enqueue(()=>change(f));const changed=structuredClone(f.job);reply.resolve();await work;
    assert.deepEqual(f.job,changed);assert.equal(f.job.dataPreparationHold.state,'HELD');
    assert.deepEqual(f.calls[0].args.job.datasets,[physical]);assert.deepEqual(f.saves,[]);
  }
});

test('worker cleanup does not switch to a different hold added while it was waiting',async()=>{
  const f=fixture({worker:true}),entered=deferred(),reply=deferred(),original=structuredClone(f.job.dataPreparationHold.spec);
  f.setHandler(async(_machine,operation,args)=>{
    if(operation==='storage.training.prepare'){entered.resolve();await reply.promise;return {state:'CANCELED',confirmedStopped:true};}
    assert.equal(operation,'storage.lease.cancel');return {jobId:args.job.id,state:'CANCELED',released:true};
  });
  const work=releaseDataPreparation(f.service,f.job);await entered.promise;
  await f.service.enqueue(()=>{f.job.dataPreparationHold.spec.datasets=[{...physical,dataset:'new-binding'}];});
  const changed=structuredClone(f.job.dataPreparationHold);reply.resolve();await work;
  assert.deepEqual(f.calls[1].args,{job:original});assert.deepEqual(f.job.dataPreparationHold,changed);
  assert.equal(f.job.trainingPreparationsReleased,true);
});

test('maintenance and account profile changes cannot strand confirmed terminal cleanup',async()=>{
  const f=fixture({worker:true});f.service.maintenanceFor=()=>true;
  Object.assign(f.user,{enabled:false,role:'admin',limits:{},name:'renamed',approvalNote:'changed'});
  const before=structuredClone(f.job);await releaseDataPreparation(f.service,f.job);
  assert.equal(f.job.trainingPreparationsReleased,true);assert.equal(f.job.dataPreparationHold.state,'RELEASED');
  assert.deepEqual(f.job.trainingPreparations,before.trainingPreparations);assert.deepEqual(f.job.spec,before.spec);
  assert.deepEqual(f.calls.map(c=>c.operation),['storage.training.prepare','storage.lease.cancel']);
});
