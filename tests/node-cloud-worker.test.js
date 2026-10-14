import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Readable} from 'node:stream';
import {CloudDirectory,runCloudFileIO,workerAdapter} from '../node/cloud-files-worker.mjs';
import {createCloudDriveFilesTransport} from '../node/clouddrive-files.mjs';
const raw=Buffer.from('cloud file bytes');
const remote={id:'actual:remote-file/id',name:'train.bin',fullPathName:'/cloud/train.bin',size:String(raw.length)};
function adapter({body=raw,size=raw.length,offset=0}={}){
  const calls=[];
  const transport={
    async rpc(method,args){calls.push([method,args]);return method==='GetSubFiles'?{subFiles:[{...remote,size:String(size),extra:'ignored',fileHashes:{1:'unused'}}]}:{downloadUrlPath:'/static/train.bin'};},
    async read(){return {status:offset?206:200,headers:{'content-length':String(body.length),...(offset?{'content-range':`bytes ${offset}-${size-1}/${size}`}:{})},body:Readable.from([body]),close(){}};},close(){},
  };
  return {directory:new CloudDirectory(transport,'node-private-token'),calls};
}
function file(t,prefix=Buffer.alloc(0)){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c4-cloud-'));const name=path.join(dir,'temporary');fs.writeFileSync(name,prefix,{mode:0o600});
  const fd=fs.openSync(name,'r+');t.after(()=>{fs.closeSync(fd);fs.rmSync(dir,{recursive:true,force:true});});return {fd,name};
}
test('list returns real remote IDs/sizes, ignores hashes and contains no credentials or receipts',async()=>{
  const {directory}=adapter();const result=await directory.list();assert.equal(result.files[0].id,remote.id);assert.equal(result.files[0].size,raw.length);
  for(const word of ['receipt','sha256','apiToken','node-private-token'])assert.equal(JSON.stringify(result).includes(word),false);
});
test('download writes real bytes through inherited FD; extra old fields do not gate completion',async t=>{
  const {fd,name}=file(t),{directory,calls}=adapter();
  const result=await runCloudFileIO({action:'download',fileId:remote.id,size:raw.length,offset:0,receipt:'ignored',sha256:'wrong',extra:true},{fd,adapter:directory});
  assert.equal(result.state,'COMPLETE');assert.deepEqual(fs.readFileSync(name),raw);assert.equal(calls.some(([m])=>/verify/i.test(m)),false);
});
test('resume reads only the remaining bytes at the original offset',async t=>{
  const {fd,name}=file(t,raw.subarray(0,6)),{directory}=adapter({body:raw.subarray(6),offset:6});
  await runCloudFileIO({action:'download',fileId:remote.id,size:raw.length,offset:6},{fd,adapter:directory});assert.deepEqual(fs.readFileSync(name),raw);
});
test('partial transfer keeps the original temporary prefix, never reports complete',async t=>{
  const {fd,name}=file(t),{directory}=adapter({body:raw.subarray(0,4)});
  await assert.rejects(runCloudFileIO({action:'download',fileId:remote.id,size:raw.length},{fd,adapter:directory}),/大小不完整/);
  assert.equal(fs.readFileSync(name).length,0);
});
test('a selected file with changed size requires a fresh size, without hashing',async t=>{
  const {fd}=file(t),{directory}=adapter({size:raw.length+1});
  await assert.rejects(runCloudFileIO({action:'download',fileId:remote.id,size:raw.length},{fd,adapter:directory}),/大小已变化/);
});
test('cloud listing skips local files and never descends a local system directory',async()=>{
  const visits=[];const directory=new CloudDirectory({async rpc(_,args){visits.push(args.path);return {subFiles:[{id:'system',fullPathName:'/etc',isLocal:true,isDirectory:true},remote]};}},'private');
  assert.equal((await directory.list()).files.length,1);assert.deepEqual(visits,['/']);
});
test('only a local CD2 static stream can receive node credentials',async t=>{
  const server=http.createServer((request,response)=>{assert.equal(request.headers.authorization,undefined);response.setHeader('content-length',raw.length);response.end(raw);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const transport=createCloudDriveFilesTransport({endpoint:`http://127.0.0.1:${server.address().port}`,allowInsecureLoopback:true});t.after(()=>transport.close());
  const response=await transport.read('/static/fixture');const parts=[];for await(const chunk of response.body)parts.push(chunk);assert.deepEqual(Buffer.concat(parts),raw);
  assert.throws(()=>transport.read('https://external.example/file'),/本地文件流/);assert.throws(()=>transport.read('/static/../etc/passwd'),/描述符/);
});
test('private worker credentials require a private file and enabled service',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c4-cloud-private-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const config=path.join(dir,'config');fs.writeFileSync(config,JSON.stringify({enabled:false}),{mode:0o600});assert.throws(()=>workerAdapter(config),/未启用/);
  fs.chmodSync(config,0o644);assert.throws(()=>workerAdapter(config),/私有配置/);
});
test('server file upload streams bytes once and returns the actual remote ID/path after size',async t=>{
  const {fd}=file(t,raw),calls=[],written=[];let closed=false;
  const transport={async rpc(method,args){
    calls.push([method,args]);
    if(method==='FindFileByPath'){if(!closed)throw Object.assign(Error('not found'),{grpcCode:5});return {...remote,size:Buffer.concat(written).length};}
    if(method==='CreateFile')return {fileHandle:'77'};
    if(method==='WriteToFile'){written.push(args.buffer);return {bytesWritten:args.buffer.length};}
    if(method==='CloseFile'){closed=true;return {success:true};}
  }};
  const result=await runCloudFileIO({action:'upload',operationId:'11111111-1111-4111-8111-111111111111',name:'train.bin',size:raw.length,receipt:'ignored'},{fd,adapter:new CloudDirectory(transport,'private')});
  assert.equal(result.id,remote.id);assert.match(result.path,/file-11111111.*train.bin$/);assert.deepEqual(Buffer.concat(written),raw);
  assert.equal(calls.filter(([m])=>m==='WriteToFile').length,1);assert.equal(calls.some(([m])=>/verify/i.test(m)),false);
});
test('cloud upload resumes its original open file handle and byte offset',async t=>{
  const {fd}=file(t,raw),written=[raw.subarray(0,6)],calls=[];let closed=false;
  const transport={async rpc(method,args){calls.push([method,args]);
    if(method==='FindFileByPath')return {...remote,size:closed?raw.length:6};
    if(method==='WriteToFile'){assert.equal(args.fileHandle,'77');assert.equal(args.startPos,'6');written.push(args.buffer);return {bytesWritten:args.buffer.length};}
    if(method==='CloseFile'){closed=true;return {success:true};}
  }};
  const result=await runCloudFileIO({action:'upload',operationId:'11111111-1111-4111-8111-111111111111',name:'train.bin',size:raw.length,fileHandle:'77',offset:6},{fd,adapter:new CloudDirectory(transport,'private')});
  assert.equal(result.state,'COMPLETE');assert.deepEqual(Buffer.concat(written),raw);assert.equal(calls.some(([m])=>m==='CreateFile'),false);
});
test('cloud upload without a real remote ID stays pending; status reads the actual file',async t=>{
  const {fd}=file(t,raw);let ready=false;
  const directory=new CloudDirectory({async rpc(){return {...remote,id:ready?remote.id:'',size:raw.length,isLocal:!ready};}},'private');
  const result=await runCloudFileIO({action:'upload',operationId:'11111111-1111-4111-8111-111111111111',name:'train.bin',size:raw.length},{fd,adapter:directory});
  assert.equal(result.state,'PENDING');assert.equal(result.id,null);ready=true;
  const later=await runCloudFileIO({action:'status',path:result.path,size:raw.length},{adapter:directory});assert.equal(later.state,'COMPLETE');assert.equal(later.id,remote.id);
});
