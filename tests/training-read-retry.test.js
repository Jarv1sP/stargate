import test from 'node:test';
import assert from 'node:assert/strict';
import {retryTrainingRead,withTrainingReadRetries} from '../training-datasets.mjs';

const busy=()=>Object.assign(Error('busy'),{status:503,code:'TRAINING_ADMISSION_BUSY'});
function clock(){
  let time=0;const waits=[];
  return {now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;},advance:ms=>time+=ms,waits};
}
test('contention retries the same read automatically and succeeds without replaying any write',async()=>{
  const c=clock(),args={userId:'demo-user-1',dataset:'example',version:'a'.repeat(64)},value={state:'READY'};
  let calls=0,checks=0;
  const result=await retryTrainingRead('datasets.training.status',async()=>{
    assert.equal(args.userId,'demo-user-1');calls++;if(calls<3)throw busy();return value;
  },{...c,check:()=>checks++});
  assert.equal(result,value);assert.equal(calls,3);assert.deepEqual(c.waits,[250,500]);assert.equal(checks,6);
});
test('an unconfirmed metadata read is retried, while authenticated refusal is immediate',async()=>{
  const c=clock();let calls=0;
  assert.equal(await retryTrainingRead('storage.training.plan',async()=>{
    if(++calls===1)throw Object.assign(Error('unconfirmed'),{status:503,code:'EXECUTOR_UNCONFIRMED'});return 'plan';
  },c),'plan');
  assert.equal(calls,2);
  for(const status of [401,403]){
    let attempts=0;const before=c.waits.length;
    await assert.rejects(retryTrainingRead('storage.training.plan',async()=>{
      attempts++;throw Object.assign(busy(),{status});
    },c),error=>error.status===status);
    assert.equal(attempts,1);assert.equal(c.waits.length,before);
  }
});
test('authorization is checked again before retry, so revoked access makes no second read',async()=>{
  const c=clock();let allowed=true,calls=0;
  await assert.rejects(retryTrainingRead('datasets.training.status',async()=>{
    calls++;allowed=false;throw busy();
  },{...c,check:()=>{if(!allowed)throw Object.assign(Error('revoked'),{status:403});}}),error=>error.status===403);
  assert.equal(calls,1);assert.deepEqual(c.waits,[]);
});
test('exhausted retries preserve explicit BUSY and stop within the extra wait budget',async()=>{
  const c=clock();let calls=0;const error=busy();
  await assert.rejects(retryTrainingRead('datasets.training.status',async()=>{calls++;throw error;},c),value=>value===error);
  assert.equal(calls,3);assert.deepEqual(c.waits,[250,500]);
  calls=0;c.waits.length=0;
  await assert.rejects(retryTrainingRead('storage.training.plan',async()=>{
    calls++;c.advance(13000);throw error;
  },c),value=>value===error);
  assert.equal(calls,1);assert.deepEqual(c.waits,[]);
});
test('all admission reads in one submission share the retry budget without resetting it',async()=>{
  const c=clock();let first=0,second=0;
  await withTrainingReadRetries(async()=>{
    assert.equal(await retryTrainingRead('datasets.training.status',async()=>{
      if(++first===1){c.advance(6000);throw busy();}return 'READY';
    },c),'READY');
    await assert.rejects(retryTrainingRead('storage.training.plan',async()=>{
      second++;c.advance(6000);throw busy();
    },c),error=>error.code==='TRAINING_ADMISSION_BUSY');
  });
  assert.equal(first,2);assert.equal(second,1);assert.deepEqual(c.waits,[250]);
});
test('uncontended reads keep the exact response with zero sleeps, and writes cannot enter retry',async()=>{
  const c=clock(),value={fits:true};let calls=0;
  assert.equal(await retryTrainingRead('storage.training.plan',async()=>{calls++;return value;},c),value);
  assert.equal(calls,1);assert.deepEqual(c.waits,[]);
  for(const operation of ['sync','jobs.submit','datasets.prepare','storage.training.prepare'])
    await assert.rejects(retryTrainingRead(operation,async()=>{calls++;},c),/Invalid training read retry operation/);
  assert.equal(calls,1);
});
