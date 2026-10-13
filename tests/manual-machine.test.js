import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';

const password='Manual-Machine-Local-Fixture-2026!';
const [selected,other,ungranted]=MACHINES.map(machine=>machine.id);

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
  const calls=[],workspaceStates=new Map();
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args:structuredClone(args)});
    if(operation==='projects.workspace'){
      const state=workspaceStates.get(machine)??'AVAILABLE';
      if(state instanceof Error)throw state;
      return {project:args.project,state,workspace:{protocol:1,persistent:true}};
    }
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
  const submit=(more={})=>invoke('jobs.submit',{machine:selected,project:'paper',cards:1,argv:['python','train.py'],key:randomUUID(),...more});
  async function settle(){
    await new Promise(resolve=>setImmediate(resolve));
    while(service.reconciling)await new Promise(resolve=>setTimeout(resolve,5));
  }
  return {get service(){return service},member,invoke,grant,submit,calls,snapshot,workspaceStates,writeStatus,settle,
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
    await assert.rejects(f.submit({machineSelection:{mode:'auto'}}),error=>error.status===400&&/不要同时指定固定服务器/.test(error.message));
    const inherited=Object.assign(Object.create({machine:selected}),{project:'paper',cards:1,argv:['python','train.py'],key:randomUUID()});
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
    assert.deepEqual(f.calls.map(call=>[call.machine,call.operation]),[[selected,'projects.workspace'],[selected,'sync']]);
    assert.deepEqual(f.calls[0].args,{project:'paper',userId:f.member.id});
    const spec=f.calls[1].args.job;
    assert.equal(spec.workspace,true);assert.equal(spec.project,'paper');
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
      await assert.rejects(f.submit(args),error=>error.status===409&&/所选机器/.test(error.message));
      await f.settle();assert.deepEqual(f.calls,[{machine:selected,operation:'projects.workspace',args:{project:'paper',userId:f.member.id}}]);
      assert.equal(f.service.store.jobs.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
    }finally{await f.close();}
  });
});

test('unknown snapshot state is rejected without dispatch or alternate placement',async()=>{
  const f=await fixture();try{
    await f.grant();f.snapshot.checkedAt='2000-01-01T00:00:00.000Z';await f.writeStatus();
    await assert.rejects(f.submit(),error=>error.status===503&&/已过期/.test(error.message));
    await f.settle();assert.deepEqual(f.calls.map(call=>[call.machine,call.operation]),[[selected,'projects.workspace']]);
    assert.equal(f.service.store.jobs.length,0);
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
    assert.deepEqual(f.calls.map(call=>[call.machine,call.operation]),[[selected,'projects.workspace']]);
    assert.equal(f.service.store.jobs.length,1);
    const explicitOther=(await f.submit({machine:other})).result;
    assert.equal(explicitOther.machine,other);await f.settle();
    assert.equal(usage(f.service.store.jobs,f.member.id),2);
    await assert.rejects(f.submit({machine:other}),error=>error.status===409&&/总额度/.test(error.message));
    assert.equal(f.service.store.jobs.length,2);
  }finally{await f.close();}
});

test('selected workspace must be confirmed without borrowing another available workspace',async t=>{
  const cases=[
    ['DRAFT',409],['SYNCING',409],['UNKNOWN',409],['FAILED',409],
    [Object.assign(Error('local transport timeout'),{status:503}),503],
    [Object.assign(Error('project owner authorization required'),{status:403}),403]
  ];
  for(const [state,status] of cases)await t.test(state instanceof Error?state.message:state,async()=>{
    const f=await fixture();try{
      await f.grant();f.workspaceStates.set(selected,state);f.workspaceStates.set(other,'AVAILABLE');
      await assert.rejects(f.submit(),error=>error.status===status&&
        (status===409?/未占用 GPU/.test(error.message):error===state));
      await f.settle();assert.equal(f.service.store.jobs.length,0);
      assert.deepEqual(f.calls,[{machine:selected,operation:'projects.workspace',args:{project:'paper',userId:f.member.id}}]);
      assert.equal(usage(f.service.store.jobs,f.member.id),0);
    }finally{await f.close();}
  });
});

