import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
const from=MACHINES[0].id,machine=MACHINES[1].id,release='a'.repeat(64),targetRelease='b'.repeat(64);
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'admin-copy-')),bootstrap=join(dir,'bootstrap'),password='Test-admin-copy-2026!';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const calls=[],states=new Map();let lost=false,protocol=1;
  const bridge=async(host,op,args)=>{
    calls.push({host,op,args});
    if(op==='projects.copy.admin-probe')return {protocol:'portable-project-v1',adminCopyProtocol:protocol,enabled:true,
      project:args.project,release:args.release,releaseReady:!!args.release,targetAbsent:!args.release,
      environmentMode:'oci',architecture:'amd64',image:'sha256:'+release,sources:[from],codeBytes:10,codeEntries:1,imageUnpackedBytes:100,availableBytes:1024**3,reserveBytes:0};
    if(op==='projects.copy.prepare')return {id:args.id,project:args.project,release:args.release,state:'READY',source:{
      id:args.id,protocol:'portable-project-v1',state:'READY',project:args.project,release:args.release,token:'x'.repeat(43),
      manifestBytes:10,manifestSha256:release,totalBytes:110,entries:8}};
    if(op==='projects.copy.admin-start'){
      states.set(args.id,{id:args.id,project:args.project,release:args.release,state:'RUNNING'});
      if(lost)throw Error('private network details');return states.get(args.id);
    }
    if(op==='projects.copy.status'){if(!states.has(args.id))throw Error('unknown');return states.get(args.id);}
    if(op==='projects.copy.revoke')return {id:args.id,sourceRevoked:true,fenced:true};
    if(op==='projects.copy.cancel')return {...states.get(args.id),id:args.id,state:'CANCELED',cleaned:true};
    throw Error('Unexpected '+op);
  };
  let service=await PortalService.open(join(dir,'db'),bootstrap,undefined,bridge);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  let admin=await service.login('admin',password);
  const source=(await service.invoke(admin.token,'users.create',{username:'source',password})).result;
  const target=(await service.invoke(admin.token,'users.create',{username:'target',password})).result;
  for(const user of [source,target])await service.invoke(admin.token,'policy.save',{userId:user.id,policyVersion:0,total:1,limits:{[from]:1,[machine]:1}});
  const args={from,machine,sourceUserId:source.id,targetUserId:target.id,project:'source-project',targetProject:'copied-project',release};
  const call=async(action,input)=>(await service.invoke(admin.token,'projects.admin-copy.'+action,input)).result;
  return {get service(){return service;},calls,states,source,target,args,call,
    begin:async()=>{const plan=await call('plan',args);const request={...args,key:randomUUID(),planHash:plan.planHash,authorization:'Owner consent in fixture record; reviewed image secrets.'};return {request,result:await call('begin',request)};},
    lose:()=>{lost=true;},legacy:()=>{protocol=0;},
    member:async(action,input)=>{const login=await service.login('source',password);return service.invoke(login.token,'projects.admin-copy.'+action,input);},
    restart:async()=>{service.close();service=await PortalService.open(join(dir,'db'),bootstrap,undefined,bridge);admin=await service.login('admin',password);}};
}
test('admin plan is read-only, pinned; begin separates identities and returns verified target release',async t=>{
  const f=await fixture(t),plan=await f.call('plan',f.args);
  assert.equal(plan.state,'PLANNED');assert.equal(plan.capacity.transportBytes,null);
  assert.ok(f.calls.every(c=>c.op==='projects.copy.admin-probe'));
  const {request,result}=await f.begin();assert.equal(result.state,'RUNNING');
  const source=f.calls.find(c=>c.op==='projects.copy.prepare'),target=f.calls.find(c=>c.op==='projects.copy.admin-start');
  assert.equal(source.args.userId,f.source.id);assert.equal(target.args.userId,f.target.id);
  assert.equal(target.args.sourceUserId,f.source.id);assert.equal(target.args.project,'copied-project');
  assert.equal(JSON.stringify(result).includes('x'.repeat(43)),false);
  const count=f.calls.length;assert.equal((await f.call('begin',request)).id,result.id);assert.equal(f.calls.length,count);
  Object.assign(f.states.get(result.id),{state:'SUCCEEDED',targetRelease});
  assert.equal((await f.call('status',{id:result.id})).targetRelease,targetRelease);
  assert.equal(f.service.store.jobs.length,0);
});
test('lost target receipt survives restart; original status never dispatches a second worker',async t=>{
  const f=await fixture(t);f.lose();const {request,result}=await f.begin();assert.equal(result.state,'UNKNOWN');
  await f.restart();assert.equal((await f.call('begin',request)).id,result.id);
  Object.assign(f.states.get(result.id),{bytes:50,totalBytes:110});
  const recovered=await f.call('status',{id:result.id});
  assert.equal(recovered.state,'RUNNING');assert.equal(recovered.error,null);assert.equal(recovered.bytes,50);assert.equal(recovered.totalBytes,110);
  await f.service.reconcileAdminProjectCopies();
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.admin-start').length,1);
  await assert.rejects(f.call('begin',{...request,targetProject:'changed'}),e=>e.status===409);
});
test('member, forged identity, zero grant, old protocol and incomplete consent cause zero dispatch',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.member('plan',f.args),e=>e.status===403);assert.equal(f.calls.length,0);
  await assert.rejects(f.call('plan',{...f.args,hostAdmin:true}));assert.equal(f.calls.length,0);
  f.service.store.users.find(u=>u.id===f.target.id).limits[machine]=0;
  await assert.rejects(f.call('plan',f.args),e=>e.status===403);assert.equal(f.calls.length,0);
  f.service.store.users.find(u=>u.id===f.target.id).limits[machine]=1;f.legacy();
  await assert.rejects(f.call('plan',f.args),e=>e.status===409);
  await assert.rejects(f.call('begin',{...f.args,key:randomUUID(),planHash:release,authorization:''}));
  assert.ok(f.calls.every(c=>c.op==='projects.copy.admin-probe'));
});
test('malformed success is unknown; explicit cancel fences source and preserves original identifier',async t=>{
  const f=await fixture(t),{result}=await f.begin();
  Object.assign(f.states.get(result.id),{state:'SUCCEEDED'});
  assert.equal((await f.call('status',{id:result.id})).state,'UNKNOWN');
  const stopped=await f.call('cancel',{id:result.id});assert.equal(stopped.state,'CANCELED');assert.equal(stopped.cleanupComplete,true);
  const mutations=f.calls.filter(c=>/revoke|cancel/.test(c.op));assert.equal(mutations[0].op,'projects.copy.revoke');
  assert.ok(mutations.every(c=>c.args.id===result.id));
});
test('revocation during source reply prevents target dispatch and background cancels original operation',async t=>{
  const f=await fixture(t),bridge=f.service.bridge;
  f.service.bridge=async(host,op,args)=>{const result=await bridge(host,op,args);if(op==='projects.copy.prepare')f.service.store.users.find(u=>u.id===f.target.id).limits[machine]=0;return result;};
  const {result}=await f.begin();assert.equal(result.state,'UNKNOWN');
  assert.equal(f.calls.some(c=>c.op==='projects.copy.admin-start'),false);
  await f.service.reconcileAdminProjectCopies();assert.equal((await f.call('status',{id:result.id})).state,'CANCELED');
});

