import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';
import {trainingSource,trainingPlan} from './training-storage-fixture.mjs';

const password='Manual-Machine-Local-Fixture-2026!';
const [selected,other,ungranted]=MACHINES.map(machine=>machine.id);
const reference={dataset:'sample',version:'a'.repeat(64)};
const secondReference={dataset:'validation',version:'b'.repeat(64)};

// This fixture never contacts real executors. Even reconciliation stays within
// the in-memory bridge; the local SQLite state is discarded after each test.
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-manual-machine-'));
  const database=join(dir,'state.sqlite'),bootstrap=join(dir,'bootstrap.json'),statusPath=join(dir,'status.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const snapshot={version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(machine=>({
    id:machine.id,reachable:true,
    gpus:Array.from({length:machine.cards},(_,index)=>({index,memoryTotalMiB:32768})),
    // A node with no immediately schedulable card may queue locally. Another
    // node's larger idle set must not override the user's explicit selection.
    gpuq:{connected:true,observeOnly:false,schedulableIndices:machine.id===selected?[]:[0,1,2,3],jobs:[]}
  }))};
  const writeStatus=()=>writeFile(statusPath,JSON.stringify(snapshot));
  await writeStatus();
  const calls=[],datasetStates=new Map();
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='datasets.status'){
      const state=datasetStates.get(machine+':'+args.dataset)??'READY';
      if(state instanceof Error)throw state;
      return {dataset:args.dataset,version:args.version,state};
    }
    if(operation==='datasets.training.status'){
      const state=datasetStates.get(machine+':'+args.dataset)??'READY';
      if(state instanceof Error)throw state;
      return trainingSource(machine,args,{state,bytes:8,files:1,directories:0});
    }
    if(operation==='datasets.list')return {datasets:[{dataset:reference.dataset,ownerIds:[args.userId],versions:[{version:reference.version}]}]};
    if(operation==='storage.training.plan')return trainingPlan(machine,args);
    if(operation==='logs')return {text:'local historical log'};
    assert.equal(operation,'sync','manual fixture rejects unknown node operations');
    return {state:'PENDING',nodeJobId:'local-'+args.job.id,assignedIndices:[]};
  };
  let service=await PortalService.open(database,bootstrap,statusPath,bridge);
  clearInterval(service.executionTimer);
  let admin=await service.login('admin',password);
  const member=(await service.invoke(admin.token,'users.create',{username:'manual-user',password})).result;
  let login=await service.login('manual-user',password);
  const invoke=(operation,args)=>service.invoke(login.token,operation,args);
  const grant=(total=4,limits={[selected]:2,[other]:2})=>service.invoke(admin.token,'policy.save',{
    userId:member.id,policyVersion:service.store.get(member.id).policyVersion,total,limits
  });
  const submit=(more={})=>invoke('jobs.submit',{machine:selected,cards:1,argv:['python','train.py'],key:randomUUID(),...more});
  async function settle(){
    await new Promise(resolve=>setImmediate(resolve));
    while(service.reconciling)await new Promise(resolve=>setTimeout(resolve,5));
  }
  return {get service(){return service},member,invoke,grant,submit,calls,snapshot,datasetStates,writeStatus,settle,
    reopen:async()=>{
      await settle();service.close();
      service=await PortalService.open(database,undefined,statusPath,bridge);clearInterval(service.executionTimer);
      admin=await service.login('admin',password);login=await service.login('manual-user',password);
    },
    close:async()=>{await settle();service.close();await rm(dir,{recursive:true,force:true});}
  };
}

test('manual target is mandatory and exact; invalid values cannot reserve, refresh or dispatch',async()=>{
  const f=await fixture();try{
    await f.grant();let refreshes=0;
    f.service.refreshGPUQ=async()=>{refreshes++;throw Error('invalid targets must not refresh status');};
    for(const machine of [undefined,null,false,0,'','AUTO',' '+selected,selected+' ',selected.toUpperCase(),'unknown',{},[selected]]){
      await assert.rejects(f.submit({machine}),error=>error.status===400&&/请选择有效的服务器/.test(error.message));
    }
    await assert.rejects(f.submit({machine:'auto'}),error=>error.status===400&&/自动选机需要已发布.*项目和固定版本/.test(error.message));
    const inherited=Object.assign(Object.create({machine:selected}),{cards:1,argv:['python','train.py'],key:randomUUID()});
    await assert.rejects(f.invoke('jobs.submit',inherited),error=>error.status===400&&/请选择有效的服务器/.test(error.message));
    await f.settle();assert.equal(refreshes,0);assert.equal(f.calls.length,0);
    assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
    assert.equal(f.service.db.prepare("SELECT count(*) AS n FROM audit WHERE operation='jobs.submit'").get().n,0);
  }finally{await f.close();}
});

