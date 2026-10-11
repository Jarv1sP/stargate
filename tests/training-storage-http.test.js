import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';
import {trainingSource,trainingPlan} from './training-storage-fixture.mjs';

const machine=MACHINES[0].id,ref={dataset:'training-data',version:'a'.repeat(64)};
const password='Storage-HTTP-Local-Fixture-2026!';
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'training-storage-http-'));
  const bootstrap=join(directory,'bootstrap.json'),status=join(directory,'status.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,
    gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,health:'ok',observeOnly:false,jobs:[]}}))}));
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port,f={calls:[],availableBytes:2**40,unknown:false};
  const bridge=async(target,operation,args)=>{
    f.calls.push({machine:target,operation,args:structuredClone(args)});
    if(operation===f.busyOperation)throw Object.assign(Error('/private/device?ticket=secret'),{status:503,code:'TRAINING_ADMISSION_BUSY'});
    if(operation==='datasets.status')return {...ref,state:'READY'};
    if(operation==='projects.verify')return {project:args.project,release:args.release,state:'READY'};
    if(operation==='datasets.training.status')return trainingSource(target,args);
    if(operation==='storage.training.plan'){
      if(f.unknown)throw Object.assign(Error('/private/device unknown'),{status:503,trainingStorage:{privatePath:'/host'}});
      return trainingPlan(target,args,{availableBytes:f.availableBytes});
    }
    throw Error('Unexpected fixture RPC: '+operation);
  };
  const {server,service}=await createPortalServer({database:join(directory,'database'),bootstrap,statusPath:status,origin,secure:false,bridge});
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);service.reconciling=true;
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{await service.tail;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const post=async(path,body,token)=>{
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const admin=(await post('/api/login',{username:'admin',password})).data;
  const call=(operation,args={},token=admin.token)=>post('/api/call',{operation,args},token);
  await call('users.create',{username:'storage-member',password});
  const member=(await post('/api/login',{username:'storage-member',password})).data;
  assert.equal((await call('policy.save',{userId:member.principal.userId,policyVersion:0,total:1,limits:{[machine]:1}})).status,200);
  return Object.assign(f,{service,call,member,admin});
}

test('HTTP warehouse capability is a bounded authenticated read, including maintenance',async t=>{
  const f=await fixture(t),args={machine,...ref};
  let release;const original=f.service.tail;f.service.tail=new Promise(resolve=>release=resolve);
  try{
    const response=await Promise.race([f.call('datasets.training.capabilities',args,f.member.token),new Promise((_,reject)=>setTimeout(()=>reject(Error('capability blocked by mutation tail')),1000))]);
    assert.equal(response.status,200);
    assert.deepEqual(response.data.result,{protocol:1,machine,...ref,warehouse:{available:true,reason:null}});
    assert.equal(response.data.state,undefined);
  }finally{release();f.service.tail=original;}
  f.service.datasetReadPending=4;
  assert.equal((await f.call('datasets.training.capabilities',args,f.member.token)).status,429);
  f.service.datasetReadPending=0;
  assert.equal((await f.call('maintenance.set',{scope:'all',revision:0,enabled:true,reason:'local fixture'})).status,200);
  const before=f.calls.length,response=await f.call('datasets.training.capabilities',args,f.member.token);
  assert.equal(response.status,200);assert.equal(response.data.result.warehouse.reason,'maintenance');
  assert.equal(response.data.result.warehouse.available,false);assert.equal(f.calls.length,before);
});

test('HTTP capacity refusal exposes only verified usable counters and never creates a job',async t=>{
  const f=await fixture(t);f.availableBytes=1024+4096;
  const submit=()=>f.call('jobs.submit',{machine,cards:1,argv:['true'],key:randomUUID(),datasets:[ref]},f.member.token);
  const response=await submit();assert.equal(response.status,409);assert.equal(response.data.code,'SUBMISSION_REJECTED');
  assert.deepEqual(response.data.storage,{protocol:1,reasonCode:'TRAINING_STORAGE_INSUFFICIENT',requiredBytes:73728,availableBytes:4096,
    volumes:[{roles:['project','cache'],requiredBytes:73728,availableBytes:4096,requiredInodes:32,availableInodes:998976}]});
  const text=JSON.stringify(response.data);
  for(const privateField of ['volumeDeviceId','requestSHA256','trainingStoragePlan','activeReservedBytes','owner'])assert.equal(text.includes(privateField),false);
  assert.equal(f.service.store.jobs.length,0);assert.ok(f.calls.every(call=>call.machine===machine));
  assert.equal(f.calls.some(call=>['sync','datasets.prepare'].includes(call.operation)),false);
  f.unknown=true;
  const unknown=await submit();assert.equal(unknown.status,503);assert.equal(unknown.data.code,'SUBMISSION_REJECTED');
  assert.deepEqual(unknown.data.storage,{protocol:1,reasonCode:'TRAINING_STORAGE_UNKNOWN',requiredBytes:null,availableBytes:null,volumes:[]});
  assert.equal(JSON.stringify(unknown.data).includes('/private/device'),false);assert.equal(JSON.stringify(unknown.data).includes('/host'),false);
  assert.equal(f.service.store.jobs.length,0);
});

test('HTTP capability rejects foreign identity fields and missing machine grants before RPC',async t=>{
  const f=await fixture(t),args={machine,...ref},before=f.calls.length;
  assert.equal((await f.call('datasets.training.capabilities',args,'0'.repeat(64))).status,401);
  for(const extra of [{userId:'other'},{hostAdmin:true},{path:'/host'}])
    assert.equal((await f.call('datasets.training.capabilities',{...args,...extra},f.member.token)).status,400);
  assert.equal((await f.call('datasets.training.capabilities',{...args,machine:MACHINES[1].id},f.member.token)).status,403);
  assert.equal(f.calls.length,before);
});

test('HTTP project probe errors are safe 503/403 refusals with no persisted task or private transport details',async t=>{
  const f=await fixture(t);
  // Isolate the new capacity read after the existing project owner/READY
  // preflight. Those preflight operations remain separate from this contract.
  f.service.ociProjectAdmission=async(target,owner,project)=>{
    assert.equal(target,machine);assert.equal(owner,f.member.principal.userId);assert.equal(project,'vision');
  };
  for(const status of [400,403,503]){
    f.service.projectCopyProbe=async()=>{throw Object.assign(Error('podman --root /private/owner/root token=secret-fixture timeout'),{status});};
    const response=await f.call('jobs.submit',{machine,cards:1,argv:['true'],key:randomUUID(),project:'vision',release:ref.version},f.member.token);
    assert.equal(response.status,status===403?403:503);assert.equal(response.data.code,'SUBMISSION_REJECTED');
    assert.equal(JSON.stringify(response.data).includes('/private/owner'),false);assert.equal(JSON.stringify(response.data).includes('secret-fixture'),false);
    if(status===403)assert.equal(response.data.storage,undefined);
    else assert.deepEqual(response.data.storage,{protocol:1,reasonCode:'TRAINING_STORAGE_UNKNOWN',requiredBytes:null,availableBytes:null,volumes:[]});
    assert.equal(f.service.store.jobs.length,0);
    assert.equal(f.calls.some(call=>['sync','projects.copy.begin','datasets.prepare'].includes(call.operation)),false);
  }
});

test('HTTP training read contention keeps BUSY and the same unregistered submission key without fallback',async t=>{
  const f=await fixture(t),key=randomUUID();
  f.service.ociProjectAdmission=async()=>{};
  f.service.projectCopyProbe=async()=>({protocol:'portable-project-v1',enabled:true,environmentMode:'oci',architecture:'amd64',
    project:'vision',release:ref.version,image:'sha256:'+'b'.repeat(64),releaseReady:true,codeBytes:1,codeEntries:1,imageUnpackedBytes:1024,imageEntries:1024});
  // Do not admit a write: every attempt stops at one of the two read phases.
  for(const mode of ['warehouse','cache']){
    for(const operation of ['datasets.training.status','storage.training.plan']){
      f.busyOperation=operation;const before=f.calls.length;
      const response=await f.call('jobs.submit',{machine,cards:1,argv:['true'],key,project:'vision',release:ref.version,datasets:[ref],datasetReadMode:mode},f.member.token);
      assert.equal(response.status,503,JSON.stringify(response.data));assert.equal(response.data.code,'TRAINING_ADMISSION_BUSY');
      assert.match(response.data.error,/数据正在使用/);assert.doesNotMatch(response.data.error,/能力.*未确认|容量.*未确认|private|ticket|secret/);
      assert.equal(response.data.storage,undefined);assert.equal(f.service.store.jobs.length,0);
      const calls=f.calls.slice(before);
      assert.equal(calls.filter(c=>c.operation===operation).length,1);
      assert.equal(calls.some(c=>['sync','datasets.prepare','datasets.list','datasets.catalog'].includes(c.operation)),false);
    }
  }
});
