import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
const machine=MACHINES[0].id;
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'C2-history-')),bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'History-Local-Only-Password!'}));const service=await PortalService.open(join(dir,'db'),bootstrap,undefined,async(host,operation,args)=>operation==='logs'?{text:'original full log'}:operation==='files.get'?{size:4,offset:args.offset??0,data:Buffer.from('data').toString('base64'),eof:true}:{nodeJobId:'J0123456789ab',state:'SUCCEEDED',assignedIndices:[]});clearInterval(service.executionTimer);const member=await service.accounts.create({name:'Team',username:'team',password:'Synthetic-Test-Member-Password'}),principal={userId:member.id,username:member.username,role:'member'},token=service.issueSession(principal);service.refreshAccounts();t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});return {service,member,principal,token};}
function job(owner,n,state='SUCCEEDED'){const id=randomUUID();return {id,key:randomUUID(),userId:owner,machine,project:'test',state,cards:1,nodeJobId:'J0123456789ab',name:'task-'+n,createdAt:new Date(n*1000).toISOString(),finishedAt:state==='SUCCEEDED'?new Date(n*1000).toISOString():undefined,error:'message '.repeat(40),spec:{id,userId:owner,project:'test',argv:['python','train.py']}};}
test('team history is bounded by bytes, includes every active task, and keeps original records available by UUID',async t=>{
 const f=await fixture(t),old=job(f.member.id,1),active=[job(f.member.id,2,'RUNNING'),job('builtin-admin',3,'PENDING')],terminal=Array.from({length:5001},(_,i)=>job(i%2?f.member.id:'builtin-admin',i+10));f.service.store.jobs=[old,...active,...terminal];
 const state=f.service.state(f.principal);assert.equal(state.jobsTotal,5004);assert.ok(state.jobs.length<5004);assert.equal(state.jobsTruncated,true);assert.ok(Buffer.byteLength(JSON.stringify(state.jobs))<=300000);for(const row of active)assert.ok(state.jobs.some(j=>j.id===row.id));assert.ok(!state.jobs.some(j=>j.id===old.id));assert.equal(f.service.store.jobs.length,5004);
 assert.equal((await f.service.invoke(f.token,'jobs.logs',{jobId:old.id})).result.text,'original full log');assert.equal((await f.service.invoke(f.token,'jobs.watch',{jobId:old.id})).result.id,old.id);assert.equal((await f.service.invoke(f.token,'jobs.completion',{jobId:old.id})).result.completed,true);
 assert.equal(Buffer.from((await f.service.invoke(f.token,'files.get',{area:'output',runId:old.id,path:'result'})).result.data,'base64').toString(),'data');
});
test('all members see all accounts/nodes/tasks and changing returned nested data never changes storage',async t=>{
 const f=await fixture(t),a=job(f.member.id,1,'RUNNING'),b=job('builtin-admin',2,'RUNNING');f.service.store.jobs=[a,b];f.service.store.snapshot=()=>assert.fail('Dashboard must not clone full durable history');
 const state=f.service.state(f.principal);assert.deepEqual(state.jobs.map(j=>j.id),[a.id,b.id]);assert.equal(state.machines.length,MACHINES.length);assert.equal(state.users.length,2);state.jobs[0].command[0]='changed';state.users[0].limits.test=99;assert.equal(a.spec.argv[0],'python');assert.equal(f.service.store.users[0].limits.test,undefined);
});
test('active command preview is bounded and never splits a Unicode surrogate',async t=>{
 const f=await fixture(t),row=job(f.member.id,1,'RUNNING');row.spec.argv=['x'.repeat(199)+'😀'];f.service.store.jobs=[row];const view=f.service.state(f.principal).jobs[0];assert.equal(view.commandTruncated,true);assert.ok(view.command.join(' ').isWellFormed());assert.ok(view.command.join(' ').length<=200);assert.equal(row.spec.argv[0].length,201);
});
