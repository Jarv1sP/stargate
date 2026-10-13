import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {MACHINES} from '../dist/model.js';
import {installTransfers} from '../transfers.mjs';
import {bindTrainingPreparation,prepareTrainingDataset,cancelTrainingPreparations,trainingPreparationCall} from '../training-preparation.mjs';
import {publicJob,usage,installExecution} from '../execution.mjs';
import {trainingPlan,trainingSource} from './training-storage-fixture.mjs';

const from=MACHINES[0].id,machine=MACHINES[1].id,ref={dataset:'sample',version:'a'.repeat(64)};
function fixture(t){
  const db=new DatabaseSync(':memory:'),calls=[],nodes=new Map(),user={id:'demo-user-1',username:'alice',name:'Alice',role:'member',enabled:true,total:2,limits:{[from]:2,[machine]:2}};
  const request={userId:user.id,hostAdmin:false,datasets:[ref],datasetReadMode:'cache',projectFootprint:null,
    datasetFootprints:[{...ref,bytes:30,files:2,directories:0,manifestBytes:100}]};
  const spec={id:randomUUID(),userId:user.id,username:user.username,cards:1,argv:['python','train.py'],name:'training',minVramGiB:0,datasets:[ref]};
  const job={id:spec.id,userId:user.id,machine,cards:1,digest:'fixed',spec,datasets:[ref],state:'PREPARING_DATA',dispatchPending:true,
    trainingStoragePlan:trainingPlan(machine,request),trainingStorageRequest:request};
  let tail=Promise.resolve(),saves=0;
  const service={db,store:{jobs:[job],users:[user],get:id=>{assert.equal(id,user.id);return structuredClone(user);}},audit(){},
    enqueue(fn){const result=tail.then(fn);tail=result.catch(()=>{});return result;},save(){saves++;if(service.saveFailure)throw Error('disk');},
    maintenanceFor:()=>false,refreshGPUQ:async()=>{},gpuq:{stale:false,hosts:[{id:machine,reachable:true,gpuq:{connected:true,observeOnly:false}}]},
    bridge:async(host,operation,args)=>{
      calls.push({host,operation,args:structuredClone(args),saves});
      if(operation==='datasets.training.status')return trainingSource(host,args,{state:'REGISTERED',bytes:30,files:2});
      if(operation==='storage.training.plan')return trainingPlan(host,args,{availableBytes:service.full?1:2**40});
      if(operation==='datasets.status')return {...ref,state:'REGISTERED'};
      if(operation==='transfers.source.prepare')return {id:args.id,token:'x'.repeat(43),state:'READY',manifestBytes:100,manifestSha256:ref.version,totalBytes:30,entries:2};
      if(operation==='transfers.release-source')return {id:args.id,released:true};
      if(operation!=='storage.training.prepare')throw Error('unexpected legacy write '+operation);
      assert.ok(job.trainingPreparations.some(value=>JSON.stringify(value)===JSON.stringify(Object.fromEntries(['job','planRequest','preparation'].map(key=>[key,args[key]])))),'durable context precedes RPC');
      if(args.operation==='datasets.prepare')return {...ref,state:service.ready?'READY':'PREPARING',operationId:'b'.repeat(64)};
      if(args.operation==='datasets.cancel')return {...ref,state:service.cancelUnknown?'UNKNOWN':'CANCELED',confirmedStopped:!service.cancelUnknown};
      if(args.operation==='transfers.start'){nodes.set(args.args.id,{id:args.args.id,state:'RUNNING'});if(service.lose){service.lose=false;throw Error('ACK lost');}return nodes.get(args.args.id);}
      if(args.operation==='transfers.status')return nodes.get(args.args.id)||{id:args.args.id,state:'UNKNOWN'};
      if(args.operation==='transfers.cancel'){nodes.set(args.args.id,{id:args.args.id,state:'CANCELED'});return nodes.get(args.args.id);}
      if(args.operation==='transfers.confirm-source-release')return {schema:1,id:args.args.id,userId:user.id,sourceMachine:from,targetMachine:machine,
        reference:{kind:'datasets',...ref},manifestSha256:ref.version,attempt:1,state:'CANCELED',confirmedStopped:true};
      throw Error('unknown private operation');
    }};
  installTransfers(service);t.after(()=>{clearInterval(service.transferTimer);db.close();});
  return {service,user,job,calls,nodes,request,principal:{userId:user.id,username:user.username,role:'member'},copy:{key:randomUUID(),kind:'copy',from,machine,...ref,name:'replica'}};
}

