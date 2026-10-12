import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
const from=MACHINES[0].id,machine=MACHINES[1].id,release='a'.repeat(64),project='portable-fixture';
const request=()=>({from,machine,project,release,key:randomUUID()});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'portable-project-api-')),bootstrap=join(dir,'bootstrap'),password='Fixture-Portable-2026!';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const calls=[],nodes=new Map();let ready=false,sourceState='READY',lost=false,cleanup=true;
  const bridge=async(host,op,args)=>{
    calls.push({host,op,args});
    if(op==='projects.copy.probe')return {protocol:'portable-project-v1',enabled:true,project:args.project,environmentMode:'oci',architecture:'amd64',sources:[from],
      releaseReady:!!args.release,...(args.release?{release:args.release,image:'sha256:'+release}:{})};
    if(op==='projects.verify'){if(!ready)throw Error('not found');return {project,release,state:'READY'};}
    if(op==='projects.copy.prepare')return {id:args.id,project:args.project,release:args.release,state:sourceState,...(sourceState==='READY'?{source:{id:args.id,token:'x'.repeat(43),protocol:'portable-project-v1',state:'READY',project,release,manifestBytes:100,manifestSha256:release,totalBytes:1024,entries:8}}:{})};
    if(op==='projects.copy.start'){
      if(!nodes.has(args.id))nodes.set(args.id,{id:args.id,project:args.project,release:args.release,state:'RUNNING',bytes:128,totalBytes:1024,developmentChanged:false});
      if(lost){lost=false;throw Error('private lost response diagnostic');}return nodes.get(args.id);
    }
    if(op==='projects.copy.cancel'){
      if(host===from)return {id:args.id,state:'CANCELED',cleaned:cleanup};
      const result=nodes.get(args.id);if(result?.state==='SUCCEEDED')return {...result,cleaned:cleanup};
      nodes.set(args.id,{id:args.id,project,release,state:'CANCELED'});return {...nodes.get(args.id),cleaned:cleanup};
    }
    if(op==='projects.copy.revoke')return {id:args.id,sourceRevoked:true,fenced:true};
    throw Error('Unexpected fixture operation: '+op);
  };
  let service=await PortalService.open(join(dir,'db'),bootstrap,undefined,bridge);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'portable-user',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{[from]:1,[machine]:1}});
  let login=await service.login('portable-user',password);
  return {calls,nodes,member,admin,get service(){return service;},
    call:async(op,args)=>(await service.invoke(login.token,op,args)).result,
    ready:()=>{ready=true;},source:value=>{sourceState=value;},lose:()=>{lost=true;},cleanup:value=>{cleanup=value;},
    restart:async()=>{service.close();service=await PortalService.open(join(dir,'db'),bootstrap,undefined,bridge);login=await service.login('portable-user',password);}};
}
test('fixed owner OCI copies are durable, idempotent, private and never use datasets or GPU jobs',async t=>{
  const f=await fixture(t),args=request(),first=await f.call('projects.replicate',args);
  assert.equal(first.state,'RUNNING');assert.equal(first.from,from);assert.equal(first.machine,machine);
  assert.equal(JSON.stringify(first).includes('x'.repeat(43)),false);
  assert.equal((await f.call('projects.replicate',args)).id,first.id);assert.equal(f.nodes.size,1);
  assert.equal(f.service.store.jobs.length,0);assert.ok(f.calls.every(call=>call.op.startsWith('projects.')));
  assert.ok(f.calls.every(call=>call.args.userId===f.member.id));
  Object.assign(f.nodes.get(first.id),{state:'SUCCEEDED',bytes:1024});
  assert.equal((await f.call('projects.replication.status',{id:first.id})).state,'SUCCEEDED');
  await f.service.reconcileProjectCopies();
  assert.equal((await f.call('projects.replication.status',{id:first.id})).cleanupComplete,true);
  await f.restart();assert.equal((await f.call('projects.replication.status',{id:first.id})).state,'SUCCEEDED');
});
test('accepted-but-lost response never creates another target or operation after restart',async t=>{
  const f=await fixture(t),args=request();f.lose();const first=await f.call('projects.replicate',args);
  assert.equal(first.state,'UNKNOWN');assert.equal(JSON.stringify(first).includes('private lost'),false);
  assert.equal(first.errorPhase,'TARGET_DISPATCH');
  assert.equal(first.errorCode,'PROJECT_COPY_TARGET_DISPATCH_UNCONFIRMED');
  // Existing deployments could persist the READY ticket but leave the old
  // source RUNNING projection. Recovery must normalize it without re-export.
  const prior=JSON.parse(f.service.db.prepare('SELECT data FROM project_copies WHERE id=?').get(first.id).data);
  prior.sourceState='RUNNING';
  f.service.db.prepare('UPDATE project_copies SET data=? WHERE id=?').run(JSON.stringify(prior),first.id);
  await f.restart();const next=await f.call('projects.replicate',args);
  assert.equal(next.id,first.id);assert.equal(next.state,'RUNNING');assert.equal(f.nodes.size,1);
  assert.equal(next.errorPhase,null);assert.equal(next.errorCode,null);
  assert.equal(next.sourceState,'READY');
  assert.deepEqual(new Set(f.calls.filter(c=>c.op==='projects.copy.start').map(c=>c.host)),new Set([machine]));
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.prepare').length,1);
  await assert.rejects(f.call('projects.replicate',{...args,project:'changed'}),e=>e.status===409);
});
test('source READY stays visible when target admission fails and resumes the same original copy',async t=>{
  const f=await fixture(t),args=request();let blocked=true;
  f.service.ociProjectAdmission=async(host,user,project,options)=>{
    if(host===machine&&options?.creatingOCI&&blocked)throw Error('private admission diagnostic');
  };
  const first=await f.call('projects.replicate',args);
  assert.equal(first.state,'UNKNOWN');assert.equal(first.sourceState,'READY');
  assert.equal(first.errorPhase,'TARGET_ADMISSION');
  assert.equal(first.errorCode,'PROJECT_COPY_TARGET_ADMISSION_UNCONFIRMED');
  assert.equal(JSON.stringify(first).includes('private admission'),false);
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.start').length,0);
  blocked=false;
  const next=await f.call('projects.replication.status',{id:first.id});
  assert.equal(next.id,first.id);assert.equal(next.state,'RUNNING');
  assert.equal(next.errorPhase,null);
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.prepare').length,1);
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.start').length,1);
});
test('source, target, owner and strict fields are enforced for member and administrator',async t=>{
  const f=await fixture(t),args=request();
  for(const changed of [{from:MACHINES[2].id},{machine:MACHINES[2].id},{userId:'builtin-admin'},{hostAdmin:true},{release:'latest'},{from:machine}])
    await assert.rejects(f.call('projects.replicate',{...args,...changed}));
  assert.equal(f.calls.length,0);
  const row=await f.call('projects.replicate',args);
  await assert.rejects(f.service.invoke(f.admin.token,'projects.replication.status',{id:row.id}),e=>e.status===404);
  f.service.store.users.find(u=>u.id===f.member.id).limits[from]=0;
  assert.equal((await f.call('projects.replication.status',{id:row.id})).state,'CANCELED');
});
test('source and target architecture must match before any export starts',async t=>{
  const f=await fixture(t),bridge=f.service.bridge;
  f.service.bridge=async(host,op,args)=>{const result=await bridge(host,op,args);return host===machine&&op==='projects.copy.probe'?{...result,architecture:'arm64'}:result;};
  await assert.rejects(f.call('projects.replicate',request()),/架构/);
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.prepare').length,0);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM project_copies').get().n,0);
});
test('cancellation persists during an export reply and stops before target dispatch',async t=>{
  const f=await fixture(t),entered=deferred(),releaseReply=deferred(),bridge=f.service.bridge;
  f.service.bridge=async(host,op,args)=>{if(op==='projects.copy.prepare'){entered.resolve();await releaseReply.promise;}return bridge(host,op,args);};
  const creating=f.call('projects.replicate',request());await entered.promise;
  const id=f.service.db.prepare('SELECT id FROM project_copies').get().id;
  const canceling=f.call('projects.replication.cancel',{id});releaseReply.resolve();await Promise.all([creating,canceling]);
  const result=await f.call('projects.replication.status',{id});assert.equal(result.state,'CANCELED');assert.equal(result.cleanupComplete,true);
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.start').length,0);
});
test('failed or canceled transfers retry cleanup until both workers are definitely stopped',async t=>{
  const f=await fixture(t),row=await f.call('projects.replicate',request());f.cleanup(false);
  let result=await f.call('projects.replication.cancel',{id:row.id});assert.equal(result.state,'CANCELED');assert.equal(result.cleanupComplete,false);
  f.cleanup(true);await f.service.reconcileProjectCopies();result=await f.call('projects.replication.status',{id:row.id});
  assert.equal(result.cleanupComplete,true);
  const count=f.calls.length;await f.service.reconcileProjectCopies();assert.equal(f.calls.length,count);
});
test('automatic preparation reuses local READY release or a stable copy operation',async t=>{
  const f=await fixture(t),ref={from,project,release};
  const first=await f.service.prepareProject(f.member.id,machine,ref),again=await f.service.prepareProject(f.member.id,machine,ref);
  assert.equal(first.state,'PREPARING');assert.equal(again.operationId,first.operationId);
  Object.assign(f.nodes.get(first.operationId),{state:'SUCCEEDED'});
  assert.equal((await f.service.prepareProject(f.member.id,machine,ref)).state,'READY');
  f.ready();const before=f.calls.length;assert.equal((await f.service.prepareProject(f.member.id,machine,ref)).state,'READY');
  assert.equal(f.calls.length-before,1);assert.equal(f.calls.at(-1).op,'projects.verify');
});
test('slow export does not hold the global mutation/terminal queue',async t=>{
  const f=await fixture(t),entered=deferred(),gate=deferred(),bridge=f.service.bridge;
  f.service.bridge=async(host,op,args)=>{if(op==='projects.copy.prepare'){entered.resolve();await gate.promise;}return bridge(host,op,args);};
  const pending=f.call('projects.replicate',request());await entered.promise;
  assert.equal(await f.service.enqueue(()=>42),42);gate.resolve();await pending;
});
test('concurrent jobs preparing the same immutable owner tuple share one copy',async t=>{
  const f=await fixture(t),reference={from,project,release};
  const results=await Promise.all(Array.from({length:8},()=>f.service.prepareProject(f.member.id,machine,reference)));
  assert.equal(new Set(results.map(r=>r.operationId)).size,1);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM project_copies').get().n,1);
  assert.equal(f.nodes.size,1);
});
test('revoked machine grants still permit owner cancellation and background cleanup, never new dispatch',async t=>{
  const f=await fixture(t),row=await f.call('projects.replicate',request());
  const starts=f.calls.filter(c=>c.op==='projects.copy.start').length;
  f.service.store.users.find(u=>u.id===f.member.id).limits={};
  f.cleanup(false);
  const canceled=await f.call('projects.replication.cancel',{id:row.id});assert.equal(canceled.state,'CANCELED');
  assert.equal(canceled.cleanupComplete,false);
  f.cleanup(true);await f.service.reconcileProjectCopies();
  assert.equal((await f.call('projects.replication.status',{id:row.id})).cleanupComplete,true);
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.start').length,starts);
});
test('disabled owner is canceled by background reconciliation without renewed grants',async t=>{
  const f=await fixture(t),row=await f.call('projects.replicate',request());
  f.service.store.users.find(u=>u.id===f.member.id).enabled=false;
  await f.service.reconcileProjectCopies();
  const saved=f.service.db.prepare('SELECT state,data FROM project_copies WHERE id=?').get(row.id);
  assert.equal(saved.state,'CANCELED');assert.equal(JSON.parse(saved.data).cancellationReason,'AUTHORIZATION_REVOKED');
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.start').length,1);
});
test('grant revoked while export reply is pending fences target before later cleanup',async t=>{
  const f=await fixture(t),entered=deferred(),gate=deferred(),bridge=f.service.bridge;
  f.service.bridge=async(host,op,args)=>{if(op==='projects.copy.prepare'){entered.resolve();await gate.promise;}return bridge(host,op,args);};
  const creating=f.call('projects.replicate',request());await entered.promise;
  f.service.store.users.find(u=>u.id===f.member.id).limits={};gate.resolve();
  const row=await creating;assert.equal(row.state,'CANCELING');assert.equal(row.cancellationReason,'AUTHORIZATION_REVOKED');
  await f.service.reconcileProjectCopies();assert.equal((await f.call('projects.replication.status',{id:row.id})).state,'CANCELED');
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.start').length,0);
});

