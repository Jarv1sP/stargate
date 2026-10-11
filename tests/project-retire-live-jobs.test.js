import test from 'node:test';
import assert from 'node:assert/strict';
const root=process.env.RELEASE_PORTAL_TEST_ROOT||new URL('..',import.meta.url).pathname.replace(/\/$/,'');
const {projectCall}=await import(`${root}/projects.mjs`);
const {executionCall}=await import(`${root}/execution.mjs`);
const {trainingStoragePlan}=await import(`${root}/training-storage.mjs`);

const {MACHINES}=await import(`${root}/dist/model.js`);
const machine=MACHINES[0].id,project='test-project',user={id:'owner',username:'owner',enabled:true,role:'member',limits:{[machine]:1}};
const args={machine,project,key:'11111111-1111-4111-8111-111111111111',revision:0,manifestSha256:'a'.repeat(64)};
for(const state of ['RUNNING','PENDING','SUBMITTING','UNKNOWN','UNCONFIRMED','SUCCEEDED','FAILED','CANCELED','STOPPED']){
  test(`project retirement treats ${state} as ${['SUCCEEDED','FAILED','CANCELED','STOPPED'].includes(state)?'history':'a live reference'}`,async()=>{
    const job={id:'job',userId:user.id,machine,project,state,release:'b'.repeat(64)},calls=[],audit=[];
    const service={store:{jobs:[job],get:()=>user},bridge:async(...v)=>{calls.push(v);return {state:'RETIRED',project,preservesBytes:true};},audit:(...v)=>audit.push(v)};
    const call=()=>projectCall(service,{username:user.username},user,'projects.retire',args,selected=>assert.equal(selected,machine));
    if(['SUCCEEDED','FAILED','CANCELED','STOPPED'].includes(state)){
      assert.equal((await call()).state,'RETIRED');
      assert.deepEqual(calls,[[machine,'projects.retire',{project,key:args.key,revision:0,manifestSha256:args.manifestSha256,userId:user.id}]]);
      assert.equal(audit.length,1);assert.equal(service.store.jobs[0],job);assert.equal(job.release,'b'.repeat(64));
    }else{
      await assert.rejects(call(),error=>error.status===409&&/进行中或待确认/.test(error.message));
      assert.equal(calls.length,0);assert.equal(audit.length,0);
    }
  });
}
test('rerunning a retired release reports restore instead of an unknown project or capacity',async()=>{
  const retired=()=>{throw new Error('发布已退役，7 天内可用原退役编号 restore。');};
  const account={...user,total:1},calls=[];
  const service={store:{jobs:[],users:[account],get:()=>account},bridge:async(...v)=>{calls.push(v);return retired();},projectCopyProbe:retired};
  await assert.rejects(executionCall(service,{userId:user.id,username:user.username,role:'member'},'jobs.submit',
    {machine,project,release:'b'.repeat(64),cards:1,key:args.key,argv:['true']}),
    error=>error.status===409&&error.code==='SUBMISSION_REJECTED'&&/发布已退役，7 天内.*restore/.test(error.message));
  assert.equal(calls.length,1);assert.equal(calls[0][1],'projects.verify');assert.equal(service.store.jobs.length,0);
  await assert.rejects(trainingStoragePlan(service,account,machine,{project:{project,release:'b'.repeat(64)},datasets:[]}),
    error=>error.status===409&&error.code==='PROJECT_RELEASE_RETIRED'&&/发布已退役，7 天内.*restore/.test(error.message));
  assert.equal(service.store.jobs.length,0);
});
