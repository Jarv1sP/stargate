import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {publicJob,pendingJobReason} from '../execution.mjs';
import {gpuCardUsage as usage} from '../dist/gpu-allocation.js';
import {DemoClient} from '../dist/client.js';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {quotaLedgerHTML} from '../dist/workbench-ui.js';

const [machine,other]=MACHINES.map(row=>row.id),userId='fixture-member';
const running=(id,indices,extra={})=>({id,userId,machine,state:'RUNNING',cards:indices.length,assignedIndices:indices,...extra});
const share=index=>({gpuIndices:[index],shared:true,vramMiB:256});

test('quota counts distinct physical cards including node queues, excluding portal waits and other members',()=>{
 const jobs=[running('a',[0]),running('b',[0]),running('c',[1],{state:'STARTING'}),running('elsewhere',[0],{machine:other}),running('peer',[2],{userId:'peer'}),
  ...['PENDING','QUEUED','SUCCEEDED','FAILED','CANCELED'].map(state=>running(state,[7],{state,nodeJobId:'J'+state,dispatchPending:false})),
  running('not-dispatched',[],{state:'SUBMITTING',dispatchPending:true,cards:8})];
 assert.equal(usage(jobs,userId,machine),3);assert.equal(usage(jobs,userId),4);
 const client=new DemoClient();client.data={jobs:jobs.map(row=>publicJob({...row,spec:{argv:['true']}}))};assert.equal(client.usage(userId,machine),3);assert.equal(client.usage(userId),4);
});

test('elastic work reserves its maximum and unresolved starts remain counted until their allocations arrive',()=>{
 const jobs=[running('elastic',[0,1],{cards:8,elastic:{minCards:2}}),running('same',[1]),running('starting',[],{state:'SUBMITTING',dispatchPending:false,cards:1}),running('unknown',[],{state:'UNKNOWN',cards:1})];
 assert.equal(usage(jobs,userId,machine),10);
 jobs[2].assignedIndices=[1];jobs[3].assignedIndices=[2];assert.equal(usage(jobs,userId,machine),9);
});

test('in-flight fixed placements reuse their exact cards while unspecified starts count as new demand',()=>{
 const jobs=[running('already-running',[0]),...Array.from({length:3},(_,n)=>running('sending-'+n,[],{cards:1,state:'SUBMITTING',dispatchPending:false,placement:share(0)}))];
 assert.equal(usage(jobs,userId,machine),1);
 jobs.push(running('unspecified',[],{cards:1,state:'SUBMITTING',dispatchPending:false}));assert.equal(usage(jobs,userId,machine),2);
 jobs.push(running('starting-without-report',[],{cards:1,state:'STARTING',placement:share(0)}));assert.equal(usage(jobs,userId,machine),2);
});

test('dispatch projection reuses explicitly shared cards and counts unspecified cards as additional demand',()=>{
 const jobs=[running('a',[0]),running('b',[0]),running('c',[0],{machine:other})];
 const candidate={id:'new',userId,machine,cards:1,placement:share(0)};
 assert.equal(usage(jobs,userId,machine,candidate),1);assert.equal(usage(jobs,userId,undefined,candidate),2);
 assert.equal(usage(jobs,userId,machine,{...candidate,placement:share(1)}),2);
 assert.equal(usage(jobs,userId,machine,{...candidate,cards:2,placement:undefined}),3);
});

test('the quota ledger groups node queues with occupied cards and portal waits with zero cards',()=>{
 const jobs=[running('a',[0]),running('b',[0]),running('node-queued',[],{state:'PENDING',cards:1,nodeJobId:'Jqueued',placement:share(0)}),running('portal-wait',[],{state:'SUBMITTING',dispatchPending:true,cards:2})],client=new DemoClient();
 client.data={jobs,users:[{id:userId,name:'Fixture',enabled:true,role:'member',total:2,limits:{[machine]:2}}]};client.principal={userId,role:'member'};
 const html=quotaLedgerHTML(client);
 assert.match(html,/1 \/ 2/);assert.match(html,/占用额度<\/span><strong>1/);assert.match(html,/等待额度（不占额度）<\/span><strong>0/);
 assert.match(html,/已派发，等待显卡/);assert.match(html,/申请 2 张/);
});

