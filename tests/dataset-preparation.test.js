import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceDataPreparation,DATA_PREPARING,releaseDataPreparation} from '../dataset-preparation.mjs';
import {usage,publicJob} from '../execution.mjs';
import {DatabaseSync} from 'node:sqlite';
import {installDatasetReplication} from '../dataset-replication.mjs';

const ref={dataset:'sample',version:'a'.repeat(64)};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture({jobs=1,total=1}={}){
  const user={id:'u1',username:'alice',role:'member',enabled:true,total,limits:{'gpu-1':total},policyVersion:1};
  const records=Array.from({length:jobs},(_,index)=>({id:'job-'+index,userId:user.id,machine:'gpu-1',cards:1,
    digest:'digest-'+index,spec:{argv:['python','train.py']},datasets:[ref],state:DATA_PREPARING,cancelRequested:false}));
  let tail=Promise.resolve(),inQueue=false;
  const calls=[],saves=[];
  const service={store:{jobs:records,get:id=>{if(id!==user.id||service.deleted)throw Error('missing user');return structuredClone(user);}},
    gpuq:{stale:false,hosts:[{id:'gpu-1',reachable:true,gpuq:{connected:true,observeOnly:false}}]},
    enqueue:fn=>{const result=tail.then(async()=>{inQueue=true;try{return await fn();}finally{inQueue=false;}});tail=result.catch(()=>{});return result;},
    save:()=>{if(service.saveFailure)throw Error('save failed');saves.push(structuredClone(records));},
    bridge:async(machine,operation,args)=>{assert.equal(inQueue,false,'remote I/O must not hold the mutation queue');calls.push({machine,operation,args});return {state:'READY',dataset:args.dataset,version:args.version};},
    refreshGPUQ:async()=>assert.equal(inQueue,false,'status refresh must not hold the mutation queue')};
  return {service,user,jobs:records,calls,saves};
}

test('slow node observation does not block mutations; cancellation prevents dispatch or cache-worker cancellation',{timeout:2000},async()=>{
  const f=fixture(),entered=deferred(),response=deferred();
  f.service.bridge=async()=>{entered.resolve();return response.promise;};
  const work=advanceDataPreparation(f.service,f.jobs[0],usage);await entered.promise;
  await f.service.enqueue(()=>{f.jobs[0].cancelRequested=true;});
  response.resolve({...ref,state:'REGISTERED'});await work;
  assert.equal(f.jobs[0].state,'CANCELED');assert.equal(usage(f.jobs,f.user.id),0);
});

test('identity, role, grants and enabled state are rechecked after I/O',async()=>{
  for(const change of [u=>u.role='admin',u=>u.total=2,u=>u.limits['gpu-1']=2,u=>u.enabled=false,u=>u.username='renamed']){
    const f=fixture(),entered=deferred(),response=deferred();
    f.service.bridge=async()=>{entered.resolve();return response.promise;};
    const work=advanceDataPreparation(f.service,f.jobs[0],usage);await entered.promise;
    await f.service.enqueue(()=>change(f.user));response.resolve({...ref,state:'READY'});await work;
    assert.equal(f.jobs[0].state,'FAILED');assert.equal(usage(f.jobs,f.user.id),0);
  }
});

test('removed user or mutated immutable job cannot promote a stale READY observation',async()=>{
  for(const change of [f=>f.service.deleted=true,f=>f.jobs[0].spec.argv=['changed']]){
    const f=fixture(),entered=deferred(),response=deferred();
    f.service.bridge=async()=>{entered.resolve();return response.promise;};
    const work=advanceDataPreparation(f.service,f.jobs[0],usage);await entered.promise;
    await f.service.enqueue(()=>change(f));response.resolve({...ref,state:'READY'});await work;
    assert.equal(f.jobs[0].state,'FAILED');assert.equal(usage(f.jobs,f.user.id),0);
  }
});

