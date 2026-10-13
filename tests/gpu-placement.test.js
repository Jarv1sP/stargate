import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gpuPlacement,placementCapable} from '../dist/gpu-allocation.js';
import {placementFromForm,placementSummary} from '../dist/gpu-allocation-ui.js';
import {normalizeJobSubmission,createSubmittedJob} from '../job-submission.mjs';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {taskTable} from '../dist/execution-ui.js';

test('shared task row retains placement, rank, progress and private notification controls',()=>{
  const job={id:randomUUID(),userId:'alice',username:'alice',name:'shared',machine:MACHINES[0].id,state:'PENDING',cards:1,
    placement:{gpuIndices:[3],shared:true,vramMiB:4096,hami:true,smPercent:50},
    priority:'P1',schedulerPriority:1,canSetPriority:true,schedulerPolicy:{yield_policy:'never',restart_policy:'never'},
    progress:{reported:true,snapshot:{phase:'train',epochsCompleted:1,epochsTotal:10,metrics:{},etaSeconds:null,severity:'info'}},
    notifications:{configured:true,enabled:false}};
  const html=taskTable([job],{admin:true,userId:'alice'});
  for(const pattern of [/共享 GPU 3/,/4096 MiB/,/HAMi SM 50%/,/value="10"/,/data-job-priority=/,/data-job-notify=/,/不让位/])assert.match(html,pattern);
  assert.doesNotMatch(taskTable([job],{admin:true,userId:'bob'}),/data-job-notify=/);
});

test('shared explicit rank remains queue-only while fixed placement accepts scoped request modes',()=>{
  const base={machine:MACHINES[0].id,project:'training',cards:1,argv:['python','train.py'],key:randomUUID()},scheduling={rank:'P1',yieldPolicy:'never',restartPolicy:'never',checkpointable:false};
  const shared={gpuIndices:[3],shared:true,vramMiB:4096};
  assert.equal(normalizeJobSubmission({...base,scheduling,placement:shared},{role:'member'}).explicit.rank,'P1');
  for(const mode of ['preempt-save','preempt-now']){
    assert.throws(()=>normalizeJobSubmission({...base,scheduling:{...scheduling,mode},placement:shared},{role:'member'}),/普通排队/);
    const pinned=normalizeJobSubmission({...base,scheduling:{...scheduling,mode},placement:{gpuIndices:[3]}},{role:'member'});
    assert.equal(pinned.explicit.mode,mode);assert.deepEqual(pinned.placement,{gpuIndices:[3],shared:false});
  }
});

test('fixed selection is canonical; shared consent and hardware caps are explicit',()=>{
  assert.deepEqual(gpuPlacement({gpuIndices:[3,1]},2),{gpuIndices:[1,3],shared:false});
  const shared=gpuPlacement({gpuIndices:[3],shared:true,vramMiB:4096,hami:true},1);
  assert.deepEqual(shared,{gpuIndices:[3],shared:true,vramMiB:4096,hami:true,smPercent:100});
  for(const value of [{gpuIndices:[3,3]},{gpuIndices:[-1]},{gpuIndices:[3],shared:true},{gpuIndices:[3],vramMiB:1},{gpuIndices:[3],shared:true,vramMiB:1,hami:true,smPercent:101}])assert.throws(()=>gpuPlacement(value,value.gpuIndices.length));
  assert.throws(()=>gpuPlacement({gpuIndices:[3]},1,{}),/弹性/);
  assert.throws(()=>gpuPlacement({gpuIndices:[3],shared:true,vramMiB:4096},1,null,{yieldPolicy:'now',restartPolicy:'never'}),/自动让位/);
  assert.throws(()=>gpuPlacement({gpuIndices:[3],shared:true,vramMiB:4096},1,null,null,'idle'),/自动让位/);
  for(const policy of [{rank:'P1',yieldPolicy:'now'},{rank:'P1',yieldPolicy:'save',checkpointable:true,restartPolicy:'on-preempt'},{rank:'P1',mode:'preempt-now'},{rank:'P1',unknown:true}])assert.throws(()=>gpuPlacement({gpuIndices:[3],shared:true,vramMiB:4096},1,null,policy));
  assert.deepEqual(gpuPlacement({gpuIndices:[100000]},1),{gpuIndices:[100000],shared:false});
  const host={reachable:true,gpuq:{connected:true,capabilities:['console-placement-v1','console-sharing-v1','console-hami-v1']}};
  assert.equal(placementCapable(host,shared),true);assert.equal(placementCapable(host,{...shared,smPercent:50}),false);
  const form=new FormData();for(const [k,v] of Object.entries({'gpu-placement':'shared','gpu-indices':'3','vram-mib':'4096'}))form.set(k,v);
  assert.deepEqual(placementFromForm(form,1,null,null,'normal'),{gpuIndices:[3],shared:true,vramMiB:4096,hami:false});
  assert.match(placementSummary({placement:shared}),/共享 GPU 3/);
});