async function fixture(t,{defaultState='RUNNING'}={}){
 const root=await mkdtemp(join(tmpdir(),'physical-quota-')),bootstrap=join(root,'bootstrap'),database=join(root,'db'),calls=[],states=new Map(),allocations=new Map();
 const password='Physical-Quota-Local-Fixture!';await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 const service=await PortalService.open(database,bootstrap,undefined,async(host,operation,args)=>{
  calls.push({host,operation,args:structuredClone(args)});
  const state=states.get(args.job.id)||defaultState;
  return {state,nodeJobId:'J'+args.job.id.replaceAll('-','').slice(0,12),assignedIndices:['PENDING','QUEUED'].includes(state)?[]:allocations.get(args.job.id)??args.job.placement?.gpuIndices??[0]};
 });
 clearInterval(service.executionTimer);const admin=await service.login('admin',password);
 const member=(await service.invoke(admin.token,'users.create',{username:'member',password})).result;
 await service.invoke(admin.token,'policy.save',{userId:member.id,total:2,limits:{[machine]:2,[other]:2}});
 const actor=await service.login('member',password);
 const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await service.reconcile();await service.tail;};
 t.after(async()=>{await settle();service.close();await rm(root,{recursive:true,force:true});});
 const submit=async(args={},token=actor.token)=>(await service.invoke(token,'jobs.submit',{machine,project:'demo',cards:1,key:randomUUID(),argv:['true'],...args})).result;
 return {service,admin,member,actor,calls,states,allocations,settle,submit};
}

test('quota two admits ten submissions but dispatches only two node-queued jobs at a time',async t=>{
 const f=await fixture(t,{defaultState:'PENDING'});f.service.reconciling=true;
 const requests=Array.from({length:10},()=>({key:randomUUID()}));
 const submitted=await Promise.all(requests.map(request=>f.submit(request)));
 assert.equal(submitted.length,10);f.service.reconciling=false;await f.settle();
 const rows=()=>f.service.store.jobs.filter(job=>job.userId===f.member.id);
 const dispatched=()=>rows().filter(job=>job.nodeJobId&&!['SUCCEEDED','FAILED','CANCELED'].includes(job.state));
 assert.equal(dispatched().length,2);assert.equal(usage(rows(),f.member.id),2);
 assert.equal(rows().filter(job=>job.state==='SUBMITTING'&&job.dispatchPending===true).length,8);
 assert.ok(rows().filter(job=>job.dispatchPending===true).every(job=>pendingJobReason(f.service,job)==='已占用 2/2 张卡'));
 for(let wave=0;wave<5;wave++){
  const active=dispatched();assert.equal(active.length,2);
  for(const [index,job] of active.entries()){f.states.set(job.id,'RUNNING');f.allocations.set(job.id,[index]);}
  await f.settle();assert.equal(dispatched().length,2);assert.equal(usage(rows(),f.member.id),2);
  for(const job of active)f.states.set(job.id,'SUCCEEDED');
  await f.settle();await f.settle();
 }
 assert.equal(rows().filter(job=>job.state==='SUCCEEDED').length,10);assert.equal(usage(rows(),f.member.id),0);
 assert.equal(new Set(f.calls.filter(call=>call.operation==='sync').map(call=>call.args.job.id)).size,10);
 for(const [index,job] of submitted.entries())assert.equal(rows().find(row=>row.id===job.id).key,requests[index].key);
});

test('node-queued fixed shared jobs reuse one card before assignments are reported',async t=>{
 const f=await fixture(t,{defaultState:'PENDING'});
 await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,total:1,limits:{[machine]:1}});
 for(let n=0;n<4;n++){const job=await f.submit({placement:share(0)});await f.settle();assert.ok(f.service.store.jobs.find(row=>row.id===job.id).nodeJobId);}
 assert.equal(usage(f.service.store.jobs,f.member.id),1);
 const waiting=await f.submit({placement:share(1)});await f.settle();
 const row=f.service.store.jobs.find(job=>job.id===waiting.id);
 assert.equal(row.dispatchPending,true);assert.equal(pendingJobReason(f.service,row),'已占用 1/1 张卡');
 assert.equal(f.calls.some(call=>call.args.job.id===waiting.id),false);
});

