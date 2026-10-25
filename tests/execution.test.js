import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';
const password='Only-Test-Password-Long-2026';
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-execution-')),database=join(dir,'db'),bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:m.id==='gpu-1'?32607:24576})),gpuq:{connected:true,observeOnly:false,schedulableIndices:[0,1],jobs:[]}}))}));
  let remoteState='RUNNING',calls=[],offline=false;
  const bridge=async(machine,operation,args)=>{calls.push({machine,operation,args});if(operation==='projects.workspace')return {project:args.project,state:'AVAILABLE',workspace:{persistent:true}};if(offline)throw Error('timeout');if(operation==='logs')return {text:'private-log'};return {state:remoteState,nodeJobId:'J'+args.job.id.replaceAll('-','').slice(0,12),assignedIndices:[0]};};
  let s=await PortalService.open(database,bootstrap,status,bridge);clearInterval(s.executionTimer);
  const admin=await s.login('admin',password);
  const member=(await s.invoke(admin.token,'users.create',{username:'alice',password})).result;
  const other=(await s.invoke(admin.token,'users.create',{username:'bob',password})).result;
  await s.invoke(admin.token,'policy.save',{userId:other.id,total:1,limits:{'gpu-1':1}});
  const a=await s.login('alice',password),b=await s.login('bob',password);
  const grant=(total=2,limits={'gpu-1':2,'gpu-2':2})=>s.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:s.store.get(member.id).policyVersion,total,limits});
  const submit=(more={})=>s.invoke(a.token,'jobs.submit',{machine:'gpu-1',project:'sample',cards:1,argv:['python','train.py'],key:randomUUID(),...more});
  const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));while(s.reconciling)await new Promise(resolve=>setTimeout(resolve,5));};
  return {get s(){return s},status,admin,a,b,member,other,grant,submit,calls,setState:value=>remoteState=value,offline:value=>offline=value,settle,reopen:async()=>{await settle();s.close();s=await PortalService.open(database,undefined,status,bridge);clearInterval(s.executionTimer);},close:async()=>{await settle();s.close();await rm(dir,{recursive:true,force:true});}};
}
test('GPU quota and administrator controls remain separate',async()=>{
 const f=await fixture();try{
   await assert.rejects(f.submit(),/总额度/);
   await assert.rejects(f.s.invoke(f.a.token,'policy.full',{userId:f.member.id,policyVersion:0}),e=>e.status===403);
   await f.grant();
   const r=await f.s.invoke(f.admin.token,'policy.full',{userId:f.member.id,policyVersion:1});assert.equal(r.result.total,30);assert.equal(r.result.role,'member');assert.equal(Object.keys(r.result.limits).length,4);
 }finally{await f.close();}
});
test('priority updates use the node state instead of refusing a stale portal cache',async()=>{
 const f=await fixture();try{
  await f.grant();const {result}=await f.submit();await f.settle();
  const job=f.s.store.jobs.find(row=>row.id===result.id),spec=structuredClone(job.spec);
  job.state='RUNNING';f.setState('PENDING');
  const value=(await f.s.invoke(f.b.token,'jobs.priority',{jobId:job.id,priority:'P4',extra:'ignored'})).result;
  assert.equal(value.state,'PENDING');assert.deepEqual(job.spec,spec);
  const sent=f.calls.filter(call=>call.operation==='priority');assert.equal(sent.length,1);
  assert.equal(sent[0].args.priority,'P4');assert.equal(sent[0].args.rankOnly,true);
 }finally{await f.close();}
});
test('priority refusals return the node reason without changing the task',async()=>{
 const f=await fixture();try{
  await f.grant();const {result}=await f.submit();await f.settle();
  const job=f.s.store.jobs.find(row=>row.id===result.id),before=structuredClone(job);
  for(const status of [409,503]){
   const error=Object.assign(Error('该任务当前不能调整优先级。'),{status,code:'PRIORITY_REJECTED'});
   f.s.bridge=async()=>{throw error;};
   await assert.rejects(f.s.invoke(f.a.token,'jobs.priority',{jobId:job.id,priority:'P4'}),value=>value===error);
   assert.deepEqual(job,before);
  }
 }finally{await f.close();}
});
test('finished tasks stay unchanged after either a priority refusal or a late node reply',async()=>{
 const f=await fixture();try{
  await f.grant();const {result}=await f.submit();await f.settle();
  const job=f.s.store.jobs.find(row=>row.id===result.id);
  for(const state of ['SUCCEEDED','FAILED','CANCELED']){
   job.state=state;job.finishedAt='2026-01-01T00:00:00.000Z';const before=structuredClone(job);
   for(const error of [Object.assign(Error('任务已经结束。'),{status:409}),Object.assign(Error('bridge timed out'),{status:504,code:'EXECUTOR_TIMEOUT'})]){
    f.s.bridge=async()=>{throw error;};
    await assert.rejects(f.s.invoke(f.a.token,'jobs.priority',{jobId:job.id,priority:'P4'}),value=>value===error);
    assert.deepEqual(job,before);
   }
   f.s.bridge=async()=>({state:'PENDING',schedulerPriority:4});
   assert.equal((await f.s.invoke(f.a.token,'jobs.priority',{jobId:job.id,priority:'P4'})).result.state,state);
   assert.deepEqual(job,before);
  }
 }finally{await f.close();}
});
test('only a lost priority response marks an active adjustment unknown',async()=>{
 const f=await fixture();try{
  await f.grant();const {result}=await f.submit();await f.settle();
  const job=f.s.store.jobs.find(row=>row.id===result.id),error=Object.assign(Error('bridge timed out'),{status:504,code:'EXECUTOR_TIMEOUT'});
  f.s.bridge=async()=>{throw error;};f.s.reconcile=async()=>{};
  await assert.rejects(f.s.invoke(f.a.token,'jobs.priority',{jobId:job.id,priority:'P4'}),value=>value===error);
  assert.equal(job.state,'RUNNING');assert.equal(job.priorityMutable,false);assert.match(job.error,/调整结果未知/);
 }finally{await f.close();}
});
test('atomic concurrent reservations and idempotency do not exceed global or per-host quota',async()=>{
 const f=await fixture();try{
   await f.grant(2,{'gpu-1':1,'gpu-2':2});
   const key=randomUUID();const both=await Promise.all([f.submit({key}),f.submit({key})]);assert.equal(both[0].result.id,both[1].result.id);assert.equal(f.s.store.jobs.length,1);
   assert.equal((await f.submit({key,argv:['python','different.py']})).result.id,both[0].result.id);assert.deepEqual(f.s.store.jobs[0].spec.argv,['python','train.py']);
   await assert.rejects(f.submit(),/所选机器的用卡额度/);
   const requests=await Promise.allSettled([f.submit({machine:'gpu-2'}),f.submit({machine:'gpu-2'})]);assert.equal(requests.filter(r=>r.status==='fulfilled').length,1);assert.equal(usage(f.s.store.jobs,f.member.id),2);
   await assert.rejects(f.grant(1,{'gpu-1':1}),/当前预留/);
 }finally{await f.close();}
});
test('logged-in team members share task state, logs and controls while submit identity stays the actor',async()=>{
 const f=await fixture();try{
   await f.grant();const j=(await f.submit({userId:f.other.id,unknown:'ignored'})).result;await f.settle();
   assert.equal(f.s.store.jobs[0].userId,f.member.id);
   const state=await f.s.invoke(f.b.token,'state');assert.equal(state.state.jobs.length,1);assert.equal(state.state.jobs[0].ownerId,f.member.id);
   assert.equal((await f.s.invoke(f.b.token,'jobs.logs',{jobId:j.id,unknown:'ignored'})).result.text,'private-log');
   await f.s.invoke(f.b.token,'jobs.cancel',{jobId:j.id});assert.equal(usage(f.s.store.jobs,f.member.id),1);
   await f.settle();f.setState('CANCELED');await f.s.reconcile();assert.equal(usage(f.s.store.jobs,f.member.id),0);
 }finally{await f.close();}
});
test('timeouts and LOST retain reservations, restart persists keys, disabled accounts cannot submit',async()=>{
 const f=await fixture();try{
   await f.grant();f.offline(true);const key=randomUUID();await f.submit({key});await f.settle();assert.equal(usage(f.s.store.jobs,f.member.id),1);
   f.offline(false);f.setState('LOST');f.s.store.jobs[0].submissionReconciliation.nextCheckAt=new Date(0).toISOString();await f.s.reconcile();assert.equal(f.s.store.jobs[0].state,'UNKNOWN');assert.equal(usage(f.s.store.jobs,f.member.id),1);
   await f.reopen();const a=await f.s.login('alice',password);assert.equal(f.s.store.jobs[0].key,key);assert.equal(usage(f.s.store.jobs,f.member.id),1);
   const admin=await f.s.login('admin',password);await f.s.invoke(admin.token,'users.enabled',{userId:f.member.id,enabled:false});
   await assert.rejects(f.s.invoke(a.token,'jobs.submit',{}),e=>e.status===401);assert.equal(usage(f.s.store.jobs,f.member.id),1);
   f.setState('SUCCEEDED');await f.s.reconcile();assert.equal(usage(f.s.store.jobs,f.member.id),0);
 }finally{await f.close();}
});
test('manual placement honors physical VRAM; AUTO needs an eligible workspace and stale monitoring may queue',async()=>{
 const f=await fixture();try{
   await f.grant();await assert.rejects(f.submit({machine:'auto',minVramGiB:32}),e=>e.status===409);assert.equal(f.s.store.jobs.length,0);
   const j=(await f.submit({machine:'gpu-1',minVramGiB:32})).result;assert.equal(j.machine,'gpu-1');await f.settle();
   await assert.rejects(f.submit({machine:'gpu-2',minVramGiB:32}),/所选机器.*显存/);
   await writeFile(f.status,'{}');const key=randomUUID(),queued=(await f.submit({key})).result;
   assert.equal(queued.machine,'gpu-1');assert.equal(f.s.store.jobs.find(row=>row.id===queued.id).key,key);
   assert.equal((await f.submit({key})).result.id,queued.id);await f.settle();
 }finally{await f.close();}
});

