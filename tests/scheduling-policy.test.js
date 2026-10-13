import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {schedulingPolicy,yieldCapable} from '../dist/scheduling-policy.js';
import {schedulingFields,schedulingFromForm,schedulingSummary} from '../dist/scheduling-ui.js';
import {usage} from '../execution.mjs';

const save={rank:'P1',yieldPolicy:'save',restartPolicy:'on-preempt',checkpointable:true};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-explicit-policy-')),database=join(dir,'db'),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),password=randomUUID()+randomUUID();
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const snapshot=async(capabilities=['priority-policy-v1','preempt-idle-only-v1','console-yield-v1'],stale=false)=>writeFile(status,JSON.stringify({version:1,checkedAt:new Date(Date.now()-(stale?240000:0)).toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,capabilities,jobs:[]}}))}));
  await snapshot();const calls=[];
  const bridge=async(machine,operation,args)=>{calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.workspace')return {project:args.project,state:'AVAILABLE',workspace:{protocol:1,persistent:true}};
    return {state:'PENDING',nodeJobId:'Jtest',schedulerPriority:Number(args.job.scheduling?.rank[1]??2),assignedIndices:[]};};
  const s=await PortalService.open(database,bootstrap,status,bridge);clearInterval(s.executionTimer);
  const admin=await s.login('admin',password),member=(await s.invoke(admin.token,'users.create',{username:'alice',password})).result,user=await s.login('alice',password);
  await s.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:4,limits:{[MACHINES[0].id]:4}});
  const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));while(s.reconciling)await new Promise(resolve=>setTimeout(resolve,2));};
  t.after(async()=>{await settle();s.close();await rm(dir,{recursive:true,force:true});});
  const submit=(scheduling=save,more={},token=user.token)=>s.invoke(token,'jobs.submit',{machine:MACHINES[0].id,project:'training',cards:1,argv:['python','train.py'],key:randomUUID(),scheduling,...more});
  return {s,admin,user,member,submit,settle,snapshot,calls};
}

test('rank never implies yielding; all five ranks exist with retained admin boundary',()=>{
  for(let n=0;n<5;n++)assert.deepEqual(schedulingPolicy({rank:'P'+n},true),{rank:'P'+n,yieldPolicy:'never',restartPolicy:'never',checkpointable:false});
  for(const rank of ['P3','P4'])assert.throws(()=>schedulingPolicy({rank}),e=>e.status===403);
  assert.deepEqual(schedulingPolicy(save),save);
  for(const value of [null,[],{rank:0},{rank:'P5'},{yieldPolicy:'legacy'},{yieldPolicy:'save'},{checkpointable:1},{yieldPolicy:'now',restartPolicy:'on-preempt',checkpointable:true},{rank:'P1',userId:'admin'}])assert.throws(()=>schedulingPolicy(value,true));
});

test('UI fields and form parsing preserve explicit consent; unknown capability is not available',()=>{
  assert.doesNotMatch(schedulingFields(),/value="P[34]"/);assert.match(schedulingFields(true),/value="P4"/);
  const form=new FormData();assert.equal(schedulingFromForm(form),null);
  for(const [key,value] of Object.entries({'custom-policy':'on','queue-rank':'P1','yield-policy':'save','restart-policy':'on-preempt',checkpointable:'on'}))form.set(key,value);
  assert.deepEqual(schedulingFromForm(form),save);form.delete('checkpointable');assert.throws(()=>schedulingFromForm(form));
  for(const host of [null,{}, {reachable:true,gpuq:{connected:true,capabilities:[]}}])assert.equal(yieldCapable(host),false);
  assert.match(schedulingSummary({scheduling:save}),/P1 · 让位 save · 恢复 on-preempt/);
  assert.match(schedulingSummary({scheduling:{...save,rank:'<script>'}}),/&lt;script&gt;/);
});

