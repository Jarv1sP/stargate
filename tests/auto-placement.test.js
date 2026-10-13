import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeJobSubmission} from '../job-submission.mjs';
import {selectMachine} from '../machine-selection.mjs';
import {executionCall,priorityCapable,usage} from '../execution.mjs';
import {MACHINES} from '../dist/model.js';
import {PortalService} from '../portal-service.mjs';

const ids=MACHINES.map(m=>m.id);
const base=()=>({machine:'auto',project:'vision',cards:1,argv:['python','train.py'],key:randomUUID()});
const normalized=(more={})=>normalizeJobSubmission({...base(),...more},{role:'member'});
function fixture(){
  const user={id:'demo-user-1',username:'alice',role:'member',enabled:true,total:8,limits:Object.fromEntries(ids.map(id=>[id,8])),policyVersion:1};
  const calls=[],saved=[],maintained=new Set(),local=new Set(ids);
  const service={store:{jobs:[],users:[user],get:()=>structuredClone(user)},db:{exec(){}},audit(){},
    save(){saved.push(structuredClone(this.store.jobs));},enqueue:async fn=>fn(),reconcile:async()=>{},
    refreshGPUQ:async()=>{},maintenanceFor:id=>maintained.has(id),
    gpuq:{stale:false,hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:24576})),
      gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[],capabilities:[],jobs:[]}}))},
    bridge:async(machine,operation,args)=>{
      calls.push({machine,operation,args});
      if(operation==='projects.list')return {projects:local.has(machine)?[{project:'vision',environmentMode:'oci'}]:[]};
      if(operation==='projects.workspace')return {project:args.project,state:local.has(machine)?'AVAILABLE':'UNAVAILABLE',workspace:{persistent:true}};
      throw Error('unexpected '+operation);
    }};
  const dependencies={store:service.store,refreshGPUQ:async()=>{await service.refreshGPUQ();return service.gpuq;},
    bridge:(...args)=>service.bridge(...args),maintenanceFor:id=>service.maintenanceFor(id),isClosing:()=>service.closing};
  return {service,user,calls,saved,maintained,local,
    select:(request=normalized(),actor=structuredClone(user))=>selectMachine(dependencies,actor,request,priorityCapable,usage),
    submit:args=>executionCall(service,{userId:user.id,username:user.username,role:user.role},'jobs.submit',args)};
}

test('AUTO canonicalizes candidates without altering manual retry identity',()=>{
  const input=base(),auto=normalizeJobSubmission(input,{role:'member'});
  assert.deepEqual(auto.machineSelection,{mode:'auto'});assert.deepEqual(auto.project,{project:'vision',workspace:true});
  assert.equal(Object.hasOwn(auto,'prepareData'),false);
  const withoutMachine={...input};delete withoutMachine.machine;
  const a=normalizeJobSubmission({...withoutMachine,machineSelection:{mode:'auto',candidates:[ids[1],ids[0]]}},{role:'member'});
  const b=normalizeJobSubmission({...withoutMachine,machineSelection:{mode:'auto',candidates:[ids[0],ids[1]]}},{role:'member'});
  assert.equal(a.digest,b.digest);
  const manual=normalizeJobSubmission({...input,machine:ids[0]},{role:'member'});
  assert.equal(Object.hasOwn(manual,'machineSelection'),false);assert.notEqual(manual.digest,auto.digest);
  for(const extra of [{machine:undefined},{machine:ids[0],machineSelection:{mode:'auto'}},{machineSelection:{mode:'fast'}},
    {machineSelection:{mode:'auto',candidates:[]}},{machineSelection:{mode:'auto',candidates:[ids[0],ids[0]]}},{project:undefined}])
    assert.throws(()=>normalized(extra));
});

test('obsolete release, dataset locality and preparation requests are rejected before node calls',async()=>{
  for(const extra of [{release:'a'.repeat(64)},{datasets:[{dataset:'private-data',version:'b'.repeat(64)}]},
    {datasetReadMode:'warehouse'},{prepareData:true}]){
    const f=fixture();await assert.rejects(f.submit({...base(),...extra}),/提交参数/);
    assert.deepEqual(f.calls,[]);assert.deepEqual(f.saved,[]);assert.deepEqual(f.service.store.jobs,[]);
  }
});

test('only existing local OCI workspaces are candidates; selection neither prepares nor copies',async()=>{
  const f=fixture();f.local.clear();f.local.add(ids[2]);
  const result=await f.select();assert.equal(result.machine,ids[2]);
  assert.equal(Object.hasOwn(result,'projectPreparation'),false);assert.equal(Object.hasOwn(result,'trainingStoragePlan'),false);
  assert.ok(f.calls.every(call=>call.operation==='projects.list'&&call.args.userId===f.user.id));
  assert.equal(f.saved.length,0);assert.equal(f.service.store.jobs.length,0);
});

