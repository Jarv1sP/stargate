import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage,publicJob,SUBMISSION_SAFE_WINDOW_MS} from '../execution.mjs';

const machine=MACHINES[0].id,nodeId='J0123456789ab';
const workspace=project=>({project,state:'AVAILABLE',workspace:{protocol:1,persistent:true}});
const password='Submission-Recovery-Fixture-Only-2026!';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'submission-recovery-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  let handler;const calls=[],service=await PortalService.open(join(dir,'db'),bootstrap,status,async(target,op,args)=>{
    calls.push({machine:target,op,args:structuredClone(args)});
    if(handler)return handler(target,op,args);
    if(op==='projects.workspace')return workspace(args.project);
    throw Error('Unexpected RPC '+op);
  });
  for(const name of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[name]);
  service.reconciling=true;
  const user=service.store.users[0];Object.assign(user,{role:'member',limits:{[machine]:1},total:1});
  const token=service.issueSession({userId:user.id,username:user.username,role:user.role});
  const request={machine,project:'paper',cards:1,argv:['true'],key:randomUUID()};
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
test('safe confirmed absence automatically dispatches the original UUID without a user retry',async t=>{
  const f=await fixture(t),job=await f.original(),spec=structuredClone(job.spec),key=job.key,digest=job.digest;
  // Legacy retryUsed must not permanently strand a confirmed absent task.
  job.submissionReconciliation={retryUsed:true,attempts:109};
  f.setHandler((_target,op)=>op==='watch'?absent(job):{state:'PENDING',nodeJobId:nodeId});await f.start();
  assert.equal(job.state,'PENDING');assert.deepEqual(f.calls.map(c=>c.op),['watch','sync']);
  assert.deepEqual(f.calls[1].args.job.id,job.id);assert.deepEqual(job.spec,spec);
  assert.equal(job.key,key);assert.equal(job.digest,digest);
  assert.equal((await f.submit()).result.id,job.id);assert.equal(f.calls.filter(c=>c.op==='sync').length,1);
  assert.equal(f.service.store.jobs.length,1);
});
for(const change of ['fresh','recent-attempt','wrong-owner','request-running','stale-proof'])test('absence cannot replay while '+change,async t=>{
  const f=await fixture(t),job=await f.original();
  if(change==='fresh')job.dispatchFinishedAt=new Date().toISOString();
  if(change==='recent-attempt')job.dispatchStartedAt=new Date().toISOString();
  f.setHandler(()=>{const result=absent(job);
    if(change==='wrong-owner')result.dispatchObservation.userId='other';
    if(change==='request-running')result.dispatchObservation.requestFinished=false;
    if(change==='stale-proof')result.dispatchObservation.observedAt-=60;
    return result;
  });
  await f.start();assert.equal(publicJob(job).canRetryDispatch,false);assert.ok(f.calls.every(c=>c.op==='watch'));
});
test('revocation prevents an otherwise confirmed same-key recovery from dispatching',async t=>{
  const f=await fixture(t),job=await f.original();f.setHandler(()=>{f.user.limits={};return absent(job);});await f.start();
  assert.equal(job.state,'FAILED');assert.equal(job.notSubmitted,true);assert.match(job.error,/授权已改变/);
  assert.equal(usage([job],f.user.id),0);assert.ok(f.calls.every(c=>c.op==='watch'));
  assert.equal((await f.submit()).result.state,'FAILED');assert.ok(f.calls.every(c=>c.op==='watch'));
});