test('failed reservation persistence never dispatches; malformed UUID is rejected',async()=>{
 const f=await fixture();try{
   await f.grant();await assert.rejects(f.submit({key:'-'.repeat(36)}),/UUID/);
   const save=f.s.save;f.s.save=()=>{throw Error('disk-full-test');};
   await assert.rejects(f.submit(),/disk-full-test/);f.s.save=save;
   await f.settle();assert.equal(f.s.store.jobs.length,0);assert.deepEqual(f.calls,[]);
   await f.reopen();assert.equal(f.s.store.jobs.length,0);
 }finally{await f.close();}
});
test('delete requires paused idle account, retains history and invalidates login',async()=>{
 const f=await fixture();try{
   await f.grant();const j=(await f.submit()).result;await f.settle();
   await assert.rejects(f.s.invoke(f.admin.token,'users.delete',{userId:f.member.id}),/只能删除/);
   await f.s.invoke(f.admin.token,'users.enabled',{userId:f.member.id,enabled:false});
   await assert.rejects(f.s.invoke(f.admin.token,'users.delete',{userId:f.member.id}),/只能删除/);
   f.setState('SUCCEEDED');await f.s.reconcile();await f.s.invoke(f.admin.token,'users.delete',{userId:f.member.id});
   assert.equal(f.s.store.jobs[0].id,j.id);await assert.rejects(f.s.login('alice',password));
   await f.reopen();assert.equal(f.s.store.jobs[0].id,j.id);assert.equal(f.s.store.users.some(u=>u.id===f.member.id),false);
 }finally{await f.close();}
});
test('team terminal targets OCI projects and preserves the input size limit',async()=>{
 const f=await fixture();try{
   await f.grant(1,{'gpu-4':1});
   await assert.rejects(f.s.invoke(f.a.token,'terminal.open',{machine:'gpu-4',key:randomUUID(),clientId:randomUUID()}),/选择项目/);
   await assert.rejects(f.s.invoke(f.a.token,'terminal.exchange',{machine:'gpu-4',project:'sample',id:randomUUID(),clientId:randomUUID(),writerToken:randomUUID(),input:'x'.repeat(13000)}),/输入过长/);
 }finally{await f.close();}
});