test('AUTO ranks free GPUs only among machines already holding the workspace',async()=>{
  const f=fixture();f.local.delete(ids[1]);f.service.gpuq.hosts[1].gpuq.schedulableIndices=[0,1];
  assert.notEqual((await f.select()).machine,ids[1]);
  f.local.add(ids[1]);const result=await f.select();assert.equal(result.machine,ids[1]);
  assert.equal(result.selectionSummary.reason,'local-workspace-and-resource-rank');assert.equal(result.selectionSummary.gpuPoolAvailable,true);
  assert.equal(Object.hasOwn(result.selectionSummary,'storageVerified'),false);
  assert.ok(f.calls.every(call=>call.operation==='projects.list'));assert.equal(f.saved.length,0);
});

test('free ranking respects cardinality, pinned indices and available personal quota',async()=>{
  const f=fixture();f.service.gpuq.hosts[0].gpuq.schedulableIndices=[0];f.service.gpuq.hosts[1].gpuq.schedulableIndices=[0,1];
  assert.equal((await f.select(normalized({cards:2}))).machine,ids[1]);
  f.service.gpuq.hosts[0].gpuq.schedulableIndices=[0,1];
  f.service.store.jobs.push({userId:f.user.id,machine:ids[0],state:'RUNNING',cards:8});
  f.user.total=16;assert.equal((await f.select(normalized({cards:2}))).machine,ids[1]);
  f.service.store.jobs=[];
  for(const host of f.service.gpuq.hosts)host.gpuq.capabilities=['console-placement-v1'];
  f.service.gpuq.hosts[1].gpuq.schedulableIndices=[2];
  assert.equal((await f.select(normalized({placement:{gpuIndices:[2]}}))).machine,ids[1]);
});

test('a free but heavily queued node does not defeat a free unqueued node',async()=>{
  const f=fixture();for(const host of f.service.gpuq.hosts.slice(0,2))host.gpuq.schedulableIndices=[0,1];
  f.service.gpuq.hosts[0].gpuq.jobs=Array.from({length:31},(_,i)=>({id:'J'+i,state:'PENDING'}));
  assert.equal((await f.select()).machine,ids[1]);
});

test('AUTO admin quota exemption applies to exclusive and shared work even with no free GPUs',async()=>{
  for(const shared of [false,true]){
    const f=fixture();f.user.role='admin';
    for(const host of f.service.gpuq.hosts)host.gpuq.capabilities=['console-placement-v1','console-sharing-v1'];
    const placement={gpuIndices:[0],shared,...(shared?{vramMiB:4096}:{})};
    f.user.limits[ids[1]]=1;f.service.store.jobs.push({id:'existing',userId:f.user.id,machine:ids[1],state:'RUNNING',cards:8});
    f.service.gpuq.hosts[1].gpuq.schedulableIndices=[0];
    assert.equal((await f.select(normalized({placement}))).machine,ids[1]);
    f.service.gpuq.hosts[1].gpuq.schedulableIndices=[];
    const reply=await f.submit({...base(),placement,machineSelection:{mode:'auto',candidates:[ids[1]]}});
    const job=f.service.store.jobs.find(j=>j.id===reply.id);
    assert.equal(reply.state,'SUBMITTING');assert.equal(reply.machine,ids[1]);assert.equal(job.dispatchPending,true);
    assert.equal(Object.hasOwn(reply,'dispatchPending'),false);assert.equal(Object.hasOwn(job,'projectPreparation'),false);
    assert.equal(usage(f.service.store.jobs,f.user.id),9);assert.equal(f.service.store.jobs[0].state,'RUNNING');
    assert.ok(f.calls.every(call=>['projects.list','projects.workspace'].includes(call.operation)));
  }
});

test('admin exemption retains global history bounds before any workspace read',async()=>{
  const f=fixture();f.user.role='admin';
  f.service.store.jobs=Array.from({length:5000},(_,i)=>({id:'historical-'+i,userId:f.user.id,machine:ids[0],state:'SUCCEEDED',cards:1}));
  await assert.rejects(f.submit(base()),error=>error.status===503&&/归档上限/.test(error.message));
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.saved,[]);
});

