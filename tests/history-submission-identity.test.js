import test from 'node:test';
import assert from 'node:assert/strict';
import {jobCompletion} from '../job-observation.mjs';
import {executionCall} from '../execution.mjs';
import {MACHINES} from '../dist/model.js';
const jobId='11111111-2222-4333-8444-555555555555',key='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',digest='a'.repeat(64),machine=MACHINES[0].id;
const fixture=()=>{const job={id:jobId,key,digest,userId:'demo-user-42',machine,state:'SUCCEEDED',spec:{id:jobId,userId:'demo-user-42',argv:['synthetic-secret-argv'],env:{TOKEN:'synthetic-secret-env'}}};return job;};
test('explicit completion returns the exact original submission key independent of display metadata',()=>{
 const job=fixture(),before=structuredClone(job),result=jobCompletion(job,{nativeObservation:{submitKey:jobId}});
 assert.deepEqual(result.submission,{key});
 assert.notEqual(result.submission.key,jobId);assert.equal(result.completed,false,'An immutable Portal receipt never proves native completion');
assert.doesNotMatch(JSON.stringify(result.submission),/argv|env|TOKEN|synthetic-secret/);assert.deepEqual(job,before);
});
test('the existing completion operation retains owner, machine and enabled-account authorization without any write or retry',async()=>{
 const job=fixture(),owner={id:job.userId,enabled:true,role:'member',limits:{[machine]:1}},other={id:'demo-user-43',enabled:true,role:'member',limits:{[machine]:1}};
 const calls=[],service={store:{jobs:[job],get:id=>id===owner.id?owner:other},bridge:async(...args)=>{calls.push(args);return {};},save:()=>assert.fail('read-only receipt cannot write')};
 const principal={userId:owner.id,role:'member'},before=structuredClone(job);
 const result=await executionCall(service,principal,'jobs.completion',{jobId});assert.equal(result.submission.key,key);assert.equal(result.readOnly,true);assert.equal(result.completed,false);assert.deepEqual(calls,[]);
 assert.equal((await executionCall(service,{userId:other.id,role:'member'},'jobs.completion',{jobId})).submission.key,key);
 owner.enabled=false;await assert.rejects(executionCall(service,principal,'jobs.completion',{jobId}),e=>e.status===403);
 owner.enabled=true;owner.limits={};assert.equal((await executionCall(service,principal,'jobs.completion',{jobId})).submission.key,key);
 assert.deepEqual(job,before);assert.deepEqual(calls,[]);
});
