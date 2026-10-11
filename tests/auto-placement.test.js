import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {normalizeJobSubmission} from '../job-submission.mjs';
import {selectMachine as selectMachineWithUsage} from '../machine-selection.mjs';
import {executionCall,priorityCapable,usage} from '../execution.mjs';
import {advanceDataPreparation,DATA_PREPARING} from '../dataset-preparation.mjs';
import {MACHINES} from '../dist/model.js';
import {PortalService} from '../portal-service.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectFootprint,trainingPlan,trainingSource} from './training-storage-fixture.mjs';

const ids=MACHINES.map(m=>m.id),release='a'.repeat(64),image='sha256:'+'b'.repeat(64);
const selectMachine=(...args)=>selectMachineWithUsage(...args,usage);
const base=()=>({machine:'auto',project:'vision',release,cards:1,argv:['python','train.py'],key:randomUUID()});
function fixture(){
  const user={id:'u',username:'alice',role:'member',enabled:true,total:8,limits:Object.fromEntries(ids.map(id=>[id,8])),policyVersion:1};
  const probes=[],calls=[],storageCalls=[],saved=[],maintained=new Set(),local=new Set([ids[0]]),incompatible=new Set();
  const service={store:{jobs:[],users:[user],get:()=>structuredClone(user)},db:{exec(){}},audit(){},save(){saved.push(structuredClone(this.store.jobs));},
    enqueue:async f=>f(),reconcile:async()=>{},refreshGPUQ:async()=>{},maintenanceFor:id=>maintained.has(id),
    gpuq:{stale:false,hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:24576})),gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[],capabilities:[],jobs:[]}}))},
    projectCopyProbe:async(owner,machine,ref)=>{
      assert.equal(owner,user.id);probes.push({machine,ref});
      if(ref.release&&!local.has(machine))throw Error('release absent');
      return {protocol:'portable-project-v1',enabled:true,environmentMode:'oci',architecture:incompatible.has(machine)?'arm64':'amd64',project:ref.project,
        releaseReady:!!ref.release,...(ref.release?{release:ref.release,image,...projectFootprint}:{}),sources:ids.filter(id=>id!==machine)};
    },
    prepareProject:async(owner,machine,ref)=>{calls.push({operation:'prepareProject',machine,ref});assert.ok(service.store.jobs.some(j=>j.machine===machine&&j.state===DATA_PREPARING),'target must persist before copy');return {...ref,machine,state:'READY'};},
    bridge:async(machine,operation,args)=>{
      if(['storage.training.plan','datasets.training.status'].includes(operation)){
        storageCalls.push({machine,operation,args});assert.equal(args.userId,user.id);assert.equal(args.hostAdmin,false);
        return operation==='storage.training.plan'?trainingPlan(machine,args):trainingSource(machine,args);
      }
      calls.push({machine,operation,args});if(operation==='projects.verify')return {project:args.project,release:args.release,state:'READY'};throw Error('unexpected '+operation);
    }};
  return {service,user,probes,calls,storageCalls,saved,maintained,local,incompatible};
}
const principal=f=>({userId:f.user.id,username:f.user.username,role:f.user.role});
const normalized=(more={})=>normalizeJobSubmission({...base(),...more},{role:'member'});

test('auto normalization is explicit, canonical and does not contaminate manual retry identity',()=>{
  const input=base(),a=normalizeJobSubmission(input,{role:'member'});
  assert.throws(()=>normalizeJobSubmission({...input,machine:undefined,machineSelection:{mode:'auto'}},{role:'member'}));
  // An omitted machine is supported, a present conflicting/undefined value is not.
  assert.equal(a.machineSelection.mode,'auto');assert.equal(a.prepareData,true);
});

test('auto candidate sets are canonical, immutable and reject malformed or implicit placement',()=>{
  const input=base();delete input.machine;
  const a=normalizeJobSubmission({...input,machineSelection:{mode:'auto',candidates:[ids[1],ids[0]]}},{role:'member'});
  const b=normalizeJobSubmission({...input,machineSelection:{mode:'auto',candidates:[ids[0],ids[1]]}},{role:'member'});
  assert.equal(a.digest,b.digest);
  for(const more of [{machine:ids[0],machineSelection:{mode:'auto'}},{machineSelection:{mode:'fast'}},{machineSelection:{mode:'auto',candidates:[]}},{machineSelection:{mode:'auto',candidates:[ids[0],ids[0]]}},{project:undefined,release:undefined}])assert.throws(()=>normalized(more));
});

