import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage,publicJob,SUBMISSION_SAFE_WINDOW_MS} from '../execution.mjs';
import {advanceDataPreparation} from '../dataset-preparation.mjs';
import {trainingPlan,trainingSource,projectFootprint} from './training-storage-fixture.mjs';

const machine=MACHINES[0].id,nodeId='J0123456789ab',ref={dataset:'sample',version:'a'.repeat(64)};
const password='Submission-Recovery-Fixture-Only-2026!';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'submission-recovery-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  let handler;const calls=[],service=await PortalService.open(join(dir,'db'),bootstrap,status,async(target,op,args)=>{
    calls.push({machine:target,op,args:structuredClone(args)});
    return handler?handler(target,op,args):{state:'PENDING',nodeJobId:nodeId};
  });
  for(const name of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[name]);
  service.reconciling=true;
  const user=service.store.users[0];Object.assign(user,{role:'member',limits:{[machine]:1},total:1});
  const token=service.issueSession({userId:user.id,username:user.username,role:user.role});
  const request={machine,cards:1,argv:['true'],key:randomUUID()};
  const submit=extra=>service.invoke(token,'jobs.submit',{...request,...extra});
  const start=()=>{service.reconciling=false;return service.reconcile();};
  const original=async()=>{const {result}=await submit();const job=service.store.jobs.find(j=>j.id===result.id);
    Object.assign(job,{dispatchPending:false,dispatchFinishedAt:new Date(Date.now()-SUBMISSION_SAFE_WINDOW_MS-1000).toISOString(),
      error:'节点操作结果未确认，请稍后查询原状态；不会自动重试。'});service.save();calls.length=0;return job;};
  t.after(async()=>{await service.tail;service.close();await rm(dir,{recursive:true,force:true});});
  return {service,user,token,request,calls,submit,start,original,setHandler:fn=>handler=fn};
}
const absent=job=>({state:'PENDING',schedulerState:'NOT_SUBMITTED',nodeJobId:null,latestAttempt:null,
  dispatchObservation:{protocol:'job-dispatch-observation-v1',jobId:job.id,userId:job.userId,submitKey:job.id,
    state:'NOT_SUBMITTED',requestFinished:true,observedAt:Date.now()/1000}});

test('uncertain submissions automatically read the original UUID, adopt its native state and clear error',async t=>{
  const f=await fixture(t),job=await f.original();f.setHandler(()=>({nodeJobId:nodeId,state:'RUNNING',assignedIndices:[0]}));
  await f.start();assert.equal(job.state,'RUNNING');assert.equal(job.error,null);
  assert.deepEqual(f.calls,[{machine,op:'watch',args:{job:job.spec}}]);assert.equal(f.service.store.jobs.length,1);
});
test('legacy PENDING/NOT_SUBMITTED placeholders are not admissions or permission to replay',async t=>{
  const f=await fixture(t),job=await f.original();f.setHandler(()=>({state:'PENDING',schedulerState:'NOT_SUBMITTED',nodeJobId:null}));
  await f.start();assert.equal(job.state,'SUBMITTING');assert.equal(publicJob(job).canRetryDispatch,false);
  assert.equal(job.error,'正在确认节点状态（自动重查中）');
  for(let n=0;n<10;n++)await f.service.reconcile();
  assert.equal(f.calls.length,1,'bounded backoff suppresses duplicate reads');assert.equal(usage(f.service.store.jobs,f.user.id),1);
});
test('a definite pre-dispatch data rejection ends the same UUID and releases quota without another sync',async t=>{
  const f=await fixture(t),job=await f.original();
  f.setHandler(()=>({state:'FAILED',notSubmitted:true,failureCode:'DATASET_NOT_READY',assignedIndices:[],error:'数据副本在提交前已失效，未启动训练。'}));
  await f.start();assert.equal(job.state,'FAILED');assert.equal(job.notSubmitted,true);
  assert.equal(job.failureCode,'DATASET_NOT_READY');assert.equal(usage([job],f.user.id),0);
  assert.ok(job.finishedAt);assert.equal(job.submissionReconciliation,undefined);
  assert.deepEqual(f.calls.map(c=>c.op),['watch']);assert.equal(f.service.store.jobs.length,1);
});
test('safe confirmed absence permits one explicit same-key same-UUID dispatch, with no second job',async t=>{
  const f=await fixture(t),job=await f.original();f.setHandler(()=>absent(job));await f.start();
  assert.equal(publicJob(job).submissionState,'NOT_DISPATCHED');assert.equal(publicJob(job).canRetryDispatch,true);
  f.service.reconciling=true;const spec=structuredClone(job.spec),reply=await f.submit();
  assert.equal(reply.result.id,job.id);assert.equal(job.dispatchPending,true);assert.deepEqual(job.spec,spec);
  assert.equal(job.submissionReconciliation.retryUsed,true);f.setHandler(()=>({state:'PENDING',nodeJobId:nodeId}));
  await f.start();assert.equal(job.state,'PENDING');assert.equal(f.calls.filter(c=>c.op==='sync').length,1);
  await f.submit();assert.equal(f.calls.filter(c=>c.op==='sync').length,1);assert.equal(f.service.store.jobs.length,1);
});
for(const change of ['fresh','wrong-owner','request-running','stale-proof'])test('absence cannot replay while '+change,async t=>{
  const f=await fixture(t),job=await f.original();
  if(change==='fresh')job.dispatchFinishedAt=new Date().toISOString();
  f.setHandler(()=>{const result=absent(job);
    if(change==='wrong-owner')result.dispatchObservation.userId='other';
    if(change==='request-running')result.dispatchObservation.requestFinished=false;
    if(change==='stale-proof')result.dispatchObservation.observedAt-=60;
    return result;
  });
  await f.start();assert.equal(publicJob(job).canRetryDispatch,false);assert.ok(f.calls.every(c=>c.op==='watch'));
});
test('revocation prevents an otherwise confirmed same-key recovery from dispatching',async t=>{
  const f=await fixture(t),job=await f.original();f.setHandler(()=>absent(job));await f.start();
  f.user.limits={};await assert.rejects(f.submit(),e=>e.status===403);assert.ok(f.calls.every(c=>c.op==='watch'));
});

