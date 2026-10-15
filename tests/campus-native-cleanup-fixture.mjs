import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createCampusNativeAgent} from '../client-campus-native.mjs';
import {createWindowsControlFetch} from '../client-windows-control.mjs';

export function nativeFixture({reject=false,cleanup=async()=>{},close=true}={}){
  let requests=0,cleanups=0,kills=0;const events=[];
  return {events,counts:()=>({requests,cleanups,kills}),extract:async()=>({path:'/fixture/owned-helper',cleanup:async()=>{events.push('cleanup');cleanups++;await cleanup();}}),spawnProcess:()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{kills++;if(close)queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});return true;};
    child.stdin=new Writable({final(done){events.push('eof');done();if(close)setTimeout(()=>{events.push('close');child.emit('exit',0);child.emit('close',0);},5);},write(_bytes,_encoding,done){
      requests++;
      const raw=reject?Buffer.alloc(0):Buffer.from(JSON.stringify({ok:true,result:{operationId:'original-operation',state:'READY'}}));
      const header=Buffer.from(JSON.stringify({ok:!reject,bodyBytes:raw.length,status:reject?409:200,
        ...(reject?{code:'HTTP_REJECTED',reasonCode:'PINNED',error:'Version is pinned',writeMayHaveReachedPeer:true}:{})}));
      const size=Buffer.alloc(4);size.writeUInt32BE(header.length);child.stdout.write(Buffer.concat([size,header,raw]));done();
    }});return child;
  }};
}

if(process.argv[2]==='success'||process.argv[2]==='rejected'){
  const f=nativeFixture({reject:process.argv[2]==='rejected',cleanup:async()=>{throw Object.assign(Error('private cleanup path'),{code:'EIO'});}});
  const transport=createWindowsControlFetch('https://control.invalid',{agentFactory:()=>createCampusNativeAgent(undefined,{...f,control:true})});
  const run=async()=>{try{
    const response=await transport.fetchImpl('https://control.invalid/api/call',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:'{}'});
    process.stdout.write(JSON.stringify(await response.json())+'\n');
  }finally{await transport.close();}};
  try{await run();}catch(error){process.stderr.write(`original business error: ${error.code}; HTTP ${error.status}\n`);process.exitCode=23;}
}