test('concurrent preparation completion checks quota and reserves atomically',async()=>{
  const f=fixture({jobs:2});
  await Promise.all(f.jobs.map(job=>advanceDataPreparation(f.service,job,usage)));
  assert.equal(f.jobs.filter(job=>job.state==='SUBMITTING').length,1);
  assert.equal(f.jobs.filter(job=>job.state===DATA_PREPARING).length,1);
  assert.equal(usage(f.jobs,f.user.id),1);
  const waiting=f.jobs.find(job=>job.state===DATA_PREPARING);
  assert.match(waiting.queueReason,/等待个人可用卡数额度/);
  f.jobs.find(job=>job.state==='SUBMITTING').state='SUCCEEDED';
  await advanceDataPreparation(f.service,waiting,usage);assert.equal(waiting.state,'SUBMITTING');
});

test('data-ready admin shared and exclusive jobs bypass personal counts but preserve leases and node admission',async()=>{
  for(const shared of [false,true]){
  const f=managed(fixture({jobs:2}));f.user.role='admin';
  for(const job of f.jobs){job.placement={gpuIndices:[0],shared,...(shared?{vramMiB:4096}:{})};Object.assign(job.spec,{cards:1,placement:job.placement});}
  await Promise.all(f.jobs.map(job=>advanceDataPreparation(f.service,job,usage)));
  assert.ok(f.jobs.every(job=>job.state==='SUBMITTING'));
  assert.equal(usage(f.jobs,f.user.id),2);assert.ok(f.jobs.every(job=>job.dataPreparationHold.state==='HELD'));
  assert.equal(f.calls.filter(call=>call.operation==='storage.lease.prepare').length,2);
  assert.equal(f.calls.filter(call=>call.operation==='storage.lease.cancel').length,0);
  }
  const offline=fixture();offline.user.role='admin';offline.jobs[0].spec.placement={shared:true};offline.jobs[0].spec.cards=1;offline.service.gpuq.stale=true;
  await advanceDataPreparation(offline.service,offline.jobs[0],usage);
  assert.equal(offline.jobs[0].state,DATA_PREPARING);assert.match(offline.jobs[0].queueReason,/等待服务器恢复/);
});

test('data-ready personal quota still applies to members in both modes and rechecks demoted admins',async()=>{
  for(const shared of [false,true]){
    const f=fixture({jobs:2});f.user.role='member';
    for(const job of f.jobs)Object.assign(job.spec,{cards:1,placement:{gpuIndices:[0],shared,...(shared?{vramMiB:4096}:{})}});
    await Promise.all(f.jobs.map(job=>advanceDataPreparation(f.service,job,usage)));
    assert.equal(f.jobs.filter(job=>job.state==='SUBMITTING').length,1);
    assert.match(f.jobs.find(job=>job.state===DATA_PREPARING).queueReason,/等待个人可用卡数额度/);
  }
  for(const shared of [false,true])for(const change of [user=>user.role='member',user=>user.enabled=false,user=>user.limits={}]){
    const f=fixture();f.user.role='admin';Object.assign(f.jobs[0].spec,{cards:1,placement:{gpuIndices:[0],shared,...(shared?{vramMiB:4096}:{})}});
    const entered=deferred(),response=deferred();f.service.bridge=async()=>{entered.resolve();return response.promise;};
    const work=advanceDataPreparation(f.service,f.jobs[0],usage);await entered.promise;
    await f.service.enqueue(()=>change(f.user));response.resolve({...ref,state:'READY'});await work;
    assert.equal(f.jobs[0].state,'FAILED');assert.equal(usage(f.jobs,f.user.id),0);
  }
});

test('duplicate observation for one job shares one operation and cannot reserve twice',async()=>{
  const f=fixture(),response=deferred();let calls=0;
  f.service.bridge=async()=>{calls++;return response.promise;};
  const first=advanceDataPreparation(f.service,f.jobs[0],usage),second=advanceDataPreparation(f.service,f.jobs[0],usage);
  assert.equal(first,second);response.resolve({...ref,state:'READY'});await Promise.all([first,second]);
  assert.equal(calls,1);assert.equal(f.saves.length,1);assert.equal(usage(f.jobs,f.user.id),1);
  await advanceDataPreparation(f.service,f.jobs[0],usage);assert.equal(calls,1);
});