test('failed source export stays failed until explicit retry with a durable new key',async t=>{
  const f=await fixture(t),args=request();f.source('FAILED');
  const failed=await f.call('projects.replicate',args);assert.equal(failed.state,'FAILED');
  f.source('READY');
  const ref={from,project,release},automatic=await f.service.prepareProject(f.member.id,machine,ref);
  assert.equal(automatic.state,'FAILED');assert.match(automatic.error,/project copy-retry/);
  assert.equal(f.nodes.size,1); // only a cancellation tombstone, no target start
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.start').length,0);
  const key=randomUUID(),retry=await f.call('projects.replication.retry',{id:failed.id,key});
  assert.notEqual(retry.id,failed.id);assert.equal(retry.retryOf,failed.id);assert.equal(retry.state,'RUNNING');
  const sourceCalls=f.calls.filter(c=>c.op==='projects.copy.prepare');
  assert.deepEqual(new Set(sourceCalls.map(c=>c.args.id)),new Set([failed.id,retry.id]));
  assert.equal((await f.service.prepareProject(f.member.id,machine,ref)).operationId,retry.id);
  await f.restart();
  assert.equal((await f.call('projects.replication.retry',{id:failed.id,key})).id,retry.id);
  await assert.rejects(f.call('projects.replication.retry',{id:failed.id,key:randomUUID()}),e=>e.status===409);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM project_copies').get().n,2);
});