function dataHandler(f,{busy=false,forbidden=false,availableBytes=2**40}={}){
  return (target,op,args)=>{
    if(op==='projects.verify')return {...args,state:'READY'};
    if(op==='projects.copy.probe')return {...args,...projectFootprint,protocol:'portable-project-v1',enabled:true,
      environmentMode:'oci',releaseReady:true,image:'sha256:'+'b'.repeat(64),architecture:'amd64',sources:[]};
    if(op==='datasets.training.status'){
      if(forbidden)throw Object.assign(Error('dataset owner authorization required'),{status:403});
      if(busy)throw Object.assign(Error('metadata unconfirmed'),{code:'NOT_READY',status:503});
      return trainingSource(target,args);
    }
    if(op==='datasets.list')return {datasets:[{dataset:ref.dataset,ownerIds:[forbidden?'other':f.user.id],versions:[{version:ref.version,state:'REGISTERED'}]}]};
    if(op==='storage.training.plan')return trainingPlan(target,args,{availableBytes});
    if(op==='storage.lease.prepare')return {jobId:args.job.id,state:'HELD'};
    if(op==='sync')return {state:'PENDING',nodeJobId:nodeId};
    if(op==='storage.lease.cancel')return {jobId:args.job.id,state:'CANCELED',released:true};
    throw Error('Unexpected RPC '+op);
  };
}
test('authorized warehouse read failures reserve the key and UUID, then resume when data and capacity are ready',async t=>{
  const f=await fixture(t);f.setHandler(dataHandler(f,{busy:true}));
  const options={datasets:[ref],datasetReadMode:'warehouse',project:'paper',release:'c'.repeat(64)},first=await f.submit(options),job=f.service.store.jobs[0];
  assert.equal(first.result.state,'PREPARING_DATA');assert.equal(first.result.id,job.id);assert.equal(usage([job],f.user.id),0);
  const durable=JSON.parse(f.service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data).jobs[0];
  assert.equal(durable.key,f.request.key);assert.equal(durable.id,job.id);assert.ok(f.calls.every(c=>c.op!=='sync'));
  const count=f.calls.length;assert.equal((await f.submit(options)).result.id,job.id);assert.equal(f.calls.length,count);
  await advanceDataPreparation(f.service,job,usage);assert.equal(job.state,'PREPARING_DATA');assert.equal(job.error,null);
  f.setHandler(dataHandler(f));await advanceDataPreparation(f.service,job,usage);
  assert.equal(job.state,'SUBMITTING');assert.equal(job.dataPreparationHold.state,'HELD');
  await f.start();assert.equal(job.state,'PENDING');assert.equal(f.calls.filter(c=>c.op==='sync').length,1);
  assert.equal(f.service.store.jobs.length,1);assert.equal(job.key,f.request.key);
});
test('owner denial never reserves a waiting UUID or makes a node write',async t=>{
  const f=await fixture(t);f.setHandler(dataHandler(f,{forbidden:true}));
  await assert.rejects(f.submit({datasets:[ref],datasetReadMode:'warehouse',project:'paper',release:'c'.repeat(64)}),e=>e.status===403);
  assert.equal(f.service.store.jobs.length,0);assert.ok(f.calls.every(c=>!['sync','datasets.prepare','storage.lease.prepare'].includes(c.op)));
});
test('an unavailable authorization list is a safe 503 with no waiting job or leaked transport detail',async t=>{
  const f=await fixture(t),normal=dataHandler(f,{busy:true});
  f.setHandler((target,op,args)=>{if(op==='datasets.list')throw Error('/private/node?token=secret');return normal(target,op,args);});
  await assert.rejects(f.submit({datasets:[ref],datasetReadMode:'warehouse',project:'paper',release:'c'.repeat(64)}),
    error=>error.status===503&&error.message==='数据集读取授权暂未确认。');
  assert.equal(f.service.store.jobs.length,0);assert.ok(f.calls.every(c=>!['sync','datasets.prepare','storage.lease.prepare'].includes(c.op)));
});
test('a deferred admission fails on a real capacity shortage, without scheduler dispatch',async t=>{
  const f=await fixture(t);f.setHandler(dataHandler(f,{busy:true}));await f.submit({datasets:[ref],datasetReadMode:'warehouse',project:'paper',release:'c'.repeat(64)});
  const job=f.service.store.jobs[0];f.setHandler(dataHandler(f,{availableBytes:0}));await advanceDataPreparation(f.service,job,usage);
  assert.equal(job.state,'FAILED');assert.match(job.error,/容量不足/);assert.equal(usage([job],f.user.id),0);
  assert.ok(f.calls.every(c=>c.op!=='sync'));
});

