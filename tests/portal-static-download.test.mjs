import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {CLIENT_DOWNLOAD_IDLE_MS,isClientDownload,watchClientDownload} from '../client-bundle.mjs';
import {createRolloutServer} from '../portal-rollout.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
const settled=async predicate=>{for(let i=0;i<200&&!predicate();i++)await wait(10);assert.ok(predicate());};

test('only the two public GET/HEAD client artifacts are static; authenticated reads and writes stay business',()=>{
  assert.equal(CLIENT_DOWNLOAD_IDLE_MS,120000);
  for(const method of ['GET','HEAD'])for(const url of ['/gpuctl.mjs','/amaxctl.mjs','/gpuctl.mjs?download=1'])assert.equal(isClientDownload({method,url}),true);
  for(const [method,url] of [['POST','/gpuctl.mjs'],['GET','/api/call'],['GET','/v1/files/example/get'],['GET','/machines.js'],['GET','/runtime.js'],['GET','/nested/gpuctl.mjs']])assert.equal(isClientDownload({method,url}),false);
});

test('static response idle watchdog closes no-progress responses and does not survive a completed response',async()=>{
  let timedOut=0,watch,closed;
  const stopped=new Promise(resolve=>closed=resolve);
  const server=http.createServer((req,res)=>{
    if(req.url==='/stalled'){
      watch=watchClientDownload(res,{idleTimeout:150,onIdle:()=>timedOut++});
      res.on('close',closed);res.write('initial bytes');
    }else if(req.url==='/complete'){
      watchClientDownload(res,{idleTimeout:150,onIdle:()=>timedOut++});res.end('complete');
    }else{res.write('business');setTimeout(()=>res.end(' done'),350);}
  }),url=await listen(server),agent=new http.Agent({keepAlive:true,maxSockets:1});
  const get=path=>new Promise((resolve,reject)=>{const req=http.get(url+path,{agent},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(text));res.on('error',reject);});req.on('error',reject);});
  try{
    const stalled=get('/stalled').then(()=>assert.fail('stalled response completed'),error=>assert.equal(error.code,'ECONNRESET'));
    await stopped;await stalled;
    assert.equal(timedOut,1);assert.equal(watch.state().stalled,true);
    assert.equal(await get('/complete'),'complete');
    assert.equal(await get('/business'),'business done');
    assert.equal(timedOut,1,'a completed static timer must not kill a later business request on the same socket');
  }finally{agent.destroy();await close(server);}
});

test('continually progressing slow static download may exceed the idle timeout many times',async()=>{
  let timedOut=0,interval;
  const server=http.createServer((req,res)=>{
    watchClientDownload(res,{idleTimeout:150,onIdle:()=>timedOut++});let chunks=0;
    res.write('start');interval=setInterval(()=>{res.write('next');if(++chunks===20){clearInterval(interval);res.end('end');}},30);
    res.once('close',()=>clearInterval(interval));
  }),url=await listen(server);
  try{
    const response=await fetch(url),body=await response.text();
    assert.equal(body,'start'+'next'.repeat(20)+'end');assert.equal(timedOut,0);
  }finally{clearInterval(interval);await close(server);}
});

test('a client that stops reading a large static body hits write-idle timeout and releases the source',async()=>{
  let source,transferred,clientResponse,timedOut=0,stopped;
  const closed=new Promise(resolve=>stopped=resolve);
  const server=http.createServer((req,res)=>{
    source=Readable.from((function*(){const chunk=Buffer.alloc(65536);for(let i=0;i<512;i++)yield chunk;})(),{objectMode:false});
    watchClientDownload(res,{idleTimeout:150,onIdle:()=>timedOut++});res.once('close',stopped);
    transferred=pipeline(source,res).then(()=>assert.fail('paused client must not consume 32MiB'),error=>assert.equal(error.code,'ERR_STREAM_PREMATURE_CLOSE'));
  }),url=await listen(server);
  const request=http.get(url,res=>{clientResponse=res;res.pause();});request.on('error',()=>{});
  try{
    await closed;await transferred;assert.equal(timedOut,1);assert.equal(source.destroyed,true);
  }finally{clientResponse?.destroy();request.destroy();await close(server);}
});

