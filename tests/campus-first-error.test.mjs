import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createCampusNativeAgent,campusNativePersonalFileRequest} from '../client-campus-native.mjs';
import {createPersonalFileTransport} from '../client-personal-file-campus.mjs';
import {uploadLocalFile} from '../client-transfers.mjs';
import {downloadResultFile} from '../client-result-download.mjs';

const pin='a'.repeat(64),grant={endpoint:'https://campus.invalid',certificateSha256:pin,
  grantId:'12345678-1234-4234-8234-123456789012',ticket:'isolated-fixture-ticket',expiresAt:Date.now()/1000+550.5,chunkBytes:1048576,file:{size:3}};
function transportFor(code,writeMayHaveReachedPeer=false){
  let frames=0;
  const agent=createCampusNativeAgent(pin,{extract:async()=>({path:'fixture',cleanup:async()=>{}}),spawnProcess(){
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>assert.fail('helper must exit through EOF');
    child.stdin=new Writable({final(done){done();queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});},write(_bytes,_encoding,done){
      frames++;const meta=Buffer.from(JSON.stringify({ok:false,code,bodyBytes:0,...(writeMayHaveReachedPeer?{writeMayHaveReachedPeer:true}:{})})),size=Buffer.alloc(4);size.writeUInt32BE(meta.length);
      done();queueMicrotask(()=>child.stdout.write(Buffer.concat([size,meta])));
    }});return child;
  }});
  return {frames:()=>frames,transportFactory:(call,options)=>createPersonalFileTransport(call,{...options,agentFactory:()=>agent,send:campusNativePersonalFileRequest})};
}
for(const code of ['ACK_UNCONFIRMED','RESPONSE_INTERRUPTED'])test(`an ambiguous ${code} keeps the original failure after upload status reconciliation`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'campus-first-ambiguous-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const local=join(root,'source'),key=randomUUID();await writeFile(local,'abc');const f=transportFor(code,true);let queries=0;
  const call=async(op,args)=>{
    if(op==='files.direct-ticket')return {result:grant};assert.equal(args.key,key);
    if(op==='data.upload.begin')return {result:{state:'UPLOADING',offset:0}};
    assert.equal(op,'data.upload.status');queries++;return {result:{state:'UPLOADING',offset:0}};
  };
  await assert.rejects(uploadLocalFile(call,{machine:'fixture',context:{area:'code',project:'fixture'},local,path:'file',key,...f}),error=>{
    assert.equal(error.code,code);assert.equal(error.writeMayHaveReachedPeer,true);assert.doesNotMatch(error.message,/SESSION_STOPPED/);assert.match(error.message,new RegExp(key));return true;
  });
  assert.equal(queries,2);assert.equal(f.frames(),1);
});
const firstError=code=>error=>{
  assert.equal(error.code,code);assert.equal(error.writeMayHaveReachedPeer,false);assert.doesNotMatch(error.message,/SESSION_STOPPED/);
  assert.match(error.message,/校园直连连不上（不在校园网或校园网断开）；上传加 --via relay、下载加 --via portal，用原 --key 续传。/);return true;
};
for(const area of ['code','dataset'])for(const code of ['TCP_TIMEOUT','DNS_FAILED','TCP_REFUSED','NETWORK_UNREACHABLE','PHYSICAL_CONNECT_FAILED'])test(`${area} upload keeps first ${code}; only explicit relay resumes the original key`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'campus-first-upload-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const local=join(root,'source'),key=randomUUID(),context={area,...(area==='code'?{project:'fixture'}:{dataset:'fixture'})};await writeFile(local,'abc');
  const f=transportFor(code),calls=[];
  const call=async(op,args)=>{
    calls.push(op);if(op==='files.direct-ticket')return {result:grant};assert.equal(args.key,key);
    if(op==='data.upload.begin')return {result:{state:'UPLOADING',offset:0}};
    if(op==='data.upload.chunk')return {result:{state:'UPLOADING',offset:3}};
    if(op==='data.upload.finish')return {result:{state:'COMPLETE'}};
    assert.fail('unwritten native requests must not enter status recovery: '+op);
  };
  const options={machine:'fixture',context,local,path:'file',key,...f};
  await assert.rejects(uploadLocalFile(call,options),firstError(code));assert.equal(f.frames(),1);assert.ok(!calls.includes('data.upload.chunk'));
  assert.equal((await uploadLocalFile(call,{...options,via:'relay'})).state,'COMPLETE');assert.equal(f.frames(),1);
});
for(const area of ['code','dataset'])test(`${area} download keeps first timeout and waits for explicit portal retry`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'campus-first-download-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const f=transportFor('TCP_TIMEOUT'),destination=join(root,'result');let portal=0;
  const call=async(op,args)=>{if(op==='files.direct-ticket')return {result:grant};assert.equal(op,'files.get');assert.equal(args.offset,0);portal++;return {result:{size:3,offset:0,data:'YWJj'}};};
  const options={machine:'fixture',context:{area,project:'fixture',dataset:'fixture'},path:'file',destination,origin:'https://portal.invalid',userId:'fixture'};
  await assert.rejects(downloadResultFile(call,options,f),firstError('TCP_TIMEOUT'));assert.equal(f.frames(),1);assert.equal(portal,0);
  await downloadResultFile(call,{...options,via:'portal'},f);assert.equal(portal,1);assert.equal(await readFile(destination,'utf8'),'abc');
});