test('audit failure rolls back intent and performs zero export or target dispatch',async t=>{
  const f=await fixture(t);f.service.audit=()=>{throw Error('audit unavailable');};
  await assert.rejects(f.begin(),/audit unavailable/);
  assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM admin_project_copies').get().n,0);
  assert.ok(f.calls.every(c=>c.op==='projects.copy.admin-probe'));
});
test('source failure remains failed; cancellation cleans the original source and never starts target',async t=>{
  const f=await fixture(t),bridge=f.service.bridge;
  f.service.bridge=async(host,op,args)=>{const result=await bridge(host,op,args);return op==='projects.copy.prepare'?{...result,state:'FAILED',source:undefined}:result;};
  const {result}=await f.begin();assert.equal(result.state,'FAILED');
  await f.service.reconcileAdminProjectCopies();
  assert.equal((await f.call('status',{id:result.id})).cleanupComplete,true);
  assert.equal(f.calls.some(c=>c.op==='projects.copy.admin-start'),false);
});
test('source launch receipt lost stays on original UUID and status never repeats prepare',async t=>{
  const f=await fixture(t),bridge=f.service.bridge;
  f.service.bridge=async(host,op,args)=>{if(op==='projects.copy.prepare'){await bridge(host,op,args);throw Error('lost');}return bridge(host,op,args);};
  const {request,result}=await f.begin();assert.equal(result.state,'UNKNOWN');
  await f.call('begin',request);await f.call('status',{id:result.id});await f.service.reconcileAdminProjectCopies();
  assert.equal(f.calls.filter(c=>c.op==='projects.copy.prepare').length,1);
  assert.equal(f.calls.some(c=>c.op==='projects.copy.admin-start'),false);
});
test('plan rejects malformed capabilities, insufficient space and changed pinned content',async t=>{
  const f=await fixture(t),bridge=f.service.bridge;
  for(const change of [{targetAbsent:false},{availableBytes:0},{sources:from},{architecture:'arm64'}]){
    f.service.bridge=async(host,op,args)=>{const result=await bridge(host,op,args);return host===machine?{...result,...change}:result;};
    await assert.rejects(f.call('plan',f.args),e=>e.status===409);
  }
  f.service.bridge=bridge;const plan=await f.call('plan',f.args);
  f.service.bridge=async(host,op,args)=>{const result=await bridge(host,op,args);return host===from?{...result,image:'sha256:'+targetRelease}:result;};
  await assert.rejects(f.call('begin',{...f.args,key:randomUUID(),planHash:plan.planHash,authorization:'Owner fixture consent'}),e=>e.status===409);
  assert.ok(f.calls.every(c=>c.op==='projects.copy.admin-probe'));
});
