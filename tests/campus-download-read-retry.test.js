import test from 'node:test';
import assert from 'node:assert/strict';
const {createPersonalFileTransport}=await import(process.env.DOWNLOAD_RETRY_TEST_MODULE||'../client-personal-file-campus.mjs');
const fingerprint='a'.repeat(64),pin='b'.repeat(64),revision='c'.repeat(64);
const route={size:1048605,fingerprint,pin,revision,machine:'node-a',endpoint:'https://campus.example',chunkBytes:1048576,endpoints:[{id:'primary',endpoint:'https://campus.example'}]};
test('real transport refuses changed certificate or source size on recovery',async()=>{
 const grant={available:true,protocol:'personal-file-campus-v1',kind:'campus-direct',routeId:'primary',grantId:'11111111-1111-4111-8111-111111111111',machine:'node-a',endpoint:route.endpoint,
  certificateSha256:pin,revision,chunkBytes:1048576,expiresAt:Math.floor(Date.now()/1000)+300,ticket:'test-ticket-placeholder-000000000',file:{protocol:2,path:'result.bin',size:route.size,fingerprint}};
 const original=await createPersonalFileTransport(async()=>({result:grant}),{machine:'node-a',context:{project:'paper'},path:'result.bin',action:'get',platform:'test',agentFactory:()=>({destroy:async()=>{}}),send:()=>assert.fail('no body allowed')});
 const fixedRoute=original.routeIdentity;await original.close();
 for(const change of [{certificateSha256:'d'.repeat(64)},{file:{...grant.file,size:route.size+1}}]){
  await assert.rejects(createPersonalFileTransport(async()=>({result:{...grant,...change}}),{machine:'node-a',context:{project:'paper'},path:'result.bin',action:'get',identity:{fingerprint},fixedRoute,platform:'test',agentFactory:()=>assert.fail('changed grant must be refused before opening helper'),send:()=>assert.fail('no body allowed')}),{code:'CAMPUS_FILE_IDENTITY_CHANGED'});
 }
 for(const change of [{revision:'d'.repeat(64)},{chunkBytes:16*1048576,maxChunkBytes:16*1048576}]){
  const recovered=await createPersonalFileTransport(async()=>({result:{...grant,...change}}),{machine:'node-a',context:{project:'paper'},path:'result.bin',action:'get',identity:{fingerprint},fixedRoute,platform:'test',agentFactory:()=>({destroy:async()=>{}}),send:()=>assert.fail('No body needed to accept an authenticated renewal')});
  assert.equal(recovered.routeIdentity.pin,pin);assert.equal(recovered.routeIdentity.machine,grant.machine);await recovered.close();
 }
});
