import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {normalizeJobSubmission} from '../job-submission.mjs';

const password='Local-Storage-Test-2026',machine=MACHINES[0].id;
const submission=()=>({machine,project:'vision',cards:1,argv:['python','train.py','--data','/data/hdd/imagenet'],key:randomUUID()});

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'direct-storage-'));
  const bootstrap=join(dir,'bootstrap'),status=join(dir,'status');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({
    id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),
    gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[0],jobs:[]}}))}));
  const calls=[];
  let state='AVAILABLE';
  const service=await PortalService.open(join(dir,'db'),bootstrap,status,async(host,operation,args)=>{
    calls.push({host,operation,args});
    if(operation==='projects.workspace')return {project:args.project,state,workspace:{protocol:1,persistent:true}};
    if(operation==='projects.list')return {projects:[{project:'vision',environmentMode:'oci'}]};
    if(operation==='sync')return {state:'RUNNING',nodeJobId:'J0123456789ab'};
    throw Error('Unexpected dependency: '+operation);
  });
  clearInterval(service.executionTimer);
  const admin=await service.login('admin',password);
  const member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:4,limits:{[machine]:4}});
  const user=await service.login('alice',password);
  const settle=async()=>{await new Promise(r=>setImmediate(r));while(service.reconciling)await new Promise(r=>setTimeout(r,2));};
  t.after(async()=>{await settle();service.close();await rm(dir,{recursive:true,force:true});});
  return {service,calls,user,member,admin,settle,state:value=>state=value,
    submit:args=>service.invoke(user.token,'jobs.submit',args)};
}

test('training uses local paths: no dataset, cache, publication or capacity RPC',async t=>{
  const f=await fixture(t),args=submission();
  const first=(await f.submit(args)).result;
  await f.settle();
  assert.equal(f.service.store.jobs[0].state,'RUNNING');
  assert.equal(first.spec,undefined);
  assert.equal(f.service.store.jobs[0].spec.workspace,true);
  assert.deepEqual(f.calls.map(c=>c.operation),['projects.workspace','sync']);
  assert.equal(Object.hasOwn(f.service.store.jobs[0].spec,'datasets'),false);
  assert.equal(Object.hasOwn(f.service.store.jobs[0].spec,'release'),false);
  const retry=(await f.submit(args)).result;
  assert.equal(retry.id,first.id);
  assert.equal(f.calls.filter(c=>c.operation==='sync').length,1);
  await assert.rejects(f.submit({...args,argv:['false']}),e=>e.status===409);
});

test('obsolete preparation and snapshot fields are refused rather than silently ignored',()=>{
  for(const extra of [{datasets:[]},{prepareData:true},{datasetReadMode:'warehouse'},{release:'a'.repeat(64)}])
    assert.throws(()=>normalizeJobSubmission({...submission(),...extra},{role:'member'}),/提交参数/);
  assert.throws(()=>normalizeJobSubmission({...submission(),project:undefined},{role:'member'}),/项目/);
});

test('workspace refusal does not reserve GPU or start data transfers',async t=>{
  const f=await fixture(t);f.state('UNAVAILABLE');
  await assert.rejects(f.submit(submission()),e=>e.status===409);
  assert.equal(f.service.store.jobs.length,0);
  assert.deepEqual(f.calls.map(c=>c.operation),['projects.workspace']);
});

test('zero authorization cannot open a workspace or submit a task',async t=>{
  const f=await fixture(t);
  await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:1,total:0,limits:{}});
  await assert.rejects(f.submit(submission()));
  assert.deepEqual(f.calls,[]);
  assert.equal(f.service.store.jobs.length,0);
});

test('automatic placement uses existing local workspaces, never starts a copy',async t=>{
  const f=await fixture(t);
  const result=(await f.submit({...submission(),machine:'auto',machineSelection:{mode:'auto',candidates:[machine]}})).result;
  await f.settle();
  assert.equal(result.machine,machine);
  assert.equal(f.service.store.jobs[0].state,'RUNNING');
  assert.deepEqual(f.calls.map(c=>c.operation),['projects.list','projects.workspace','sync']);
});