// New tasks use the existing workspace. Historical storage-admission code is
// not reached by jobs.submit; never restore that retired workflow in fixtures.
for(const extra of [{release:'c'.repeat(64)}, {datasets:[{dataset:'sample',version:'a'.repeat(64)}]},
  {datasetReadMode:'warehouse'}, {prepareData:true}])test('retired new-submission field is rejected before any RPC: '+Object.keys(extra)[0],async t=>{
  const f=await fixture(t);
  await assert.rejects(f.submit(extra),e=>e.status===400&&/提交参数/.test(e.message));
  assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.user.id),0);
  assert.deepEqual(f.calls,[]);
});
test('workspace admission persists the original key and UUID without data preparation or capacity RPCs',async t=>{
  const f=await fixture(t),first=await f.submit(),job=f.service.store.jobs[0];
  assert.equal(first.result.state,'SUBMITTING');assert.equal(first.result.id,job.id);assert.equal(usage([job],f.user.id),1);
  assert.equal(job.spec.workspace,true);assert.equal(Object.hasOwn(job.spec,'release'),false);
  assert.equal(Object.hasOwn(job.spec,'datasets'),false);assert.equal(Object.hasOwn(job,'dataPreparationHold'),false);
  const durable=JSON.parse(f.service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data).jobs[0];
  assert.equal(durable.key,f.request.key);assert.equal(durable.id,job.id);assert.equal(durable.dispatchPending,true);
  assert.deepEqual(f.calls,[{machine,op:'projects.workspace',args:{project:'paper',userId:f.user.id}}]);
  const count=f.calls.length;assert.equal((await f.submit()).result.id,job.id);assert.equal(f.calls.length,count);
  f.setHandler((_target,op)=>{assert.equal(op,'sync');return {state:'PENDING',nodeJobId:nodeId};});
  await f.start();assert.equal(job.state,'PENDING');assert.equal(f.calls.filter(c=>c.op==='sync').length,1);
  assert.equal(f.service.store.jobs.length,1);assert.equal(job.key,f.request.key);
});
test('workspace owner denial reserves no task and never falls back to a data catalog or scheduler write',async t=>{
  const f=await fixture(t);
  f.setHandler((_target,op,args)=>{
    assert.equal(op,'projects.workspace');assert.deepEqual(args,{project:'paper',userId:f.user.id});
    throw Object.assign(Error('project owner authorization required'),{status:403});
  });
  await assert.rejects(f.submit(),e=>e.status===403);
  assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.user.id),0);
  assert.deepEqual(f.calls.map(c=>c.op),['projects.workspace']);
});
test('unconfirmed workspace admission reserves no task and can be retried with the same unused key',async t=>{
  const f=await fixture(t);
  f.setHandler(()=>{throw Object.assign(Error('workspace not confirmed'),{status:503,code:'EXECUTOR_UNCONFIRMED'});});
  await assert.rejects(f.submit(),e=>e.status===503&&e.code==='EXECUTOR_UNCONFIRMED');
  assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.user.id),0);
  assert.deepEqual(f.calls.map(c=>c.op),['projects.workspace']);
  f.setHandler(null);const reply=await f.submit();
  assert.equal(reply.result.state,'SUBMITTING');assert.equal(f.service.store.jobs[0].key,f.request.key);
  assert.deepEqual(f.calls.map(c=>c.op),['projects.workspace','projects.workspace']);
});
test('unavailable, mismatched or nonpersistent workspace does not authorize a new task',async t=>{
  const f=await fixture(t);
  for(const reply of [{...workspace('paper'),state:'UNKNOWN'},workspace('other-project'),
    {...workspace('paper'),workspace:{protocol:1,persistent:false}}]){
    f.setHandler(()=>reply);
    await assert.rejects(f.submit(),e=>e.status===409&&e.code==='SUBMISSION_REJECTED');
    assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.user.id),0);
  }
  assert.deepEqual(f.calls.map(c=>c.op),Array(3).fill('projects.workspace'));
});
test('client cannot select another workspace owner or grant itself administrative data access',async t=>{
  const f=await fixture(t);
  for(const extra of [{userId:'other'},{owner:'other'},{hostAdmin:true}])
    await assert.rejects(f.submit(extra),e=>e.status===400);
  assert.equal(f.service.store.jobs.length,0);assert.deepEqual(f.calls,[]);
});
test('revocation after workspace admission prevents first dispatch without acquiring any resource',async t=>{
  const f=await fixture(t);await f.submit();
  const job=f.service.store.jobs[0],count=f.calls.length;f.user.limits={};
  await f.start();assert.equal(job.state,'FAILED');assert.equal(job.notSubmitted,true);
  assert.equal(job.failureCode,'SUBMISSION_AUTH_REVOKED');assert.match(job.error,/授权/);
  assert.equal(f.calls.length,count);assert.equal(usage([job],f.user.id),0);
});
test('a lost recovery reply cannot replay without a fresh authoritative absence',async t=>{
  const f=await fixture(t),job=await f.original();
  f.setHandler((_target,op)=>{if(op==='watch')return absent(job);throw Object.assign(Error('lost ACK'),{code:'EXECUTOR_TIMEOUT',status:504});});
  await f.start();assert.equal(f.calls.filter(c=>c.op==='sync').length,1);
  job.submissionReconciliation.nextCheckAt=new Date(0).toISOString();
  f.setHandler(()=>({state:'PENDING',schedulerState:'NOT_SUBMITTED',nodeJobId:null}));
  await f.service.reconcile();assert.equal(publicJob(job).canRetryDispatch,false);
  await f.submit();assert.equal(f.calls.filter(c=>c.op==='sync').length,1);assert.equal(f.service.store.jobs.length,1);
});
test('first dispatch uses completed admission without repeating lock-sensitive capacity reads',async t=>{
  const f=await fixture(t),first=await f.submit(),job=f.service.store.jobs[0];
  job.trainingStoragePlan={fits:true,checkedAt:new Date(0).toISOString()};
  f.setHandler((_target,op)=>{assert.equal(op,'sync');return {state:'PENDING',nodeJobId:nodeId};});
  await f.start();assert.equal(job.state,'PENDING');assert.equal(job.id,first.result.id);
  assert.deepEqual(f.calls.map(c=>c.op),['projects.workspace','sync']);
});
test('temporary non-dispatch keeps waiting and resumes the same UUID after more than three retries',async t=>{
  const f=await fixture(t),job=await f.original(),spec=structuredClone(job.spec);
  f.setHandler((_target,op)=>{if(op==='watch')return absent(job);throw Object.assign(Error('node refused'),{code:'EXECUTOR_UNCONFIRMED',status:502});});
  for(let n=0;n<4;n++){
    job.dispatchFinishedAt=new Date(Date.now()-SUBMISSION_SAFE_WINDOW_MS-1000).toISOString();
    job.dispatchStartedAt=job.dispatchFinishedAt;
    if(job.submissionReconciliation)job.submissionReconciliation.nextCheckAt=new Date(0).toISOString();
    await f.start();
  }
  assert.equal(f.calls.filter(c=>c.op==='sync').length,4);assert.equal(job.state,'SUBMITTING');
  assert.notEqual(job.notSubmitted,true);assert.equal(usage([job],f.user.id),1);
  job.dispatchFinishedAt=new Date(Date.now()-SUBMISSION_SAFE_WINDOW_MS-1000).toISOString();
  job.dispatchStartedAt=job.dispatchFinishedAt;job.submissionReconciliation.nextCheckAt=new Date(0).toISOString();
  f.setHandler((_target,op)=>op==='watch'?absent(job):{state:'PENDING',nodeJobId:nodeId});
  await f.start();assert.equal(job.state,'PENDING');assert.equal(job.nodeJobId,nodeId);
  assert.equal(f.service.store.jobs.length,1);assert.deepEqual(job.spec,spec);
});
test('same key recovers an old retry-limit failure by observing before dispatch, without a new UUID',async t=>{
  const f=await fixture(t),job=await f.original();
  Object.assign(job,{state:'FAILED',notSubmitted:true,failureCode:'SUBMISSION_NOT_DISPATCHED',finishedAt:new Date().toISOString()});
  const spec=structuredClone(job.spec);f.calls.length=0;
  const response=await f.submit();assert.equal(response.result.id,job.id);assert.equal(job.state,'SUBMITTING');
  assert.equal(job.dispatchPending,false);assert.deepEqual(f.calls,[]);assert.equal(f.service.store.jobs.length,1);
  f.setHandler((_target,op)=>op==='watch'?absent(job):{state:'PENDING',nodeJobId:nodeId});
  await f.start();assert.equal(job.state,'PENDING');assert.deepEqual(f.calls.map(c=>c.op),['watch','sync']);
  assert.deepEqual(job.spec,spec);assert.equal(f.service.store.jobs.length,1);
});
test('an unconfirmed node receipt preserves quota and exposes the reason after the safety window',async t=>{
  const f=await fixture(t),job=await f.original();
  job.dispatchStartedAt=new Date(Date.now()-SUBMISSION_SAFE_WINDOW_MS-1000).toISOString();
  f.setHandler(()=>{throw Object.assign(Error('private transport detail'),{code:'NODE_CONNECT_FAILED',status:503});});
  await f.start();assert.equal(job.state,'SUBMITTING');assert.equal(usage([job],f.user.id),1);
  assert.match(publicJob(job).error,/NODE_CONNECT_FAILED/);assert.doesNotMatch(publicJob(job).error,/private transport/);
  assert.deepEqual(f.calls.map(c=>c.op),['watch']);
});