test('local READY project wins; selection performs no prepare or GPU writes',async()=>{
  const f=fixture();f.local.clear();f.local.add(ids[2]);
  const result=await selectMachine(f.service,f.user,normalized(),priorityCapable);
  assert.equal(result.machine,ids[2]);assert.equal(result.projectPreparation.from,ids[2]);assert.equal(result.projectPreparation.state,'READY');
  assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);
  assert.equal(f.storageCalls.filter(c=>c.operation==='storage.training.plan').length,ids.length);
  assert.ok(f.storageCalls.every(c=>c.args.hostAdmin===false),'capacity proof retains the member identity');
});

test('AUTO excludes visible foreign READY data and ranks only authorized dataset locations',async()=>{
  const f=fixture(),ref={dataset:'private-data',version:'c'.repeat(64)},bridge=f.service.bridge;let owned=true;
  f.service.bridge=async(machine,operation,args)=>{
    if(operation==='datasets.list')return {datasets:[{dataset:ref.dataset,ownerIds:[owned&&machine===ids[2]?f.user.id:'another-user'],versions:[{version:ref.version,state:'READY',canPrepare:true}]}]};
    return bridge(machine,operation,args);
  };
  f.service.gpuq.hosts[0].gpuq.schedulableIndices=[0,1];
  assert.equal((await selectMachine(f.service,f.user,normalized({datasets:[ref]}),priorityCapable)).machine,ids[2]);
  owned=false;
  await assert.rejects(selectMachine(f.service,f.user,normalized({datasets:[ref]}),priorityCapable),e=>e.status===409&&/可读取/.test(e.message));
  assert.equal(f.service.store.jobs.length,0);assert.equal(f.saved.length,0);
  assert.equal(f.calls.some(c=>['prepareProject','datasets.prepare','sync'].includes(c.operation)),false);
});

test('AUTO retains complete authenticated identity when the shared catalog checks new-node deletion capabilities',async()=>{
  const f=fixture(),ref={dataset:'personal-data',version:'c'.repeat(64)},checked=[],bridge=f.service.bridge;
  f.service.bridge=async(machine,operation,args)=>{
    if(operation!=='datasets.list')return bridge(machine,operation,args);
    assert.equal(operation,'datasets.list');
    assert.equal(args.userId,args.hostAdmin?'builtin-admin':f.user.id);
    return {datasetDelete:1,datasets:[{dataset:ref.dataset,ownerIds:[f.user.id],versions:[{version:ref.version,state:'READY',deletionPermissions:{memberAllowed:!args.hostAdmin}}]}]};
  };
  f.service.datasetDeleteCapabilities=async who=>{
    assert.deepEqual(who,principal(f),'capability account check needs the complete server-derived principal');
    checked.push(who);return {datasetDelete:1};
  };
  assert.equal((await selectMachine(f.service,f.user,normalized({datasets:[ref]}),priorityCapable)).machine,ids[0]);
  assert.ok(checked.length>0);assert.equal(f.saved.length,0);assert.equal(f.service.store.jobs.length,0);
});

test('AUTO prefers a genuinely free pool over a busy local project, without dispatching or copying',async()=>{
  const f=fixture();f.service.gpuq.hosts[0].gpuq.jobs=[{id:'Jbusy',state:'RUNNING',assigned_gpu_indices:[0]}];
  f.service.gpuq.hosts[1].gpuq.schedulableIndices=[0,1];
  const result=await selectMachine(f.service,f.user,normalized(),priorityCapable);
  assert.equal(result.machine,ids[1]);assert.equal(result.projectPreparation.from,ids[0]);assert.equal(result.projectPreparation.state,'WAITING');
  assert.equal(result.selectionSummary.protocol,1);assert.equal(result.selectionSummary.selectedMachine,ids[1]);
  assert.equal(result.selectionSummary.reason,'storage-fit-and-resource-rank');assert.equal(result.selectionSummary.gpuPoolAvailable,true);
  assert.equal(result.selectionSummary.storageVerified,true);
  assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);
  // Reported free indices cannot manufacture a nonexistent/low-VRAM GPU.
  f.service.gpuq.hosts[1].gpuq.schedulableIndices=[99,99];
  assert.equal((await selectMachine(f.service,f.user,normalized(),priorityCapable)).machine,ids[0]);
  f.service.gpuq.hosts[1].gpuq.schedulableIndices=[0];f.service.gpuq.hosts[1].gpus[0].memoryTotalMiB=8192;
  assert.equal((await selectMachine(f.service,f.user,normalized({minVramGiB:24}),priorityCapable)).machine,ids[0]);
});

