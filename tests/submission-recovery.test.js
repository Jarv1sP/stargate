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
const password='Submission-Recovery-Fixture-Only-2026!';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'submission-recovery-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  let handler;const calls=[],service=await PortalService.open(join(dir,'db'),bootstrap,status,async(target,op,args)=>{
    calls.push({machine:target,op,args:structuredClone(args)});
    if(op==='projects.workspace')return {project:args.project,state:'AVAILABLE',workspace:{persistent:true}};
    return handler?handler(target,op,args):{state:'PENDING',nodeJobId:nodeId};
  });
  for(const name of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[name]);
  service.reconciling=true;
  const user=service.store.users[0];service.accounts.db.prepare("UPDATE accounts SET role='member' WHERE id=?").run(user.id);Object.assign(user,{role:'member',limits:{[machine]:1},total:1});
  const token=service.issueSession({userId:user.id,username:user.username,role:user.role});
  const request={machine,project:'sample',cards:1,argv:['true'],key:randomUUID()};
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

test('a definite pre-dispatch refusal ends the same UUID and releases quota without another sync',async t=>{
  const f=await fixture(t),job=await f.original();
  f.setHandler(()=>({state:'FAILED',notSubmitted:true,failureCode:'SUBMISSION_AUTH_REVOKED',assignedIndices:[],error:'数据副本在提交前已失效，未启动训练。'}));
  await f.start();assert.equal(job.state,'FAILED');assert.equal(job.notSubmitted,true);
  assert.equal(job.failureCode,'SUBMISSION_AUTH_REVOKED');assert.equal(usage([job],f.user.id),0);
  assert.ok(job.finishedAt);assert.equal(job.submissionReconciliation,undefined);
  assert.deepEqual(f.calls.map(c=>c.op),['watch']);assert.equal(f.service.store.jobs.length,1);
});
test('safe confirmed absence automatically dispatches the original UUID without a user retry',async t=>{
  const f=await fixture(t),job=await f.original(),spec=structuredClone(job.spec),key=job.key,digest=job.digest;
  f.setHandler((_target,op)=>op==='watch'?absent(job):{state:'PENDING',nodeJobId:nodeId});await f.start();
  assert.equal(job.state,'PENDING');assert.deepEqual(f.calls.map(c=>c.op),['watch','sync']);
  assert.deepEqual(f.calls[1].args.job.id,job.id);assert.deepEqual(job.spec,spec);
  assert.equal(job.key,key);assert.equal(job.digest,digest);
  assert.equal((await f.submit()).result.id,job.id);assert.equal(f.calls.filter(c=>c.op==='sync').length,1);
  assert.equal(f.service.store.jobs.length,1);
});
test('absence cannot replay while a native attempt is active',async t=>{
  const f=await fixture(t),job=await f.original();
  f.setHandler(()=>({...absent(job),latestAttempt:{id:'Aactive',state:'RUNNING'}}));
  await f.start();assert.equal(publicJob(job).canRetryDispatch,false);assert.ok(f.calls.every(c=>c.op==='watch'));
});
test('revocation prevents an otherwise confirmed same-key recovery from dispatching',async t=>{
  const f=await fixture(t),job=await f.original();f.setHandler(()=>{f.user.limits={};return absent(job);});await f.start();
  assert.equal(job.state,'FAILED');assert.equal(job.notSubmitted,true);assert.match(job.error,/授权已改变/);
  assert.equal(usage([job],f.user.id),0);assert.ok(f.calls.every(c=>c.op==='watch'));
  await assert.rejects(f.submit(),error=>error.status===403);assert.ok(f.calls.every(c=>c.op==='watch'));
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
test('an unconfirmed node receipt preserves quota and exposes the reason after the safety window',async t=>{
  const f=await fixture(t),job=await f.original();
  job.dispatchStartedAt=new Date(Date.now()-SUBMISSION_SAFE_WINDOW_MS-1000).toISOString();
  f.setHandler(()=>{throw Object.assign(Error('private transport detail'),{code:'NODE_CONNECT_FAILED',status:503});});
  await f.start();assert.equal(job.state,'SUBMITTING');assert.equal(usage([job],f.user.id),1);
  assert.match(publicJob(job).error,/NODE_CONNECT_FAILED/);assert.doesNotMatch(publicJob(job).error,/private transport/);
  assert.deepEqual(f.calls.map(c=>c.op),['watch']);
});

test('first dispatch uses the current workspace without a Portal storage-preparation read',async t=>{
 const f=await fixture(t),first=await f.submit();assert.deepEqual(f.calls,[]);
 f.setHandler((_target,op)=>{assert.equal(op,'sync');return {state:'PENDING',nodeJobId:nodeId};});
 await f.start();assert.equal(f.service.store.jobs[0].id,first.result.id);assert.equal(f.service.store.jobs[0].state,'PENDING');assert.deepEqual(f.calls.map(row=>row.op),['sync']);
});
