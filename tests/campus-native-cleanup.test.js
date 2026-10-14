import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createCampusNativeAgent,extractCampusNative} from '../client-campus-native.mjs';
import {prepareWindowsNativeFolder} from '../client-campus-native-runtime.mjs';
import {nativeFixture} from './campus-native-cleanup-fixture.mjs';

const request=agent=>agent.request({op:'control',control:{origin:'https://control.invalid',path:'/api/call'}},Buffer.from('{}'));
test('cleanup EIO preserves successful CLI JSON and exit 0, warning exactly once',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./campus-native-cleanup-fixture.mjs',import.meta.url)),'success'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{ok:true,result:{operationId:'original-operation',state:'READY'}});
  assert.equal(result.stderr.trim().split('\n').length,1);
  assert.match(result.stderr,/^Warning: .*\(EIO\).*original result unchanged/);
  assert.doesNotMatch(result.stderr,/private cleanup path/);
});
test('cleanup EIO preserves the original business error and exit code',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./campus-native-cleanup-fixture.mjs',import.meta.url)),'rejected'],{encoding:'utf8'});
  assert.equal(result.status,23);assert.equal(result.stdout,'');
  assert.equal(result.stderr.match(/Warning:/g)?.length,1);
  assert.match(result.stderr,/original business error: HTTP_REJECTED; HTTP 409/);
});
test('cleanup and warning run once, without replaying a request',async()=>{
  const f=nativeFixture(),warnings=[],agent=createCampusNativeAgent(undefined,{...f,control:true,warn:error=>warnings.push(error.code)});
  const reply=await request(agent);assert.equal(JSON.parse(reply.raw).result.operationId,'original-operation');
  await Promise.all([agent.destroy(),agent.destroy()]);await agent.destroy();
  assert.deepEqual(warnings,['EIO']);assert.deepEqual(f.counts(),{requests:1,cleanups:1,kills:1});
});
test('successful cleanup is silent and a failed warning sink cannot replace the result',async()=>{
  for(const [expected,cleanup] of [[0,async()=>{}],[1,async()=>{throw Object.assign(Error('locked'),{code:'EIO'});}]]){
    let warnings=0;const f=nativeFixture({cleanup}),agent=createCampusNativeAgent(undefined,{...f,control:true,warn:()=>{warnings++;throw Error('stderr closed');}});
    await request(agent);await agent.destroy();assert.equal(warnings,expected);
    assert.equal(f.counts().requests,1);assert.equal(f.counts().cleanups,1);
  }
});
test('unconfirmed native process exit remains an error, not a cleanup warning',async()=>{
  const f=nativeFixture({close:false}),warnings=[],agent=createCampusNativeAgent(undefined,{...f,control:true,shutdownTimeoutMs:30,warn:error=>warnings.push(error.code)});
  await request(agent);await assert.rejects(agent.destroy(),{code:'NATIVE_EXIT_UNCONFIRMED'});
  assert.deepEqual(warnings,[]);assert.equal(f.counts().cleanups,0);
});
test('a stuck filesystem cleanup stays bounded and only warns once',async()=>{
  const f=nativeFixture({cleanup:()=>new Promise(()=>{})}),warnings=[],agent=createCampusNativeAgent(undefined,{...f,control:true,shutdownTimeoutMs:30,warn:error=>warnings.push(error.code)});
  await request(agent);await agent.destroy();assert.deepEqual(warnings,['NATIVE_CLEANUP_UNCONFIRMED']);
});
test('extraction failure is not replaced by Windows temporary-folder cleanup EIO',async()=>{
  const warnings=[];
  await assert.rejects(extractCampusNative({schema:1,protocol:'campus-native-https-v1',artifacts:{}},{
    resolveRuntime:async()=>({platform:'windows',arch:'x64',interop:false}),
    prepareWindows:async()=>({arch:'x64',cleanup:async()=>{throw Object.assign(Error('locked'),{code:'EIO'});}}),warn:error=>warnings.push(error.code)
  }),{code:'NATIVE_NOT_BUNDLED'});
  assert.deepEqual(warnings,['EIO']);
});
test('a replaced private folder is never removed',async()=>{
  const uuid='12345678-1234-4234-8234-123456789012';let calls=0,removed=0;
  const folder=await prepareWindowsNativeFolder({platform:'windows',interop:false},{uuid,
    powerShell:async()=>'/fixture/powershell',command:async()=>JSON.stringify({schema:1,private:true,owner:'S-1-5-21',arch:'x64',path:`C:\\Temp\\stargate-campus-${uuid}`}),
    stat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false,dev:1,ino:++calls}),remove:async()=>{removed++;}
  });
  const f=nativeFixture({cleanup:folder.cleanup}),warnings=[],agent=createCampusNativeAgent(undefined,{...f,control:true,warn:error=>warnings.push(error.code)});
  await request(agent);await agent.destroy();assert.equal(removed,0);assert.deepEqual(warnings,['NATIVE_CLEANUP_UNCONFIRMED']);
});