test('unlimited same-card shared submissions run; a new card waits and resumes under its original key',async t=>{
 const f=await fixture(t),shared=[];
 for(let n=0;n<4;n++){shared.push(await f.submit({placement:share(0)}));await f.settle();}
 assert.equal(usage(f.service.store.jobs,f.member.id),1);assert.equal(new Set(f.calls.map(call=>call.args.job.id)).size,4);
 const second=await f.submit({placement:share(1)});await f.settle();
 const key=randomUUID(),queued=await f.submit({key,placement:share(2)});await f.settle();
 const row=f.service.store.jobs.find(job=>job.id===queued.id);
 assert.equal(row.dispatchPending,true);assert.equal(f.calls.some(call=>call.args.job.id===queued.id),false);
 assert.equal(pendingJobReason(f.service,row),'已占用 2/2 张卡');assert.equal(usage(f.service.store.jobs,f.member.id),2);
 assert.equal((await f.submit({key,placement:share(2)})).id,queued.id);
 for(const job of shared.slice(0,-1))f.states.set(job.id,'SUCCEEDED');await f.service.reconcile();
 assert.equal(usage(f.service.store.jobs,f.member.id),2);assert.equal(row.dispatchPending,true);
 f.states.set(shared.at(-1).id,'SUCCEEDED');await f.service.reconcile();await f.service.reconcile();
 assert.equal(row.state,'RUNNING');assert.equal(row.key,key);assert.equal(usage(f.service.store.jobs,f.member.id),2);
 assert.equal(f.service.store.jobs.find(job=>job.id===second.id).state,'RUNNING');
});

test('cross-machine quota uses physical card pairs and a shared job on an already-used card still dispatches',async t=>{
 const f=await fixture(t);await f.submit({placement:share(0)});await f.settle();await f.submit({machine:other,placement:share(0)});await f.settle();
 const waiting=await f.submit({machine:other,placement:share(1)});await f.settle();
 assert.equal(pendingJobReason(f.service,f.service.store.jobs.find(job=>job.id===waiting.id)),'已占用 2/2 张卡');
 const shared=await f.submit({machine:other,placement:share(0)});await f.settle();
 assert.equal(f.service.store.jobs.find(job=>job.id===shared.id).state,'RUNNING');assert.equal(usage(f.service.store.jobs,f.member.id),2);
});

test('elastic maximum keeps expansion headroom while another shared task can reuse its reported card',async t=>{
 const f=await fixture(t);await f.submit({cards:2,elastic:{minCards:1,globalBatch:2,microBatch:1}});await f.settle();
 assert.equal(usage(f.service.store.jobs,f.member.id),2);
 const same=await f.submit({placement:share(0)});await f.settle();assert.equal(f.service.store.jobs.find(job=>job.id===same.id).state,'RUNNING');
 const waiting=await f.submit({placement:share(1)});await f.settle();assert.equal(pendingJobReason(f.service,f.service.store.jobs.find(job=>job.id===waiting.id)),'已占用 2/2 张卡');
});

test('administrators remain exempt and single impossible requests retain their existing bounds',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.submit({cards:3}),/总额度|所选机器的用卡额度/);
 const get=f.service.store.get;
 t.mock.method(f.service.store,'get',function(id){const user=get.call(this,id);return id==='builtin-admin'?{...user,total:1,limits:{[machine]:1}}:user;});
 for(let index=0;index<5;index++){await f.submit({placement:share(index)},f.admin.token);await f.settle();}
 assert.equal(usage(f.service.store.jobs,'builtin-admin'),5);assert.equal(f.service.store.jobs.filter(job=>job.userId==='builtin-admin').every(job=>job.state==='RUNNING'),true);
});

test('quota decreases leave running work alone and derive waiting reasons without persisting them',async t=>{
 const f=await fixture(t);
 for(const index of [0,1]){await f.submit({placement:share(index)});await f.settle();}
 const waiting=await f.submit({placement:share(2)});await f.settle();
 await f.service.invoke(f.admin.token,'policy.save',{userId:f.member.id,total:1,limits:{[machine]:1}});
 const jobs=f.service.store.jobs,row=jobs.find(job=>job.id===waiting.id);
 assert.equal(jobs.filter(job=>job.state==='RUNNING').length,2);assert.equal(usage(jobs,f.member.id),2);
 assert.equal(pendingJobReason(f.service,row),'已占用 2/1 张卡');assert.equal(row.queueReason,null);
 const persisted=JSON.parse(f.service.db.prepare('SELECT data FROM portal_state_v2 WHERE id=1').get().data);
 assert.equal(persisted.jobs.find(job=>job.id===waiting.id).queueReason,null);
 assert.equal((await f.service.invoke(f.actor.token,'state')).state.jobs.find(job=>job.id===waiting.id).queueReason,'已占用 2/1 张卡');
});
