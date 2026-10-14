import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPost} from '../client-http.mjs';
const CLI_IDENTITY={name:'gpuctl',protocol:2};
import {createWindowsControlFetch,finishPlatformControlTransport} from '../client-windows-control.mjs';

// The current Go helper forwards the one approved CLI marker.
// Exercise the HTTP serializer through the Windows adapter, including writes,
// so a metadata change cannot be hidden by an unrestricted fetch mock.
for(const operation of ['state','community.posts.list','files.direct-ticket','data.upload.status','jobs.submit']){
  test(`${operation}: forwards the current control request without strict field rejection`,async()=>{
    const args=operation==='state'?{view:'summary'}:{key:'11111111-1111-4111-8111-111111111111'};
    const body={operation,args},calls=[];
    const transport=createWindowsControlFetch('https://portal.example',{agentFactory:()=>({
      request:async(header,bytes)=>{
        assert.equal(header.op,'control');assert.equal(header.control.path,'/api/call');
        const sent=JSON.parse(bytes);calls.push(sent);
        assert.deepEqual(Object.keys(sent).sort(),['args','client','operation']);
        assert.deepEqual(sent,{...body,client:CLI_IDENTITY});
        return {value:{status:200},raw:Buffer.from('{"ok":true}')};
      },destroy:async()=>{}
    })});
    try{
      assert.deepEqual(await apiPost('https://portal.example','call',body,{
        client:CLI_IDENTITY,fetchImpl:transport.fetchImpl,
        sleep:()=>assert.fail('a local protocol mismatch must not be masked by read retries')
      }),{ok:true});
      assert.equal(calls.length,1);
      assert.deepEqual(body,{operation,args});
    }finally{await finishPlatformControlTransport(transport);}
  });
}
