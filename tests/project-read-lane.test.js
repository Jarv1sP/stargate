import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';

const machine=MACHINES[0].id;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'project-read-lane-')),password='Local-Project-Read-Fixture-2026!';
  await writeFile(join(dir,'bootstrap'),JSON.stringify({username:'admin',password}));
  const calls=[],service=await PortalService.open(join(dir,'db'),join(dir,'bootstrap'),undefined,async(target,operation,args)=>{
    calls.push({target,operation,args:structuredClone(args)});
    return operation==='projects.quota'?{owner:args.userId,enabled:false,enforcement:null,volumes:null}:{project:'paper',state:'READY',projects:[]};
  });
  for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[key]);
  const login=await service.login('admin',password);
  t.after(async()=>{await service.tail;service.close();await rm(dir,{recursive:true,force:true});});
  return {service,token:login.token,calls};
}
for(const operation of ['projects.list','projects.quota','projects.status','projects.retire.list','projects.retire.status']){
  test(operation+' completes before a stalled mutation, without recomputing the dashboard',async t=>{
    const {service,token,calls}=await fixture(t),blocked=deferred(),write=service.enqueue(()=>blocked.promise);
    await Promise.resolve();
    const args={machine,...(!['projects.list','projects.quota'].includes(operation)?{project:'paper'}:{}),
      ...(['projects.retire.status'].includes(operation)?{key:'11111111-1111-4111-8111-111111111111'}:{})};
    let timer;
    try{
      const reply=await Promise.race([service.invoke(token,operation,args),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('read was blocked by the mutation tail')),500);})]);
      assert.equal(Object.hasOwn(reply,'state'),false);assert.equal(service.pending,1);
      assert.equal(calls.length,1);assert.equal(calls[0].operation,operation);
      assert.equal(calls[0].args.userId,'builtin-admin');assert.equal(calls[0].target,machine);
    }finally{clearTimeout(timer);blocked.resolve();await write;}
  });
}
test('project reads keep login revocation while other-owner selectors and extra fields are accepted',async t=>{
 const {service,token,calls}=await fixture(t);
 assert.equal((await service.invoke(token,'projects.status',{machine,project:'paper',ownerId:'another-user',extra:'ignored'})).result.state,'READY');assert.equal(calls[0].args.ownerId,'another-user');assert.equal(calls[0].args.extra,undefined);
 service.revokeSession(token);await assert.rejects(service.invoke(token,'projects.status',{machine,project:'paper'}),e=>[401,403].includes(e.status));assert.equal(calls.length,1);
});