test('API persists independent policy, retains quota and deduplicates immutable retries',async t=>{
  const f=await fixture(t),key=randomUUID();
  const [a,b]=await Promise.all([f.submit(save,{key}),f.submit(save,{key})]);
  assert.equal(a.result.id,b.result.id);assert.equal(f.s.store.jobs.length,1);
  await f.settle();const spec=f.s.store.jobs[0].spec;
  assert.deepEqual(spec.scheduling,save);assert.equal(Object.hasOwn(spec,'priority'),false);assert.equal(Object.hasOwn(spec,'preemptIdleOnly'),false);
  assert.equal(usage(f.s.store.jobs,f.member.id),1);
  await assert.rejects(f.submit({...save,rank:'P2'},{key}),e=>e.status===409);
  await assert.rejects(f.submit({...save,restartPolicy:'never'},{key}),e=>e.status===409);
  const dispatched=f.calls.filter(c=>c.operation==='sync');assert.equal(dispatched.length,1);
  assert.ok(dispatched.every(c=>JSON.stringify(c.args.job.scheduling)===JSON.stringify(save)));
  // Cancelling is still a request; no premature quota release.
  await f.s.invoke(f.user.token,'jobs.cancel',{jobId:a.result.id});assert.equal(usage(f.s.store.jobs,f.member.id),1);
});

test('API rejects unauthorized rank, missing adapter, mixed preset and unknown capability before reservation',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.submit({...save,rank:'P4'}),e=>e.status===403);
  for(const [policy,more] of [[{...save,checkpointable:false},{}],[save,{priority:'idle'}],[{...save,hostAdmin:true},{}]])await assert.rejects(f.submit(policy,more),e=>e.status===400);
  await f.snapshot(['priority-policy-v1','preempt-idle-only-v1']);await assert.rejects(f.submit(),e=>e.status===503);
  await f.snapshot(undefined,true);await assert.rejects(f.submit(),e=>e.status===503);
  assert.equal(f.s.store.jobs.length,0);assert.ok(f.calls.every(c=>c.operation==='projects.workspace'));
});

test('administrator can select P3/P4 without forcing a victim or restarting from scratch',async t=>{
  const f=await fixture(t);
  for(const rank of ['P3','P4'])assert.equal((await f.submit({rank}, {},f.admin.token)).result.scheduling.yieldPolicy,'never');
  await f.settle();const dispatched=f.calls.filter(c=>c.operation==='sync');
  assert.equal(new Set(dispatched.map(c=>c.args.job.id)).size,2);assert.equal(f.s.store.jobs.length,2);
  assert.ok(dispatched.every(c=>c.args.job.scheduling.restartPolicy==='never'));
});

test('request modes canonicalize aliases and queue retains the original immutable retry identity',async t=>{
  assert.deepEqual(schedulingPolicy({...save,mode:'queue'}),save);
  for(const [alias,mode] of [['preempt1','preempt-save'],['preempt2','preempt-now']])assert.deepEqual(schedulingPolicy({...save,mode:alias}),{...save,mode});
  for(const mode of [true,1,null,'bad'])assert.throws(()=>schedulingPolicy({...save,mode}));
  const f=await fixture(t),key=randomUUID();
  const original=(await f.submit(save,{key})).result;
  assert.equal((await f.submit({...save,mode:'queue'},{key})).result.id,original.id);
  assert.equal(f.s.store.jobs.length,1);assert.equal(Object.hasOwn(f.s.store.jobs[0].spec.scheduling,'mode'),false);
});

test('hard requester modes require fresh opt-in capability before reserving quota or dispatching',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.submit({...save,mode:'preempt1'}),e=>e.status===503);
  assert.equal(f.s.store.jobs.length,0);assert.ok(f.calls.every(c=>c.operation==='projects.workspace'));
  await f.snapshot(['priority-policy-v1','preempt-idle-only-v1','console-yield-v1','preempt-opt-in-only-v1']);
  const key=randomUUID(),policy={...save,mode:'preempt-now'};
  const result=(await f.submit(policy,{key})).result;
  await f.settle();const dispatched=f.calls.filter(c=>c.operation==='sync');assert.equal(dispatched.length,1);assert.deepEqual(dispatched[0].args.job.scheduling,policy);
  assert.equal((await f.submit({...save,mode:'preempt2'},{key})).result.id,result.id);
  await assert.rejects(f.submit({...save,mode:'preempt1'},{key}),e=>e.status===409);
  await f.s.invoke(f.user.token,'jobs.cancel',{jobId:result.id});assert.equal(usage(f.s.store.jobs,f.member.id),1);
});
