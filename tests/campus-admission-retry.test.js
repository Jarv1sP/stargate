import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createCampusNativeAgent,campusNativePersonalFileRequest} from '../client-campus-native.mjs';

const pin='a'.repeat(64),uuid='12345678-1234-4234-8234-123456789012';
const grant={available:true,protocol:'personal-file-campus-v1',kind:'campus-direct',routeId:'primary',endpoint:'https://campus.invalid',
  certificateSha256:pin,revision:'b'.repeat(64),machine:'fixture',grantId:uuid,ticket:'isolated-fixture-ticket',expiresAt:Math.floor(Date.now()/1000)+300,
  chunkBytes:1024**2,file:{protocol:2,path:'file.bin',size:3,fingerprint:'c'.repeat(64)}};
function fixture(handle,options={}){
  const calls=[];let kills=0,spawns=0;
  const agent=createCampusNativeAgent(pin,{...options,extract:async()=>({path:'fixture-helper',cleanup:async()=>{}}),spawnProcess(){
    spawns++;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{kills++;queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});return true;};
    child.stdin=new Writable({write(bytes,_encoding,done){
      const n=bytes.readUInt32BE(0),header=JSON.parse(bytes.subarray(4,4+n)),body=Buffer.from(bytes.subarray(4+n));calls.push({header,body,time:Date.now()});
      const {raw=Buffer.alloc(0),...reply}=handle(header,body,calls.length),meta=Buffer.from(JSON.stringify({schema:1,seq:header.seq,bodyBytes:raw.length,...reply})),size=Buffer.alloc(4);
      size.writeUInt32BE(meta.length);done();queueMicrotask(()=>child.stdout.write(Buffer.concat([size,meta,raw])));
    }});return child;
  }});
  return {agent,calls,get kills(){return kills;},get spawns(){return spawns;}};
}
const busy=delay=>({ok:false,code:'HTTP_REJECTED',status:429,reasonCode:'LISTENER_BUSY',extraFutureField:true,retryAfterMs:delay});

for(const op of ['probe','put','get'])test(`${op} waits Retry-After and retries only the identical not-admitted frame`,async()=>{
  const delay=op==='probe'?30:10;
  const f=fixture((_header,_body,n)=>n===1?busy(delay):op==='get'?{ok:true,metadata:{...grant.file,offset:0,eof:true},raw:Buffer.from('raw')}:{ok:true,result:{offset:3}});
  try{
    if(op==='put'||op==='get')await campusNativePersonalFileRequest(grant,f.agent,op,{offset:0,...(op==='put'?{bytes:Buffer.from('raw'),final:true}:{})});
    else await f.agent.request({op,offset:0,...(op==='probe'?{endpoint:grant.endpoint,certificateSha256:pin,probeTimeoutMs:1000}:{
      grant:{...grant,protocol:'dataset-upload-v1',grantId:undefined,maxChunkBytes:16*1024**2},uploadId:uuid,...(op==='manifest'?{}:{path:'file.bin'})})},op==='chunk'||op==='manifest'?Buffer.from('raw'):undefined);
    assert.equal(f.calls.length,2);assert.equal(f.spawns,1);assert.equal(f.kills,0);
    const [{header:a,body:first,time:start},{header:b,body:second,time:finish}]=f.calls;
    assert.ok(finish-start>=delay-1,'Retry-After must not be shortened');assert.equal(b.seq,a.seq+1);
    assert.deepEqual({...b,seq:a.seq},a);assert.deepEqual(second,first);
  }finally{await f.agent.destroy();}
});

for(const status of [401,403,409])test(`an explicit HTTP ${status} failure never replays a write`,async()=>{
 const f=fixture(()=>({...busy(10),status}));try{await assert.rejects(campusNativePersonalFileRequest(grant,f.agent,'put',{offset:0,bytes:Buffer.from('raw'),final:true}));assert.equal(f.calls.length,1);}finally{await f.agent.destroy();}
});
test('admission retries stop after eight waits and retain the explicit 429',async()=>{
  const f=fixture(()=>busy(1));
  try{await assert.rejects(campusNativePersonalFileRequest(grant,f.agent,'put',{offset:0,bytes:Buffer.from('raw'),final:true}),e=>e.status===429&&e.reasonCode==='LISTENER_BUSY');assert.equal(f.calls.length,9);}
  finally{await f.agent.destroy();}
});

test('Retry-After beyond the remaining overall budget does not send early',async()=>{
  const f=fixture(()=>busy(100),{admissionRetryBudgetMs:50});
  try{await assert.rejects(f.agent.request({op:'probe',offset:0,endpoint:grant.endpoint,certificateSha256:pin}));assert.equal(f.calls.length,1);}
  finally{await f.agent.destroy();}
});

test('destroy cancels an admission wait without another frame',async()=>{
  const f=fixture(()=>busy(2000));
  const operation=f.agent.request({op:'probe',offset:0,endpoint:grant.endpoint,certificateSha256:pin});
  const rejected=assert.rejects(operation,/CLOSED/);
  await new Promise(resolve=>setTimeout(resolve,20));await f.agent.destroy();await rejected;assert.equal(f.calls.length,1);
});
