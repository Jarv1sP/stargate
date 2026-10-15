import test from 'node:test';
import assert from 'node:assert/strict';
import {personalFileGrant,createPersonalFileTransport} from '../client-personal-file-campus.mjs';

const grant=()=>({endpoint:'https://campus.example',certificateSha256:'a'.repeat(64),
  grantId:'12345678-1234-4234-8234-123456789012',chunkBytes:1048576,ticket:'isolated-capability-123456789',
  expiresAt:Date.now()/1000+550.5,file:{size:3}});
test('campus grants provide a TLS endpoint and bounded file transfers',()=>{
  const value=grant();assert.equal(personalFileGrant(value,'fixed','get'),value);
  for(const change of [{certificateSha256:'invalid'},{chunkBytes:2097152},{ticket:'invalid'},
    {endpoint:'http://campus.example'},{grantId:'invalid'},{file:{size:-1}}])
    assert.throws(()=>personalFileGrant({...grant(),...change},'fixed','get'));
});
test('a file request refreshes its scheduled ticket before sending bytes',async()=>{
  for(const area of ['code','output','dataset']){
    let tickets=0,sent=0;
    const transport=await createPersonalFileTransport(async()=>({result:{...grant(),expiresAt:++tickets===1?1.5:Date.now()/1000+550.5}}),{
      machine:'fixture',context:{area},path:'fixed',action:'get',
      agentFactory:()=>({destroy:async()=>{}}),send:async()=>{sent++;return {data:'YWJj'};}
    });
    try{assert.equal((await transport.request({offset:0})).data,'YWJj');assert.equal(tickets,2);assert.equal(sent,1);}
    finally{await transport.close();}
  }
});