test('local binding is durable before RPC, immutable and private; no legacy prepare',async t=>{
  const f=fixture(t);
  await prepareTrainingDataset(f.service,f.job.id,ref,ref);
  const original=structuredClone(f.job.trainingPreparations[0]);
  await prepareTrainingDataset(f.service,f.job.id,ref,ref);
  assert.deepEqual(f.job.trainingPreparations,[original]);
  assert.equal(f.calls.filter(c=>c.operation==='storage.training.prepare').length,2);
  for(const key of ['trainingPreparations','trainingStorageRequest','trainingStoragePlan'])assert.equal(Object.hasOwn(publicJob(f.job),key),false);
  await assert.rejects(bindTrainingPreparation(f.service,f.job.id,{kind:'dataset',sourceMachine:machine,logicalReference:ref,reference:{...ref,dataset:'changed'}}));
});
test('persistence failure, invalid owner/mode/version and old job do zero RPC',async t=>{
  const f=fixture(t);f.service.saveFailure=true;
  await assert.rejects(prepareTrainingDataset(f.service,f.job.id,ref,ref));assert.equal(f.calls.length,0);assert.equal(f.job.trainingPreparations,undefined);
  f.service.saveFailure=false;delete f.job.trainingStoragePlan;
  await assert.rejects(prepareTrainingDataset(f.service,f.job.id,ref,ref));assert.equal(f.calls.length,0);
});
test('marked transfer lost ACK follows original ID through status/cancel/source stop proof, never old worker',async t=>{
  const f=fixture(t);f.service.lose=true;
  const first=await f.service.trainingTransferCall(f.principal,f.copy,{jobId:f.job.id,logicalReference:ref});
  assert.equal(first.state,'UNKNOWN');assert.equal(Object.hasOwn(first,'trainingPreparation'),false);
  const again=await f.service.trainingTransferCall(f.principal,f.copy,{jobId:f.job.id,logicalReference:ref});
  assert.equal(again.id,first.id);assert.equal(again.state,'RUNNING');
  assert.equal(f.calls.filter(c=>c.args.operation==='transfers.start').length,1);
  assert.equal(f.calls.filter(c=>c.operation==='transfers.source.prepare').length,1);
  f.job.cancelRequested=true;f.job.state='CANCELED';await cancelTrainingPreparations(f.service,f.job);
  const privateOps=f.calls.filter(c=>c.operation==='storage.training.prepare').map(c=>c.args.operation);
  assert.deepEqual(privateOps,['transfers.start','transfers.status','transfers.cancel','transfers.confirm-source-release']);
  assert.equal(f.calls.filter(c=>['transfers.start','transfers.cancel','transfers.status','datasets.prepare'].includes(c.operation)).length,0);
});
test('legacy transfer cannot be upgraded and a caller cannot inject a public training flag',async t=>{
  const f=fixture(t);
  // Original public fields reject a cohort/admission option before any node I/O.
  await assert.rejects(f.service.transferCall(f.principal,'transfers.create',{...f.copy,trainingJobId:f.job.id}));
  assert.equal(f.calls.length,0);
  const id=randomUUID(),now=Date.now(),payload={kind:'copy',machine,reference:{kind:'datasets',...ref},from,timeoutSec:86400,name:'replica'};
  const hash=(await import('node:crypto')).createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  f.service.db.prepare('INSERT INTO transfers(id,owner_id,client_key,digest,state,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,f.user.id,f.copy.key,hash,'UNKNOWN',now,now,JSON.stringify({...payload,owner:{id:f.user.id},sourceRelease:{protocol:1,state:'UNCONFIRMED'}}));
  await assert.rejects(f.service.trainingTransferCall(f.principal,f.copy,{jobId:f.job.id,logicalReference:ref}));assert.equal(f.calls.length,0);
});
test('historical worker cancellation requires actual stop confirmation and cannot restart preparation',async t=>{
  const f=fixture(t);
  f.job.trainingPreparations=[{job:structuredClone(f.job.spec),planRequest:structuredClone(f.request),preparation:{
    protocol:1,id:randomUUID(),kind:'dataset',sourceMachine:machine,targetMachine:machine,logicalReference:ref,reference:ref,
  }}];
  f.job.state='CANCELED';f.job.cancelRequested=true;f.service.cancelUnknown=true;
  await assert.rejects(cancelTrainingPreparations(f.service,f.job),/停止尚未确认/);
  const calls=f.calls.length;
  await assert.rejects(trainingPreparationCall(f.service,f.job.trainingPreparations[0],'datasets.prepare',{userId:f.user.id,hostAdmin:false,...ref}));
  assert.equal(f.calls.length,calls,'a canceled historical task cannot start another preparation');
  f.service.cancelUnknown=false;await cancelTrainingPreparations(f.service,f.job);
  assert.deepEqual(f.calls.map(c=>c.args.operation),['datasets.cancel','datasets.cancel']);
  assert.deepEqual(f.calls[0].args,f.calls[1].args);
});
test('historical preparation never resumes or promotes even when data and storage become READY',async t=>{
  const f=fixture(t);
  f.service.ready=true;const before=structuredClone(f.job);
  installExecution(f.service,f.service.bridge);clearInterval(f.service.executionTimer);
  for(let n=0;n<3;n++)await f.service.reconcile();
  assert.deepEqual(f.job,before);assert.deepEqual(f.calls,[]);assert.equal(usage([f.job],f.user.id),0);
  assert.match(publicJob(f.job).queueReason,/取消.*重新提交/);
});
test('lost or null transfer context cannot downgrade a durable marked intent to legacy',async t=>{
  for(const marker of ['missing','null']){
    const f=fixture(t);
    const value=await f.service.trainingTransferCall(f.principal,f.copy,{jobId:f.job.id,logicalReference:ref});
    const row=f.service.db.prepare('SELECT data FROM transfers WHERE id=?').get(value.id),data=JSON.parse(row.data);
    if(marker==='missing')delete data.trainingPreparation;else data.trainingPreparation=null;
    f.service.db.prepare('UPDATE transfers SET data=? WHERE id=?').run(JSON.stringify(data),value.id);
    f.calls.length=0;
    assert.equal((await f.service.transferCall(f.principal,'transfers.status',{id:value.id})).state,'UNKNOWN');
    assert.equal(f.calls.length,0,'missing context must never send a legacy target request');
  }
});
test('lost training context and unavailable job registry cannot be guessed legacy',async t=>{
  for(const registry of ['missing','null']){
    const f=fixture(t);
    const value=await f.service.trainingTransferCall(f.principal,f.copy,{jobId:f.job.id,logicalReference:ref});
    const row=f.service.db.prepare('SELECT data FROM transfers WHERE id=?').get(value.id),data=JSON.parse(row.data);
    delete data.trainingPreparation;
    f.service.db.prepare('UPDATE transfers SET data=? WHERE id=?').run(JSON.stringify(data),value.id);
    if(registry==='missing')delete f.service.store.jobs;else f.service.store.jobs=null;
    f.calls.length=0;
    assert.equal((await f.service.transferCall(f.principal,'transfers.status',{id:value.id})).state,'UNKNOWN');
    assert.equal(f.calls.length,0,'unavailable registry cannot authorize a legacy target request');
  }
});