test('maintenance arriving during READY observation preserves the pending job and resumes only after explicit clear',async()=>{
  const f=fixture(),entered=deferred(),reply=deferred();let maintained=false;
  f.service.maintenanceFor=()=>maintained;
  f.service.bridge=async()=>{entered.resolve();return reply.promise;};
  const pending=advanceDataPreparation(f.service,f.jobs[0],usage);await entered.promise;
  maintained=true;reply.resolve({...ref,state:'READY'});await pending;
  assert.equal(f.jobs[0].state,DATA_PREPARING);assert.equal(usage(f.jobs,f.user.id),0);assert.equal(f.saves.length,0);
  await advanceDataPreparation(f.service,f.jobs[0],usage);assert.equal(f.jobs[0].state,DATA_PREPARING);
  maintained=false;await advanceDataPreparation(f.service,f.jobs[0],usage);assert.equal(f.jobs[0].state,'SUBMITTING');
});

test('a verified personal replica keeps the logical user path and leases its real ID',async()=>{
  const f=fixture();let observations=0;
  const actual={dataset:'u-personal-copy',version:ref.version,mountAs:ref.dataset};
  f.service.resolveDataset=async()=>{observations++;return {status:{...ref,state:'READY'},reference:actual};};
  await advanceDataPreparation(f.service,f.jobs[0],usage);
  assert.equal(observations,1);assert.equal(f.jobs[0].state,'SUBMITTING');
  assert.deepEqual(f.jobs[0].datasets,[ref]);assert.deepEqual(f.jobs[0].spec.datasets,[actual]);
});

test('failed durable reservation restores all in-memory fields and can retry safely',async()=>{
  const f=fixture(),before=structuredClone(f.jobs[0]);f.service.saveFailure=true;
  await assert.rejects(advanceDataPreparation(f.service,f.jobs[0],usage),/save failed/);
  assert.deepEqual(f.jobs[0],before);assert.equal(usage(f.jobs,f.user.id),0);
  f.service.saveFailure=false;await advanceDataPreparation(f.service,f.jobs[0],usage);
  assert.equal(f.jobs[0].state,'SUBMITTING');assert.equal(f.saves.length,1);
});

test('cancellation save failure retains pending cancellation and never reserves',async()=>{
  const f=fixture();f.jobs[0].cancelRequested=true;f.service.saveFailure=true;
  await assert.rejects(advanceDataPreparation(f.service,f.jobs[0],usage),/save failed/);
  assert.equal(f.jobs[0].state,DATA_PREPARING);assert.equal(f.jobs[0].cancelRequested,true);
  assert.equal(f.calls.length,0);assert.equal(usage(f.jobs,f.user.id),0);
  f.service.saveFailure=false;await advanceDataPreparation(f.service,f.jobs[0],usage);assert.equal(f.jobs[0].state,'CANCELED');
});

test('preparing or failed data never enters scheduler submission; actor is always owner-only',async()=>{
  const f=fixture();
  f.service.bridge=async(machine,operation,args)=>{f.calls.push({operation,args});return {...ref,state:operation==='datasets.status'?'REGISTERED':'PREPARING'};};
  await advanceDataPreparation(f.service,f.jobs[0],usage);
  assert.equal(f.jobs[0].state,DATA_PREPARING);assert.equal(usage(f.jobs,f.user.id),0);
  assert.deepEqual(f.calls.map(call=>call.operation),['datasets.status','datasets.prepare']);
  assert.ok(f.calls.every(call=>call.args.userId===f.user.id&&call.args.hostAdmin===false));
  f.service.bridge=async()=>({...ref,state:'FAILED'});
  await advanceDataPreparation(f.service,f.jobs[0],usage);assert.equal(f.jobs[0].state,'FAILED');
});

