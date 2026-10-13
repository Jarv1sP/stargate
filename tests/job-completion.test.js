import test from 'node:test';
import assert from 'node:assert/strict';
import {executionCall,usage} from '../execution.mjs';
import {jobCompletion} from '../job-observation.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createPortalServer} from '../portal-server.mjs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const ID='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',NODE='J0123456789ab';
const fixture=()=>{
  const owner={id:'demo-user-1',enabled:true,limits:{'gpu-1':1}};
  const job={id:ID,userId:owner.id,machine:'gpu-1',nodeJobId:NODE,state:'FAILED',cancelRequested:false,cards:1,
    spec:{id:ID,userId:owner.id,project:'research',release:'a'.repeat(64),argv:['train']},
    latestAttempt:{id:'Aold',ordinal:1,state:'EXITED_FAILURE',exitCode:125,startedAt:50,finishedAt:100},
    dataPreparationHold:{state:'RELEASED'},assignedIndices:[],actualCards:0};
  const raw={protocol:'native-observation-v1',status:'CONFIRMED',jobId:ID,userId:owner.id,nodeJobId:NODE,submitKey:ID,specVerified:true,
    state:'SUCCEEDED',nativeVersion:9,observedAt:400,latestRetry:{eventId:12,createdAt:200},
    latestAttempt:{id:'Anew',ordinal:2,state:'EXITED_SUCCESS',exit_code:0,failure_reason:null,started_at:250,finished_at:300},progress:null};
  const result={nodeJobId:NODE,state:'SUCCEEDED',assignedIndices:[],nativeObservation:raw},calls=[];
  const service={store:{get:id=>id===owner.id?owner:{id,enabled:true,limits:{'gpu-1':1}},jobs:[job]},
    save:()=>assert.fail('No lifecycle writes'),bridge:async(...args)=>{calls.push(args);return result;}};
  return {owner,job,raw,result,calls,service,principal:{userId:owner.id,role:'member'}};
};

