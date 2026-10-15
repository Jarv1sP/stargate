import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {pinnedUploadAgent} from '../client-direct-upload.mjs';

const grant={machine:'fixture-node',endpoint:'https://campus.example:18441',certificateSha256:'a'.repeat(64),revision:'b'.repeat(64),routes:[{id:'primary',kind:'campus-direct',endpoint:'https://campus.example:18441'},{id:'node-lan',kind:'campus-direct',endpoint:'https://192.168.50.7:18441'}]};
test('pin agent distinguishes TCP timeout from TLS timeout and never releases an unpinned socket',async()=>{
  for(const connected of [false,true]){
    let released=0;const socket=new EventEmitter();socket.destroy=()=>{};
    const agent=pinnedUploadAgent(grant.certificateSha256,{timeoutMs:5,connect:()=>{if(connected)queueMicrotask(()=>socket.emit('connect'));return socket;}});
    // Keep the test alive while the production unref'ed deadline fires.
    const keeper=setTimeout(()=>{},100);
    const error=await new Promise(resolve=>agent.createConnection({},(error,value)=>{if(value)released++;resolve(error);}));clearTimeout(keeper);agent.destroy();
    assert.equal(error.uploadProbeCode,connected?'HANDSHAKE_TIMEOUT':'TCP_TIMEOUT');assert.equal(released,0);
  }
});