test('not-yet-observed tasks reduce advisory free capacity without changing recorded targets',async()=>{
  const f=fixture();for(const host of f.service.gpuq.hosts.slice(0,2))host.gpuq.schedulableIndices=[0];
  const first=await f.submit(base()),second=await f.submit(base());
  assert.equal(first.machine,ids[0]);assert.equal(second.machine,ids[1]);
  assert.equal(f.service.store.jobs.length,2);assert.equal(usage(f.service.store.jobs,f.user.id),2);
  assert.equal(first.machine,f.service.store.jobs[0].machine);
  assert.equal(Object.hasOwn(f.service.store.jobs[0].spec,'selectionSummary'),false);
  assert.equal(Object.hasOwn(f.service.store.jobs[0].spec,'machineSelection'),false);
});

test('restricted candidates exclude foreign, maintained, low-VRAM and offline machines',async()=>{
  const f=fixture();f.user.limits[ids[3]]=0;f.maintained.add(ids[1]);
  const request=normalized({machineSelection:{mode:'auto',candidates:[ids[1],ids[2],ids[3]]}});
  assert.equal((await f.select(request)).machine,ids[2]);assert.ok(f.calls.every(call=>call.machine===ids[2]));
  f.service.gpuq.hosts[2].gpus=[];await assert.rejects(f.select(request),/没有已授权/);
  f.service.gpuq.hosts[2].gpus=[{index:0,memoryTotalMiB:4096}];
  await assert.rejects(f.select({...request,minVramGiB:24}),/没有已授权/);
  f.service.gpuq.hosts[2].reachable=false;await assert.rejects(f.select(request),/没有已授权/);
});

test('unknown scheduling capability, stale status and non-OCI workspaces are not accepted',async()=>{
  const f=fixture();await assert.rejects(f.select(normalized({priority:'normal'})),/调度能力/);
  f.service.gpuq.stale=true;await assert.rejects(f.select(),/过期/);f.service.gpuq.stale=false;
  f.service.bridge=async()=>({projects:[{project:'vision',environmentMode:'shared'}]});
  await assert.rejects(f.select(),/没有这个项目工作区/);assert.equal(f.saved.length,0);
});

test('grant revocation and shutdown during workspace reads prevent selection without writes',async()=>{
  for(const change of ['grant','closing']){
    const f=fixture(),bridge=f.service.bridge;
    f.service.bridge=async(...args)=>{const value=await bridge(...args);
      if(change==='grant')f.user.limits[ids[0]]=0;else f.service.closing=true;
      return value;
    };
    await assert.rejects(f.select(),error=>error.status===403);assert.equal(f.saved.length,0);assert.equal(f.service.store.jobs.length,0);
  }
});

test('display-only changes do not revoke effective machine grants',async()=>{
  const f=fixture(),bridge=f.service.bridge;
  f.service.bridge=async(...args)=>{const value=await bridge(...args);f.user.name='Renamed';f.user.approvalNote='reviewed';f.user.policyVersion++;return value;};
  assert.ok(ids.includes((await f.select()).machine));assert.equal(f.saved.length,0);
});

test('AUTO excludes degraded or unknown nodes while allowing healthy nodes with no free GPU',async()=>{
  for(const health of ['degraded','recovering','unknown',undefined]){
    const f=fixture();f.service.gpuq.hosts[0].gpuq.health=health;
    assert.notEqual((await f.select()).machine,ids[0]);
    await assert.rejects(f.select(normalized({machineSelection:{mode:'auto',candidates:[ids[0]]}})),/健康/);
    assert.ok(f.calls.every(call=>call.machine!==ids[0]));assert.equal(f.saved.length,0);
  }
  const f=fixture();assert.equal((await f.select()).machine,ids[0]);
  f.service.gpuq.hosts[0].gpuq.observeOnly=undefined;
  await assert.rejects(f.select(normalized({machineSelection:{mode:'auto',candidates:[ids[0]]}})),/健康/);
});

test('selection never reserves volumes or expands images; workspace admission still handles actual disk refusal',async()=>{
  const f=fixture();assert.ok(ids.includes((await f.select()).machine));
  assert.deepEqual(new Set(f.calls.map(call=>call.operation)),new Set(['projects.list']));assert.equal(f.saved.length,0);
  f.service.bridge=async(_machine,operation)=>operation==='projects.list'?{projects:[{project:'vision',environmentMode:'oci'}]}:{state:'UNAVAILABLE'};
  await assert.rejects(f.submit(base()),/工作区尚未准备完成/);assert.equal(f.service.store.jobs.length,0);
});

test('save failure rolls back the reservation and cannot start copying or dispatch',async()=>{
  const f=fixture();f.service.save=()=>{throw Error('disk full');};
  await assert.rejects(f.submit(base()),/disk full/);assert.equal(f.service.store.jobs.length,0);
  assert.ok(f.calls.every(call=>['projects.list','projects.workspace'].includes(call.operation)));
});