test('wrong data version, invalid project, unavailable host and shutdown fail closed',async()=>{
  const mismatch=fixture();mismatch.service.bridge=async()=>({...ref,version:'b'.repeat(64),state:'READY'});
  await assert.rejects(advanceDataPreparation(mismatch.service,mismatch.jobs[0],usage),/版本不符/);
  assert.equal(mismatch.jobs[0].state,DATA_PREPARING);
  const project=fixture();Object.assign(project.jobs[0],{project:'p',release:'r'});
  project.service.bridge=async(_machine,operation)=>operation==='projects.verify'?{state:'READY',project:'other',release:'r'}:{...ref,state:'READY'};
  await advanceDataPreparation(project.service,project.jobs[0],usage);assert.equal(project.jobs[0].state,'FAILED');
  const offline=fixture();offline.service.gpuq.stale=true;
  await advanceDataPreparation(offline.service,offline.jobs[0],usage);assert.equal(offline.jobs[0].state,DATA_PREPARING);
  assert.match(offline.jobs[0].queueReason,/等待服务器恢复/);
  const closed=fixture();closed.service.closing=true;
  await advanceDataPreparation(closed.service,closed.jobs[0],usage);assert.equal(closed.calls.length,0);assert.equal(closed.saves.length,0);
});

function managed(f){
  f.service.storageArchivePolicy={enabled:true};
  for(const job of f.jobs)Object.assign(job.spec,{id:job.id,userId:job.userId});
  f.service.bridge=async(machine,operation,args)=>{
    f.calls.push({machine,operation,args});
    if(operation==='storage.lease.prepare')return {jobId:args.job.id,state:'HELD'};
    if(operation==='storage.lease.cancel')return {jobId:args.job.id,state:'CANCELED',released:true};
    return {...ref,state:'READY'};
  };
  return f;
}

test('feature-on waiting retains durable HELD leases and promotion does not pretend handoff',async()=>{
  const f=managed(fixture({jobs:2}));
  await Promise.all(f.jobs.map(job=>advanceDataPreparation(f.service,job,usage)));
  assert.equal(f.jobs.filter(job=>job.state==='SUBMITTING').length,1);
  const waiting=f.jobs.find(job=>job.state===DATA_PREPARING);
  assert.equal(waiting.dataPreparationHold.state,'HELD');
  assert.ok(f.jobs.every(job=>job.dataPreparationHold.state==='HELD'));
  assert.equal(f.calls.filter(call=>call.operation==='storage.lease.prepare').length,2);
  assert.equal(f.calls.filter(call=>call.operation==='storage.lease.cancel').length,0);
  const promoted=f.jobs.find(job=>job!==waiting);promoted.state='SUCCEEDED';
  await advanceDataPreparation(f.service,waiting,usage);
  assert.equal(waiting.state,'SUBMITTING');assert.equal(waiting.dataPreparationHold.state,'HELD');
  assert.equal(Object.hasOwn(publicJob(waiting),'dataPreparationHold'),false);
});

test('feature-on cancellation after prepare reply loss fences the original intent',async()=>{
  const f=managed(fixture()),ready=deferred(),reply=deferred();
  const original=f.service.bridge;
  f.service.bridge=async(machine,operation,args)=>{
    if(operation==='storage.lease.prepare'){ready.resolve();await reply.promise;throw Error('lost preparation reply');}
    return original(machine,operation,args);
  };
  const work=advanceDataPreparation(f.service,f.jobs[0],usage);await ready.promise;
  assert.equal(f.jobs[0].dataPreparationHold.state,'INTENT');
  await f.service.enqueue(()=>{f.jobs[0].cancelRequested=true;f.jobs[0].state='CANCELED';});
  reply.resolve();await assert.rejects(work,/lost preparation reply/);
  assert.equal(f.jobs[0].dataPreparationHold.state,'RELEASED');
  assert.equal(f.calls.filter(call=>call.operation==='storage.lease.cancel').length,1);
});