test('explicit server remains selected even when another server has more idle GPUs',async()=>{
  const f=await fixture();try{
    await f.grant();
    const result=(await f.submit()).result;
    assert.equal(result.machine,selected);assert.equal(result.state,'SUBMITTING');
    assert.equal(result.cards,1);assert.equal(Object.hasOwn(result,'assignedIndices'),false);
    await f.settle();
    assert.equal(f.service.store.jobs[0].machine,selected);assert.equal(f.service.store.jobs[0].state,'PENDING');
    assert.deepEqual(f.calls.map(call=>[call.machine,call.operation]),[[selected,'sync']]);
    const spec=f.calls[0].args.job;
    assert.equal(spec.cards,1);assert.equal(Object.hasOwn(spec,'assignedIndices'),false);
    assert.equal(Object.hasOwn(spec,'gpuIndices'),false);assert.equal(Object.hasOwn(spec,'machine'),false);
  }finally{await f.close();}
});

test('a selected-node outage or insufficient physical capacity never falls back to a healthy node',async t=>{
  const cases=[
    ['unreachable',host=>{host.reachable=false;},{}],
    ['GPUQ disconnected',host=>{host.gpuq.connected=false;},{}],
    ['observe only',host=>{host.gpuq.observeOnly=true;},{}],
    ['missing GPU inventory',host=>{host.gpus=[];},{}],
    ['insufficient VRAM',host=>{host.gpus.forEach(gpu=>{gpu.memoryTotalMiB=24576;});},{minVramGiB:32}],
    ['insufficient physical cards',host=>{host.gpus=host.gpus.slice(0,1);},{cards:2}],
  ];
  for(const [name,change,args] of cases)await t.test(name,async()=>{
    const f=await fixture();try{
      await f.grant();change(f.snapshot.hosts.find(host=>host.id===selected));await f.writeStatus();
      await assert.rejects(f.submit({...args,datasets:[reference]}),error=>error.status===409&&/所选机器/.test(error.message));
      await f.settle();assert.equal(f.calls.length,0);
      assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
    }finally{await f.close();}
  });
});

test('unknown snapshot state is rejected without dispatch or alternate placement',async()=>{
  const f=await fixture();try{
    await f.grant();f.snapshot.checkedAt='2000-01-01T00:00:00.000Z';await f.writeStatus();
    await assert.rejects(f.submit(),error=>error.status===503&&/已过期/.test(error.message));
    await f.settle();assert.equal(f.calls.length,0);assert.equal(f.service.store.jobs.length,0);
  }finally{await f.close();}
});

test('selected-node authorization cannot be borrowed from another authorized machine',async()=>{
  const f=await fixture();try{
    await f.grant(2,{[other]:2});
    for(const machine of [selected,ungranted])await assert.rejects(f.submit({machine}),error=>error.status===403);
    await f.settle();assert.equal(f.calls.length,0);assert.equal(f.service.store.jobs.length,0);
    assert.equal((await f.submit({machine:other})).result.machine,other);
  }finally{await f.close();}
});

test('full selected-node quota does not spill over and global quota still spans all machines',async()=>{
  const f=await fixture();try{
    await f.grant(2,{[selected]:1,[other]:2});
    await f.submit();await f.settle();f.calls.length=0;
    await assert.rejects(f.submit(),error=>error.status===409&&/所选机器的用卡额度/.test(error.message));
    assert.equal(f.calls.length,0);assert.equal(f.service.store.jobs.length,1);
    const explicitOther=(await f.submit({machine:other})).result;
    assert.equal(explicitOther.machine,other);await f.settle();
    assert.equal(usage(f.service.store.jobs,f.member.id),2);
    await assert.rejects(f.submit({machine:other}),error=>error.status===409&&/总额度/.test(error.message));
    assert.equal(f.service.store.jobs.length,2);
  }finally{await f.close();}
});

test('selected-node readiness waits through transport failure without borrowing another READY replica',async t=>{
  const cases=[
    ['REGISTERED',409],['STAGING',409],['PREPARING',409],['FAILED',409],
    [Error('local transport timeout'),503],[Error('dataset owner authorization required'),403]
  ];
  for(const [state,status] of cases)await t.test(state instanceof Error?state.message:state,async()=>{
    const f=await fixture();try{
      await f.grant();f.datasetStates.set(selected+':sample',state);
      if(status===503){
        const {result}=await f.submit({datasets:[reference]});assert.equal(result.state,'PREPARING_DATA');
        assert.equal(f.service.store.jobs.length,1);assert.equal(result.machine,selected);
        assert.deepEqual(f.calls.map(call=>[call.machine,call.operation]),[[selected,'datasets.status'],[selected,'datasets.list']]);
      }else{
        await assert.rejects(f.submit({datasets:[reference]}),error=>error.status===status&&/未占用 GPU/.test(error.message));
        await f.settle();assert.equal(f.service.store.jobs.length,0);
        assert.deepEqual(f.calls.map(call=>[call.machine,call.operation]),[[selected,'datasets.status']]);
      }
      assert.ok(f.calls.every(call=>call.machine===selected&&call.args.userId===f.member.id&&call.args.hostAdmin===false));
      assert.equal(usage(f.service.store.jobs,f.member.id),0);
    }finally{await f.close();}
  });
});

