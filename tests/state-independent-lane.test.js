import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {readCLIState} from '../client-state.mjs';
import {DemoClient} from '../dist/client.js';
import {resourceServerView} from '../dist/resources-ui.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,{role='admin'}={}){
 const dir=await mkdtemp(join(tmpdir(),'state-lane-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
 const password='Isolated-State-Lane-2026!';
 await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
 const snapshot={version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map((m,index)=>({id:m.id,reachable:index!==3,collectedAt:index===3?null:new Date().toISOString(),gpus:[],gpuq:{connected:index!==3,jobs:[]}}))};
 await writeFile(status,JSON.stringify(snapshot));
 let bridgeCalls=0;
 const service=await PortalService.open(join(dir,'database'),bootstrap,status,async()=>{bridgeCalls++;throw Error('State must never issue a node RPC');});
 for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[key]);
 const user=service.store.users[0];user.limits=Object.fromEntries(MACHINES.map(m=>[m.id,m.cards]));user.total=100;service.accounts.db.prepare("UPDATE accounts SET role=? WHERE id=?").run(role,user.id);
 const {token}=await service.login('admin',password);
 t.after(async()=>{if(!service.closing)service.close();await rm(dir,{recursive:true,force:true});});
 return {service,token,user,status,snapshot,bridgeCalls:()=>bridgeCalls};
}
test('state returns account/job records with one unavailable node while a mutation is held',async t=>{
 const f=await fixture(t),held=deferred(),started=deferred();let writes=0;
 const write=f.service.enqueue(async()=>{writes++;started.resolve();await held.promise;});await started.promise;
 try{
  const reply=await Promise.race([f.service.invoke(f.token,'state',{}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('state waited behind a node operation')),1000);timer.unref();})]);
  assert.equal(reply.state.machines.length,MACHINES.length);assert.equal(reply.state.gpuq.hosts.length,MACHINES.length);
  assert.equal(reply.state.gpuq.hosts[3].collectedAt,null);assert.equal(reply.state.gpuq.hosts[3].reachable,false);
  assert.ok(reply.state.gpuq.hosts.slice(0,3).every(h=>h.reachable&&h.gpuq.connected));
  assert.equal(f.service.pending,1);assert.equal(writes,1);assert.equal(f.bridgeCalls(),0);assert.equal(f.bridgeCalls(),0);
 }finally{held.resolve();await write;}
});
for(const change of ['logout','disable','closing'])test('state rejects '+change+' before returning a cached snapshot',async t=>{
 const f=await fixture(t);
 if(change==='logout')f.service.revokeSession(f.token);
 if(change==='disable')f.service.accounts.db.prepare('UPDATE accounts SET enabled=0 WHERE id=?').run(f.user.id);
 if(change==='closing')f.service.close();
 await assert.rejects(f.service.invoke(f.token,'state',{}),e=>[401,403,503].includes(e.status));
 assert.equal(f.bridgeCalls(),0);
});
test('concurrent state reads share the local snapshot without rejecting a ninth observer',async t=>{
 const f=await fixture(t),held=deferred();f.service.refreshGPUQ=()=>held.promise;
 const reads=Array.from({length:16},()=>f.service.invoke(f.token,'state',{}));
 assert.equal(f.service.pending,0);
 held.resolve();await Promise.all(reads);assert.equal(f.bridgeCalls(),0);
});
test('an idle first state query picks up the current collector snapshot within its short wait',async t=>{
 const f=await fixture(t),old=new Date(Date.now()-60000).toISOString();
 f.service.gpuq.checkedAt=old;
 const start=performance.now(),reply=await f.service.invoke(f.token,'state',{});
 assert.ok(performance.now()-start<1000);
 assert.equal(reply.state.gpuq.checkedAt,f.snapshot.checkedAt);
 assert.equal(reply.state.gpuq.stale,false);assert.notEqual(reply.state.gpuq.checkedAt,old);
 assert.equal(f.bridgeCalls(),0);
});
test('full state waits at most half a second then shows expired hosts as the last sample',async t=>{
 const f=await fixture(t),held=deferred();f.service.gpuqReadWork=held.promise;
 f.service.gpuq.checkedAt=new Date(Date.now()-181000).toISOString();
 const checkedAt=f.service.gpuq.checkedAt;
 const start=performance.now(),reply=await Promise.race([f.service.invoke(f.token,'state',{}),
  new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('state waited for refresh')),1000);timer.unref();})]);
 assert.ok(performance.now()-start<1000);assert.equal(reply.state.gpuq.stale,true);
 assert.equal(reply.state.gpuq.checkedAt,checkedAt);assert.equal(reply.state.gpuq.hosts.length,MACHINES.length);
 assert.ok(reply.state.gpuq.hosts.every(host=>host.samplingStale===true));
 const view=resourceServerView(MACHINES[0],{snapshot:reply.state.gpuq,production:true});
 assert.equal(view.observed,true);assert.match(view.status,/^上次采样/);
 assert.ok(reply.state.gpuq.hosts[0].reachable);assert.equal(f.service.gpuqReadWork,held.promise);assert.equal(f.bridgeCalls(),0);
 held.resolve({checkedAt:f.snapshot.checkedAt,stale:false,hosts:f.service.gpuq.hosts});await new Promise(setImmediate);
 assert.equal(f.service.gpuq.checkedAt,f.snapshot.checkedAt,'the next query can use the background result');
});
test('CLI jobs and browser refresh both return cached state without waiting for nodes',async t=>{
 const f=await fixture(t),held=deferred();f.service.refreshGPUQ=()=>held.promise;
 f.service.gpuq.stale=true;
 const client=new DemoClient();client.remote=true;client.token=f.token;
 client.transport=async(path,body,token)=>f.service.invoke(token,body.operation,body.args);
 try{
  const [jobs]=await Promise.race([
   Promise.all([readCLIState((op,args)=>f.service.invoke(f.token,op,args),'jobs'),client.refresh()]),
   new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('client waited for node refresh')),1000);timer.unref();})]);
  assert.equal(jobs.gpuq.stale,true);assert.equal(client.data.gpuq.stale,true);
  assert.equal(jobs.gpuq.checkedAt,f.snapshot.checkedAt);assert.equal(client.data.gpuq.checkedAt,f.snapshot.checkedAt);
  assert.equal(f.bridgeCalls(),0);
 }finally{held.resolve();}
});
test('state rejects invalid args and cannot expose an admin snapshot to a member',async t=>{
 const f=await fixture(t,{role:'member'});f.user.limits={[MACHINES[0].id]:1};
 for(const args of [null,[],true])await assert.rejects(f.service.invoke(f.token,'state',args),/参数格式错误/);
 const reply=await f.service.invoke(f.token,'state',{});
 assert.equal(reply.state.users.length,1);assert.equal(reply.state.machines.length,MACHINES.length);assert.equal(reply.state.gpuq.hosts.length,MACHINES.length);
 assert.equal(Object.hasOwn(reply.state,'invitations'),false);
});
test('account mutation remains serialized and is never replayed by an independent state query',async t=>{
 const f=await fixture(t),held=deferred(),started=deferred();
 const first=f.service.enqueue(async()=>{started.resolve();await held.promise;});await started.promise;
 let saves=0;const save=f.service.save.bind(f.service);f.service.save=()=>{saves++;return save();};
 const previousName=f.user.name,edit=f.service.invoke(f.token,'profile.update',{name:'Updated Fixture'});
 try{
  const state=await f.service.invoke(f.token,'state',{});assert.equal(state.state.users[0].name,previousName);assert.equal(saves,0);
 }finally{held.resolve();await first;}
  await edit;assert.equal(saves,1);assert.equal(f.user.name,'Updated Fixture');
});
test('summary never reads job/process history or the snapshot filesystem',async t=>{
 const f=await fixture(t);let refreshes=0;
 f.service.refreshGPUQ=()=>{refreshes++;throw Error('Summary must not read files');};
 Object.defineProperty(f.service.store,'jobs',{get(){throw Error('Summary accessed job history');},configurable:true});
 for(const host of f.service.gpuq.hosts)Object.defineProperty(host,'tasks',{get(){throw Error('Summary accessed process details');}});
 const start=performance.now(),reply=await f.service.invoke(f.token,'state',{view:'summary'});
 assert.equal(reply.state.summaryVersion,1);assert.equal(reply.state.machines.length,MACHINES.length);assert.equal(refreshes,0);
 for(const key of ['jobs','gpuq','transfers','invitations'])assert.equal(Object.hasOwn(reply.state,key),false);
 assert.ok(Buffer.byteLength(JSON.stringify(reply))<50000);
 t.diagnostic(JSON.stringify({summaryBytes:Buffer.byteLength(JSON.stringify(reply)),elapsedMs:performance.now()-start}));
});
test('summary preserves member policy filtering and admin account policy metadata',async t=>{
 const f=await fixture(t,{role:'member'});f.user.limits={[MACHINES[0].id]:1};f.user.policyVersion=9;
 const summary=(await f.service.invoke(f.token,'state',{view:'summary'})).state;
 const full=(await f.service.invoke(f.token,'state',{})).state;
 assert.deepEqual(summary.users,full.users);assert.deepEqual(summary.machines,full.machines);
 assert.equal(summary.users.length,1);assert.equal(summary.users[0].policyVersion,9);
 assert.deepEqual(summary.operationalMaintenance,full.operationalMaintenance);
 assert.deepEqual(summary.datasetUploadAdmission,full.datasetUploadAdmission);
 assert.ok(Array.isArray(full.jobs));assert.ok(full.gpuq);assert.ok(full.transfers);
});
test('summary does not mark stale cached node connectivity as current',async t=>{
 const f=await fixture(t);f.service.gpuq={stale:false,checkedAt:new Date(Date.now()-181000).toISOString(),hosts:[{gpuq:{connected:true}}]};
 assert.equal((await f.service.invoke(f.token,'state',{view:'summary'})).state.gpuqConnected,false);
});
test('summary rejects invalid views and revoked authorization',async t=>{
 const f=await fixture(t);
 for(const args of [{view:'everything'}])await assert.rejects(f.service.invoke(f.token,'state',args),e=>e.status===400);
 f.service.revokeSession(f.token);await assert.rejects(f.service.invoke(f.token,'state',{view:'summary'}),e=>e.status===401);
});
