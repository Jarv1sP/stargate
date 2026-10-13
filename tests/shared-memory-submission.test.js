import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeJobSubmission,createSubmittedJob} from '../job-submission.mjs';
import {MACHINES} from '../dist/model.js';

const user={id:'demo-user-1',username:'test',role:'member'};
const args={machine:MACHINES[0].id,project:'vision',cards:1,argv:['true'],key:'11111111-1111-4111-8111-111111111111'};

test('optional RAM cap persists in the immutable spec and retry identity',()=>{
  const old=normalizeJobSubmission(args,user);
  const request=normalizeJobSubmission({...args,memoryLimitGiB:60},user);
  assert.notEqual(old.digest,request.digest);
  assert.equal(createSubmittedJob(request,user,true).spec.memoryLimitGiB,60);
  assert.equal(Object.hasOwn(createSubmittedJob(old,user,true).spec,'memoryLimitGiB'),false);
  assert.equal(old.digest,normalizeJobSubmission({...args,memoryLimitGiB:undefined},user).digest);
});

test('RAM cap does not accept unlimited strings, fractions, or implicit coercion',()=>{
  for(const value of [0,-1,true,null,'60','max',1.5,Infinity,1048577]){
    assert.throws(()=>normalizeJobSubmission({...args,memoryLimitGiB:value},user),/内存上限/);
  }
});