test('free ranking respects requested cardinality, pinned indices and available personal quota',async()=>{
  const f=fixture();f.service.gpuq.hosts[1].gpuq.schedulableIndices=[0];
  assert.equal((await selectMachine(f.service,f.user,normalized({cards:2}),priorityCapable)).machine,ids[0]);
  f.service.gpuq.hosts[1].gpuq.schedulableIndices=[0,1];
  assert.equal((await selectMachine(f.service,f.user,normalized({cards:2}),priorityCapable)).machine,ids[1]);
  f.user.limits[ids[1]]=2;f.service.store.jobs.push({userId:f.user.id,machine:ids[1],state:'RUNNING',cards:2});
  assert.equal((await selectMachine(f.service,f.user,normalized(),priorityCapable)).machine,ids[0]);
  f.service.store.jobs=[];for(const host of f.service.gpuq.hosts)host.gpuq.capabilities=['console-placement-v1'];
  assert.equal((await selectMachine(f.service,f.user,normalized({placement:{gpuIndices:[2]}}),priorityCapable)).machine,ids[0]);
});

test('a free but heavily queued local node does not defeat another free unqueued node',async()=>{
  const f=fixture();for(const host of f.service.gpuq.hosts.slice(0,2))host.gpuq.schedulableIndices=[0,1];
  f.service.gpuq.hosts[0].gpuq.jobs=Array.from({length:31},(_,i)=>({id:'J'+i,state:'PENDING'}));
  assert.equal((await selectMachine(f.service,f.user,normalized(),priorityCapable)).machine,ids[1]);
});

test('AUTO admin exemption applies to exclusive and shared ranking and preparation on busy nodes',async()=>{
  for(const shared of [false,true]){
    const f=fixture();f.user.role='admin';
    for(const host of f.service.gpuq.hosts)host.gpuq.capabilities=['console-placement-v1','console-sharing-v1'];
    const placement={gpuIndices:[0],shared,...(shared?{vramMiB:4096}:{})};
    f.user.limits[ids[1]]=1;f.service.store.jobs.push({id:'existing',userId:f.user.id,machine:ids[1],state:'RUNNING',cards:8});
    f.service.gpuq.hosts[1].gpuq.schedulableIndices=[0];
    assert.equal((await selectMachine(f.service,f.user,normalized({placement}),priorityCapable)).machine,ids[1],'actual free capacity wins despite personal counts');
    f.service.gpuq.hosts[1].gpuq.schedulableIndices=[];
    const input={...base(),placement,machineSelection:{mode:'auto',candidates:[ids[1]]}};
    const reply=await executionCall(f.service,principal(f),'jobs.submit',input),job=f.service.store.jobs.find(j=>j.id===reply.id);
    assert.equal(reply.state,DATA_PREPARING);assert.equal(reply.machine,ids[1]);
    assert.equal(Object.hasOwn(reply,'dispatchPending'),false);
    await advanceDataPreparation(f.service,job,usage);
    assert.equal(job.state,'SUBMITTING');assert.equal(job.machine,ids[1]);assert.equal(job.dispatchPending,true);
    assert.equal(usage(f.service.store.jobs,f.user.id),9);assert.equal(f.service.store.jobs[0].state,'RUNNING');
    assert.ok(f.calls.every(call=>['prepareProject','projects.verify'].includes(call.operation)));
  }
});

test('admin exemption retains global history and per-user preparation bounds without dispatch',async()=>{
  const f=fixture();f.user.role='admin';
  f.service.store.jobs=Array.from({length:10},(_,i)=>({id:'preparing-'+i,userId:f.user.id,machine:ids[0],state:DATA_PREPARING,cards:1}));
  await assert.rejects(executionCall(f.service,principal(f),'jobs.submit',base()),error=>error.status===429&&/最多保留 10/.test(error.message));
  f.service.store.jobs=Array.from({length:5000},(_,i)=>({id:'historical-'+i,userId:f.user.id,machine:ids[0],state:'SUCCEEDED',cards:1}));
  await assert.rejects(executionCall(f.service,principal(f),'jobs.submit',base()),error=>error.status===503&&/归档上限/.test(error.message));
  assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);
});

