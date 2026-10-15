import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createPortalServer} from '../portal-server.mjs';
import {normalizeJobSubmission,createSubmittedJob} from '../job-submission.mjs';
import {apiPost} from '../client-http.mjs';
import {MACHINES} from '../dist/model.js';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'cli-submit-receipt-')),bootstrap=join(dir,'bootstrap'),origin='https://fixture.invalid';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Receipt-Fixture-2026!'}),{mode:0o600});
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,bridge:async()=>assert.fail('existing key cannot dispatch')});
  for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[key]);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const login=await service.login('admin','Receipt-Fixture-2026!'),user=service.store.get(login.principal.userId);
  const args={machine:MACHINES[0].id,project:'sample',cards:1,argv:['true'],key:'11111111-1111-4111-8111-111111111111'};
  const job=createSubmittedJob(normalizeJobSubmission(args,login.principal),user,false);job.state='RUNNING';service.store.jobs.push(job);service.save();
  const send=(body,headers={})=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path:'/api/call',method:'POST',headers:{Host:'fixture.invalid','Content-Type':'application/json',...headers}},res=>{
      let text='';res.on('data',part=>text+=part);res.on('end',()=>resolve(new Response(text,{status:res.statusCode})));});
    req.on('error',reject);req.end(body);
  });
  return {service,login,args,job,send};
}

test('CLI submit returns the same durable UUID without building state or replaying a write',async t=>{
  const f=await fixture(t),before=structuredClone(f.job);let calls=0;
  const state=t.mock.method(f.service,'state',()=>assert.fail('CLI receipt must not build full state'));
  const response=await apiPost('https://fixture.invalid','call',{operation:'jobs.submit',args:f.args},{token:f.login.token,
    fetchImpl:async(_url,options)=>{calls++;return f.send(options.body,options.headers);}});
  assert.equal(response.result.id,f.job.id);assert.equal(response.result.key,f.args.key);assert.equal(response.result.state,'RUNNING');
  assert.equal(Object.hasOwn(response,'state'),false);assert.equal(response.principal.userId,f.login.principal.userId);
  assert.equal(calls,1);assert.equal(state.mock.calls.length,0);assert.deepEqual(f.service.store.jobs,[before]);
});

test('browser cookie and Origin-bearing bearer submit retain their dashboard state',async t=>{
  const f=await fixture(t);
  for(const headers of [{Cookie:`team_session=${f.login.token}`,Origin:'https://fixture.invalid'},
    {Authorization:`Bearer ${f.login.token}`,Origin:'https://fixture.invalid'}]){
    const response=await f.send(JSON.stringify({operation:'jobs.submit',args:f.args}),headers),value=await response.json();
    assert.equal(response.status,200);assert.equal(value.result.id,f.job.id);assert.equal(value.state.jobs.length,1);
  }
  const response=await f.send(JSON.stringify({operation:'state',args:{view:'summary'},client:{name:'gpuctl',protocol:2}}),{Authorization:`Bearer ${f.login.token}`});
  assert.equal((await response.json()).state.summaryVersion,1);
});
