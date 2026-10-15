import http from 'node:http';
import {spawn} from 'node:child_process';
import {chmod,unlink,mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {isClientDownload,watchClientDownload,CLIENT_DOWNLOAD_IDLE_MS} from './client-bundle.mjs';

// Keep one owner of Portal's in-memory state/SQLite database. A prewarmed
// candidate forwards to the old owner, then holds new requests during handoff.
// A request already forwarded is never retried or replayed by this supervisor.
export function createRolloutServer({upstream,startActive,queueTimeout=90000,maxPending=64,staticIdleTimeout=CLIENT_DOWNLOAD_IDLE_MS}){
  let phase='proxy',target=new URL(upstream),forwarding=0,businessForwarding=0,staticIdleTimeouts=0,activation;
  const pending=new Set(),downloads=new Map(),inFlight=new Map();
  const state=()=>({phase,forwarding,businessForwarding,staticForwarding:downloads.size,staticIdleTimeouts,
    inFlightByType:[...inFlight.values()].reduce((counts,{type})=>{counts[type]=(counts[type]||0)+1;return counts;},{}),
    staticDownloads:[...downloads.values()].map(({path,watch})=>({path,...watch.state()})),pending:pending.size});
  const forward=(req,res)=>{
    if(req.destroyed||res.destroyed)return;
    const staticDownload=isClientDownload(req);let ended=false,watch;
    forwarding++;if(!staticDownload)businessForwarding++;
    const finish=()=>{
      if(ended)return;ended=true;forwarding--;
      inFlight.delete(next);
      if(staticDownload){watch.close();downloads.delete(next);}else businessForwarding--;
    };
    const next=http.request({hostname:target.hostname,port:target.port||80,method:req.method,path:req.url,headers:req.headers,agent:false},reply=>{
      reply.once('end',finish);reply.once('close',finish);
      reply.on('error',()=>res.destroy());
      if(reply.headers['content-type']?.startsWith('text/event-stream'))record.type='poll';
      if(res.destroyed)reply.resume();
      else{
        // Consume the original reply after the client leaves, including a
        // writer that already sent headers. Never replay it or finish early.
        const consume=()=>{reply.unpipe(res);reply.resume();};
        res.once('close',consume);reply.once('close',()=>res.removeListener('close',consume));
        res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);
      }
    });
    const record={type:staticDownload?'static':['GET','HEAD'].includes(req.method)?'read':'write'};
    inFlight.set(next,record);
    if(req.url.split('?')[0]==='/api/call'){
      // Observe only a bounded prefix for handoff counts. Bytes still stream
      // unchanged to Portal; this does not parse, authorize or replay a call.
      let prefix='';
      const classify=chunk=>{
        prefix+=chunk.toString('utf8').slice(0,4096-prefix.length);
        const operation=prefix.match(/"operation"\s*:\s*"([\w.-]+)"/)?.[1];
        if(operation){
          if(operation==='terminal.exchange')record.type='terminal';
          else if(operation==='jobs.logs')record.type='logs';
          else if(operation==='jobs.watch')record.type='poll';
          else if(operation==='state'||/\.(?:get|list|status|quota|catalog|completion|diagnostics)$/.test(operation))record.type='read';
        }
        if(operation||prefix.length>=4096){prefix='';req.removeListener('data',classify);}
      };
      req.on('data',classify);
    }
    if(staticDownload){
      watch=watchClientDownload(res,{idleTimeout:staticIdleTimeout,onIdle:()=>{staticIdleTimeouts++;next.destroy();}});
      downloads.set(next,{path:req.url.split('?')[0],watch});
    }
    // A submitted request may outlive its client. Keep observing that exact
    // upstream request until it finishes; draining must not cut its writer.
    res.once('close',()=>{if(!req.complete)next.destroy();});
    next.once('error',()=>{
      finish();
      if(res.destroyed)return;
      if(res.headersSent)return res.destroy();
      res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({error:'服务连接中断；原操作未自动重试，请查询原编号。'}));
    });
    req.once('aborted',()=>next.destroy());req.pipe(next);
  };
  const server=http.createServer((req,res)=>{
    if(req.url==='/healthz'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({ok:true,...state()}));
    }
    if(phase!=='hold'&&phase!=='activating')return forward(req,res);
    if(pending.size>=maxPending){res.writeHead(503,{'Retry-After':'1','Cache-Control':'no-store'});return res.end();}
    const entry={req,res};pending.add(entry);
    const remove=()=>{pending.delete(entry);clearTimeout(entry.timer);};
    entry.timer=setTimeout(()=>{remove();if(!res.destroyed){res.writeHead(503,{'Retry-After':'1','Cache-Control':'no-store'});res.end();}},queueTimeout);
    res.once('close',remove);
  });
  server.headersTimeout=10000;server.requestTimeout=120000;server.keepAliveTimeout=5000;server.maxConnections=128;
  return {server,state,
    hold(){if(phase!=='proxy')throw Error('Handoff is not in proxy phase');phase='hold';},
    resume(){
      if(phase!=='hold')throw Error('Handoff is not holding');
      phase='proxy';
      for(const entry of [...pending]){clearTimeout(entry.timer);pending.delete(entry);forward(entry.req,entry.res);}
    },
    activate(){
      if(phase==='active')return Promise.resolve();
      if(activation)return activation;
      if(phase!=='hold'||businessForwarding!==0)return Promise.reject(Error('Old business requests have not drained'));
      phase='activating';
      activation=Promise.resolve().then(startActive).then(url=>{
        target=new URL(url);phase='active';
        for(const entry of [...pending]){clearTimeout(entry.timer);pending.delete(entry);forward(entry.req,entry.res);}
      },error=>{phase='hold';activation=null;throw error;});
      return activation;
    },
    close(){for(const entry of pending){clearTimeout(entry.timer);entry.res.destroy();}pending.clear();return new Promise(resolve=>server.close(resolve));}
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.umask(0o077);
  // Import/validate candidate code without opening the shared production DB.
  await import('./portal-server.mjs');
  const upstream=process.argv[2],generation=process.argv[3];
  if(!upstream||! /^[a-f0-9]{7,40}$/.test(generation||''))throw Error('Old Portal upstream and release generation are required');
  const markerDir='/data/portal-rollout',marker=markerDir+'/active',childPort=8081,controlPath='/tmp/portal-rollout-control.sock';let child,stopping=false;
  const rollout=createRolloutServer({upstream,startActive:async()=>{
    await mkdir(markerDir,{recursive:true,mode:0o700});
    const tmp=marker+'.'+process.pid;await writeFile(tmp,generation,{mode:0o600,flag:'wx'});await rename(tmp,marker);
    child=spawn(process.execPath,['portal-server.mjs'],{stdio:'inherit',env:{...process.env,PORT:String(childPort),LISTEN_HOST:'127.0.0.1'}});
    let exited=false;child.once('exit',code=>{exited=true;if(rollout.state().phase==='active'&&!stopping)process.exit(code||1);});
    for(let i=0;i<150;i++){
      if(exited)throw Error('Candidate Portal exited before readiness');
      const ok=await new Promise(resolve=>{
        const req=http.get({hostname:'127.0.0.1',port:childPort,path:'/healthz',headers:{Host:new URL(process.env.PUBLIC_ORIGIN).host}},res=>{res.resume();resolve(res.statusCode===200);});
        req.setTimeout(500,()=>req.destroy());req.on('error',()=>resolve(false));
      });
      if(ok)return 'http://127.0.0.1:'+childPort;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Candidate Portal readiness timeout');
  }});
  const control=http.createServer(async(req,res)=>{
    try{
      if(req.method==='POST'&&req.url==='/hold')rollout.hold();
      else if(req.method==='POST'&&req.url==='/resume')rollout.resume();
      else if(req.method==='POST'&&req.url==='/activate')await rollout.activate();
      else if(req.method!=='GET'||req.url!=='/state'){res.writeHead(404);return res.end();}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rollout.state()));
    }catch(error){res.writeHead(409);res.end(JSON.stringify({error:error.message}));}
  });
  await unlink(controlPath).catch(error=>{if(error.code!=='ENOENT')throw error;});
  await new Promise(resolve=>control.listen(controlPath,resolve));await chmod(controlPath,0o600);
  let previous;try{previous=await readFile(marker,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous===generation){rollout.hold();await rollout.activate();}
  rollout.server.listen(Number(process.env.PORT||8080),process.env.LISTEN_HOST||'0.0.0.0');
  const stop=()=>{
    if(stopping)return;stopping=true;
    if(child){child.once('exit',()=>{control.close();rollout.close().then(()=>process.exit(0));});child.kill('SIGTERM');}
    else{control.close();rollout.close().then(()=>process.exit(0));}
  };
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
}
