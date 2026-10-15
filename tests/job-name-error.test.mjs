import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeJobSubmission} from '../job-submission.mjs';
import {MACHINES} from '../dist/model.js';

const submit=name=>normalizeJobSubmission({machine:MACHINES[0].id,project:'sample',cards:1,
  argv:['true'],key:'11111111-1111-4111-8111-111111111111',name},{userId:'fixture-member'});
test('overlong job names explain the current length and how to fix --name',()=>{
  for(const name of ['a'.repeat(65),'中'.repeat(65),'😀'.repeat(33)])
    assert.throws(()=>submit(name),{status:400,message:`任务名称最多 64 个字符（当前 ${name.length} 个），请缩短 --name。`});
});
test('job names explain newline and control characters',()=>{
  for(const control of ['\0','\t','\n','\r','\x1f'])
    assert.throws(()=>submit('train'+control+'name'),{status:400,message:'任务名称不能包含换行或控制字符。'});
});
test('job name boundaries, counting and default remain unchanged',()=>{
  for(const name of ['a'.repeat(64),'中'.repeat(64),'😀'.repeat(32),'train\x7f'])assert.equal(submit(name).name,name);
  for(const name of [undefined,'',null,0])assert.equal(submit(name).name,'train');
  assert.throws(()=>submit({}),{status:400,message:'任务名称无效。'});
});
