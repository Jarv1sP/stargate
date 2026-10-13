import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {elasticAllocation,elasticCapable,allocationLabel} from '../dist/gpu-allocation.js';
import {elasticFromForm,allocationSummary} from '../dist/gpu-allocation-ui.js';
import {taskTable} from '../dist/execution-ui.js';
import {normalizeJobSubmission} from '../job-submission.mjs';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';

const elastic={minCards:1,globalBatch:256,microBatch:8,autoExpand:true};
const scheduling={rank:'P1',yieldPolicy:'save',restartPolicy:'on-preempt',checkpointable:true};
const base=()=>({machine:MACHINES[0].id,project:'training',cards:8,argv:['python','train.py'],key:randomUUID()});

test('elastic task rows retain rank-only controls and advisory training progress together',()=>{
  const job={id:randomUUID(),name:'elastic-training',username:'alice',machine:MACHINES[0].id,state:'PENDING',
    cards:8,elastic,allowedGpuCounts:[1,2,4,8],actualCards:2,priority:'P1',schedulerPriority:1,canSetPriority:true,
    schedulerPolicy:{yield_policy:'save',restart_policy:'on-preempt'},
    progress:{reported:true,snapshot:{phase:'train',epochsCompleted:1,epochsTotal:10,metrics:{loss:0.1},etaSeconds:null,severity:'info'}}};
  const html=taskTable([job],{admin:true});
  for(const pattern of [/当前 2 张/,/合法卡数 1,2,4,8/,/value="10"/,/轮次 1\/10/,/服务器确认/,/保存后让位/,/data-job-priority=/,/仅改排队顺序/])assert.match(html,pattern);
  assert.doesNotMatch(taskTable([{...job,state:'RUNNING'}],{admin:true}),/data-job-priority=/);
});

test('elastic world sizes keep an exact global batch including unsafe product edges',()=>{
  assert.deepEqual(elasticAllocation(elastic,8,scheduling).allowed,[1,2,4,8]);
  assert.deepEqual(elasticAllocation({minCards:2,globalBatch:240,microBatch:8},8).allowed,[2,3,5,6]);
  assert.deepEqual(elasticAllocation({minCards:1,globalBatch:Number.MAX_SAFE_INTEGER,microBatch:Number.MAX_SAFE_INTEGER},8).allowed,[1]);
  for(const value of [{...elastic,minCards:9},{...elastic,globalBatch:7,microBatch:8},{...elastic,autoExpand:1},{...elastic,globalBatch:1.5},{...elastic,owner:'x'}])assert.throws(()=>elasticAllocation(value,8,scheduling));
  assert.throws(()=>elasticAllocation(elastic,8,{...scheduling,restartPolicy:'never'}),/自动扩卡/);
  for(const policy of [{checkpointable:true,restartPolicy:'on-preempt',yieldPolicy:'now'},{checkpointable:true,restartPolicy:'on-preempt',yieldPolicy:'never'},{checkpointable:'true',restartPolicy:'on-preempt',yieldPolicy:'save'},{...scheduling,unexpected:true}])assert.throws(()=>elasticAllocation(elastic,8,policy),/自动扩卡/);
  assert.deepEqual(elasticAllocation({...elastic,globalBatch:512,minCards:32,autoExpand:false},64).allowed,[32,64]);
  assert.throws(()=>elasticAllocation({...elastic,autoExpand:false},65));
  assert.throws(()=>elasticAllocation({...elastic,minCards:8},8,scheduling),/至少两种/);
});

test('canonical allocation participates in workspace identity without changing omitted-allocation retries',()=>{
  const input=base(),old=normalizeJobSubmission(input,{role:'member'});
  assert.equal(old.digest,createHash('sha256').update(JSON.stringify([input.machine,8,0,input.argv,'train',{project:'training',workspace:true}])).digest('hex'));
  const a=normalizeJobSubmission({...input,elastic,scheduling},{role:'member'});
  assert.deepEqual(a.allowedGpuCounts,[1,2,4,8]);assert.notEqual(a.digest,old.digest);
  assert.notEqual(normalizeJobSubmission({...input,elastic:{...elastic,minCards:2},scheduling},{role:'member'}).digest,a.digest);
  const form=new FormData();for(const [k,v] of Object.entries({elastic:'on','min-cards':'1','global-batch':'256','micro-batch':'8','auto-expand':'on'}))form.set(k,v);
  assert.deepEqual(elasticFromForm(form,8,scheduling),elastic);
  assert.match(allocationSummary({cards:8,elastic,allowedGpuCounts:a.allowedGpuCounts,actualCards:2}),/当前 2 张/);
  assert.match(allocationLabel({cards:8,elastic,allowedGpuCounts:a.allowedGpuCounts,actualCards:2}),/弹性 1–8 张 · 当前 2 张 · 合法卡数 1,2,4,8/);
  assert.equal(elasticCapable({reachable:true,gpuq:{connected:true,capabilities:['elastic-batch-v1']}}),false);
});

test('portal reserves maximum cards while reconciling reduced runs, retries and unknown state',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-elastic-test-')),status=join(dir,'status'),bootstrap=join(dir,'bootstrap'),password=randomUUID()+randomUUID();
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const snapshot=async capabilities=>writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,capabilities,jobs:[]}}))}));
  await snapshot(['priority-policy-v1','preempt-idle-only-v1','console-yield-v1','console-elastic-v1']);
  let state='RUNNING';const calls=[];
  const s=await PortalService.open(join(dir,'db'),bootstrap,status,async(machine,operation,args)=>{calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.workspace')return {project:args.project,state:'AVAILABLE',workspace:{protocol:1,persistent:true}};
    return {state,nodeJobId:'Jtest',assignedIndices:state==='RUNNING'?[0,1]:[]};});clearInterval(s.executionTimer);
  const settle=async()=>{await new Promise(r=>setImmediate(r));while(s.reconciling)await new Promise(r=>setTimeout(r,2));};
  t.after(async()=>{await settle();s.close();await rm(dir,{recursive:true,force:true});});
  const admin=await s.login('admin',password),member=(await s.invoke(admin.token,'users.create',{username:'alice',password})).result,user=await s.login('alice',password);
  await s.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:8,limits:{[MACHINES[0].id]:8}});
  const input={...base(),elastic,scheduling},submit=more=>s.invoke(user.token,'jobs.submit',{...input,...more});
  const [a,b]=await Promise.all([submit({}),submit({})]);assert.equal(a.result.id,b.result.id);await settle();
  assert.equal(s.store.jobs[0].actualCards,2);assert.equal(usage(s.store.jobs,member.id),8);
  const dispatched=calls.filter(c=>c.operation==='sync');assert.equal(dispatched.length,1);assert.equal(dispatched[0].args.job.cards,8);
  await assert.rejects(submit({key:randomUUID()}),/总额度/);await assert.rejects(submit({elastic:{...elastic,minCards:2}}),e=>e.status===409);
  state='LOST';await s.reconcile();assert.equal(usage(s.store.jobs,member.id),8);
  state='SUCCEEDED';await s.reconcile();assert.equal(usage(s.store.jobs,member.id),0);
  await snapshot(['priority-policy-v1','preempt-idle-only-v1','console-yield-v1']);await assert.rejects(submit({key:randomUUID()}),e=>e.status===503);
});
