import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createCampusNativeAgent} from '../client-campus-native.mjs';
import {nativeFixture} from './campus-native-cleanup-fixture.mjs';

const request=agent=>agent.request({op:'control',control:{origin:'https://control.invalid',path:'/api/call'}},Buffer.from('{}'));
for(const mode of ['success','rejected'])test(`CLI ${mode} preserves the original output and exit code during cleanup`,()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./campus-native-cleanup-fixture.mjs',import.meta.url)),mode],{encoding:'utf8'});
  assert.equal(result.status,mode==='success'?0:23,result.stderr);
  if(mode==='success'){assert.deepEqual(JSON.parse(result.stdout),{ok:true,result:{operationId:'original-operation',state:'READY'}});assert.equal(result.stderr,'');}
  else{assert.equal(result.stdout,'');assert.match(result.stderr,/original business error: HTTP_REJECTED; HTTP 409/);}
  assert.doesNotMatch(result.stderr,/private cleanup path/);
});
test('helper receives EOF, closes, then is cleaned exactly once without replay or a signal',async()=>{
  const f=nativeFixture(),agent=createCampusNativeAgent(undefined,{...f,control:true});
  const reply=await request(agent);assert.equal(JSON.parse(reply.raw).result.operationId,'original-operation');
  await Promise.all([agent.destroy(),agent.destroy()]);await agent.destroy();
  assert.deepEqual(f.events,['eof','close','cleanup']);assert.deepEqual(f.counts(),{requests:1,cleanups:1,kills:0});
});
test('an unconfirmed process exit never permits helper deletion',async()=>{
  const f=nativeFixture({close:false}),agent=createCampusNativeAgent(undefined,{...f,control:true,shutdownTimeoutMs:30});
  await request(agent);await assert.rejects(agent.destroy(),{code:'NATIVE_EXIT_UNCONFIRMED'});assert.equal(f.counts().cleanups,0);
});
test('a stuck cleanup stays bounded without replacing the completed operation',async()=>{
  const f=nativeFixture({cleanup:()=>new Promise(()=>{})}),agent=createCampusNativeAgent(undefined,{...f,control:true,shutdownTimeoutMs:30});
  await request(agent);await agent.destroy();assert.equal(f.counts().requests,1);assert.equal(f.counts().cleanups,1);
});
