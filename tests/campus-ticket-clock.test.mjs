import test from 'node:test';
import assert from 'node:assert/strict';
import {validCampusTicketTime} from '../dist/campus-ticket-time.js';
import {personalFileGrant,createPersonalFileTransport} from '../client-personal-file-campus.mjs';
import {campusNativePersonalFileRequest} from '../client-campus-native.mjs';

const server=1700000000,ttl=300,chunk=1048576;
const personal=()=>({available:true,protocol:'personal-file-campus-v1',machine:'fixture',kind:'campus-direct',routeId:'primary',
  endpoint:'https://campus.example',certificateSha256:'a'.repeat(64),revision:'b'.repeat(64),grantId:'12345678-1234-4234-8234-123456789012',
  expiresAt:server+ttl,chunkBytes:chunk,ticket:'isolated-capability-123456789',file:{protocol:2,path:'fixed',size:3}});
const factories=[
  ['CLI personal', (g,now)=>personalFileGrant(g,'fixed','get',now),personal],
];
for(const [name,check,grant] of factories){
  test(name+' accepts bounded clock skew and preserves non-time authority checks',()=>{
    for(const skew of [-5,5,-119])for(const metadata of [false,true]){
      const value={...grant(),...(metadata?{issuedAt:server,ttl}:{})};
      assert.equal(check(value,server+skew).expiresAt,server+ttl);
    }
    assert.equal(check({...grant(),expiresAt:server-119},server).expiresAt,server-119);
    assert.throws(()=>check({...grant(),expiresAt:server-120},server));
    assert.equal(check({...grant(),expiresAt:server+420},server).expiresAt,server+420);
    assert.throws(()=>check({...grant(),expiresAt:server+421},server));
    for(const change of [{certificateSha256:'invalid'},{chunkBytes:2*chunk},{ticket:'invalid'},{endpoint:'http://campus.example'}])
      assert.throws(()=>check({...grant(),...change},server-5));
  });
}
test('authority issuedAt/ttl take precedence and malformed issuance metadata cannot use fallback',()=>{
  assert.equal(validCampusTicketTime({issuedAt:server,ttl:30,expiresAt:server+30},server-119),true);
  for(const change of [{ttl:301},{ttl:0},{ttl:1.5},{issuedAt:server+121,expiresAt:server+151},
    {expiresAt:server+31},{issuedAt:undefined},{ttl:undefined},{issuedAt:NaN}])
    assert.equal(validCampusTicketTime({issuedAt:server,ttl:30,expiresAt:server+30,...change},server),false);
});
test('code, output and directory dataset scopes use the same authenticated file transport',async()=>{
  let started=0;const hooks={now:()=>server-119,agentFactory:()=>{started++;return {destroy:async()=>{}};},send:async()=>{throw Error('No body expected');}};
  for(const area of ['code','output','dataset']){const transport=await createPersonalFileTransport(async()=>({result:personal()}),{machine:'fixture',context:{area},path:'fixed',action:'get',...hooks});await transport.close();}
  assert.equal(started,3);assert.throws(()=>personalFileGrant({...personal(),grantId:'invalid'},'fixed','get',server));
});
test('native personal wire retains optional issuance metadata without changing UUID/pin/size',async()=>{
  const grant={...personal(),issuedAt:server,ttl},seen=[];
  const agent={pin:grant.certificateSha256,request:async(header,bytes)=>{seen.push({header,bytes});return {value:{result:{complete:true}},raw:Buffer.alloc(0)};}};
  await campusNativePersonalFileRequest(grant,agent,'put',{offset:0,final:true,bytes:Buffer.alloc(0)});
  assert.equal(seen[0].header.grant.issuedAt,server);assert.equal(seen[0].header.grant.ttl,ttl);
  assert.equal(seen[0].header.grant.grantId,grant.grantId);assert.equal(seen[0].header.grant.certificateSha256,grant.certificateSha256);
  assert.equal(seen[0].bytes.length,0);
});