test('direct data paths remain literal command arguments on the chosen workspace with no data or capacity RPC',async()=>{
  const f=await fixture();try{
    await f.grant();
    f.workspaceStates.set(other,Error('unrelated node must not be queried'));
    const argv=['python','train.py','--train','/data/hdd/sample','--validation','/data/ssd/validation','--output','/outputs/experiment'];
    const result=(await f.submit({argv})).result;
    assert.equal(result.machine,selected);await f.settle();
    assert.deepEqual(f.calls.map(call=>[call.machine,call.operation]),[[selected,'projects.workspace'],[selected,'sync']]);
    assert.deepEqual(f.calls[0].args,{project:'paper',userId:f.member.id});
    const spec=f.calls[1].args.job;
    assert.deepEqual(spec.argv,argv);assert.equal(spec.userId,f.member.id);assert.equal(spec.project,'paper');
    assert.equal(spec.workspace,true);assert.equal(Object.hasOwn(spec,'datasets'),false);
    assert.equal(Object.hasOwn(spec,'release'),false);assert.equal(Object.hasOwn(spec,'hostAdmin'),false);
  }finally{await f.close();}
});

test('retired publication and dataset fields cannot reenable copying or data preparation on a manual target',async()=>{
  const f=await fixture();try{
    await f.grant();
    for(const fields of [{release:'a'.repeat(64)}, {datasets:[{dataset:'sample',version:'b'.repeat(64)}]},
      {datasetReadMode:'warehouse'}, {prepareData:true}]){
      await assert.rejects(f.submit(fields),error=>error.status===400&&/提交参数/.test(error.message));
      assert.equal(f.service.store.jobs.length,0);assert.deepEqual(f.calls,[]);
    }
    assert.equal(usage(f.service.store.jobs,f.member.id),0);
  }finally{await f.close();}
});

test('explicit-machine retries keep workspace digests and durable IDs without rerunning readiness',async t=>{
  for(const argv of [['python','train.py'],['python','train.py','--data','/data/hdd/sample']])await t.test(argv.join(' '),async()=>{
    const f=await fixture();try{
      await f.grant();const key=randomUUID();
      const result=(await f.submit({key,argv})).result;await f.settle();
      const digest=createHash('sha256').update(JSON.stringify([selected,1,0,argv,'train',{project:'paper',workspace:true}])).digest('hex');
      assert.equal(f.service.store.jobs[0].digest,digest);
      await f.reopen();f.calls.length=0;
      f.service.refreshGPUQ=async()=>{throw Error('a persisted idempotent retry must not recheck node status');};
      const again=(await f.submit({key,argv})).result;
      assert.equal(again.id,result.id);assert.equal(again.machine,selected);assert.equal(f.calls.length,0);
      assert.equal(f.service.store.jobs.length,1);assert.equal(f.service.store.jobs[0].digest,digest);
      await assert.rejects(f.submit({key,machine:other,argv}),error=>error.status===409&&/同一提交键/.test(error.message));
      assert.equal(f.service.store.jobs[0].machine,selected);
    }finally{await f.close();}
  });
});

test('legacy auto history remains readable without reinterpreting its old key as a workspace submission',async()=>{
  const f=await fixture();try{
    await f.grant();const key=randomUUID();
    const first=(await f.submit({key})).result;await f.settle();
    const stored=f.service.store.jobs[0];stored.state='SUCCEEDED';
    // Authentic pre-workspace record: no project/workspace in either the
    // public metadata or immutable execution spec, and the original digest.
    for(const value of [stored,stored.spec]){delete value.project;delete value.workspace;}
    stored.digest=createHash('sha256').update(JSON.stringify(['auto',1,0,['python','train.py'],'train'])).digest('hex');
    f.service.save();await f.reopen();f.calls.length=0;
    const history=structuredClone(f.service.store.jobs);
    const state=(await f.invoke('state')).state;
    assert.equal(state.jobs[0].id,first.id);assert.equal(state.jobs[0].machine,selected);
    assert.equal((await f.invoke('jobs.logs',{jobId:first.id})).result.text,'local historical log');
    for(const machine of ['auto',undefined])await assert.rejects(f.submit({key,machine,project:undefined}),error=>error.status===400);
    for(const machine of ['auto',selected])await assert.rejects(f.submit({key,machine}),error=>error.status===409&&/同一提交键/.test(error.message));
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