test('pinned target and sharing budget change immutable submit identity',()=>{
  const base={machine:MACHINES[0].id,project:'training',cards:2,argv:['python','train.py'],key:randomUUID()},principal={role:'member'};
  const a=normalizeJobSubmission({...base,placement:{gpuIndices:[2,0]}},principal),b=normalizeJobSubmission({...base,placement:{gpuIndices:[0,2]}},principal);
  assert.equal(a.digest,b.digest);assert.notEqual(a.digest,normalizeJobSubmission({...base,placement:{gpuIndices:[0,1]}},principal).digest);
  base.cards=1;const shared={gpuIndices:[3],shared:true,vramMiB:4096};
  assert.notEqual(normalizeJobSubmission({...base,placement:shared},principal).digest,normalizeJobSubmission({...base,placement:{...shared,vramMiB:2048}},principal).digest);
});

test('portal accepts explicit one-sided sharing and rejects unavailable fixed cards/runtime before quota reservation',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-placement-test-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),password=randomUUID()+randomUUID();
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768,memoryUsedMiB:8192,processes:[{pid:123,memoryUsedMiB:8192}]})),gpuq:{connected:true,observeOnly:false,capabilities:['priority-policy-v1','preempt-idle-only-v1','console-placement-v1','console-sharing-v1'],jobs:[]}}))}));
  const calls=[],s=await PortalService.open(join(dir,'db'),bootstrap,status,async(machine,operation,args)=>{calls.push({machine,operation,args});
    if(operation==='projects.workspace')return {project:args.project,state:'AVAILABLE',workspace:{protocol:1,persistent:true}};
    return {state:'PENDING',assignedIndices:[]};});clearInterval(s.executionTimer);
  const settle=async()=>{await new Promise(r=>setImmediate(r));while(s.reconciling)await new Promise(r=>setTimeout(r,2));};
  t.after(async()=>{await settle();s.close();await rm(dir,{recursive:true,force:true});});
  const admin=await s.login('admin',password),member=(await s.invoke(admin.token,'users.create',{username:'alice',password})).result,user=await s.login('alice',password);
  await s.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[MACHINES[0].id]:2}});
  const key=randomUUID(),input={machine:MACHINES[0].id,project:'training',cards:1,argv:['python','small.py'],key,placement:{gpuIndices:[3],shared:true,vramMiB:4096}},submit=more=>s.invoke(user.token,'jobs.submit',{...input,...more});
  const [a,b]=await Promise.all([submit({}),submit({})]);assert.equal(a.result.id,b.result.id);await settle();assert.deepEqual(calls.map(c=>c.operation),['projects.workspace','sync']);
  assert.deepEqual(calls[1].args.job.placement,{gpuIndices:[3],shared:true,vramMiB:4096,hami:false});
  for(const placement of [{gpuIndices:[100],shared:false},{gpuIndices:[3],shared:true,vramMiB:50000},{gpuIndices:[3],shared:true,vramMiB:4096,hami:true}])await assert.rejects(submit({key:randomUUID(),placement}),e=>[409,503].includes(e.status));
  assert.equal(s.store.jobs.length,1);
});

