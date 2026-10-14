import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedCampusEndpoints,chooseCampusEndpoint,privateLanOrigin} from '../client-campus-endpoints.mjs';
import {createPersonalFileTransport} from '../client-personal-file-campus.mjs';
const pin='a'.repeat(64),revision='b'.repeat(64),uploadId='11111111-1111-4111-8111-111111111111';
const routes=[{id:'primary',kind:'campus-direct',endpoint:'https://campus.invalid:18441'},{id:'node-lan',kind:'campus-direct',endpoint:'https://192.168.50.7:18444'}];
const base={available:true,protocol:'personal-file-campus-v1',kind:'campus-direct',routeId:'primary',endpoint:routes[0].endpoint,certificateSha256:pin,revision,machine:'fixture',expiresAt:Math.floor(Date.now()/1000)+300,chunkBytes:1048576,ticket:'unchanged_opaque_ticket_fixture',routes};
const capability={protocol:'personal-file-campus-v1',listenerReady:true,machine:base.machine,revision};
const agentFactory=pin=>({pin,destroy:async()=>{}});
const personal=(extra={})=>({...base,protocol:'personal-file-campus-v1',grantId:uploadId,file:{protocol:2,path:'source',size:3},...extra});
const network=()=>Object.assign(Error('uncertain original write'),{code:'ACK_UNCONFIRMED',writeMayHaveReachedPeer:true});
test('authenticated HTTPS endpoints keep a fixed primary and private LAN alias',()=>{
  assert.deepEqual(approvedCampusEndpoints(base).map(e=>e.id),['node-lan','primary']);
  for(const endpoint of ['http://192.168.50.7','https://100.64.0.1','https://127.0.0.1','https://8.8.8.8','https://user@192.168.50.7','https://192.168.50.7/path']){
    assert.equal(privateLanOrigin(endpoint),false);assert.throws(()=>approvedCampusEndpoints({...base,routes:[routes[0],{...routes[1],endpoint}]}));
  }
  assert.equal(approvedCampusEndpoints({...base,routes:[...routes,{id:'other',kind:'campus-direct',endpoint:'https://extra.invalid'}]}).length,3);
  for(const invalid of [[...routes,{id:'tail',kind:'tail-upload',endpoint:'https://tail.invalid'}],[routes[1]],[{...routes[0],endpoint:'https://changed.invalid'},routes[1]]])assert.throws(()=>approvedCampusEndpoints({...base,routes:invalid}));
});
test('LAN is tried before the primary using the same authenticated endpoint list',async()=>{
 const seen=[];const selected=await chooseCampusEndpoint(base,approvedCampusEndpoints(base),{probe:async(grant,endpoint)=>{seen.push(endpoint.id);return capability;}});assert.equal(selected.id,'node-lan');assert.deepEqual(seen,['node-lan']);
});
test('personal GET switches endpoints at exactly the same offset, pin and opaque grant',async()=>{
  const calls=[],grant=personal(),transport=await createPersonalFileTransport(async()=>({result:grant}),{machine:'fixture',context:{project:'own',area:'code'},path:'source',action:'get',agentFactory,probeEndpoint:async()=>capability,send:async(g,a,op,args)=>{
    calls.push({grant:g,op,args});if(calls.length===1)throw network();return {offset:args.offset,data:'YWJj'};
  }});
  try{assert.equal((await transport.request({offset:0})).data,'YWJj');assert.equal(calls.length,2);assert.equal(calls[0].args.dialEndpoint,routes[1].endpoint);assert.equal(calls[1].args.dialEndpoint,undefined);assert.equal(calls[0].grant,calls[1].grant);assert.equal(calls[1].args.offset,0);}finally{await transport.close();}
});
test('personal PUT changes endpoint but never replays an ambiguous write before caller status reconciliation',async()=>{
  const calls=[],grant=personal(),transport=await createPersonalFileTransport(async()=>({result:grant}),{machine:'fixture',context:{project:'own',area:'code'},path:'source',action:'put',identity:{uploadId,totalSize:3},agentFactory,probeEndpoint:async()=>capability,send:async(g,a,op,args)=>{calls.push({g,args});if(calls.length===1)throw network();return {size:3,complete:true};}});
  try{await assert.rejects(transport.request({offset:0,final:true,bytes:Buffer.from('abc')}),/uncertain/);assert.equal(calls.length,1);await transport.request({offset:3,final:true,bytes:Buffer.alloc(0)});assert.equal(calls[1].args.dialEndpoint,undefined);assert.equal(calls[0].g.ticket,calls[1].g.ticket);}finally{await transport.close();}
});
test('HTTP authorization rejection never triggers personal endpoint fallback',async()=>{
  let sends=0,probes=0;const transport=await createPersonalFileTransport(async()=>({result:personal()}),{machine:'fixture',context:{project:'own'},path:'source',action:'put',agentFactory,probeEndpoint:async()=>{probes++;return capability;},send:async()=>{sends++;throw Object.assign(Error('rejected'),{code:'HTTP_REJECTED',status:409});}});
  try{await assert.rejects(transport.request({offset:0,final:true,bytes:Buffer.alloc(0)}),/rejected/);assert.equal(sends,1);assert.equal(probes,1);}finally{await transport.close();}
});
