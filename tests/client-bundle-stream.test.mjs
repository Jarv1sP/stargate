import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {standaloneClientStream,standaloneClientInfo,standaloneClientRangeStream,clientByteRange} from '../client-bundle.mjs';

const placeholder=JSON.stringify('__GPUQ_PUBLIC_ORIGIN__');
const footer=slots=>'\n// STARGATE_BUILD_INFO '+JSON.stringify({revision:'fixture-build-17',originSlots:slots})+'\n';

test('ranges address exact rendered UTF-8 bytes across the origin replacement',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuq-range-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'client.mjs'),origin='https://example.test/中文';
  const source=`const url=${placeholder}; // 中文\n`,expected=Buffer.from(source.replace(placeholder,JSON.stringify(origin)));
  await writeFile(file,source);
  for(const [start,end] of [[0,0],[3,20],[9,expected.length-1],[expected.length-4,expected.length-1]]){
    const parts=[];for await(const part of standaloneClientRangeStream(origin,{file,start,end,chunkBytes:3}))parts.push(part);
    assert.deepEqual(Buffer.concat(parts),expected.subarray(start,end+1));
  }
  assert.deepEqual(clientByteRange('bytes=3-',20),{start:3,end:19});
  assert.deepEqual(clientByteRange('bytes=-4',20),{start:16,end:19});
  assert.deepEqual(clientByteRange('bytes=3-200',20),{start:3,end:19});
  for(const bad of ['bytes=20-','bytes=4-3','bytes=-0','bytes=1-2,4-5','bytes=-','bytes=99999999999999999999-'])assert.equal(clientByteRange(bad,20),null,bad);
});

test('streamed CLI preserves UTF-8 and replaces every JSON literal across chunk boundaries',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuq-stream-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'client.mjs'),origin='https://fixture.example/\"\\测试';
  const source=`// 中文\nconst a=${placeholder},b=${placeholder};\nconst unquoted='__GPUQ_PUBLIC_ORIGIN__';\n`+footer(2);
  await writeFile(file,source);
  const expected=Buffer.from(source.replaceAll(placeholder,()=>JSON.stringify(origin)));
  for(let chunkBytes=1;chunkBytes<=Buffer.byteLength(placeholder)+1;chunkBytes++){
    const parts=[];
    for await(const part of standaloneClientStream(origin,{file,chunkBytes}))parts.push(part);
    assert.deepEqual(Buffer.concat(parts),expected,'chunk width '+chunkBytes);
    assert.deepEqual(await standaloneClientInfo(origin,{file,chunkBytes}),{bytes:expected.length,etag:'fixture-build-17'});
  }
});

test('missing bundle and missing origin placeholder remain errors',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuq-stream-missing-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await assert.rejects(standaloneClientInfo('https://fixture.example',{file:join(root,'missing')}),error=>error.status===503);
  const file=join(root,'wrong');await writeFile(file,'// no origin literal\n');
  await assert.rejects(standaloneClientInfo('https://fixture.example',{file}),/build info is missing/);
  const consume=async()=>{for await(const _part of standaloneClientStream('https://fixture.example',{file})){};};
  await assert.rejects(consume(),/missing its public origin placeholder/);
});

test('four concurrent large UTF-8 CLI streams fit a 32 MiB JS heap',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuq-stream-large-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'client.mjs'),fd=await open(file,'wx');
  const block=Buffer.alloc(1024*1024,0x61),header=Buffer.from('// 中文\n'),tail=Buffer.from(`\nconst origin=${placeholder};\n`+footer(1));
  let bytes=0;
  const write=async part=>{await fd.writeFile(part);bytes+=part.length;};
  await write(header);
  for(let i=0;i<40;i++)await write(block);
  // Count rendered bytes while writing the placeholder and build footer.
  await fd.writeFile(tail);await fd.close();
  const renderedTail=Buffer.from(tail.toString().replaceAll(placeholder,JSON.stringify('https://fixture.example')));
  bytes+=renderedTail.length;
  const module=pathToFileURL(new URL('../client-bundle.mjs',import.meta.url).pathname).href;
  const program=`import {standaloneClientInfo,standaloneClientStream} from ${JSON.stringify(module)};const results=await Promise.all(Array.from({length:4},async()=>{const info=await standaloneClientInfo('https://fixture.example',{file:process.argv[1]});let bytes=0;for await(const part of standaloneClientStream('https://fixture.example',{file:process.argv[1]}))bytes+=part.length;return {info,bytes};}));console.log(JSON.stringify({results,maxRssKiB:process.resourceUsage().maxRSS}));`;
  const child=spawn(process.execPath,['--max-old-space-size=32','--input-type=module','-e',program,file],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  assert.equal(exit.code,0,stderr+' '+exit.signal);
  const result=JSON.parse(stdout);
  for(const actual of result.results)assert.deepEqual(actual,{bytes,info:{bytes,etag:'fixture-build-17'}});
  assert.ok(result.maxRssKiB<128*1024,'streaming process exceeded 128 MiB RSS: '+result.maxRssKiB);
});
