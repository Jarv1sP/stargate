import test from 'node:test';
import assert from 'node:assert/strict';
import {MACHINES} from '../dist/model.js';
import {trainingDatasetCapabilities} from '../training-datasets.mjs';

const machine=MACHINES[0].id;
const other=MACHINES[1].id;
const cold=MACHINES[3].id;
const ref={dataset:'sample',version:'a'.repeat(64)},args={machine,...ref};
function fixture(){
  const user={id:'demo-user-1',username:'member',role:'member',enabled:true,limits:{[machine]:1,[other]:1,[cold]:1}},calls=[];
  const principal={userId:user.id,username:user.username,role:user.role};
  const status={protocol:'dataset-training-source-v1',machine,...ref,datasetReadMode:'warehouse',
    datasetWarehouseRead:1,authority:'hdd',state:'READY',warehouseReady:true,reference:{...ref},
    source:{root:'/private/warehouse'},bytes:12,files:1,directories:0};
  const service={store:{get:id=>{if(id!==user.id)throw Error('no account');return structuredClone(user);}},
    gpuq:{stale:false,hosts:[{id:machine,reachable:true},{id:cold,reachable:true}]},
    maintenanceFor:()=>false,bridge:async(m,operation,request)=>{
      calls.push({machine:m,operation,args:request});await service.onReply?.();
      if(service.error)throw service.error;return structuredClone(status);
    }};
  const call=(request=args,actor=principal)=>trainingDatasetCapabilities(service,actor,request);
  return {user,principal,status,service,calls,call};
}
const view=(reason=null,target=machine)=>({protocol:1,machine:target,...ref,warehouse:{available:reason===null,reason}});

test('exact member-bound READY projection exposes no source or admission fields',async()=>{
  const f=fixture();f.service.resolveDataset=()=>assert.fail('never consult cache');
  assert.deepEqual(await f.call(),view());
  assert.deepEqual(f.calls,[{machine,operation:'datasets.training.status',args:{userId:f.user.id,hostAdmin:false,...ref,datasetReadMode:'warehouse'}}]);
  assert.equal(JSON.stringify(await f.call()).includes('/private/warehouse'),false);
  assert.equal(JSON.stringify(await f.call()).includes('authority'),false);
  f.status.reference.dataset='physical';assert.deepEqual(await f.call(),view());
});

test('only exactly three fixed-version input fields are accepted, with zero RPC on invalid input',async()=>{
  for(const request of [null,[],{}, {...args,version:'latest'},{...args,dataset:'../sample'},
    {...args,path:'/host'},{...args,userId:'other'},{...args,hostAdmin:true},{...args,authority:'hdd'},
    {...args,datasetReadMode:'warehouse'},{...args,readMode:'cache'},{...args,reference:ref},
    {...args,machine:null},{...args,dataset:42},{...args,version:['a'.repeat(64)]}]){
    const f=fixture();await assert.rejects(f.call(request),e=>e.status===400);assert.equal(f.calls.length,0);
  }
});

test('account, principal and machine authorization are checked before any probe, including admins',async()=>{
  for(const change of [f=>{f.user.enabled=false;},f=>{f.user.limits={};},f=>{f.principal.userId='other';},
    f=>{f.principal.username='another';},f=>{f.principal.role='admin';}]){
    const f=fixture();change(f);await assert.rejects(f.call(),e=>e.status===403);assert.equal(f.calls.length,0);
  }
  const f=fixture();await assert.rejects(f.call({...args,machine:'unknown-host'}),e=>e.status===403);
  f.user.role='admin';f.principal.role='admin';assert.deepEqual(await f.call(),view());
  assert.equal(f.calls[0].args.hostAdmin,false);
});

test('any authorized host is probed regardless of GPU class; actual maintenance skips the probe',async()=>{
  for(const target of [other,cold]){
    const f=fixture();f.status.machine=target;assert.deepEqual(await f.call({...args,machine:target}),view(null,target));
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].machine,target);
  }
  const f=fixture();f.service.maintenanceFor=()=>true;assert.deepEqual(await f.call(),view('maintenance'));assert.equal(f.calls.length,0);
});

test('only a matching explicit no-authority/no-READY receipt proves machine-not-warehouse',async()=>{
  for(const state of [undefined,'NOT_READY']){
    const f=fixture();Object.assign(f.status,{datasetWarehouseRead:0,authority:null,warehouseReady:false,state});delete f.status.reference;
    assert.deepEqual(await f.call(),view('machine-not-warehouse'));
    for(const changed of [{authority:'hdd'},{warehouseReady:true},{reference:ref},{state:'READY'},
      {state:'UNKNOWN'},{machine:other},{dataset:'another'},{version:'b'.repeat(64)},{protocol:undefined}]){
      const u=fixture();Object.assign(u.status,f.status,changed);if(!Object.hasOwn(changed,'reference'))delete u.status.reference;
      assert.deepEqual(await u.call(),view('unverified'));
    }
  }
});