test('unobserved preparing targets reduce advisory free capacity; recorded targets never drift',async()=>{
  const f=fixture();for(const h of f.service.gpuq.hosts.slice(0,2))h.gpuq.schedulableIndices=[0];
  const first=await executionCall(f.service,principal(f),'jobs.submit',base());assert.equal(first.machine,ids[0]);
  assert.equal(first.selectionSummary.selectedMachine,ids[0]);assert.equal(first.selectionSummary.storageVerified,true);
  assert.equal(Object.hasOwn(f.service.store.jobs[0].spec,'selectionSummary'),false,'display ranking must not alter the immutable native spec');
  const second=await executionCall(f.service,principal(f),'jobs.submit',base());assert.equal(second.machine,ids[1]);
  assert.equal(f.service.store.jobs.length,2);assert.equal(usage(f.service.store.jobs,f.user.id),0);
  assert.equal(f.calls.length,0);assert.equal(first.machine,f.service.store.jobs[0].machine);
});

test('authorized source can feed restricted candidates; foreign, maintained, low-VRAM, offline and wrong-arch targets excluded',async()=>{
  const f=fixture();f.user.limits[ids[3]]=0;f.incompatible.add(ids[1]);
  const request=normalized({machineSelection:{mode:'auto',candidates:[ids[1],ids[2],ids[3]]}});
  const result=await selectMachine(f.service,f.user,request,priorityCapable);assert.equal(result.machine,ids[2]);assert.equal(result.projectPreparation.from,ids[0]);
  assert.ok(f.probes.every(p=>p.machine!==ids[3]));
  f.maintained.add(ids[2]);await assert.rejects(selectMachine(f.service,f.user,request,priorityCapable),/兼容/);
  f.maintained.clear();f.service.gpuq.hosts[2].gpus=[];await assert.rejects(selectMachine(f.service,f.user,request,priorityCapable));
  f.service.gpuq.hosts[1].reachable=false;await assert.rejects(selectMachine(f.service,f.user,request,priorityCapable),/没有已授权/);
});

test('unsafe scheduling capability, stale status, non-OCI or mismatched immutable images fail closed',async()=>{
  const f=fixture();await assert.rejects(selectMachine(f.service,f.user,normalized({priority:'normal'}),priorityCapable),/调度能力/);
  f.service.gpuq.stale=true;await assert.rejects(selectMachine(f.service,f.user,normalized(),priorityCapable),/过期/);f.service.gpuq.stale=false;
  const probe=f.service.projectCopyProbe;f.service.projectCopyProbe=async(...args)=>({...await probe(...args),environmentMode:'shared'});
  await assert.rejects(selectMachine(f.service,f.user,normalized(),priorityCapable),/未找到/);
  f.local.add(ids[1]);f.service.projectCopyProbe=async(...args)=>({...await probe(...args),image:'sha256:'+(args[1]===ids[0]?'c':'b').repeat(64)});
  await assert.rejects(selectMachine(f.service,f.user,normalized(),priorityCapable),/不一致/);
});

test('machine grant revocation during probing prevents selection without writes',async()=>{
  const f=fixture(),probe=f.service.projectCopyProbe;
  f.service.projectCopyProbe=async(...args)=>{const value=await probe(...args);f.user.limits[ids[0]]=0;return value;};
  await assert.rejects(selectMachine(f.service,structuredClone(f.user),normalized(),priorityCapable),e=>e.status===403);
  assert.equal(f.saved.length,0);assert.equal(f.calls.length,0);
});

test('display metadata and policy revision during probing do not revoke effective machine grants',async()=>{
  const f=fixture(),probe=f.service.projectCopyProbe;
  f.service.projectCopyProbe=async(...args)=>{const value=await probe(...args);f.user.name='Renamed';f.user.approvalNote='reviewed';f.user.policyVersion++;return value;};
  const result=await selectMachine(f.service,structuredClone(f.user),normalized(),priorityCapable);
  assert.ok(ids.includes(result.machine));assert.equal(f.saved.length,0);assert.equal(f.calls.length,0);
});

