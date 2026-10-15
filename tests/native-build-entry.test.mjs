import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildCampusNative} from '../scripts/build-campus-native.mjs';
import {extractCampusNative} from '../client-campus-native.mjs';

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
  assert.deepEqual(Object.keys(input.artifacts),['linux-x64','linux-arm64','windows-x64','windows-arm64']);
  assert.deepEqual(Object.values(input.artifacts).map(row=>Buffer.from(row.base64,'base64').toString()),
    ['linux/amd64','linux/arm64','windows/amd64','windows/arm64']);
  const binary=await extractCampusNative(input,{resolveRuntime:async()=>({platform:'linux',arch:'x64',interop:false})});
  try{assert.equal(await readFile(binary.path,'utf8'),'linux/amd64');}finally{await binary.cleanup();}
});