test('only a fresh exact negative reachability snapshot can be called offline',async()=>{
  const f=fixture();f.service.gpuq.hosts[0].reachable=false;
  assert.deepEqual(await f.call(),view('offline'));assert.equal(f.calls.length,0);
  for(const snapshot of [{stale:true,hosts:[{id:machine,reachable:false}]},
    {stale:false,hosts:[]},{stale:false,hosts:[{id:machine}]},{}]){
    const u=fixture();u.service.gpuq=snapshot;u.service.error=Error('transport unknown');
    assert.deepEqual(await u.call(),view('unverified'));assert.equal(u.calls.length,1);
  }
});

test('refreshed collector failures are unknown, not offline; refreshed policy is checked',async()=>{
  const f=fixture();f.service.refreshGPUQ=async()=>{throw Error('read failed');};
  assert.deepEqual(await f.call(),view('unverified'));assert.equal(f.calls.length,0);
  const u=fixture();u.service.refreshGPUQ=async()=>{u.user.limits={};};
  await assert.rejects(u.call(),e=>e.status===403);assert.equal(u.calls.length,0);
});

test('node ACL denial stays forbidden while arbitrary failures cannot imply absence or offline',async()=>{
  const f=fixture();f.service.error=Object.assign(Error('denied'),{status:403});
  assert.deepEqual(await f.call(),view('forbidden'));assert.equal(f.calls[0].args.hostAdmin,false);
  for(const error of [Error('timeout'),Object.assign(Error('not found'),{status:404}),
    Object.assign(Error('capacity'),{status:409}),Object.assign(Error('unavailable'),{status:503})]){
    const u=fixture();u.service.error=error;assert.deepEqual(await u.call(),view('unverified'));
  }
});

test('fixed envelope and proven missing protocol capability are differentiated from malformed receipts',async()=>{
  for(const changed of [{protocol:'legacy'}]){
    const f=fixture();Object.assign(f.status,changed);assert.deepEqual(await f.call(),view('protocol-unavailable'));
  }
  const f=fixture();delete f.service.bridge;assert.deepEqual(await f.call(),view('protocol-unavailable'));
  for(const changed of [{protocol:undefined},{machine:other},{dataset:'foreign'},{version:'b'.repeat(64)},
    {datasetReadMode:'cache'},{datasetWarehouseRead:undefined},{datasetWarehouseRead:true},{authority:'../host'},
    {warehouseReady:undefined},{state:'REGISTERED'},{reference:{...ref,path:'/root'}},
    {reference:{...ref,version:'b'.repeat(64)}},{reference:null},{warehouseReady:false}]){
    const u=fixture();Object.assign(u.status,changed);assert.deepEqual(await u.call(),view('unverified'));
  }
});

test('not-ready requires a current explicit negative warehouse proof, never a hot READY inference',async()=>{
  const f=fixture();f.status.state='NOT_READY';f.status.warehouseReady=false;delete f.status.reference;
  assert.deepEqual(await f.call(),view('not-ready'));
  f.status.reference={...ref};assert.deepEqual(await f.call(),view('unverified'));
  delete f.status.reference;f.status.warehouseReady=true;assert.deepEqual(await f.call(),view('unverified'));
});

test('policy/login identity changes during success and failure reads reject instead of publishing stale capability',async()=>{
  for(const failed of [false,true])for(const change of [f=>{f.user.enabled=false;},f=>{f.user.limits={};},
    f=>{f.user.username='renamed';},f=>{f.user.role='admin';}]){
    const f=fixture();f.service.onReply=()=>change(f);if(failed)f.service.error=Object.assign(Error('denied'),{status:403});
    await assert.rejects(f.call(),e=>e.status===403);assert.equal(f.calls.length,1);
  }
});

test('maintenance and closing during an in-flight read cannot enable warehouse mode',async()=>{
  const f=fixture();f.service.onReply=()=>{f.service.maintenanceFor=()=>true;};
  assert.deepEqual(await f.call(),view('maintenance'));
  const u=fixture();u.service.onReply=()=>{u.service.closing=true;};await assert.rejects(u.call(),e=>e.status===503);
});


test('warehouse capability tolerates display and approval changes without granting any extra authority',async()=>{
  for(const change of [f=>{f.user.name='Renamed';},f=>{f.user.approvalNote='Updated';},f=>{f.user.policyVersion=2;}]){
    const f=fixture();f.service.onReply=()=>change(f);
    assert.deepEqual(await f.call(),view());assert.equal(f.calls.length,1);
  }
});
