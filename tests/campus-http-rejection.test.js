import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createCampusNativeAgent} from '../client-campus-native.mjs';

const pin='c'.repeat(64),grant={chunkBytes:1048576,
  ticket:'opaque-header-secret.opaque-nonce-secret',grantId:'01234567-1234-4234-8234-012345678901'};
function fixture(reply){
  let calls=0,cleaned=0;
  const spawnProcess=()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});return true;};
    child.stdin=new Writable({write(_bytes,_encoding,done){
      calls++;
      const value=Buffer.from(JSON.stringify({ok:false,bodyBytes:0,code:'HTTP_REJECTED',status:409,writeMayHaveReachedPeer:true,...reply}));
      const size=Buffer.alloc(4);size.writeUInt32BE(value.length);child.stdout.write(Buffer.concat([size,value]));done();
    }});return child;
  };
  return {spawnProcess,extract:async()=>({path:'/fixture/helper',cleanup:async()=>{cleaned++;}}),calls:()=>calls,cleaned:()=>cleaned};
}

test('HTTP rejection retains the first safe error across repeated requests without replay',async()=>{
  const f=fixture({reasonCode:'upload-rejected',error:'Upload state changed; check portal status and resume',ticket:grant.ticket,grant,headers:{Authorization:`Bearer ${grant.ticket}`}}),agent=createCampusNativeAgent(pin,f);
  try{
    await assert.rejects(agent.request({op:'put',grant,offset:0,final:true},Buffer.from('raw')),error=>{
      assert.equal(error.code,'HTTP_REJECTED');assert.equal(error.status,409);assert.equal(error.writeMayHaveReachedPeer,true);
      assert.match(error.message,/HTTP 409; reasonCode=upload-rejected; error=Upload state changed/);
      assert.equal(error.reasonCode,'upload-rejected');assert.equal(error.nodeError,'Upload state changed; check portal status and resume');
      assert.deepEqual(Object.keys(error).sort(),['code','nodeError','reasonCode','status','writeMayHaveReachedPeer'].sort());
      for(const secret of [grant.ticket,grant.grantId,'Authorization'])assert.equal(error.message.includes(secret),false);
      return true;
    });
    await assert.rejects(agent.request({op:'put',grant,offset:0,final:true},Buffer.from('raw')),error=>{
      assert.equal(error.code,'HTTP_REJECTED');assert.equal(error.status,409);assert.match(error.message,/HTTP 409; reasonCode=upload-rejected/);return true;
    });
    assert.equal(f.calls(),1);
  }finally{await agent.destroy();}assert.equal(f.cleaned(),1);
});

test('native rejection fields cannot echo capabilities, control characters or serialized grants',async()=>{
  for(const errorText of [grant.ticket,'OPAQUE-NONCE-SECRET',grant.grantId,'Bearer new-secret','grant {hidden}','line\nsecret','text\u202esecret','a'.repeat(513),{ticket:grant.ticket}]){
    const f=fixture({reasonCode:'SAFE',error:errorText}),agent=createCampusNativeAgent(pin,f);
    try{await assert.rejects(agent.request({op:'get',grant,offset:0}),error=>{
      assert.match(error.message,/HTTP 409; reasonCode=SAFE/);assert.equal(error.nodeError,undefined);assert.equal(error.message.includes('error='),false);return true;
    });}finally{await agent.destroy();}
  }
});

test('invalid reason code and status are omitted, other failures cannot introduce node messages',async()=>{
  for(const reply of [{reasonCode:'bad reason',status:'409',error:{ticket:'hidden'}},{code:'ACK_UNCONFIRMED',reasonCode:'SAFE',error:'unrelated-node-message'}]){
    const f=fixture(reply),agent=createCampusNativeAgent(pin,f);
    try{await assert.rejects(agent.request({op:'get',grant,offset:0}),error=>{
      assert.equal(error.reasonCode,undefined);assert.equal(error.nodeError,undefined);assert.equal(error.message.includes('; HTTP '),false);return true;
    });}finally{await agent.destroy();}
  }
});