test('current enabled admin shared and exclusive submissions bypass personal counts without bypassing physical admission',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-admin-sharing-test-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),password=randomUUID()+randomUUID();
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768,memoryUsedMiB:8192})),
    gpuq:{connected:true,observeOnly:false,schedulableIndices:[],capabilities:['priority-policy-v1','preempt-idle-only-v1','console-placement-v1','console-sharing-v1'],jobs:[]}}))}));
  const calls=[],s=await PortalService.open(join(dir,'db'),bootstrap,status,async(machine,operation,args)=>{
    calls.push({machine,operation,args});
    if(operation==='projects.workspace')return {project:args.project,state:'AVAILABLE',workspace:{protocol:1,persistent:true}};
    return {state:'PENDING',assignedIndices:[],queueReason:'waiting for shared VRAM budget'};
  });clearInterval(s.executionTimer);
  const settle=async()=>{await new Promise(r=>setImmediate(r));while(s.reconciling)await new Promise(r=>setTimeout(r,2));};
  t.after(async()=>{await settle();s.close();await rm(dir,{recursive:true,force:true});});
  const admin=await s.login('admin',password),member=(await s.invoke(admin.token,'users.create',{username:'alice',password})).result;
  const machine=MACHINES.find(m=>m.id==='amax-5090')||MACHINES[0];
  await s.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{[machine.id]:1}});
  const memberSession=await s.login('alice',password),adminUser=s.store.get(s.principal(admin.token).userId);
  const input={machine:machine.id,project:'training',cards:1,argv:['python','small.py'],placement:{gpuIndices:[2],shared:true,vramMiB:4096}};
  const submit=(token,more={})=>s.invoke(token,'jobs.submit',{...input,key:randomUUID(),...more});
  const reserve=(user,target,count)=>{
    for(let index=0;index<count;index++){
      const request=normalizeJobSubmission({...input,machine:target,key:randomUUID()},{role:user.role});
      const job=createSubmittedJob(request,user,true);job.state='PENDING';s.store.jobs.push(job);
    }
    s.save();
  };
  reserve(adminUser,machine.id,machine.cards);
  const accepted=(await submit(admin.token)).result;await settle();
  assert.equal(s.store.jobs.find(job=>job.id===accepted.id).state,'PENDING');
  const dispatch=calls.find(call=>call.operation==='sync'&&call.args.job.id===accepted.id);
  assert.equal(dispatch.operation,'sync');assert.deepEqual(dispatch.args.job.placement,{...input.placement,hami:false});
  assert.equal(dispatch.args.job.userId,adminUser.id);assert.equal(dispatch.args.job.cards,1);
  for(const target of MACHINES.filter(m=>m.id!==machine.id))reserve(adminUser,target.id,target.cards);
  const globalAccepted=(await submit(admin.token)).result;await settle();
  const state=(await s.invoke(admin.token,'state')).state;
  assert.equal(state.jobs.find(job=>job.id===globalAccepted.id).state,'PENDING');
  assert.match(state.jobs.find(job=>job.id===globalAccepted.id).queueReason,/VRAM budget/);
  // Exemption does not remove any real jobs/leases. A busy GPU queues both modes.
  assert.ok(state.jobs.filter(job=>job.userId===adminUser.id).length>adminUser.total);
  const count=s.store.jobs.length;
  for(const more of [{placement:{gpuIndices:[2]}},{placement:undefined,cards:machine.cards}]){
    const exclusive=(await submit(admin.token,more)).result;await settle();
    assert.equal(s.store.jobs.find(job=>job.id===exclusive.id).state,'PENDING');
    const call=calls.find(call=>call.operation==='sync'&&call.args.job.id===exclusive.id);assert.equal(call.operation,'sync');
    assert.equal(call.args.job.cards,more.cards||1);assert.equal(call.args.job.placement?.shared||false,false);
  }
  assert.equal(s.store.jobs.length,count+2);assert.ok(calls.every(call=>['projects.workspace','sync'].includes(call.operation)));
  const smallest=MACHINES.reduce((a,b)=>a.cards<b.cards?a:b);
  await assert.rejects(submit(admin.token,{machine:smallest.id,placement:undefined,cards:smallest.cards+1}),error=>[400,409].includes(error.status)&&/卡数/.test(error.message));
  const baseline=structuredClone(s.store.users.find(user=>user.id===adminUser.id));
  await assert.rejects(s.invoke(admin.token,'policy.full',{userId:adminUser.id,policyVersion:baseline.policyVersion}),/免个人累计用卡额度.*无需配置个人额度/);
  assert.deepEqual(s.store.users.find(user=>user.id===adminUser.id),baseline);
  for(const placement of [{gpuIndices:[100],shared:true,vramMiB:4096},{gpuIndices:[2],shared:true,vramMiB:50000},{...input.placement,hami:true}])
    await assert.rejects(submit(admin.token,{placement}),error=>[409,503].includes(error.status));
  reserve(s.store.get(member.id),machine.id,1);
  await assert.rejects(submit(memberSession.token),error=>error.status===409&&/额度/.test(error.message));
  await assert.rejects(submit(memberSession.token,{placement:undefined}),error=>error.status===409&&/额度/.test(error.message));
  // Use normal role changes: no exemption survives a new member session.
  await s.invoke(admin.token,'users.role',{userId:member.id,role:'admin'});
  const promoted=await s.login('alice',password);await submit(promoted.token);await settle();
  await s.invoke(admin.token,'users.role',{userId:member.id,role:'member'});
  const demoted=await s.login('alice',password);
  await assert.rejects(submit(demoted.token),error=>error.status===409&&/额度/.test(error.message));
  await s.invoke(admin.token,'users.role',{userId:member.id,role:'admin'});
  const enabledAdmin=await s.login('alice',password);
  await s.invoke(admin.token,'users.enabled',{userId:member.id,enabled:false});
  await assert.rejects(submit(enabledAdmin.token));
});
