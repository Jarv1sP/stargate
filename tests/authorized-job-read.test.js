import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {DemoClient} from '../dist/client.js';

const machine=MACHINES[0].id,id='11111111-1111-4111-8111-111111111111',nodeId='J0123456789ab';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const operations=['jobs.logs','jobs.watch','jobs.completion','jobs.diagnostics'];
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'authorized-job-read-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Authorized-Read-Fixture-2026!'}));
  const calls=[],service=await PortalService.open(join(dir,'db'),bootstrap,undefined,async(...args)=>{calls.push(args);return reply(args[1]);});
  for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[key]);
  const user=service.store.users[0];service.accounts.db.prepare("UPDATE accounts SET role='member' WHERE id=?").run(user.id);Object.assign(user,{role:'member',limits:{[machine]:1},total:1});
  const principal={userId:user.id,username:user.username,role:'member'},token=service.issueSession(principal);
  const job={id,userId:user.id,username:user.username,machine,nodeJobId:nodeId,cards:1,state:'SUCCEEDED',
    spec:{id,userId:user.id,argv:['true']}};service.store.jobs=[job];
  const reply=kind=>kind==='logs'?{text:'confirmed original log'}:kind==='diagnostics'?{jobId:id,logs:[]}:
    {nodeJobId:nodeId,state:'SUCCEEDED',assignedIndices:[]};
  service.state=()=>assert.fail('An observation must not rebuild dashboard');
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  return {service,token,user,job,principal,calls,reply};
}


test('a team member can read another member job after their own submit quota is removed',async t=>{
 const f=await fixture(t);f.job.userId='other';f.user.limits={};f.user.total=0;
 for(const operation of operations)assert.ok((await f.service.invoke(f.token,operation,{jobId:id,extension:'ignored'})).result);
 assert.equal(f.calls.length,operations.length);
});
test('log downloads preserve the original attempt and byte offset through the authenticated read lane',async t=>{
 const f=await fixture(t),request={jobId:id,download:true,attemptId:'A'+'1'.repeat(32),offset:1024**2};
 f.service.bridge=async(host,operation,args)=>{
  assert.equal(host,machine);assert.equal(operation,'logs');
  assert.deepEqual({download:args.download,attemptId:args.attemptId,offset:args.offset},
   {download:true,attemptId:request.attemptId,offset:request.offset});
  assert.equal(args.job.id,id);assert.equal(args.path,undefined);
  return {size:request.offset+1,data:'YQ==',offset:request.offset,eof:true};
 };
 const value=await f.service.invoke(f.token,'jobs.logs',{...request,path:'/etc/passwd',futureField:true});
 assert.equal(value.result.data,'YQ==');
});
test('state returns immediately while approval metadata and collector refresh change independently',async t=>{
 const f=await fixture(t),blocked=deferred();f.service.state=()=>({jobs:[]});
 f.service.refreshGPUQ=()=>blocked.promise;
 try{
  assert.deepEqual((await f.service.invoke(f.token,'state')).state,{jobs:[]});
  f.user.name='Changed';f.user.approvalNote='Changed';
  assert.deepEqual((await f.service.invoke(f.token,'state')).state,{jobs:[]});
 }finally{blocked.resolve();}
});
test('project status uses the same narrowed authorization across its nested read checks',async t=>{
  const f=await fixture(t),started=deferred(),blocked=deferred();
  f.service.bridge=async()=>{started.resolve();await blocked.promise;return {project:'paper',state:'READY',release:'a'.repeat(64)};};
  const pending=f.service.invoke(f.token,'projects.status',{machine,project:'paper'});await started.promise;f.user.name='Changed';f.user.policyVersion++;blocked.resolve();
  assert.equal((await pending).result.state,'READY');
});
test('browser retries job observation network failures once and never replays writes or authorization failures',async()=>{
  for(const operation of [...operations,'state','storage.snapshot','data.upload.status','datasets.list']){
    const client=new DemoClient();client.remote=true;let count=0;
    client.transport=async()=>{if(!count++)throw new TypeError('offline');return {result:{text:'retained'}};};
    assert.equal((await client.invoke(operation,{jobId:id},'original-token')).result.text,'retained');assert.equal(count,2);
  }
  for(const [operation,error] of [['jobs.cancel',new TypeError('offline')],['storage.refresh',new TypeError('offline')],['jobs.logs',Object.assign(Error('forbidden'),{status:403})],['datasets.list',Object.assign(Error('expired'),{status:401})]]){
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

test('browser preserves safe BUSY code and retries only a read once',async()=>{
 const client=new DemoClient();client.remote=true;let count=0;
 client.transport=async()=>{if(!count++)throw Object.assign(Error('busy'),{status:429,code:'TRAINING_ADMISSION_BUSY'});return {result:{state:'UNKNOWN'}};};
 assert.equal((await client.invoke('datasets.list',{},'token')).result.state,'UNKNOWN');assert.equal(count,2);
 const prior=globalThis.fetch;globalThis.fetch=async()=>({ok:false,status:503,json:async()=>({code:'UPLOAD_BUSY',error:'busy'})});
 try{await assert.rejects(DemoClient.prototype.transport.call(new DemoClient(),'call',{}),e=>e.code==='UPLOAD_BUSY'&&e.status===503);}finally{globalThis.fetch=prior;}
});
