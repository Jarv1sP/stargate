import test from 'node:test';
import assert from 'node:assert/strict';
import {campusNativePersonalFileRequest} from '../client-campus-native.mjs';
const {createPersonalFileTransport}=await import(process.env.DOWNLOAD_RETRY_TEST_MODULE||'../client-personal-file-campus.mjs');
const pin='a'.repeat(64),size=3;
const grant=()=>({endpoint:'https://campus.example',certificateSha256:pin,
  grantId:'11111111-1111-4111-8111-111111111111',chunkBytes:1048576,
  expiresAt:1700000300,ticket:'test-ticket-placeholder-000000000',file:{path:'result.bin',size}});
for(const action of ['get','put'])test(`${action} renewal uses the new endpoint and connection pin with the original request`,async()=>{
  let elapsed=0,next=grant();const tickets=[],agents=[],frames=[];
  const transport=await createPersonalFileTransport(async(op,args)=>{assert.equal(op,'files.direct-ticket');tickets.push(args);return {result:next};},{
    machine:'node-a',context:{project:'paper'},path:'result.bin',action,
    identity:action==='put'?{uploadId:'22222222-2222-4222-8222-222222222222',totalSize:size}:{},
    now:()=>1700000000+elapsed/1000,monotonic:()=>elapsed,
    agentFactory:pin=>{const agent={pin,closed:false,destroy:async()=>{agent.closed=true;},request:async(header,body)=>{
      frames.push({header,pin});return action==='get'?{value:{metadata:{size,offset:header.offset}},raw:Buffer.from('abc')}:{value:{result:{offset:header.offset+body.length}},raw:Buffer.alloc(0)};
    }};agents.push(agent);return agent;},send:campusNativePersonalFileRequest
  });
  const args={offset:0,...(action==='put'?{bytes:Buffer.from('abc'),final:false}:{})};
  try{
    await transport.request(args);elapsed=181000;
    next={...next,endpoint:'https://renewed.example',certificateSha256:'b'.repeat(64),expiresAt:1700000481,ticket:'renewed-ticket-placeholder-000000'};
    await transport.request(args);
    assert.equal(agents.length,2);assert.equal(agents[0].closed,true);assert.deepEqual(tickets[1],tickets[0]);
    assert.equal(frames[1].header.grant.endpoint,next.endpoint);assert.equal(frames[1].pin,next.certificateSha256);
    assert.equal(frames[1].header.grant.ticket,next.ticket);assert.equal(frames[1].header.offset,0);
    if(action==='get'){
      next={...next,file:{...next.file,size:size+1}};
      elapsed=362000;
      await assert.rejects(transport.request(args),/文件大小已改变/);assert.equal(frames.length,2);
    }
  }finally{await transport.close();}
  assert.ok(agents.every(agent=>agent.closed));
});
for(const action of ['get','put'])test(`${action} renewal reuses a connection when only the ticket changes`,async()=>{
  let elapsed=0,tickets=0,agents=0,closed=0;const frames=[];
  const transport=await createPersonalFileTransport(async()=>({result:{...grant(),ticket:'ticket-placeholder-'+String(++tickets).padStart(8,'0')}}),{
    machine:'node-a',context:{project:'paper'},path:'result.bin',action,
    now:()=>1700000000+elapsed/1000,monotonic:()=>elapsed,
    agentFactory:()=>{agents++;return {destroy:async()=>{closed++;},request:async header=>{
      frames.push(header);return action==='get'?{value:{metadata:{size,offset:header.offset}},raw:Buffer.from('abc')}:{value:{result:{offset:3}},raw:Buffer.alloc(0)};
    }};},send:campusNativePersonalFileRequest
  });
  try{
    for(elapsed=181000;elapsed<=183000;elapsed+=1000)await transport.request({offset:0,...(action==='put'?{bytes:Buffer.from('abc'),final:false}:{})});
    assert.equal(agents,1);assert.equal(closed,0);assert.equal(tickets,4);
    assert.deepEqual(frames.map(frame=>frame.grant.ticket),[2,3,4].map(n=>'ticket-placeholder-'+String(n).padStart(8,'0')));
  }finally{await transport.close();}
  assert.equal(closed,1);
});