test('retry requires owner, current authorization, terminal state and fresh cleanup proof',async t=>{
  const f=await fixture(t),first=await f.call('projects.replicate',request()),key=randomUUID();
  await assert.rejects(f.call('projects.replication.retry',{id:first.id,key}),e=>e.status===409);
  await assert.rejects(f.service.invoke(f.admin.token,'projects.replication.retry',{id:first.id,key}),e=>e.status===404);
  await f.call('projects.replication.cancel',{id:first.id});
  f.cleanup(false);
  await assert.rejects(f.call('projects.replication.retry',{id:first.id,key}),/清理/);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM project_copies').get().n,1);
  f.cleanup(true);f.service.store.users.find(u=>u.id===f.member.id).limits[from]=0;
  await assert.rejects(f.call('projects.replication.retry',{id:first.id,key}),e=>e.status===403);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM project_copies').get().n,1);
});

test('concurrent retry keys cannot create two copies after a lost preparation reply',async t=>{
  const f=await fixture(t);f.source('FAILED');const first=await f.call('projects.replicate',request());
  f.source('READY');const key=randomUUID();
  const results=await Promise.all([f.call('projects.replication.retry',{id:first.id,key}),f.call('projects.replication.retry',{id:first.id,key})]);
  assert.equal(results[0].id,results[1].id);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM project_copies').get().n,2);
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.start').every(c=>c.args.id===results[0].id),true);
});

