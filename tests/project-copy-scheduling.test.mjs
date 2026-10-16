import test from 'node:test';
import assert from 'node:assert/strict';
import {MACHINES} from '../dist/model.js';
import {normalizeJobSubmission,createSubmittedJob} from '../job-submission.mjs';
import {firstDispatch} from '../tasks/submit.mjs';
import {DatabaseSync} from 'node:sqlite';
import {installTransfers} from '../transfers.mjs';

const id='11111111-1111-4111-8111-111111111111',from=MACHINES[0].id,to=MACHINES[1].id;
const user={id:'alice',username:'alice',role:'admin',enabled:true,total:16,limits:{[from]:8,[to]:8}};
function job(){
 const request=normalizeJobSubmission({machine:to,sourceMachine:from,project:'demo',cards:1,argv:['python','train.py'],key:id},user);
 return createSubmittedJob(request,user,true,{id});
}
function fixture(row){
 let copied=false;const calls=[];
 const service={store:{jobs:[row],get:()=>user},save(){},enqueue:fn=>Promise.resolve().then(fn),
  audit(){},db:new DatabaseSync(':memory:'),
  bridge:async(machine,op,args)=>{
   calls.push({machine,op,args});
   if(op==='transfers.project.prepare')return {id,token:'fixture-ticket'};
   if(op==='transfers.project.start'||op==='transfers.status')return {id,state:copied?'SUCCEEDED':'RUNNING'};
   if(op==='transfers.cancel')return {id,state:'CANCELED'};
   if(op==='sync')return {state:'PENDING'};
   throw Error('Unexpected '+op);
  }};
 installTransfers(service);
 return {service,calls,complete:()=>copied=true};
}

test('a cross-node job retains its development machine and uses a task-local workspace copy',()=>{
 const row=job();assert.equal(row.sourceMachine,from);assert.equal(row.spec.projectCopy,id);assert.equal(row.spec.project,'demo');
});

test('dispatch waits for the original copy operation, then submits once without changing the public project',async()=>{
 const row=job(),f=fixture(row),helpers={usage:()=>0,fail:message=>{throw Error(message);}};
 let attempt=await firstDispatch(f.service,row,helpers);if(attempt?.response)await attempt.response;
 assert.equal(f.calls.filter(c=>c.op==='sync').length,0);assert.equal(row.dispatchPending,true);
 assert.equal(row.projectPreparation.state,'RUNNING');assert.equal(row.projectPreparation.id,id);
 f.complete();attempt=await firstDispatch(f.service,row,helpers);await attempt.response;
 assert.equal(f.calls.filter(c=>c.op==='sync').length,1);assert.equal(row.dispatchPending,false);
 const submit=f.calls.find(c=>c.op==='sync');assert.equal(submit.args.job.projectCopy,id);assert.equal(submit.args.job.project,'demo');
});

test('same-node jobs keep their current writable environment without copying',async()=>{
 const row=job();row.sourceMachine=to;delete row.spec.projectCopy;
 const f=fixture(row),attempt=await firstDispatch(f.service,row,{usage:()=>0,fail:message=>{throw Error(message);}});await attempt.response;
 assert.deepEqual(f.calls.map(c=>c.op),['sync']);
});
