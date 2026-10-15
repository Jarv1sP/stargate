import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractCampusNative} from '../client-campus-native.mjs';
import {prepareWindowsNativeFolder} from '../client-campus-native-runtime.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'campus-cache-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const bytes=Buffer.from('synthetic helper'),artifacts={version:'fixture-build-a',artifacts:{'windows-x64':{bytes:bytes.length,base64:bytes.toString('base64')}}};
 const options={resolveRuntime:async()=>({platform:'windows',arch:'x64',interop:false}),prepareWindows:async()=>({folder:root,arch:'x64'})};
 return {root,bytes,artifacts,options};
}
test('helper persists after close and a later CLI invocation reuses its build path without decoding again',async t=>{
 const f=await fixture(t),first=await extractCampusNative(f.artifacts,f.options);
 assert.equal(first.path,join(f.root,'stargate-campus',f.artifacts.version,'campus-http.exe'));
 await first.cleanup();assert.deepEqual(await readFile(first.path),f.bytes);
 const reused=await extractCampusNative({version:f.artifacts.version,get artifacts(){assert.fail('cache hit must not reread embedded bytes');}},f.options);
 assert.equal(reused.path,first.path);await reused.cleanup();await access(first.path);
});
test('concurrent first invocations publish one complete helper for the same build',async t=>{
 const f=await fixture(t),results=await Promise.allSettled(Array.from({length:4},()=>extractCampusNative(f.artifacts,f.options)));
 for(const result of results)assert.equal(result.status,'fulfilled',String(result.reason));
 const helpers=results.map(r=>r.value);assert.equal(new Set(helpers.map(h=>h.path)).size,1);
 assert.deepEqual(await readFile(helpers[0].path),f.bytes);await Promise.all(helpers.map(h=>h.cleanup()));await access(helpers[0].path);
});
test('a new build quietly retires old build and UUID folders once, keeping unrelated temp files',async t=>{
 const f=await fixture(t),old=join(f.root,'stargate-campus','old-build'),legacy=join(f.root,'stargate-campus-11111111-1111-4111-8111-111111111111'),unrelated=join(f.root,'stargate-campus-not-a-uuid');
 for(const path of [old,legacy,unrelated]){await mkdir(path,{recursive:true});await writeFile(join(path,'keep'),'old');}
 const helper=await extractCampusNative(f.artifacts,f.options);await helper.cleanup();
 for(const path of [old,legacy])await assert.rejects(access(path),{code:'ENOENT'});
 await access(unrelated);await mkdir(legacy);await extractCampusNative(f.artifacts,f.options);await access(legacy);
});
test('locked old folders do not stop the new helper or produce cleanup warnings',async t=>{
 const f=await fixture(t),old=join(f.root,'stargate-campus','locked');await mkdir(old,{recursive:true});
 const helper=await extractCampusNative(f.artifacts,{...f.options,remove:async(path,options)=>{
  if(path===old)throw Object.assign(Error('locked'),{code:'EIO'});return rm(path,options);
 }});
 await helper.cleanup();assert.deepEqual(await readFile(helper.path),f.bytes);await access(old);
});
test('build labels remain below the temp cache and a missing helper keeps its existing error',async t=>{
 const f=await fixture(t);
 for(const version of ['..','../outside','C:\\outside']){
  const helper=await extractCampusNative({...f.artifacts,version},f.options);
  assert.ok(helper.path.startsWith(join(f.root,'stargate-campus')+'/')||helper.path.startsWith(join(f.root,'stargate-campus')+'\\'));
 }
 await assert.rejects(extractCampusNative({version:'missing',artifacts:{}},f.options),{code:'NATIVE_NOT_BUNDLED'});
});
test('Windows bootstrap uses the user temp path and ignores extra output fields',async()=>{
 const folder=await prepareWindowsNativeFolder({platform:'windows',arch:'x64',interop:false},{powerShell:async()=>'/fixture/powershell',command:async()=>JSON.stringify({path:'C:\\Users\\Fixture\\Temp\\',arch:'x64',extra:'ignored'})});
 assert.equal(folder.folder,'C:\\Users\\Fixture\\Temp\\');
});
test('WSL maps the Windows user temp path without per-invocation removal',async()=>{
 const programs=[],folder=await prepareWindowsNativeFolder({platform:'windows',arch:'x64',interop:true},{powerShell:async()=>'/fixture/powershell',command:async(program)=>{
  programs.push(program);return program==='/usr/bin/wslpath'?'/fixture/user temp':JSON.stringify({path:'C:\\Users\\Fixture\\Temp',arch:'x64'});
 }});
 assert.equal(folder.folder,'/fixture/user temp');assert.deepEqual(programs,['/fixture/powershell','/usr/bin/wslpath']);
});
test('real Windows bootstrap keeps the local user temp constraint', {skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'campus-fixed-temp-')),previous={TEMP:process.env.TEMP,TMP:process.env.TMP};
 t.after(async()=>{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;await rm(root,{recursive:true,force:true});});
 process.env.TEMP=root;process.env.TMP=root;
 const folder=await prepareWindowsNativeFolder({platform:'windows',arch:process.arch,interop:false});assert.equal(folder.folder.replace(/[\\/]$/,''),root);
 process.env.TEMP='\\\\fixture.invalid\\temp';process.env.TMP=process.env.TEMP;
 await assert.rejects(prepareWindowsNativeFolder({platform:'windows',arch:process.arch,interop:false}));
});
