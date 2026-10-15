import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {approvedCampusEndpoints,chooseCampusEndpoint,privateLanOrigin} from '../client-campus-endpoints.mjs';
import {createPersonalFileTransport} from '../client-personal-file-campus.mjs';
import {createCampusNativeAgent,campusNativePersonalFileRequest} from '../client-campus-native.mjs';
import {uploadLocalFile} from '../client-transfers.mjs';
const pin='a'.repeat(64),uploadId='11111111-1111-4111-8111-111111111111';
const routes=[{id:'primary',kind:'campus-direct',endpoint:'https://campus.invalid:18441'},{id:'node-lan',kind:'campus-direct',endpoint:'https://192.168.50.7:18444'}];
const base={endpoint:routes[0].endpoint,certificateSha256:pin,machine:'fixture',expiresAt:Math.floor(Date.now()/1000)+300,chunkBytes:1048576,ticket:'unchanged_opaque_ticket_fixture',routes};
const personal=(extra={})=>({...base,grantId:uploadId,file:{size:3},...extra});
function nativeFactory(handle){
  return pin=>createCampusNativeAgent(pin,{extract:async()=>({path:'fixture-helper',cleanup:async()=>{}}),spawnProcess(){
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>assert.fail('helper must exit through EOF');
    child.stdin=new Writable({final(done){done();queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});},write(bytes,_encoding,done){
      const n=bytes.readUInt32BE(0),header=JSON.parse(bytes.subarray(4,4+n)),body=bytes.subarray(4+n);
      const {raw=Buffer.alloc(0),...value}=handle(header,body),meta=Buffer.from(JSON.stringify({...value,bodyBytes:raw.length})),size=Buffer.alloc(4);size.writeUInt32BE(meta.length);
      done();queueMicrotask(()=>child.stdout.write(Buffer.concat([size,meta,raw])));
    }});return child;
  }});
}
test('authenticated routes skip unusable entries and retain the primary and private LAN alias',()=>{
  assert.deepEqual(approvedCampusEndpoints(base).map(e=>e.id),['node-lan','primary']);
  for(const endpoint of ['http://192.168.50.7','https://100.64.0.1','https://127.0.0.1','https://8.8.8.8','https://user@192.168.50.7','https://192.168.50.7/path']){
    assert.equal(privateLanOrigin(endpoint),false);assert.deepEqual(approvedCampusEndpoints({...base,routes:[routes[0],{...routes[1],endpoint}]}),[routes[0]]);
  }
  assert.equal(approvedCampusEndpoints({...base,routes:[...routes,{id:'other',kind:'campus-direct',endpoint:'https://extra.invalid'}]}).length,3);
  for(const entries of [[...routes,{id:'tail',kind:'tail-upload',endpoint:'https://tail.invalid'}],[routes[1]],[{...routes[0],endpoint:'https://changed.invalid'},routes[1]],[routes[0],routes[0],routes[1]]])assert.deepEqual(approvedCampusEndpoints({...base,routes:entries}),[routes[1],routes[0]]);
  for(const entries of [[],null,[null]])assert.deepEqual(approvedCampusEndpoints({...base,routes:entries}),[routes[0]]);
});
test('LAN is tried before the primary using the same authenticated endpoint list',async()=>{
 const seen=[];const selected=await chooseCampusEndpoint(base,approvedCampusEndpoints(base),{probe:async(grant,endpoint)=>{seen.push(endpoint.id);}});assert.equal(selected.id,'node-lan');assert.deepEqual(seen,['node-lan']);
});
for(const action of ['get','put'])for(const start of ['node-lan','primary'])test(`${action} switches from ${start} after a native unwritten timeout without changing the request`,async()=>{
  const calls=[],grant=personal();
  const transport=await createPersonalFileTransport(async()=>({result:grant}),{machine:'fixture',context:{project:'own',area:'code'},path:'source',action,
    identity:action==='put'?{uploadId,totalSize:3}:{},send:campusNativePersonalFileRequest,
    probeEndpoint:async(_grant,endpoint)=>{if(start==='primary'&&endpoint.id==='node-lan')throw Object.assign(Error('LAN unavailable'),{code:'TCP_TIMEOUT'});},
    agentFactory:nativeFactory((header,body)=>{calls.push({header,body});if(calls.length===1)return {ok:false,code:'TCP_TIMEOUT'};
      return action==='get'?{ok:true,metadata:{size:3,offset:header.offset},raw:Buffer.from('abc')}:{ok:true,result:{offset:3,complete:true}};})});
  try{
    const result=await transport.request({offset:0,...(action==='put'?{final:true,bytes:Buffer.from('abc')}:{})});
    assert.equal(action==='get'?result.data:result.offset,action==='get'?'YWJj':3);assert.equal(calls.length,2);
    assert.equal(calls[0].header.dialEndpoint,start==='node-lan'?routes[1].endpoint:undefined);assert.equal(calls[1].header.dialEndpoint,start==='node-lan'?undefined:routes[1].endpoint);
    assert.deepEqual(calls[0].header.grant,calls[1].header.grant);assert.equal(calls[1].header.offset,0);assert.deepEqual(calls[0].body,calls[1].body);
  }finally{await transport.close();}
});
test('personal PUT changes endpoint but never replays an ambiguous write before caller status reconciliation',async()=>{
  const calls=[],grant=personal(),transport=await createPersonalFileTransport(async()=>({result:grant}),{machine:'fixture',context:{project:'own',area:'code'},path:'source',action:'put',identity:{uploadId,totalSize:3},probeEndpoint:async()=>{},send:campusNativePersonalFileRequest,
    agentFactory:nativeFactory(header=>{calls.push(header);return calls.length===1?{ok:false,code:'ACK_UNCONFIRMED',writeMayHaveReachedPeer:true}:{ok:true,result:{offset:3,complete:true}};})});
  try{await assert.rejects(transport.request({offset:0,final:true,bytes:Buffer.from('abc')}),{code:'ACK_UNCONFIRMED',writeMayHaveReachedPeer:true});assert.equal(calls.length,1);await transport.request({offset:3,final:true,bytes:Buffer.alloc(0)});assert.equal(calls[1].dialEndpoint,undefined);assert.equal(calls[0].grant.ticket,calls[1].grant.ticket);}finally{await transport.close();}
});
test('HTTP authorization rejection never triggers personal endpoint fallback',async()=>{
  let sends=0,probes=0;const transport=await createPersonalFileTransport(async()=>({result:personal()}),{machine:'fixture',context:{project:'own'},path:'source',action:'put',probeEndpoint:async()=>{probes++;},send:campusNativePersonalFileRequest,
    agentFactory:nativeFactory(()=>{sends++;return {ok:false,code:'HTTP_REJECTED',status:409};})});
  try{await assert.rejects(transport.request({offset:0,final:true,bytes:Buffer.alloc(0)}),{code:'HTTP_REJECTED',status:409});assert.equal(sends,1);assert.equal(probes,1);}finally{await transport.close();}
});
test('a timeout followed by an ambiguous PUT reconciles the original key instead of reporting an unwritten request',async t=>{
  const root=await mkdtemp(join(tmpdir(),'campus-lan-upload-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const local=join(root,'source');await writeFile(local,'abc');let frames=0,queries=0;
  const call=async(op,args)=>{
    if(op==='files.direct-ticket')return {result:personal()};assert.equal(args.key,uploadId);
    if(op==='data.upload.begin')return {result:{state:'UPLOADING',offset:0}};
    if(op==='data.upload.status'){queries++;return {result:{state:'UPLOADING',offset:3}};}
    assert.equal(op,'data.upload.finish');return {result:{state:'COMPLETE'}};
  };
  const agentFactory=nativeFactory(()=>++frames===1?{ok:false,code:'TCP_TIMEOUT'}:{ok:false,code:'ACK_UNCONFIRMED',writeMayHaveReachedPeer:true});
  const result=await uploadLocalFile(call,{machine:'fixture',context:{area:'code',project:'own'},path:'source',local,key:uploadId,via:'direct',
    transportFactory:(call,options)=>createPersonalFileTransport(call,{...options,probeEndpoint:async()=>{},agentFactory,send:campusNativePersonalFileRequest})});
  assert.equal(result.state,'COMPLETE');assert.equal(queries,1);assert.equal(frames,2);
});
test('only exhaustion of campus addresses adds relay instructions and keeps the first native error',async()=>{
  let calls=0;const transport=await createPersonalFileTransport(async()=>({result:personal()}),{machine:'fixture',context:{project:'own'},path:'source',action:'get',probeEndpoint:async()=>{},send:campusNativePersonalFileRequest,
    agentFactory:nativeFactory(()=>({ok:false,code:++calls===1?'TCP_TIMEOUT':'DNS_FAILED'}))});
  try{await assert.rejects(transport.request({offset:0}),error=>{assert.equal(error.code,'TCP_TIMEOUT');assert.match(error.message,/--via relay.*--via portal/);assert.doesNotMatch(error.message,/SESSION_STOPPED/);return true;});assert.equal(calls,2);}finally{await transport.close();}
});