test('different concurrent retry keys cannot silently share a new operation identity',async t=>{
  const f=await fixture(t);f.source('FAILED');const first=await f.call('projects.replicate',request());f.source('READY');
  const results=await Promise.allSettled([f.call('projects.replication.retry',{id:first.id,key:randomUUID()}),f.call('projects.replication.retry',{id:first.id,key:randomUUID()})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM project_copies').get().n,2);
});

test('retry key survives an ambiguous admission error before new dispatch',async t=>{
  const f=await fixture(t);f.source('FAILED');const first=await f.call('projects.replicate',request());f.source('READY');
  const bridge=f.service.bridge,key=randomUUID();let interrupted=true;
  f.service.bridge=async(host,op,args)=>{if(interrupted&&op==='projects.copy.probe')throw Error('admission reply lost');return bridge(host,op,args);};
  await assert.rejects(f.call('projects.replication.retry',{id:first.id,key}),/admission reply lost/);
  assert.equal(JSON.parse(f.service.db.prepare('SELECT data FROM project_copies WHERE id=?').get(first.id).data).retryKey,key);
  interrupted=false;const retried=await f.call('projects.replication.retry',{id:first.id,key});
  assert.equal(retried.state,'RUNNING');assert.equal(retried.retryOf,first.id);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM project_copies').get().n,2);
});

test('authorization revocation fences source even while target is unreachable; packages wait for stopped proof',async t=>{
  const f=await fixture(t),first=await f.call('projects.replicate',request());
  const bridge=f.service.bridge;let unavailable=true;
  f.service.bridge=async(host,op,args)=>{
    if(host===machine&&op==='projects.copy.cancel'&&unavailable){f.calls.push({host,op,args});throw Error('target unreachable');}
    return bridge(host,op,args);
  };
  f.service.store.users.find(u=>u.id===f.member.id).enabled=false;
  const before=f.calls.length;await f.service.reconcileProjectCopies();
  const attempted=f.calls.slice(before);
  assert.equal(attempted[0].op,'projects.copy.revoke');assert.equal(attempted[0].host,from);
  assert.equal(attempted.some(c=>c.host===from&&c.op==='projects.copy.cancel'),false);
  let row=f.service.db.prepare('SELECT state,data FROM project_copies WHERE id=?').get(first.id),data=JSON.parse(row.data);
  assert.equal(row.state,'CANCELING');assert.equal(data.sourceRevoked,true);assert.notEqual(data.cleanupComplete,true);
  assert.equal(data.errorPhase,'CANCELLATION');
  assert.equal(data.errorCode,'PROJECT_COPY_CANCELLATION_UNCONFIRMED');
  unavailable=false;await f.service.reconcileProjectCopies();
  row=f.service.db.prepare('SELECT state,data FROM project_copies WHERE id=?').get(first.id);data=JSON.parse(row.data);
  assert.equal(row.state,'CANCELED');assert.equal(data.cleanupComplete,true);
});

test('source fence failure still attempts target stop, without claiming completed cancellation',async t=>{
  const f=await fixture(t),first=await f.call('projects.replicate',request()),bridge=f.service.bridge;
  f.service.bridge=async(host,op,args)=>{if(op==='projects.copy.revoke')throw Error('source unreachable');return bridge(host,op,args);};
  const result=await f.call('projects.replication.cancel',{id:first.id});
  assert.equal(result.state,'CANCELING');assert.notEqual(result.sourceRevoked,true);
  assert.equal(f.calls.some(c=>c.host===machine&&c.op==='projects.copy.cancel'),true);
  assert.equal(f.calls.some(c=>c.host===from&&c.op==='projects.copy.cancel'),false);
});
