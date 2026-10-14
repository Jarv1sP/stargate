import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bridgeClient} from '../execution.mjs';

test('backlog five accepts all eight reads after connect-only EAGAIN retries, without duplicate requests',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'bridge-backlog-')),path=join(directory,'bridge.sock');
  const server=spawn('python3',['-B','-c',`import socket,sys,json
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.bind(sys.argv[1]);s.listen(5);print('READY',flush=True);sys.stdin.readline()
for ordinal in range(8):
 c,_=s.accept();raw=b''
 while part:=c.recv(65536):raw+=part
 value=json.loads(raw);c.sendall(json.dumps({'ok':True,'result':{'machine':value['machine'],'operation':value['operation'],'ordinal':ordinal}}).encode());c.close()
`,path],{stdio:['pipe','pipe','pipe']});
  const original=net.createConnection,errors=[];
  t.mock.method(Math,'random',()=>0.99);
  t.mock.method(net,'createConnection',function(...args){const socket=original.apply(this,args);socket.on('error',error=>errors.push({code:error.code,bytes:socket.bytesWritten}));return socket;});
  try{
    await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
    const bridge=bridgeClient(path),requests=Array.from({length:8},(_,i)=>({machine:'fixture-'+i,operation:i<4?'datasets.list':'datasets.capacity'}));
    const pending=Promise.all(requests.map(value=>bridge(value.machine,value.operation,{})));
    await new Promise(resolve=>setTimeout(resolve,50));server.stdin.end('accept\n');
    const replies=await pending;
    assert.equal(replies.length,8);assert.equal(new Set(replies.map(value=>value.ordinal)).size,8);
    replies.forEach((value,i)=>{assert.equal(value.machine,requests[i].machine);assert.equal(value.operation,requests[i].operation);});
    assert.ok(errors.length>=2);assert.ok(errors.every(error=>error.code==='EAGAIN'&&error.bytes===0));
  }finally{
    if(server.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve));}
    await rm(directory,{recursive:true,force:true});
  }
});

function failingSocket(t,code,{connected=false}={}){
  let attempts=0,writes=0;
  t.mock.method(net,'createConnection',()=>{
    attempts++;const socket=new EventEmitter();socket.bytesWritten=0;
    socket.setTimeout=()=>socket;
    socket.end=value=>{writes++;socket.bytesWritten=Buffer.byteLength(value);return socket;};
    socket.destroy=error=>{process.nextTick(()=>{if(error)socket.emit('error',error);socket.emit('close');});return socket;};
    process.nextTick(()=>{if(connected)socket.emit('connect');socket.emit('error',Object.assign(Error('fixture transport'),{code}));socket.emit('close');});
    return socket;
  });
  return {get attempts(){return attempts;},get writes(){return writes;}};
}

test('persistent EAGAIN stops after eight retries and retains errno without sending bytes',async t=>{
  t.mock.method(Math,'random',()=>0);
  const fixture=failingSocket(t,'EAGAIN');
  await assert.rejects(bridgeClient('/fixture')('fixture','datasets.capacity',{}),error=>error.code==='EXECUTOR_UNAVAILABLE'&&error.errno==='EAGAIN'&&/EAGAIN/.test(error.message));
  assert.equal(fixture.attempts,9);assert.equal(fixture.writes,0);
});

test('ECONNREFUSED is never retried',async t=>{
  const fixture=failingSocket(t,'ECONNREFUSED');
  await assert.rejects(bridgeClient('/fixture')('fixture','datasets.capacity',{}),error=>error.code==='EXECUTOR_UNAVAILABLE'&&error.errno==='ECONNREFUSED');
  assert.equal(fixture.attempts,1);assert.equal(fixture.writes,0);
});

test('EAGAIN after connecting and sending a mutation cannot replay it',async t=>{
  const fixture=failingSocket(t,'EAGAIN',{connected:true});
  await assert.rejects(bridgeClient('/fixture')('fixture','jobs.submit',{key:'original-key'}),error=>error.code==='EXECUTOR_UNAVAILABLE');
  assert.equal(fixture.attempts,1);assert.equal(fixture.writes,1);
});

test('EOF after a successful reconnect neither replays nor reports the retired connection errno',async t=>{
  let attempts=0,writes=0;
  t.mock.method(net,'createConnection',()=>{
    const number=++attempts,socket=new EventEmitter();socket.bytesWritten=0;
    socket.setTimeout=()=>socket;socket.destroy=()=>socket;
    socket.end=value=>{writes++;socket.bytesWritten=Buffer.byteLength(value);return socket;};
    process.nextTick(()=>{
      if(number===1)socket.emit('error',Object.assign(Error('fixture'),{code:'EAGAIN'}));
      else{socket.emit('connect');socket.emit('end');}
      socket.emit('close');
    });return socket;
  });
  await assert.rejects(bridgeClient('/fixture')('fixture','jobs.submit',{}),error=>error.code==='EXECUTOR_UNAVAILABLE'&&error.errno===undefined);
  assert.equal(attempts,2);assert.equal(writes,1);
});

test('connect retries remain inside the original elapsed deadline',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const fixture=failingSocket(t,'EAGAIN');
  const pending=assert.rejects(bridgeClient('/fixture')('fixture','datasets.capacity',{}),error=>error.code==='EXECUTOR_TIMEOUT'&&error.status===504);
  await new Promise(setImmediate);
  t.mock.timers.tick(32000);
  await pending;
  assert.equal(fixture.attempts,1);assert.equal(fixture.writes,0);
});