test('AUTO excludes connected degraded/unknown nodes without treating an empty free pool as unhealthy',async()=>{
  for(const health of ['degraded','recovering','unknown',undefined]){
    const f=fixture();f.service.gpuq.hosts[0].gpuq.health=health;
    const chosen=await selectMachine(f.service,f.user,normalized(),priorityCapable);
    assert.notEqual(chosen.machine,ids[0]);
    await assert.rejects(selectMachine(f.service,f.user,normalized({machineSelection:{mode:'auto',candidates:[ids[0]]}}),priorityCapable),/健康/);
    assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);
  }
  const f=fixture();assert.deepEqual(f.service.gpuq.hosts[0].gpuq.schedulableIndices,[]);
  assert.equal((await selectMachine(f.service,f.user,normalized(),priorityCapable)).machine,ids[0]);
  f.service.gpuq.hosts[0].gpuq.observeOnly=undefined;
  await assert.rejects(selectMachine(f.service,f.user,normalized({machineSelection:{mode:'auto',candidates:[ids[0]]}}),priorityCapable),/健康/);
});

test('dataset locality wins before advisory queue length; missing or unauthorized versions exclude the target',async()=>{
  const f=fixture(),ref={dataset:'data',version:'c'.repeat(64)},bridge=f.service.bridge;
  f.service.bridge=async(machine,operation,args)=>{
    if(operation!=='datasets.list')return bridge(machine,operation,args);
    // Discovery uses one fixed metadata-only service identity; the catalog
    // derives usability from the requesting member's exact owner ACL below.
    assert.equal(operation,'datasets.list');assert.equal(args.userId,'builtin-admin');assert.equal(args.hostAdmin,true);
    return {datasets:[{dataset:ref.dataset,ownerIds:[f.user.id],versions:[{version:ref.version,state:machine===ids[1]?'READY':'REGISTERED',canPrepare:false}]}]};
  };
  f.service.transferCall=async()=>({enabled:true,sources:ids});
  const request=normalized({datasets:[ref],machineSelection:{mode:'auto',candidates:[ids[0],ids[1]]}});
  const result=await selectMachine(f.service,f.user,request,priorityCapable);assert.equal(result.machine,ids[1]);assert.equal(result.projectPreparation.from,ids[0]);
  f.service.bridge=async()=>({datasets:[]});await assert.rejects(selectMachine(f.service,f.user,request,priorityCapable),/数据来源/);
});

test('AUTO excludes an otherwise free GPU target with insufficient project volume',async()=>{
  const f=fixture(),bridge=f.service.bridge;
  f.service.gpuq.hosts[1].gpuq.schedulableIndices=[0,1];
  f.service.bridge=async(machine,operation,args)=>operation==='storage.training.plan'&&machine===ids[1]?trainingPlan(machine,args,{availableBytes:0}):bridge(machine,operation,args);
  const result=await selectMachine(f.service,f.user,normalized(),priorityCapable);
  assert.equal(result.machine,ids[0]);assert.equal(result.trainingStoragePlan.fits,true);
  assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);
});

test('AUTO refuses all unknown/full volume candidates instead of preparing or moving to root disk',async()=>{
  for(const response of ['unknown','full']){
    const f=fixture(),bridge=f.service.bridge;
    f.service.bridge=async(machine,operation,args)=>operation==='storage.training.plan'?
      response==='full'?trainingPlan(machine,args,{availableBytes:0}):{protocol:'dataset-storage-node-v1',usableBytes:2**40}:bridge(machine,operation,args);
    await assert.rejects(selectMachine(f.service,f.user,normalized(),priorityCapable),/已确认足够/);
    assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);assert.equal(f.service.store.jobs.length,0);
  }
});

test('AUTO does not guess a missing READY source OCI image footprint',async()=>{
  const f=fixture(),probe=f.service.projectCopyProbe;
  f.service.projectCopyProbe=async(...args)=>({...await probe(...args),imageUnpackedBytes:undefined});
  await assert.rejects(selectMachine(f.service,f.user,normalized(),priorityCapable),/容量/);
  assert.equal(f.storageCalls.length,0);assert.equal(f.calls.length,0);
});

