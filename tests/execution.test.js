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
  const bridge=async(machine,operation,args)=>{calls.push({machine,operation,args});if(offline)throw Error('timeout');if(operation==='logs')return {text:'private-log'};return {state:remoteState,nodeJobId:'J'+args.job.id.replaceAll('-','').slice(0,12),assignedIndices:[0]};};
  let s=await PortalService.open(database,bootstrap,status,bridge);clearInterval(s.executionTimer);
  const admin=await s.login('admin',password);
  const member=(await s.invoke(admin.token,'users.create',{username:'alice',password})).result;
  const other=(await s.invoke(admin.token,'users.create',{username:'bob',password})).result;
  const a=await s.login('alice',password),b=await s.login('bob',password);
  const grant=(total=2,limits={'gpu-1':2,'gpu-2':2})=>s.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:s.store.get(member.id).policyVersion,total,limits});
  const submit=(more={})=>s.invoke(a.token,'jobs.submit',{machine:'gpu-1',cards:1,argv:['python','train.py'],key:randomUUID(),...more});
  const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));while(s.reconciling)await new Promise(resolve=>setTimeout(resolve,5));};
  return {get s(){return s},status,admin,a,b,member,other,grant,submit,calls,setState:value=>remoteState=value,offline:value=>offline=value,settle,reopen:async()=>{await settle();s.close();s=await PortalService.open(database,undefined,status,bridge);clearInterval(s.executionTimer);},close:async()=>{await settle();s.close();await rm(dir,{recursive:true,force:true});}};
}
test('approval required, optimistic grant writes, maximum GPU access is not administrator',async()=>{
 const f=await fixture();try{
   await assert.rejects(f.submit(),/总额度/);
   await assert.rejects(f.s.invoke(f.a.token,'policy.full',{userId:f.member.id,policyVersion:0}),e=>e.status===403);
   await f.grant();await assert.rejects(f.s.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:0,total:1,limits:{'gpu-1':1}}),e=>e.status===409);
   const r=await f.s.invoke(f.admin.token,'policy.full',{userId:f.member.id,policyVersion:1});assert.equal(r.result.total,30);assert.equal(r.result.role,'member');assert.equal(Object.keys(r.result.limits).length,4);
 }finally{await f.close();}
});
test('atomic concurrent reservations and idempotency do not exceed global or per-host quota',async()=>{
 const f=await fixture();try{
   await f.grant(2,{'gpu-1':1,'gpu-2':2});
   const key=randomUUID();const both=await Promise.all([f.submit({key}),f.submit({key})]);assert.equal(both[0].result.id,both[1].result.id);assert.equal(f.s.store.jobs.length,1);
   await assert.rejects(f.submit({key,argv:['python','different.py']}),e=>e.status===409);
   await assert.rejects(f.submit(),/所选机器的用卡额度/);
   const requests=await Promise.allSettled([f.submit({machine:'gpu-2'}),f.submit({machine:'gpu-2'})]);assert.equal(requests.filter(r=>r.status==='fulfilled').length,1);assert.equal(usage(f.s.store.jobs,f.member.id),2);
   await assert.rejects(f.grant(1,{'gpu-1':1}),/当前预留/);
 }finally{await f.close();}
});
test('ownership is enforced for tasks, logs, files; admin can cancel but not impersonate',async()=>{
 const f=await fixture();try{
   await f.grant();const j=(await f.submit()).result;await f.settle();
   for(const operation of ['jobs.logs','jobs.cancel'])await assert.rejects(f.s.invoke(f.b.token,operation,{jobId:j.id}),e=>e.status===403);
   await assert.rejects(f.s.invoke(f.b.token,'files.list',{machine:'gpu-1'}),e=>e.status===403);
   await assert.rejects(f.submit({userId:f.other.id}),/参数无效/);
   const state=await f.s.invoke(f.b.token,'state');assert.equal(state.state.jobs.length,0);
   assert.equal((await f.s.invoke(f.a.token,'jobs.logs',{jobId:j.id})).result.text,'private-log');
   await f.s.invoke(f.admin.token,'jobs.cancel',{jobId:j.id});assert.equal(usage(f.s.store.jobs,f.member.id),1);
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
test('manual placement honors physical VRAM and rejects auto and stale/offline state',async()=>{
 const f=await fixture();try{
   await f.grant();await assert.rejects(f.submit({machine:'auto',minVramGiB:32}),e=>e.status===400);
   const j=(await f.submit({machine:'gpu-1',minVramGiB:32})).result;assert.equal(j.machine,'gpu-1');await f.settle();
   await assert.rejects(f.submit({machine:'gpu-2',minVramGiB:32}),/所选机器.*显存/);
   await writeFile(f.status,'{}');await assert.rejects(f.submit(),e=>e.status===503);
 }finally{await f.close();}
});
test('old administrator invitations are disabled on migration',async()=>{
 const f=await fixture();try{
   const code='old-admin-code';f.s.db.prepare('INSERT INTO invites(role,digest,enabled,uses,max_uses,created_at) VALUES(?,?,1,0,1,?)').run('admin',createHash('sha256').update(code).digest('hex'),new Date().toISOString());
   await f.reopen();await assert.rejects(f.s.register({username:'attacker',password,invite:code}),e=>e.status===403);
 }finally{await f.close();}
});
test('failed reservation persistence never dispatches; malformed UUID is rejected',async()=>{
 const f=await fixture();try{
   await f.grant();await assert.rejects(f.submit({key:'-'.repeat(36)}),/UUID/);
   const save=f.s.save;f.s.save=()=>{throw Error('disk-full-test');};
   await assert.rejects(f.submit(),/disk-full-test/);f.s.save=save;
   await f.settle();assert.equal(f.s.store.jobs.length,0);assert.equal(f.calls.length,0);
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
test('terminal identity is server-owned and root requires administrator, not full GPU grant',async()=>{
 const f=await fixture();try{
   await assert.rejects(f.s.invoke(f.a.token,'terminal.open',{machine:'gpu-4',key:randomUUID()}),e=>e.status===403);
   await f.s.invoke(f.admin.token,'policy.full',{userId:f.member.id,policyVersion:0});
   await assert.rejects(f.s.invoke(f.a.token,'terminal.open',{machine:'gpu-4',key:randomUUID(),hostAdmin:true}),e=>e.status===403);
   await assert.rejects(f.s.invoke(f.a.token,'terminal.open',{machine:'gpu-4',key:randomUUID(),userId:'builtin-admin'}),/参数/);
   await assert.rejects(f.s.invoke(f.a.token,'terminal.exchange',{machine:'gpu-4',id:randomUUID(),clientId:randomUUID(),writerToken:randomUUID(),input:'x'.repeat(13000)}),/输入过长/);
 }finally{await f.close();}
});

test('terminal preparation holds including old HANDED_OFF retry cleanup across reconcile passes',async()=>{
 const f=await fixture();try{
   await f.grant();await f.submit();await f.settle();
   const job=f.s.store.jobs[0];job.state='FAILED';
   job.dataPreparationHold={state:'HANDED_OFF',spec:structuredClone(job.spec)};f.s.save();
   let attempts=0;
   f.s.bridge=async(_machine,operation,args)=>{
     assert.equal(operation,'storage.lease.cancel');assert.deepEqual(args,{job:job.dataPreparationHold.spec});
     attempts++;if(attempts===1)throw Error('reply lost after node cleanup');
     return {jobId:job.id,state:'CANCELED',released:true};
   };
   await f.s.reconcile();assert.equal(job.dataPreparationHold.state,'HANDED_OFF');
   await f.s.reconcile();assert.equal(job.dataPreparationHold.state,'RELEASED');
   await f.s.reconcile();assert.equal(attempts,2);
 }finally{await f.close();}
});
