import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createCampusNativeAgent,extractCampusNative} from '../client-campus-native.mjs';
import {prepareWindowsNativeFolder} from '../client-campus-native-runtime.mjs';
import {nativeFixture} from './campus-native-cleanup-fixture.mjs';

const request=agent=>agent.request({op:'control',control:{origin:'https://control.invalid',path:'/api/call'}},Buffer.from('{}'));
test('native artifact selection extracts a bounded local executable',async()=>{
 const bytes=Buffer.from('synthetic helper'),item={bytes:bytes.length,base64:bytes.toString('base64')};
 const runtime={resolveRuntime:async()=>({platform:'linux',arch:'x64'})};
 const helper=await extractCampusNative({artifacts:{'linux-x64':item}},runtime);
 try{assert.deepEqual(await readFile(helper.path),bytes);}finally{await helper.cleanup();}
});
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
test('extraction errors survive a failed temporary-folder cleanup',async()=>{
  await assert.rejects(extractCampusNative({artifacts:{}},{
    resolveRuntime:async()=>({platform:'windows',arch:'x64',interop:false}),
    prepareWindows:async()=>({arch:'x64',cleanup:async()=>{throw Object.assign(Error('locked'),{code:'EIO'});}})
  }),{code:'NATIVE_NOT_BUNDLED'});
});
const uuid='12345678-1234-4234-8234-123456789012';
const options={uuid,powerShell:async()=>'/fixture/powershell',
  command:async()=>JSON.stringify({arch:'x64',path:`C:\\Temp\\stargate-campus-${uuid}`}),
  stat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false,dev:1,ino:1})};
test('Windows executable locks are retried briefly until the directory is removed',async()=>{
  let attempts=0;const folder=await prepareWindowsNativeFolder({platform:'windows',interop:false},{...options,remove:async()=>{
    if(++attempts<4)throw Object.assign(Error('executable still locked'),{code:['EIO','EBUSY','EPERM'][attempts-1]});
  }});await folder.cleanup();assert.equal(attempts,4);
});
test('WSL waits for Windows deletion instead of using the Linux filesystem',async()=>{
  const commands=[];let calls=0,started,release,complete=false;
  const deleting=new Promise(resolve=>{started=resolve;}),removed=new Promise(resolve=>{release=resolve;});
  const folder=await prepareWindowsNativeFolder({platform:'windows',interop:true},{...options,
    command:async(program,args)=>{commands.push({program,args});if(++calls===1)return JSON.stringify({arch:'x64',path:`C:\\Temp\\stargate-campus-${uuid}`});if(calls===2)return `/mnt/c/Temp/stargate-campus-${uuid}`;started();await removed;return '';},
    remove:async()=>assert.fail('WSL must use Windows to release executable locks')});
  const cleanup=folder.cleanup().then(()=>{complete=true;});await deleting;assert.equal(complete,false);
  release();await cleanup;assert.equal(complete,true);assert.equal(commands.length,3);assert.equal(commands[2].program,'/fixture/powershell');
});
test('permanent Windows cleanup errors stop after the bounded retries',async()=>{
  let attempts=0;const folder=await prepareWindowsNativeFolder({platform:'windows',interop:false},{...options,remove:async()=>{attempts++;throw Object.assign(Error('locked'),{code:'EIO'});}});
  await assert.rejects(folder.cleanup(),{code:'EIO'});assert.equal(attempts,6);
});
test('a replaced private folder is never removed',async()=>{
  let calls=0,removed=0;const folder=await prepareWindowsNativeFolder({platform:'windows',interop:false},{...options,
    stat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false,dev:1,ino:++calls}),remove:async()=>{removed++;}});
  await assert.rejects(folder.cleanup(),{code:'NATIVE_CLEANUP_UNCONFIRMED'});assert.equal(removed,0);
});