test('AUTO warehouse mode requires actual local source capability even when cache catalog is READY',async()=>{
  const f=fixture(),bridge=f.service.bridge,ref={dataset:'warehouse-data',version:'c'.repeat(64)};
  f.service.gpuq.hosts[1].gpuq.schedulableIndices=[0];
  f.service.bridge=async(machine,operation,args)=>{
    if(operation==='datasets.training.status'&&args.datasetReadMode==='warehouse'){
      const value=trainingSource(machine,args);return machine===ids[2]?value:{...value,datasetWarehouseRead:0,warehouseReady:false,state:'NOT_READY',reference:undefined};
    }
    if(operation==='datasets.list')throw Error('warehouse selection must not consult cache catalog');
    return bridge(machine,operation,args);
  };
  const result=await selectMachine(f.service,f.user,normalized({datasets:[ref],datasetReadMode:'warehouse'}),priorityCapable);
  assert.equal(result.machine,ids[2]);assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);
});

test('save failure cannot trigger copy and terminal project failure never allocates GPU',async()=>{
  const f=fixture();f.service.save=()=>{throw Error('disk full');};
  await assert.rejects(executionCall(f.service,principal(f),'jobs.submit',base()),/disk full/);
  assert.equal(f.service.store.jobs.length,0);assert.equal(f.calls.length,0);
  f.service.save=()=>{};await executionCall(f.service,principal(f),'jobs.submit',base());const job=f.service.store.jobs[0];
  f.service.prepareProject=async(owner,machine,ref)=>({...ref,machine,state:'FAILED',operationId:'copy-1'});
  await advanceDataPreparation(f.service,job,usage);assert.equal(job.state,'FAILED');assert.equal(usage([job],f.user.id),0);assert.equal(f.calls.length,0);
});

test('auto submission stores one target before copy, reuses key after restart and never drifts on timeout',async()=>{
  const f=fixture(),input={...base(),machineSelection:{mode:'auto',candidates:[ids[1]]}};
  const result=await executionCall(f.service,principal(f),'jobs.submit',input);
  assert.equal(result.machine,ids[1]);assert.equal(result.state,DATA_PREPARING);assert.equal(usage(f.service.store.jobs,f.user.id),0);assert.equal(f.calls.length,0);
  const before=structuredClone(f.service.store.jobs[0]),probes=f.probes.length;
  f.service.store.jobs=JSON.parse(JSON.stringify(f.service.store.jobs));f.local.add(ids[1]);f.service.gpuq.hosts[1].reachable=false;
  const retried=await executionCall(f.service,principal(f),'jobs.submit',input);
  assert.equal(retried.id,result.id);assert.equal(retried.machine,ids[1]);assert.equal(f.probes.length,probes);
  f.service.prepareProject=async()=>{throw Error('lost reply');};
  await assert.rejects(advanceDataPreparation(f.service,f.service.store.jobs[0],usage),/lost reply/);
  assert.deepEqual(f.service.store.jobs[0],before);assert.equal(usage(f.service.store.jobs,f.user.id),0);
  await assert.rejects(executionCall(f.service,principal(f),'jobs.submit',{...input,machineSelection:{mode:'auto',candidates:[ids[2]]}}),/同一提交键/);
});

test('project preparation progress remains no-GPU and promotes exact release once ready',async()=>{
  const f=fixture(),input={...base(),machineSelection:{mode:'auto',candidates:[ids[1]]}};
  await executionCall(f.service,principal(f),'jobs.submit',input);const job=f.service.store.jobs[0];
  f.service.prepareProject=async(owner,machine,ref)=>({...ref,machine,state:'PREPARING',operationId:'copy-1'});
  await advanceDataPreparation(f.service,job,usage);assert.equal(job.state,DATA_PREPARING);assert.equal(job.projectPreparation.operationId,'copy-1');assert.equal(usage([job],f.user.id),0);
  f.service.prepareProject=async(owner,machine,ref)=>({...ref,machine,state:'READY',operationId:'copy-1'});
  await advanceDataPreparation(f.service,job,usage);assert.equal(job.state,'SUBMITTING');assert.equal(job.machine,ids[1]);assert.equal(job.spec.release,release);assert.equal(usage([job],f.user.id),1);
  assert.ok(!Object.hasOwn(job.spec,'machineSelection'));assert.ok(!Object.hasOwn(job.spec,'projectPreparation'));
});

test('AUTO never promotes onto a node which becomes unhealthy after copying',async()=>{
  const f=fixture();await executionCall(f.service,principal(f),'jobs.submit',base());const job=f.service.store.jobs[0];
  f.service.gpuq.hosts.find(h=>h.id===job.machine).gpuq.health='degraded';
  await advanceDataPreparation(f.service,job,usage);assert.equal(job.state,DATA_PREPARING);assert.match(job.queueReason,/服务器恢复/);assert.equal(usage([job],f.user.id),0);
});