test('all dataset references are checked only on the chosen node with owner identity',async()=>{
  const f=await fixture();try{
    await f.grant();
    f.datasetStates.set(other+':sample',Error('unrelated node must not be queried'));
    f.datasetStates.set(other+':validation','REGISTERED');
    const result=(await f.submit({datasets:[reference,secondReference]})).result;
    assert.equal(result.machine,selected);await f.settle();
    const checks=f.calls.filter(call=>call.operation==='datasets.status');
    // Initial readiness, submission capacity and first-dispatch capacity each
    // recheck the exact selected-node identity; no alternate READY is borrowed.
    assert.equal(checks.length,6);assert.ok(f.calls.every(call=>call.machine===selected));
    assert.deepEqual(checks.map(call=>call.args),Array.from({length:3},()=>[reference,secondReference]
      .map(ref=>({...ref,userId:f.member.id,hostAdmin:false}))).flat());
    const footprints=f.calls.filter(call=>call.operation==='datasets.training.status');
    assert.deepEqual(footprints.map(call=>call.args),Array.from({length:2},()=>[reference,secondReference]
      .map(ref=>({userId:f.member.id,hostAdmin:false,...ref,datasetReadMode:'cache'}))).flat());
    const plans=f.calls.filter(call=>call.operation==='storage.training.plan');
    assert.equal(plans.length,2);
    for(const plan of plans)assert.deepEqual(plan.args,{userId:f.member.id,hostAdmin:false,
      datasets:[reference,secondReference],datasetReadMode:'cache',projectFootprint:null,
      datasetFootprints:[reference,secondReference].map(ref=>({...ref,bytes:8,files:1,directories:0,manifestBytes:100}))});
    assert.deepEqual(f.calls.find(call=>call.operation==='sync').args.job.datasets,[reference,secondReference]);
  }finally{await f.close();}
});

test('explicit-machine retries keep legacy digests and durable IDs without rerunning readiness',async t=>{
  for(const datasets of [undefined,[reference]])await t.test(datasets?'dataset job':'job without datasets',async()=>{
    const f=await fixture();try{
      await f.grant();const key=randomUUID();
      const result=(await f.submit({key,datasets})).result;await f.settle();
      const digest=createHash('sha256').update(JSON.stringify([selected,1,0,['python','train.py'],'train',...(datasets?[datasets]:[])])).digest('hex');
      assert.equal(f.service.store.jobs[0].digest,digest);
      await f.reopen();f.calls.length=0;
      f.service.refreshGPUQ=async()=>{throw Error('a persisted idempotent retry must not recheck node status');};
      const again=(await f.submit({key,datasets:datasets||[]})).result;
      assert.equal(again.id,result.id);assert.equal(again.machine,selected);assert.equal(f.calls.length,0);
      assert.equal(f.service.store.jobs.length,1);assert.equal(f.service.store.jobs[0].digest,digest);
      await assert.rejects(f.submit({key,machine:other,datasets}),error=>error.status===409&&/同一提交键/.test(error.message));
      assert.equal(f.service.store.jobs[0].machine,selected);
    }finally{await f.close();}
  });
});

test('legacy auto history remains readable without allowing auto retries or rewriting its identity',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID();
    const first=(await f.submit({key})).result;await f.settle();
    const stored=f.service.store.jobs[0];stored.state='SUCCEEDED';
    stored.digest=createHash('sha256').update(JSON.stringify(['auto',1,0,['python','train.py'],'train'])).digest('hex');
    f.service.save();await f.reopen();f.calls.length=0;
    const history=structuredClone(f.service.store.jobs);
    const state=(await f.invoke('state')).state;
    assert.equal(state.jobs[0].id,first.id);assert.equal(state.jobs[0].machine,selected);
    assert.equal((await f.invoke('jobs.logs',{jobId:first.id})).result.text,'local historical log');
    for(const machine of ['auto',undefined])await assert.rejects(f.submit({key,machine}),error=>error.status===400);
    await assert.rejects(f.submit({key}),error=>error.status===409&&/同一提交键/.test(error.message));
    assert.deepEqual(f.service.store.jobs,history);
    assert.deepEqual(f.calls.map(call=>[call.machine,call.operation]),[[selected,'logs']]);
  }finally{await f.close();}
});

test('concurrent same-key manual submissions reserve once and cannot reinterpret the machine',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID();
    const requests=await Promise.allSettled([f.submit({key}),f.submit({key}),f.submit({key,machine:other})]);
    assert.equal(requests[0].status,'fulfilled');assert.equal(requests[1].status,'fulfilled');
    assert.equal(requests[0].value.result.id,requests[1].value.result.id);
    assert.equal(requests[2].status,'rejected');assert.equal(requests[2].reason.status,409);
    await f.settle();assert.equal(f.service.store.jobs.length,1);assert.equal(usage(f.service.store.jobs,f.member.id),1);
    assert.ok(f.calls.every(call=>call.machine===selected));
  }finally{await f.close();}
});
