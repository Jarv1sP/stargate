import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {seedAccounts} from './fixtures/accounts.mjs';
const machine=MACHINES[0].id,tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'admission-priority-')),bootstrap=join(root,'bootstrap'),calls=[],gates=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Synthetic-Priority-Fixture!'}));
  let handler,work;
  const service=await PortalService.open(join(root,'db'),bootstrap,undefined,async(host,operation,args)=>{
    calls.push({host,operation,args:structuredClone(args)});
    if(handler){const result=await handler(operation,args);if(result)return result;}
    return {state:operation==='cancel'?'CANCELED':'PENDING',nodeJobId:'J'+args.job.id.replaceAll('-','').slice(0,12),assignedIndices:[]};
  });clearInterval(service.executionTimer);service.reconciling=true;
  const users=['alice','bob'].map(id=>({id,username:id,name:id,role:'member',enabled:true,total:1,limits:{[machine]:1}}));seedAccounts(service,...users);
  const tokens=Object.fromEntries(users.map(u=>[u.id,service.issueSession({userId:u.id,username:u.username,role:u.role})]));
  const call=async(op,args,user='alice')=>(await service.invoke(tokens[user],op,args)).result;
  t.after(async()=>{for(const gate of gates)gate.resolve();await work;await service.tail;service.close();await rm(root,{recursive:true,force:true});});
  return {service,calls,call,handler:fn=>handler=fn,gate:()=>{const gate=deferred();gates.push(gate);return gate;},
    submit:(policy,user='alice')=>call('jobs.submit',{machine,project:'fixture',cards:1,key:randomUUID(),argv:['true'],
      ...(typeof policy==='string'?{priority:policy}:{scheduling:{yieldPolicy:'never',...policy}})},user),
    occupying(){const id=randomUUID(),job={id,key:randomUUID(),userId:'alice',machine,project:'fixture',name:'occupied',cards:1,
      state:'RUNNING',nodeJobId:'J0123456789ab',assignedIndices:[0],createdAt:new Date().toISOString(),
      spec:{id,userId:'alice',project:'fixture',cards:1,argv:['true']}};service.store.jobs.push(job);service.save(job);return job;},
    start(){service.reconciling=false;return work=service.reconcile();}};
}
const dispatched=(f,jobs)=>[...new Set(f.calls.filter(c=>c.operation==='sync'&&jobs.some(j=>j.id===c.args.job.id)).map(c=>c.args.job.id))];

test('quota freed by a point observation admits P4 ahead of earlier P0',async t=>{
  const f=await fixture(t),old=f.occupying(),low=await f.submit({rank:'P0'}),high=await f.submit({rank:'P4'});
  f.handler(async(_op,args)=>args.job.id===old.id?{state:'SUCCEEDED',nodeJobId:old.nodeJobId}:undefined);
  await f.call('jobs.watch',{jobId:old.id});await f.start();
  assert.deepEqual(dispatched(f,[low,high]),[high.id]);assert.equal(f.service.job(low.id).dispatchPending,true);
});

test('a higher rank that already waited for quota is reconsidered after an observation frees it in the same pass',async t=>{
  const f=await fixture(t),old=f.occupying(),low=await f.submit({rank:'P0'}),high=await f.submit({rank:'P4'}),entered=f.gate(),release=f.gate();
  f.handler(async(_op,args)=>{if(args.job.id===old.id){entered.resolve();await release.promise;return {state:'SUCCEEDED',nodeJobId:old.nodeJobId};}});
  const work=f.start();await entered.promise;await tick();await tick();assert.deepEqual(dispatched(f,[low,high]),[]);
  release.resolve();await work;assert.deepEqual(dispatched(f,[low,high]),[high.id]);
});

test('equal-priority first dispatch remains FIFO',async t=>{
  const f=await fixture(t),first=await f.submit({rank:'P2'}),second=await f.submit({rank:'P2'});await f.start();
  assert.deepEqual(dispatched(f,[first,second]),[first.id]);
});

test('priority presets use the same ordering as explicit ranks',async t=>{
  const f=await fixture(t),low=await f.submit('idle'),high=await f.submit('high');await f.start();
  assert.deepEqual(dispatched(f,[low,high]),[high.id]);
});

test('one member waiting for quota does not block a runnable lower-priority member',async t=>{
  const f=await fixture(t),old=f.occupying(),high=await f.submit({rank:'P4'}),low=await f.submit({rank:'P0'},'bob');
  f.handler(async(_op,args)=>args.job.id===old.id?{state:'RUNNING',nodeJobId:old.nodeJobId,assignedIndices:[0]}:undefined);
  await f.start();assert.deepEqual(dispatched(f,[high,low]),[low.id]);assert.equal(f.service.job(high.id).dispatchPending,true);
});

test('cancellation retains its urgent path and is never dispatched as training',async t=>{
  const f=await fixture(t),low=await f.submit({rank:'P0'}),high=await f.submit({rank:'P4'});
  await f.call('jobs.cancel',{jobId:high.id});await f.start();
  assert.equal(f.calls[0].operation,'cancel');assert.equal(f.calls[0].args.job.id,high.id);
  assert.deepEqual(dispatched(f,[low,high]),[low.id]);
});
