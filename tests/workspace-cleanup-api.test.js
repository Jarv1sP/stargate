import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'workspace-cleanup-api-')),password='Cleanup-Fixture-Password-2026!';
  await writeFile(join(dir,'bootstrap'),JSON.stringify({username:'admin',password}));
  await writeFile(join(dir,'status'),JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:[],gpuq:{connected:true,observeOnly:false,jobs:[]}}))}));
  const calls=[];let fail=false;
  const service=await PortalService.open(join(dir,'db'),join(dir,'bootstrap'),join(dir,'status'),async(machine,operation,args)=>{
    calls.push({machine,operation,args});if(fail)throw Error('response lost');
    return {protocol:1,key:args.key,path:args.path,recursive:args.recursive,state:operation.endsWith('remove-plan')?'PREVIEW':'QUEUED',freedBytes:null};
  });
  clearInterval(service.executionTimer);
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:1,limits:{'gpu-1':1}});
  const user=await service.login('alice',password);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  return {service,calls,admin,user,member,lose:()=>{fail=true;}};
}

test('private cleanup forwards only authenticated owner and exact original key, never retries a lost write',async t=>{
  const f=await fixture(t),key=randomUUID(),args={machine:'gpu-1',path:'old',recursive:true,key};
  const result=await f.service.invoke(f.user.token,'datasets.workspace.remove',args);
  assert.equal(result.result.key,key);assert.equal(result.result.freedBytes,null);
  assert.deepEqual(f.calls,[{machine:'gpu-1',operation:'datasets.workspace.remove',args:{path:'old',recursive:true,key,userId:f.member.id,hostAdmin:false}}]);
  f.lose();await assert.rejects(f.service.invoke(f.user.token,'datasets.workspace.remove',args),/response lost/);
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].args.key,key);
  assert.equal(f.service.store.jobs.length,0);
});

test('cleanup cannot name another owner, whole root, host path or ungranted machine',async t=>{
  const f=await fixture(t),key=randomUUID();
  for(const patch of [{userId:'someone-else'},{hostAdmin:true},{project:'other'},{machine:'gpu-2'},{path:'.'},{path:'../other'},{path:'/data1'},{recursive:'true'},{key:'not-a-uuid'}]){
    await assert.rejects(f.service.invoke(f.user.token,'datasets.workspace.remove',{machine:'gpu-1',path:'old',recursive:true,key,...patch}));
  }
  await assert.rejects(f.service.invoke('invalid','datasets.workspace.remove-status',{machine:'gpu-1',key}),e=>e.status===401);
  assert.equal(f.calls.length,0);
  await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,policyVersion:1,total:0,limits:{}});
  await assert.rejects(f.service.invoke(f.user.token,'datasets.workspace.remove',{machine:'gpu-1',path:'old',recursive:true,key}));
  assert.equal(f.calls.length,0);
});

test('maintenance preserves preview and original-key lookup but prevents new cleanup dispatch',async t=>{
  const f=await fixture(t),key=randomUUID();
  await f.service.invoke(f.admin.token,'maintenance.set',{scope:'all',enabled:true,revision:0,reason:'fixture maintenance'});
  for(const [operation,args] of [['remove-plan',{path:'old',recursive:true}],['remove-status',{key}]]){
    await f.service.invoke(f.user.token,'datasets.workspace.'+operation,{machine:'gpu-1',...args});
  }
  assert.equal(f.calls.length,2);
  await assert.rejects(f.service.invoke(f.user.token,'datasets.workspace.remove',{machine:'gpu-1',path:'old',recursive:true,key}));
  assert.equal(f.calls.length,2);
});