test('terminal preflight failure and legacy early HANDED_OFF still retry lost cancellation replies',async()=>{
  for(const initial of ['HELD','HANDED_OFF']){
    const f=managed(fixture());await advanceDataPreparation(f.service,f.jobs[0],usage);
    const job=f.jobs[0];job.dataPreparationHold.state=initial;job.state='FAILED';
    const spec=structuredClone(job.dataPreparationHold.spec),original=f.service.bridge;
    f.service.bridge=async()=>{throw Error('lost cleanup reply');};
    await assert.rejects(releaseDataPreparation(f.service,job),/lost cleanup reply/);
    assert.equal(job.dataPreparationHold.state,initial);
    f.service.bridge=original;await releaseDataPreparation(f.service,job);
    assert.equal(job.dataPreparationHold.state,'RELEASED');
    assert.deepEqual(f.calls.at(-1).args,{job:spec});
    await releaseDataPreparation(f.service,job);
    assert.equal(f.calls.filter(call=>call.operation==='storage.lease.cancel').length,1);
  }
});

test('nonterminal or unknown submission never invokes prepare cancellation',async()=>{
  const f=managed(fixture());await advanceDataPreparation(f.service,f.jobs[0],usage);
  for(const state of ['SUBMITTING','PENDING','RUNNING','UNKNOWN']){
    f.jobs[0].state=state;await releaseDataPreparation(f.service,f.jobs[0]);
  }
  assert.equal(f.calls.filter(call=>call.operation==='storage.lease.cancel').length,0);
  assert.equal(f.jobs[0].dataPreparationHold.state,'HELD');
});

test('warehouse physical cache is used by the durable hold and runner while public identity stays logical',async t=>{
  const f=managed(fixture()),db=new DatabaseSync(':memory:');t.after(()=>db.close());f.service.db=db;
  const physical={dataset:'private-cache',version:ref.version,mountAs:ref.dataset},bridge=f.service.bridge;
  f.service.bridge=async(machine,operation,args)=>operation==='datasets.status'?{...ref,state:'READY',warehouseReady:true,warehouseCanPrepare:true,storageReference:{dataset:physical.dataset,version:physical.version}}:bridge(machine,operation,args);
  installDatasetReplication(f.service);await advanceDataPreparation(f.service,f.jobs[0],usage);
  const job=f.jobs[0];assert.equal(job.state,'SUBMITTING');assert.deepEqual(job.datasets,[ref]);assert.deepEqual(job.spec.datasets,[physical]);
  assert.deepEqual(job.dataPreparationHold.spec.datasets,[physical]);
  assert.deepEqual(f.calls.find(call=>call.operation==='storage.lease.prepare').args.job.datasets,[physical]);
  assert.equal(job.dataPreparationHold.state,'HELD');assert.doesNotMatch(JSON.stringify(publicJob(job)),/private-cache|storageReference/);
  job.state='CANCELED';await releaseDataPreparation(f.service,job);
  assert.deepEqual(f.calls.find(call=>call.operation==='storage.lease.cancel').args.job.datasets,[physical]);
});
test('missing warehouse binding cannot promote a preparation or reserve GPUs',async t=>{
  const f=managed(fixture()),db=new DatabaseSync(':memory:');t.after(()=>db.close());f.service.db=db;
  f.service.bridge=async()=>({...ref,state:'READY',warehouseReady:true});installDatasetReplication(f.service);
  await assert.rejects(advanceDataPreparation(f.service,f.jobs[0],usage),e=>e.code==='WAREHOUSE_REFERENCE_INVALID');
  assert.equal(f.jobs[0].state,DATA_PREPARING);assert.equal(usage(f.jobs,f.user.id),0);assert.equal(f.jobs[0].dataPreparationHold,undefined);
});


test('profile and approval revisions do not fail an authorized data preparation',async()=>{
  for(const change of [u=>u.name='Renamed',u=>u.approvalNote='Updated',u=>u.policyVersion++]){
    const f=fixture(),entered=deferred(),response=deferred();
    f.service.bridge=async()=>{entered.resolve();return response.promise;};
    const work=advanceDataPreparation(f.service,f.jobs[0],usage);await entered.promise;
    await f.service.enqueue(()=>change(f.user));response.resolve({...ref,state:'READY'});await work;
    assert.equal(f.jobs[0].state,'SUBMITTING');assert.equal(usage(f.jobs,f.user.id),1);
  }
});
