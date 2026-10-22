import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildCampusNative} from '../scripts/build-campus-native.mjs';
import {buildClient} from '../scripts/build-client.mjs';
import {extractCampusNative} from '../client-campus-native.mjs';

test('release input contains actual Intel and Apple Silicon Mach-O helpers',async()=>{
 const input=JSON.parse(await readFile(new URL('../build/campus-native/embedded-artifacts.private.json',import.meta.url),'utf8'));
 for(const [platform,cpu] of [['darwin-x64',0x01000007],['darwin-arm64',0x0100000c]]){
  const item=input.artifacts[platform];assert.ok(item,platform+' must be built from source');
  const bytes=Buffer.from(item.base64,'base64');assert.equal(bytes.length,item.bytes);
  assert.equal(bytes.readUInt32LE(0),0xfeedfacf);assert.equal(bytes.readUInt32LE(4),cpu);
  let at=32,signed=false;
  for(let i=0;i<bytes.readUInt32LE(16);i++){
   if(bytes.readUInt32LE(at)===0x1d)signed=true;
   at+=bytes.readUInt32LE(at+4);
  }
  if(platform==='darwin-arm64')assert.ok(signed,'Apple Silicon executable needs the Go linker code signature');
 }
});

test('a failed cross-build preserves the old input; success replaces both old Linux helpers with compiled outputs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'native build fixture ')),outfile=join(root,'build/input.json');
  t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'build'));
  const previous=JSON.stringify({artifacts:{'linux-x64':'old Linux x64','linux-arm64':'old Linux arm64'}});
  await writeFile(outfile,previous);let fail=true;
  const run=async(_go,args,{env})=>{
    if(fail&&env.GOOS==='windows')throw Error('compiler unavailable');
    await writeFile(args[args.indexOf('-o')+1],env.GOOS+'/'+env.GOARCH);return {stdout:''};
  };
  await assert.rejects(buildCampusNative({root,outfile,run}),/compiler unavailable/);
  assert.equal(await readFile(outfile,'utf8'),previous);
  fail=false;await buildCampusNative({root,outfile,run});
  const input=JSON.parse(await readFile(outfile,'utf8'));
  await buildCampusNative({root,outfile,run});assert.notEqual(JSON.parse(await readFile(outfile,'utf8')).version,input.version);
  assert.deepEqual(Object.keys(input.artifacts),['linux-x64','linux-arm64','darwin-x64','darwin-arm64','windows-x64','windows-arm64']);
  assert.deepEqual(Object.values(input.artifacts).map(row=>Buffer.from(row.base64,'base64').toString()),
    ['linux/amd64','linux/arm64','darwin/amd64','darwin/arm64','windows/amd64','windows/arm64']);
  const binary=await extractCampusNative(input,{directory:join(root,'temporary'),resolveRuntime:async()=>({platform:'linux',arch:'x64',interop:false})});
  try{assert.equal(await readFile(binary.path,'utf8'),'linux/amd64');}finally{await binary.cleanup();}
});

test('separate bundled CLI invocations reuse the build revision and a new release changes cache path',async t=>{
  const root=await mkdtemp(join(tmpdir(),'native-cache-build-')),directory=join(root,'temporary'),outfile=join(root,'build/gpuctl.mjs');
  t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'build/campus-native'),{recursive:true});
  const base64=Buffer.from('synthetic helper').toString('base64');
  await writeFile(join(root,'build/campus-native/embedded-artifacts.private.json'),JSON.stringify({version:'native-input',artifacts:{'linux-x64':{bytes:16,base64}}}));
  await writeFile(join(root,'cli.mjs'),`import {extractCampusNative} from ${JSON.stringify(fileURLToPath(new URL('../client-campus-native.mjs',import.meta.url)))};const helper=await extractCampusNative(undefined,{directory:${JSON.stringify(directory)},resolveRuntime:async()=>({platform:'linux',arch:'x64',interop:false})});console.log(helper.path);await helper.cleanup();`);
  const invoke=async()=>(await promisify(execFile)(process.execPath,[outfile],{timeout:5000})).stdout.trim();
  await buildClient({root,outfile,revision:'release-a'});const first=await invoke(),again=await invoke();
  assert.equal(first,join(directory,`stargate-campus-${process.getuid?.()??'user'}`,'release-a','campus-http'));assert.equal(again,first);assert.equal(await readFile(first,'utf8'),'synthetic helper');
  await buildClient({root,outfile,revision:'release-b'});const next=await invoke();
  assert.equal(next,join(directory,`stargate-campus-${process.getuid?.()??'user'}`,'release-b','campus-http'));assert.notEqual(next,first);assert.equal(await readFile(next,'utf8'),'synthetic helper');
});