test('cancellation, source revocation, maintenance and immutable-source changes prevent promotion',async()=>{
  for(const scenario of ['cancel','source-revoked','maintenance','mutated-source']){
    const f=fixture();await executionCall(f.service,principal(f),'jobs.submit',{...base(),machineSelection:{mode:'auto',candidates:[ids[1]]}});const job=f.service.store.jobs[0];
    let done;const wait=new Promise(resolve=>done=resolve),enter=[];
    f.service.prepareProject=async(owner,machine,ref)=>{enter.push(1);await wait;return {...ref,machine,state:'READY'};};
    const work=advanceDataPreparation(f.service,job,usage);while(!enter.length)await new Promise(r=>setImmediate(r));
    if(scenario==='cancel')job.cancelRequested=true;
    if(scenario==='source-revoked')delete f.user.limits[ids[0]];
    if(scenario==='maintenance')f.maintained.add(ids[1]);
    if(scenario==='mutated-source')job.projectPreparation.from=ids[2];
    done();await work;assert.notEqual(job.state,'SUBMITTING');assert.equal(usage([job],f.user.id),0);
  }
});

test('real SQLite portal persists AUTO identity across reopen and serial concurrent retries',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuq-auto-db-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),database=join(dir,'db');
  const password='Local-Test-Only-Auto-Placement-2026';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const f=fixture();await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:f.service.gpuq.hosts}));
  let service=await PortalService.open(database,bootstrap,status,f.service.bridge);
  const configure=()=>{clearInterval(service.executionTimer);service.reconcile=async()=>{};service.projectCopyProbe=f.service.projectCopyProbe;service.prepareProject=f.service.prepareProject;};
  configure();t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  const {token}=await service.login('alice',password);
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:2,limits:{[ids[0]]:2,[ids[1]]:2}});
  f.user.id=member.id;
  const request={...base(),machineSelection:{mode:'auto',candidates:[ids[1]]}};
  const replies=await Promise.all([service.invoke(token,'jobs.submit',request),service.invoke(token,'jobs.submit',request)]);
  assert.equal(replies[0].result.id,replies[1].result.id);assert.equal(service.store.jobs.length,1);assert.equal(usage(service.store.jobs,member.id),0);
  service.close();service=await PortalService.open(database,undefined,status,f.service.bridge);configure();
  const next=await service.login('alice',password),retried=(await service.invoke(next.token,'jobs.submit',request)).result;
  assert.equal(retried.id,replies[0].result.id);assert.equal(retried.machine,ids[1]);assert.equal(retried.state,DATA_PREPARING);assert.equal(f.calls.length,0);
  assert.ok(f.storageCalls.length>0);assert.ok(f.storageCalls.every(call=>['storage.training.plan','datasets.training.status'].includes(call.operation)));
});


test('AUTO does not misreport an unconfirmed project probe as an unpublished release',async()=>{
  const f=fixture();
  f.service.projectCopyProbe=async()=>{throw Object.assign(Error('PRIVATE runtime guard details'),{status:503,code:'EXECUTOR_UNCONFIRMED'});};
  await assert.rejects(executionCall(f.service,principal(f),'jobs.submit',base()),e=>e.status===503&&e.code==='SUBMISSION_REJECTED'&&/未提交训练/.test(e.message)&&!/请先发布|PRIVATE/.test(e.message));
  assert.equal(f.service.store.jobs.length,0);assert.equal(f.saved.length,0);assert.equal(f.calls.length,0);assert.equal(f.storageCalls.length,0);
});

test('AUTO retains confirmed absence and can use an exact READY source despite another unavailable probe',async()=>{
  const absent=fixture();absent.local.clear();
  await assert.rejects(selectMachine(absent.service,absent.user,normalized(),priorityCapable),e=>e.status===409&&/请先发布项目/.test(e.message));
  const f=fixture(),probe=f.service.projectCopyProbe;
  f.service.projectCopyProbe=async(owner,machine,ref)=>{
    if(machine!==ids[0])throw Object.assign(Error('temporarily unconfirmed'),{status:503});
    return probe(owner,machine,ref);
  };
  const result=await selectMachine(f.service,f.user,normalized(),priorityCapable);
  assert.equal(result.machine,ids[0]);assert.equal(result.projectPreparation.state,'READY');assert.equal(f.saved.length,0);assert.equal(f.calls.length,0);
});