test('AUTO persists one target and recovers its key without probing or moving an offline target',async()=>{
  const f=fixture(),input={...base(),machineSelection:{mode:'auto',candidates:[ids[1]]}};
  const first=await f.submit(input),before=structuredClone(f.service.store.jobs[0]),calls=f.calls.length;
  assert.equal(first.state,'SUBMITTING');assert.equal(usage(f.service.store.jobs,f.user.id),1);
  f.service.store.jobs=JSON.parse(JSON.stringify(f.service.store.jobs));f.local.clear();f.service.gpuq.hosts[1].reachable=false;
  const retried=await f.submit(input);assert.equal(retried.id,first.id);assert.equal(retried.machine,ids[1]);assert.equal(f.calls.length,calls);
  assert.deepEqual(f.service.store.jobs[0],before);
  await assert.rejects(f.submit({...input,machineSelection:{mode:'auto',candidates:[ids[2]]}}),/同一提交键/);
});

test('maintenance starting during workspace admission prevents persistence',async()=>{
  const f=fixture(),bridge=f.service.bridge;
  f.service.bridge=async(machine,operation,args)=>{const result=await bridge(machine,operation,args);if(operation==='projects.workspace')f.maintained.add(machine);return result;};
  await assert.rejects(f.submit(base()),/维护状态已改变/);assert.equal(f.service.store.jobs.length,0);assert.equal(f.saved.length,0);
});

test('real SQLite portal preserves AUTO identity across reopen and serial concurrent retries',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-auto-db-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),database=join(dir,'db');
  const password='Local-Test-Only-Auto-Placement-2026';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const f=fixture();await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:f.service.gpuq.hosts}));
  let service=await PortalService.open(database,bootstrap,status,f.service.bridge);
  const configure=()=>{clearInterval(service.executionTimer);service.reconcile=async()=>{};};
  configure();t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  const {token}=await service.login('alice',password);
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[ids[0]]:2,[ids[1]]:2}});
  const request={...base(),machineSelection:{mode:'auto',candidates:[ids[1]]}};
  const replies=await Promise.all([service.invoke(token,'jobs.submit',request),service.invoke(token,'jobs.submit',request)]);
  assert.equal(replies[0].result.id,replies[1].result.id);assert.equal(service.store.jobs.length,1);assert.equal(usage(service.store.jobs,member.id),1);
  const callCount=f.calls.length;
  service.close();service=await PortalService.open(database,undefined,status,f.service.bridge);configure();
  const next=await service.login('alice',password),retried=(await service.invoke(next.token,'jobs.submit',request)).result;
  assert.equal(retried.id,replies[0].result.id);assert.equal(retried.machine,ids[1]);assert.equal(retried.state,'SUBMITTING');
  assert.equal(f.calls.length,callCount);assert.ok(f.calls.every(call=>['projects.list','projects.workspace'].includes(call.operation)));
});

test('unconfirmed workspace errors never become a claim that a published release is absent',async()=>{
  const f=fixture();f.service.bridge=async()=>{throw Object.assign(Error('节点操作结果未确认'),{status:503,code:'EXECUTOR_UNCONFIRMED'});};
  await assert.rejects(f.submit(base()),error=>error.status===503&&error.code==='SUBMISSION_REJECTED'&&/未确认/.test(error.message)&&!/发布/.test(error.message));
  assert.equal(f.service.store.jobs.length,0);assert.equal(f.saved.length,0);
});

test('confirmed absence asks for manual workspace transfer and never starts automatic copying',async()=>{
  const f=fixture();f.local.clear();
  await assert.rejects(f.select(),error=>error.status===409&&/先把工作区和所需数据传到目标机/.test(error.message));
  assert.ok(f.calls.every(call=>call.operation==='projects.list'));assert.equal(f.saved.length,0);assert.equal(f.service.store.jobs.length,0);
});

test('P3/P4 and HAMi requirements cannot be bypassed by AUTO or an empty free pool',async()=>{
  const f=fixture();
  for(const rank of ['P3','P4'])await assert.rejects(f.submit({...base(),scheduling:{rank}}),error=>error.status===403);
  assert.deepEqual(f.calls,[]);
  const request=normalized({placement:{gpuIndices:[0],shared:true,vramMiB:4096,hami:true,smPercent:50},
    machineSelection:{mode:'auto',candidates:[ids[0]]}});
  const caps=f.service.gpuq.hosts[0].gpuq.capabilities;
  caps.push('console-placement-v1','console-sharing-v1');await assert.rejects(f.select(request),/调度能力/);
  caps.push('console-hami-v1');await assert.rejects(f.select(request),/调度能力/);
  caps.push('console-hami-sm-v1');assert.equal((await f.select(request)).machine,ids[0]);
  assert.equal(f.saved.length,0);
});
