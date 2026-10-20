import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {prepareWindowsNativeFolder,boundedLocalCommand} from '../client-campus-native-runtime.mjs';
import {extractCampusNative} from '../client-campus-native.mjs';

const runtime={platform:'windows',arch:'x64',interop:true},windowsPath='C:\\Users\\Fixture\\Temp\\';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'gpuctl-bootstrap-')),folder=join(root,'user temp'),cacheFile=join(root,'state','windows-bootstrap.json');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(folder);await mkdir(join(root,'state'));
 return {root,folder,cacheFile};
}
const seed=(f,value={path:windowsPath,arch:'x64'})=>writeFile(f.cacheFile,typeof value==='string'?value:JSON.stringify(value));

test('cached Windows temp and arch skip PowerShell in a later invocation',async t=>{
 const f=await fixture(t);await seed(f,{path:windowsPath,arch:'arm64',extra:'ignored'});
 const result=await prepareWindowsNativeFolder(runtime,{cacheFile:f.cacheFile,powerShell:async()=>assert.fail('cache hit started PowerShell'),command:async(program,args,options)=>{
  assert.equal(program,'/usr/bin/wslpath');assert.deepEqual(args,['-u',windowsPath]);assert.equal(options,undefined);return f.folder;
 }});
 assert.equal(result.folder,f.folder);assert.equal(result.arch,'arm64');
});
test('a missing cached directory bootstraps again and saves the replacement',async t=>{
 const f=await fixture(t),stale='C:\\Users\\Fixture\\OldTemp\\',programs=[];await seed(f,{path:stale,arch:'arm64'});
 const result=await prepareWindowsNativeFolder(runtime,{cacheFile:f.cacheFile,powerShell:async()=>'/fixture/powershell',command:async(program,args,options)=>{
  programs.push(program);if(program==='/usr/bin/wslpath')return args[1]===stale?join(f.root,'gone'):f.folder;
  assert.equal(options.timeoutMs,30000);return JSON.stringify({path:windowsPath,arch:'x64',extra:'ignored'});
 }});
 assert.equal(result.folder,f.folder);assert.equal(result.arch,'x64');
 assert.deepEqual(programs,['/usr/bin/wslpath','/fixture/powershell','/usr/bin/wslpath']);
 assert.deepEqual(JSON.parse(await readFile(f.cacheFile,'utf8')),{path:windowsPath,arch:'x64'});
});
test('malformed or unusable cache contents fall back to bootstrap',async t=>{
 const f=await fixture(t);
 for(const cached of ['not json',JSON.stringify({path:windowsPath,arch:'unsupported'})]){
  await seed(f,cached);let bootstraps=0;
  const result=await prepareWindowsNativeFolder(runtime,{cacheFile:f.cacheFile,powerShell:async()=>'/fixture/powershell',command:async program=>{
   if(program==='/usr/bin/wslpath')return f.folder;bootstraps++;return JSON.stringify({path:windowsPath,arch:'x64'});
  }});
  assert.equal(result.folder,f.folder);assert.equal(bootstraps,1);
  assert.deepEqual(JSON.parse(await readFile(f.cacheFile,'utf8')),{path:windowsPath,arch:'x64'});
 }
});
test('a 12-second PowerShell bootstrap completes inside its 30-second timeout',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});let started,kills=0;
 const ready=new Promise(resolve=>started=resolve);
 const result=prepareWindowsNativeFolder(runtime,{cacheFile:f.cacheFile,powerShell:async()=>'/fixture/powershell',command:(program,args,options)=>{
  if(program==='/usr/bin/wslpath')return Promise.resolve(f.folder);
  return boundedLocalCommand(program,args,{...options,spawnProcess:()=>{
   const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{kills++;child.emit('close',-1);};
   setTimeout(()=>{child.stdout.end(JSON.stringify({path:windowsPath,arch:'x64'}));child.emit('close',0);},12000);started();return child;
  }});
 }});
 await ready;t.mock.timers.tick(12000);assert.equal((await result).folder,f.folder);assert.equal(kills,0);
});
test('other bounded local commands still time out after eight seconds',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let kills=0;
 const result=boundedLocalCommand('/usr/bin/wslpath',[],{spawnProcess:()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{kills++;child.emit('close',-1);};return child;
 }});
 const rejected=assert.rejects(result,{code:'WINDOWS_INTEROP_UNAVAILABLE'});t.mock.timers.tick(7999);assert.equal(kills,0);
 t.mock.timers.tick(1);await rejected;assert.equal(kills,1);
});
test('helper extraction failure invalidates bootstrap and retries once in the fresh temp directory',async t=>{
 const f=await fixture(t),fresh=join(f.root,'fresh temp'),freshPath='D:\\UserTemp\\';await mkdir(fresh);await seed(f);
 await writeFile(join(f.folder,'stargate-campus'),'blocks extraction');let bootstraps=0;
 const artifacts={version:'fixture-build',artifacts:{'windows-x64':{base64:Buffer.from('complete helper').toString('base64')}}};
 const prepareWindows=value=>prepareWindowsNativeFolder(value,{cacheFile:f.cacheFile,powerShell:async()=>'/fixture/powershell',command:async(program,args)=>{
  if(program==='/usr/bin/wslpath')return args[1]===freshPath?fresh:f.folder;
  bootstraps++;return JSON.stringify({path:freshPath,arch:'x64'});
 }});
 const binary=await extractCampusNative(artifacts,{resolveRuntime:async()=>runtime,prepareWindows});
 assert.equal(bootstraps,1);assert.equal(binary.interop,true);assert.equal(await readFile(binary.path,'utf8'),'complete helper');
 assert.ok(binary.path.startsWith(fresh));assert.deepEqual(JSON.parse(await readFile(f.cacheFile,'utf8')),{path:freshPath,arch:'x64'});
});
test('a second extraction failure clears the cache and stops instead of bootstrapping repeatedly',async t=>{
 const f=await fixture(t);await seed(f);await writeFile(join(f.folder,'stargate-campus'),'blocks extraction');let bootstraps=0;
 const prepareWindows=value=>prepareWindowsNativeFolder(value,{cacheFile:f.cacheFile,powerShell:async()=>'/fixture/powershell',command:async program=>{
  if(program==='/usr/bin/wslpath')return f.folder;bootstraps++;return JSON.stringify({path:windowsPath,arch:'x64'});
 }});
 await assert.rejects(extractCampusNative({version:'fixture-build',artifacts:{}},{resolveRuntime:async()=>runtime,prepareWindows}),{code:'ENOTDIR'});
 assert.equal(bootstraps,1);await assert.rejects(readFile(f.cacheFile),{code:'ENOENT'});
});
