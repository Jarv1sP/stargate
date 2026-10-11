import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PortalService} from '../portal-service.mjs';
import {MACHINES,authorizationPolicy} from '../dist/model.js';
import {DemoClient} from '../dist/client.js';

const machine=MACHINES[0].id,id='11111111-1111-4111-8111-111111111111',nodeId='J0123456789ab';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const operations=['jobs.logs','jobs.watch','jobs.completion','jobs.diagnostics'];
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'authorized-job-read-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Authorized-Read-Fixture-2026!'}));
  const calls=[],service=await PortalService.open(join(dir,'db'),bootstrap,undefined,async(...args)=>{calls.push(args);return reply(args[1]);});
  for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[key]);
  const user=service.store.users[0];Object.assign(user,{role:'member',limits:{[machine]:1},total:1});
  const principal={userId:user.id,username:user.username,role:'member'},token=service.issueSession(principal);
  const job={id,userId:user.id,username:user.username,machine,nodeJobId:nodeId,cards:1,state:'SUCCEEDED',
    spec:{id,userId:user.id,argv:['true']}};service.store.jobs=[job];
  const reply=kind=>kind==='logs'?{text:'confirmed original log'}:kind==='diagnostics'?{jobId:id,logs:[]}:
    {nodeJobId:nodeId,state:'SUCCEEDED',assignedIndices:[]};
  service.state=()=>assert.fail('An observation must not rebuild dashboard');
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  return {service,token,user,job,principal,calls,reply};
}
test('authorization projection ignores display/approval metadata and key order, retaining effective grants and quotas',()=>{
  const account={id:'owner',username:'owner',enabled:true,role:'member',limits:{b:2,a:1},total:2};
  const before=authorizationPolicy(account);
  assert.equal(authorizationPolicy({...account,name:'Changed',approvedAt:'later',approvedBy:'someone',approvalNote:'reviewed',policyVersion:99,limits:{a:1,b:2,ungranted:0}}),before);
  for(const change of [{id:'other'},{username:'other'},{enabled:false},{role:'admin'},{limits:{a:1}},{total:1}])
    assert.notEqual(authorizationPolicy({...account,...change}),before);
});
for(const operation of operations){
  test(operation+' bypasses a stalled mutation queue, with no state rebuild or control RPC',async t=>{
    const f=await fixture(t),blocked=deferred(),write=f.service.enqueue(()=>blocked.promise);
    try{
      const value=await f.service.invoke(f.token,operation,{jobId:id});
      assert.ok(value.result);assert.equal(Object.hasOwn(value,'state'),false);assert.equal(f.service.pending,1);
      assert.deepEqual(f.calls.map(([,kind])=>kind),[operation==='jobs.completion'?'watch':operation.slice(5)]);
      assert.ok(f.calls.every(([target,,args])=>target===machine&&args.job.id===id&&args.job.userId===f.user.id));
    }finally{blocked.resolve();await write;}
  });
  test(operation+' retries one transient node failure using the identical original job',async t=>{
    const f=await fixture(t);let attempts=0;
    f.service.bridge=async(...args)=>{f.calls.push(args);if(!attempts++)throw Object.assign(Error('connection reset'),{code:'NODE_CONNECT_FAILED',status:503});return f.reply(args[1]);};
    const value=await f.service.invoke(f.token,operation,{jobId:id});assert.ok(value.result);
    assert.equal(attempts,2);assert.deepEqual(f.calls[0].slice(0,3),f.calls[1].slice(0,3));
    assert.ok(f.calls.every(args=>args[3].rpcTimeoutMs<=27000&&args[3].signal instanceof AbortSignal));
    assert.equal(f.service.jobReadPending,0);
  });
  test(operation+' allows a display-name/approval change while its node read is pending',async t=>{
    const f=await fixture(t),started=deferred(),blocked=deferred();
    f.service.bridge=async(...args)=>{started.resolve();await blocked.promise;return f.reply(args[1]);};
    const pending=f.service.invoke(f.token,operation,{jobId:id});await started.promise;
    Object.assign(f.user,{name:'Renamed',approvedBy:'reviewer',approvalNote:'Updated',policyVersion:2});
    f.job.progressCheckedAt=new Date().toISOString();f.job.name='New display';
    blocked.resolve();assert.ok((await pending).result);
  });
}
for(const change of ['machine','disabled','role','logout','owner'])test('job reads reject '+change+' before exposing bytes or retrying',async t=>{
  const f=await fixture(t),started=deferred(),blocked=deferred();let attempts=0;
  f.service.bridge=async()=>{attempts++;started.resolve();await blocked.promise;throw Object.assign(Error('PRIVATE old account'),{code:'NODE_CONNECT_FAILED',status:503});};
  const pending=f.service.invoke(f.token,'jobs.logs',{jobId:id});await started.promise;
  if(change==='machine')f.user.limits={};if(change==='disabled')f.user.enabled=false;if(change==='role')f.user.role='admin';
  if(change==='logout')f.service.revokeSession(f.token);if(change==='owner')f.job.userId='other';
  blocked.resolve();await assert.rejects(pending,e=>[401,403].includes(e.status)&&!e.message.includes('PRIVATE'));
  assert.equal(attempts,1);assert.equal(f.service.jobReadPending,0);
});
test('foreign or ungranted jobs are refused before any bridge request',async t=>{
  const f=await fixture(t);f.job.userId='other';
  for(const operation of operations)await assert.rejects(f.service.invoke(f.token,operation,{jobId:id}),e=>e.status===403);
  f.job.userId=f.user.id;f.user.limits={};
  for(const operation of operations)await assert.rejects(f.service.invoke(f.token,operation,{jobId:id}),e=>e.status===403);
  assert.deepEqual(f.calls,[]);
});
test('state ignores approval metadata updated during local collector reading',async t=>{
  const f=await fixture(t),started=deferred(),blocked=deferred();f.service.state=()=>({jobs:[]});
  f.service.refreshGPUQ=async()=>{started.resolve();await blocked.promise;};
  const pending=f.service.invoke(f.token,'state');await started.promise;f.user.name='Changed';f.user.approvalNote='Changed';blocked.resolve();
  assert.deepEqual((await pending).state,{jobs:[]});
});
test('project status uses the same narrowed authorization across its nested read checks',async t=>{
  const f=await fixture(t),started=deferred(),blocked=deferred();f.service.state=()=>({});
  f.service.bridge=async()=>{started.resolve();await blocked.promise;return {project:'paper',state:'READY',release:'a'.repeat(64)};};
  const pending=f.service.invoke(f.token,'projects.status',{machine,project:'paper'});await started.promise;f.user.name='Changed';f.user.policyVersion++;blocked.resolve();
  assert.equal((await pending).result.state,'READY');
});
test('browser retries job observation network failures once and never replays writes or authorization failures',async()=>{
  for(const operation of operations){
    const client=new DemoClient();client.remote=true;let count=0;
    client.transport=async()=>{if(!count++)throw new TypeError('offline');return {result:{text:'retained'}};};
    assert.equal((await client.invoke(operation,{jobId:id},'original-token')).result.text,'retained');assert.equal(count,2);
  }
  for(const [operation,error] of [['jobs.cancel',new TypeError('offline')],['jobs.logs',Object.assign(Error('forbidden'),{status:403})]]){
    const client=new DemoClient();client.remote=true;let count=0;client.transport=async()=>{count++;throw error;};
    await assert.rejects(client.invoke(operation,{jobId:id},'token'),e=>e===error);assert.equal(count,1);
  }
});
test('browser cancellation or account change suppresses an automatic recheck',async()=>{
  for(const change of ['account','cancel']){
    const client=new DemoClient(),controller=new AbortController();client.remote=true;let count=0;
    client.transport=async()=>{count++;if(change==='account')client.authGeneration++;else controller.abort();throw new TypeError('offline');};
    await assert.rejects(client.invoke('jobs.logs',{jobId:id},'token',{signal:controller.signal}),/offline/);assert.equal(count,1);
  }
});