test('explicit completion verifies same immutable job later success without changing failed history or quotas',async()=>{
  const f=fixture(),before=structuredClone(f.job);
  const value=await executionCall(f.service,f.principal,'jobs.completion',{jobId:ID});
  assert.equal(value.protocol,'job-completion-v1');assert.equal(value.completed,true);assert.equal(value.state,'SUCCEEDED');
  assert.equal(value.portalHistory.state,'FAILED');assert.equal(value.completedAttempt.id,'Anew');assert.equal(value.nativeVersion,9);
  assert.equal(value.project,'research');assert.equal(value.release,'a'.repeat(64));assert.match(value.specSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(f.job,before);assert.equal(usage(f.service.store.jobs,f.owner.id),0);
  assert.deepEqual(f.calls,[['gpu-1','watch',{job:f.job.spec,expectedNodeJobId:NODE}]]);
});

test('historical physical native binding leaves the public completion digest tied to original user intent',async()=>{
  const f=fixture(),logical={dataset:'images',version:'b'.repeat(64)},physical={...logical,dataset:'images-replica'};
  f.job.spec.datasets=[logical];f.job.dataPreparationHold.spec={...structuredClone(f.job.spec),datasets:[physical]};
  const before=structuredClone(f.job),value=await executionCall(f.service,f.principal,'jobs.completion',{jobId:ID});
  assert.equal(value.completed,true);assert.equal(value.specSha256,createHash('sha256').update(JSON.stringify(f.job.spec)).digest('hex'));
  assert.deepEqual(f.calls,[['gpu-1','watch',{job:f.job.dataPreparationHold.spec,expectedNodeJobId:NODE}]]);
  assert.deepEqual(f.job,before);
});

test('native success alone never overrides cleanup, leases, contradictory attempt or cancellation',()=>{
  const patches=[{state:'UNKNOWN'},{assignedIndices:[0]},{assignedIndices:undefined},{nodeJobId:'Jffffffffffff'}];
  for(const patch of patches){const f=fixture();assert.equal(jobCompletion(f.job,{...f.result,...patch}).completed,false);}
  for(const patch of [{exit_code:1},{exit_code:null},{state:'RUNNING'},{failure_reason:'worker remains'},
    {started_at:null},{finished_at:null},{finished_at:240},{finished_at:401}]){
    const f=fixture();Object.assign(f.raw.latestAttempt,patch);assert.equal(jobCompletion(f.job,f.result).completed,false,JSON.stringify(patch));
  }
  for(const patch of [{cancelRequested:true},{state:'CANCELED'}]){
    const f=fixture();Object.assign(f.job,patch);assert.equal(jobCompletion(f.job,f.result).reason,'PORTAL_CANCELLATION_REQUIRES_REVIEW');
  }
});

test('later success requires trusted retry after old failure and before the new attempt',()=>{
  for(const event of [null,{eventId:12,createdAt:99},{eventId:12,createdAt:260}]){
    const f=fixture();f.raw.latestRetry=event;assert.equal(jobCompletion(f.job,f.result).completed,false);
  }
  const f=fixture();delete f.job.latestAttempt;assert.equal(jobCompletion(f.job,f.result).completed,false);
  const g=fixture();g.raw.latestAttempt.id='Aold';g.raw.latestAttempt.ordinal=1;assert.equal(jobCompletion(g.job,g.result).completed,false);
});

test('unchanged successful attempt is accepted without inventing a retry',()=>{
  const f=fixture();f.job.state='SUCCEEDED';f.job.latestAttempt={id:'Anew',ordinal:2,state:'EXITED_SUCCESS',exitCode:0,startedAt:250,finishedAt:300};f.raw.latestRetry=null;
  assert.equal(jobCompletion(f.job,f.result).completed,true);
});

test('explicit resource reconciliation fixes real watch UNKNOWN contract without changing old failed lifecycle',async()=>{
  const f=fixture(),id='A'+'a'.repeat(32),before=structuredClone(f.job);f.raw.latestAttempt.id=id;
  const expected={nodeJobId:NODE,attemptId:id,attemptOrdinal:2,nativeVersion:9};
  f.service.audit=()=>{};let released=false;
  f.service.bridge=async(machine,operation,args)=>{
    f.calls.push([machine,operation,args]);
    if(operation==='storage.lease.cancel'){assert.deepEqual(args,{job:f.job.spec,expectedNative:expected});released=true;return {jobId:ID,state:'CANCELED',released:true,reconciledNative:Object.fromEntries(Object.entries(expected).reverse())};}
    assert.equal(operation,'watch');return {...f.result,state:released?'SUCCEEDED':'UNKNOWN',...(released?{}:{error:'Dataset lease cleanup awaits scheduler reconciliation'})};
  };
  const value=await executionCall(f.service,f.principal,'jobs.reconcile-resources',{jobId:ID});
  assert.equal(value.resourcesReleased,true);assert.equal(value.completion.completed,true);assert.deepEqual(f.job,before);
  assert.deepEqual(f.calls.map(c=>c[1]),['watch','storage.lease.cancel','watch']);
});

test('a later native retry after exact resource cleanup never becomes a completion claim',async()=>{
  const f=fixture();f.raw.latestAttempt.id='A'+'a'.repeat(32);f.service.audit=()=>{};let released=false;
  f.service.bridge=async(machine,op,args)=>{
    if(op==='storage.lease.cancel'){released=true;return {jobId:ID,state:'CANCELED',released:true,reconciledNative:args.expectedNative};}
    return released?{...f.result,state:'PENDING',nativeObservation:{...f.raw,state:'PENDING',nativeVersion:10}}:f.result;
  };
  const value=await executionCall(f.service,f.principal,'jobs.reconcile-resources',{jobId:ID});
  assert.equal(value.resourcesReleased,true);assert.equal(value.completion.completed,false);assert.equal(f.job.state,'FAILED');
});

test('actual native watch and durable cache cleanup responses satisfy the Portal completion protocol',async()=>{
  const value=JSON.parse(execFileSync('python3',[new URL('./job-resource-contract-fixture.py',import.meta.url).pathname],{encoding:'utf8'}));
  const f=fixture();f.job.spec=value.spec;const before=structuredClone(f.job);f.service.audit=()=>{};
  let cleaned=false;f.service.bridge=async(machine,operation,args)=>{
    assert.equal(machine,'gpu-1');assert.deepEqual(args.job,value.spec);
    if(operation==='storage.lease.cancel'){
      assert.deepEqual(args.expectedNative,value.released.reconciledNative);cleaned=true;return value.released;
    }
    assert.equal(operation,'watch');return cleaned?value.after:value.before;
  };
  assert.equal(jobCompletion(f.job,value.before).completed,false);
  const result=await executionCall(f.service,f.principal,'jobs.reconcile-resources',{jobId:ID});
  assert.equal(result.resourcesReleased,true);assert.equal(result.completion.completed,true);
  assert.equal(result.completion.completedAttempt.id,value.after.nativeObservation.latestAttempt.id);
  assert.deepEqual(f.job,before);assert.equal(value.unchangedSpec,true);assert.equal(value.datasetLeasesAfter,0);
});

test('resource reconciliation rejects missing identity, live attempt, changed policy and unconfirmed release without new commands',async()=>{
  for(const patch of [{state:'RUNNING'}, {nodeJobId:null}]){
    const f=fixture();Object.assign(f.job,patch);await assert.rejects(executionCall(f.service,f.principal,'jobs.reconcile-resources',{jobId:ID}),e=>e.status===409);assert.equal(f.calls.length,0);
  }
  for(const mutation of [f=>{f.raw.state='RUNNING';},f=>{f.raw.latestAttempt.state='RUNNING';},f=>{f.raw.specVerified=false;},f=>{f.raw.latestAttempt=null;}]){
    const f=fixture();f.raw.latestAttempt.id='A'+'a'.repeat(32);mutation(f);
    await assert.rejects(executionCall(f.service,f.principal,'jobs.reconcile-resources',{jobId:ID}),e=>e.status===409);assert.deepEqual(f.calls.map(c=>c[1]),['watch']);
  }
  const f=fixture();f.raw.latestAttempt.id='A'+'a'.repeat(32);f.service.audit=()=>{};
  f.service.bridge=async(m,op)=>op==='watch'?f.result:{jobId:ID,state:'CANCELED',released:true};
  await assert.rejects(executionCall(f.service,f.principal,'jobs.reconcile-resources',{jobId:ID}),e=>e.status===409);
  const g=fixture();g.service.bridge=async()=>{g.owner.enabled=false;return g.result;};
  await assert.rejects(executionCall(g.service,g.principal,'jobs.reconcile-resources',{jobId:ID}),e=>e.status===409);
  const h=fixture();
  await assert.rejects(executionCall(h.service,{userId:'demo-user-2',role:'member'},'jobs.reconcile-resources',{jobId:ID}),e=>e.status===403);
  await assert.rejects(executionCall(h.service,h.principal,'jobs.reconcile-resources',{jobId:ID,expectedNative:{}}));
  assert.equal(h.calls.length,0);
});

test('identity mismatches, old nodes and transport errors produce unconfirmed, not fabricated success',async()=>{
  for(const patch of [{submitKey:'wrong'},{userId:'other'},{jobId:'wrong'},{nodeJobId:'Jffffffffffff'},{specVerified:false},{status:'UNKNOWN'}]){
    const f=fixture();Object.assign(f.raw,patch);assert.equal(jobCompletion(f.job,f.result).completed,false);
  }
  const f=fixture();f.service.bridge=async()=>{throw Error('private socket path');};
  const value=await executionCall(f.service,f.principal,'jobs.completion',{jobId:ID});assert.equal(value.completed,false);assert.doesNotMatch(JSON.stringify(value),/private socket/);
  delete f.job.nodeJobId;f.service.bridge=()=>assert.fail('No native ID');assert.equal((await executionCall(f.service,f.principal,'jobs.completion',{jobId:ID})).completed,false);
});

test('completion enforces owner and exact arguments, and rechecks policy after await',async()=>{
  const f=fixture();
  await assert.rejects(executionCall(f.service,{userId:'demo-user-2',role:'member'},'jobs.completion',{jobId:ID}),e=>e.status===403);
  for(const extra of [{machine:'gpu-1'},{state:'SUCCEEDED'},{nativeObservation:f.raw},{expectedNodeJobId:NODE},{hostAdmin:true}])
    await assert.rejects(executionCall(f.service,f.principal,'jobs.completion',{jobId:ID,...extra}));
  assert.equal(f.calls.length,0);
  f.service.bridge=async()=>{f.owner.limits={};return f.result;};
  await assert.rejects(executionCall(f.service,f.principal,'jobs.completion',{jobId:ID}),e=>e.status===409);
});

test('real authenticated HTTP completion preserves persisted failure and emits no control operation',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-completion-')),bootstrap=join(dir,'bootstrap');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Completion-Fixture-2026!'}));
  const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));const origin='http://127.0.0.1:'+port;
  const f=fixture(),{server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge:f.service.bridge});
  clearInterval(service.executionTimer);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const login=await service.login('admin','Completion-Fixture-2026!');
  f.job.userId=login.principal.userId;f.job.spec.userId=login.principal.userId;f.raw.userId=login.principal.userId;
  service.store.jobs.push(f.job);service.save();const before=service.db.prepare('SELECT data FROM portal_state').get().data;
  const response=await fetch(origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.token},body:JSON.stringify({operation:'jobs.completion',args:{jobId:ID}})});
  assert.equal(response.status,200);const value=(await response.json()).result;
  assert.equal(value.completed,true);assert.equal(value.portalHistory.state,'FAILED');assert.equal(value.completedAttempt.ordinal,2);
  assert.equal(service.db.prepare('SELECT data FROM portal_state').get().data,before);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][1],'watch');
  await service.invoke(login.token,'logout',{});
});