test('abandoned large response consumes the original reply and clears its counter without replay',async()=>{
  let calls=0,completed=0;
  const old=http.createServer(async(req,res)=>{
    calls++;req.resume();const chunk=Buffer.alloc(65536,7);res.writeHead(200,{'Content-Length':32*1024*1024});
    for(let i=0;i<512;i++)if(!res.write(chunk))await once(res,'drain');res.end();completed++;
  }),oldURL=await listen(old),rollout=createRolloutServer({upstream:oldURL,startActive:()=>oldURL}),url=await listen(rollout.server);
  try{
    await new Promise((resolve,reject)=>{const req=http.get(url+'/gpuctl.mjs',res=>res.once('data',()=>{res.destroy();resolve();}));req.on('error',reject);});
    rollout.hold();await settled(()=>rollout.state().forwarding===0);
    assert.equal(completed,1);assert.equal(calls,1);assert.equal(rollout.state().staticForwarding,0);await rollout.activate();
  }finally{await close(rollout.server);await close(old);}
});

test('client leaving after writer headers does not permit handoff until the original writer finishes',async()=>{
  let calls=0,finish;
  const work=new Promise(resolve=>finish=resolve);
  const old=http.createServer(async(req,res)=>{for await(const chunk of req){}calls++;res.write('pending');await work;res.end('committed');});
  const oldURL=await listen(old),rollout=createRolloutServer({upstream:oldURL,startActive:()=>oldURL,staticIdleTimeout:50}),url=await listen(rollout.server);
  try{
    await new Promise((resolve,reject)=>{const req=http.request(url+'/gpuctl.mjs',{method:'POST'},res=>res.once('data',()=>{res.destroy();resolve();}));req.on('error',reject);req.end('original-key');});
    await wait(120);rollout.hold();assert.equal(rollout.state().businessForwarding,1);assert.equal(rollout.state().staticForwarding,0);
    await assert.rejects(rollout.activate(),/not drained/);
    finish();await settled(()=>rollout.state().businessForwarding===0);assert.equal(calls,1);await rollout.activate();
  }finally{finish();await close(rollout.server);await close(old);}
});

test('business RPC draining excludes public downloads and reports them separately without query strings',async()=>{
  let downloadEnd,businessEnd,downloadStarted,businessStarted,activated=0;
  const downloading=new Promise(resolve=>downloadStarted=resolve),working=new Promise(resolve=>businessStarted=resolve);
  const old=http.createServer((req,res)=>{
    req.resume();res.write('pending');
    if(req.url.startsWith('/amaxctl.mjs')){downloadEnd=()=>res.end('artifact');downloadStarted();}
    else{businessEnd=()=>res.end('confirmed');businessStarted();}
  }),oldURL=await listen(old),rollout=createRolloutServer({upstream:oldURL,startActive:()=>{activated++;return oldURL;}}),url=await listen(rollout.server);
  try{
    const download=fetch(url+'/amaxctl.mjs?unlogged=value').then(res=>res.text());await downloading;
    const business=fetch(url+'/api/call',{method:'POST',body:'one-key'}).then(res=>res.text());await working;
    const state=rollout.state();assert.equal(state.forwarding,2);assert.equal(state.businessForwarding,1);assert.equal(state.staticForwarding,1);
    assert.equal(state.staticDownloads[0].path,'/amaxctl.mjs');assert.equal(JSON.stringify(state).includes('unlogged'),false);
    rollout.hold();await assert.rejects(rollout.activate(),/not drained/);assert.equal(activated,0);
    businessEnd();await business;await settled(()=>rollout.state().businessForwarding===0);
    await rollout.activate();assert.equal(activated,1);assert.equal(rollout.state().staticForwarding,1);
    downloadEnd();assert.equal(await download,'pendingartifact');await settled(()=>rollout.state().forwarding===0);
  }finally{downloadEnd?.();businessEnd?.();await close(rollout.server);await close(old);}
});

test('supervisor also closes stalled public downloads when its old upstream has no idle guard',async()=>{
  let calls=0;
  const old=http.createServer((req,res)=>{calls++;req.resume();res.write('never finishes');});
  const oldURL=await listen(old),rollout=createRolloutServer({upstream:oldURL,startActive:()=>oldURL,staticIdleTimeout:150}),url=await listen(rollout.server);
  try{
    await assert.rejects(fetch(url+'/gpuctl.mjs').then(res=>res.text()),/terminated/);
    await settled(()=>rollout.state().forwarding===0);
    const state=rollout.state();assert.equal(state.businessForwarding,0);assert.equal(state.staticForwarding,0);assert.equal(state.staticIdleTimeouts,1);assert.equal(calls,1);
    rollout.hold();await rollout.activate();
  }finally{await close(rollout.server);await close(old);}
});