test('known data authorization with unknown capacity is accepted and waits without a GPU or data write',async t=>{
  const f=await fixture(t),normal=dataHandler(f);
  f.setHandler((target,op,args)=>{if(op==='storage.training.plan')throw Object.assign(Error('capacity read pending'),{status:503});return normal(target,op,args);});
  const reply=await f.submit({datasets:[ref],datasetReadMode:'warehouse',project:'paper',release:'c'.repeat(64)});
  assert.equal(reply.result.state,'PREPARING_DATA');assert.equal(usage(f.service.store.jobs,f.user.id),0);
  assert.ok(f.calls.every(c=>!['sync','datasets.prepare','storage.lease.prepare'].includes(c.op)));
  f.setHandler(normal);await advanceDataPreparation(f.service,f.service.store.jobs[0],usage);
  assert.equal(f.service.store.jobs[0].state,'SUBMITTING');assert.equal(f.service.store.jobs[0].id,reply.result.id);
});
test('a visible version owned by someone else cannot authorize waiting admission after a failed read',async t=>{
  const f=await fixture(t),normal=dataHandler(f,{busy:true});
  f.setHandler((target,op,args)=>op==='datasets.list'?{datasets:[{dataset:ref.dataset,ownerIds:['other'],versions:[{version:ref.version}]}]}:normal(target,op,args));
  await assert.rejects(f.submit({datasets:[ref],datasetReadMode:'warehouse',project:'paper',release:'c'.repeat(64)}),e=>e.status===403);
  assert.equal(f.service.store.jobs.length,0);assert.ok(f.calls.every(c=>c.args.hostAdmin!==true));
});
test('revoked waiting admission fails before reading or dispatching',async t=>{
  const f=await fixture(t);f.setHandler(dataHandler(f,{busy:true}));
  await f.submit({datasets:[ref],datasetReadMode:'warehouse',project:'paper',release:'c'.repeat(64)});
  const job=f.service.store.jobs[0],count=f.calls.length;f.user.limits={};
  await advanceDataPreparation(f.service,job,usage);assert.equal(job.state,'FAILED');assert.match(job.error,/授权/);
  assert.equal(f.calls.length,count);assert.equal(usage([job],f.user.id),0);
});
test('one lost recovery reply cannot authorize a second replay of the same original UUID',async t=>{
  const f=await fixture(t),job=await f.original();f.setHandler(()=>absent(job));await f.start();
  f.service.reconciling=true;await f.submit();f.setHandler(()=>{throw Object.assign(Error('lost ACK'),{code:'EXECUTOR_TIMEOUT',status:504});});
  await f.start();assert.equal(f.calls.filter(c=>c.op==='sync').length,1);
  job.dispatchFinishedAt=new Date(Date.now()-SUBMISSION_SAFE_WINDOW_MS-1000).toISOString();job.submissionReconciliation.nextCheckAt=new Date(0).toISOString();
  f.setHandler(()=>absent(job));await f.service.reconcile();assert.equal(publicJob(job).canRetryDispatch,false);
  await f.submit();assert.equal(f.calls.filter(c=>c.op==='sync').length,1);assert.equal(f.service.store.jobs.length,1);
});
