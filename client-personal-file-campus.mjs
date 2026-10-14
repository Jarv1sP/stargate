import {approvedCampusEndpoints,chooseCampusEndpoint,sameCampusEndpoints,campusConnectionFailure} from './client-campus-endpoints.mjs';
import {request as httpsRequest} from 'node:https';
import {pinnedUploadAgent,probeDirectUploadRoute} from './client-direct-upload.mjs';
import {campusNativeTransportOptions} from './client-campus-native.mjs';
import {validCampusTicketTime} from './dist/campus-ticket-time.js';

const PROTOCOL='personal-file-campus-v1',CHUNK=1024**2,MAX_CHUNK=16*CHUNK;
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=message=>{throw Object.assign(Error(message),{code:'CAMPUS_FILE_IDENTITY_CHANGED'});};
const fixedEndpoints=(before,after)=>{try{sameCampusEndpoints(before,after);}catch{fail('Campus file endpoints changed; original operation paused');}};
const transient=error=>error?.name!=='AbortError'&&!['ABORT_ERR','OPERATION_CANCELLED'].includes(error?.code)
  &&(error?.status===undefined||[429,502,503,504].includes(error.status)||error.status===400&&
    /\[Errno 11\]|Resource temporarily unavailable|\bbusy\b|active reader or lifecycle operation|锁.*(?:忙|占用)/i.test(error.message??''));
const RENEW_DELAYS=[1000,2000,4000,8000,16000,16000,16000,16000,16000,16000];
// This only reauthorizes one fixed scope. It never writes or retries a file
// frame, and does not extend the old grant's validity while Portal is down.
export async function requestPersonalFileTicket(call,request,{now=()=>Date.now()/1000,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),expiresAt=Infinity}={}){
  const deadline=Math.min(now()+120,expiresAt),wallDeadline=performance.now()+Math.max(0,deadline-now())*1000;
  let last;
  for(let attempt=0;attempt<=RENEW_DELAYS.length;attempt++){
    const remaining=Math.min((deadline-now())*1000,wallDeadline-performance.now());
    if(remaining<=0)break;
    try{return await call('files.direct-ticket',request,AbortSignal.timeout(Math.max(1,Math.ceil(remaining))));}
    catch(error){
      last=error;if(!transient(error))throw error;
      const delay=RENEW_DELAYS[attempt];
      if(delay===undefined||delay>=Math.min((deadline-now())*1000,wallDeadline-performance.now()))break;
      await sleep(delay);
    }
  }
  throw last??Object.assign(Error('Campus file renewal window ended; keep the original operation identity'),{code:'CAMPUS_RENEWAL_EXHAUSTED'});
}
export function personalFileGrant(value,path,action,now=Date.now()/1000){
  if(!value
    ||!UUID.test(value.grantId||'')||!HASH.test(value.certificateSha256||'')
    ||![CHUNK,MAX_CHUNK].includes(value.chunkBytes)||value.chunkBytes===MAX_CHUNK&&value.maxChunkBytes!==MAX_CHUNK
    ||value.maxChunkBytes!==undefined&&![CHUNK,MAX_CHUNK].includes(value.maxChunkBytes)
    ||!validCampusTicketTime(value,now)
    ||typeof value.ticket!=='string'||! /^[A-Za-z0-9_.-]{20,4096}$/.test(value.ticket))fail('直连连接信息不完整，请稍后重新请求；原传输已保留。');
  let endpoint;try{endpoint=new URL(value.endpoint);}catch{fail('Invalid campus file endpoint');}
  if(endpoint.protocol!=='https:'||endpoint.origin!==value.endpoint||endpoint.pathname!=='/'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)fail('Campus files require one fixed HTTPS origin');
  if(action==='get'&&(!value.file
    ||!Number.isSafeInteger(value.file.size)||value.file.size<0))fail('没有读到文件大小，请稍后重试原下载。');
  return value;
}

export function personalFileRequest(grant,agent,action,args,{request=httpsRequest,timeoutMs=30000}={}){
  if(![CHUNK,MAX_CHUNK].includes(grant?.chunkBytes)||grant.chunkBytes===MAX_CHUNK&&grant.maxChunkBytes!==MAX_CHUNK)fail('Invalid authenticated campus chunk bound');
  if(!['get','put'].includes(action)||!Number.isSafeInteger(args.offset)||args.offset<0)fail('Invalid campus file request');
  const writing=action==='put',target=new URL(`/v1/files/${grant.grantId}/${action}`,grant.endpoint);
  target.searchParams.set('offset',String(args.offset));
  if(writing){
    if(typeof args.final!=='boolean'||!Buffer.isBuffer(args.bytes)||args.bytes.length>grant.chunkBytes)fail('Invalid campus file chunk');
    target.searchParams.set('final',String(args.final));
  }
  return new Promise((resolve,reject)=>{
    let req,timer,done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);if(error){req?.destroy();reject(error);}else resolve(result);};
    try{
      req=request(target,{agent,method:writing?'POST':'GET',headers:{Authorization:`Bearer ${grant.ticket}`,
        Accept:writing?'application/json':'application/octet-stream',...(writing?{'Content-Type':'application/octet-stream','Content-Length':args.bytes.length}:{})}},res=>{
        const parts=[];let size=0;
        res.on('data',bytes=>{size+=bytes.length;if(size>(writing?65536:grant.chunkBytes)){res.destroy();finish(Error('Campus file response exceeds the bound'));}else parts.push(bytes);});
        res.on('aborted',()=>finish(Object.assign(Error('Campus file response interrupted; keep the original operation identity'),{code:'RESPONSE_INTERRUPTED'})));
        res.on('error',()=>finish(Object.assign(Error('Campus file response failed; partial and original identity were preserved'),{code:'RESPONSE_INTERRUPTED'})));
        res.on('end',()=>{
          if(res.statusCode!==200){
            let reasonCode;try{const value=JSON.parse(Buffer.concat(parts).toString()),code=value.reasonCode??value.code;if(typeof code==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(code))reasonCode=code;}catch{}
            return finish(Object.assign(Error(`Campus file request rejected (HTTP ${res.statusCode}); no VPS or Tail fallback`),{status:res.statusCode,...(reasonCode?{reasonCode}:{})}));
          }
          try{
            const bytes=Buffer.concat(parts);
            if(writing){
              if(!/^application\/json(?:;|$)/i.test(res.headers['content-type']||''))throw Error();
              const result=JSON.parse(bytes.toString());if(result.ok!==true||!result.result)throw Error();return finish(null,result.result);
            }
            if(res.headers['content-type']!=='application/octet-stream'||typeof res.headers['x-gpuq-file-metadata']!=='string'
              ||res.headers['x-gpuq-file-metadata'].length>4096||bytes.length>grant.chunkBytes)throw Error();
            const metadata=JSON.parse(Buffer.from(res.headers['x-gpuq-file-metadata'],'base64url').toString());
            if(metadata.size!==grant.file.size||metadata.offset!==args.offset)throw Error();
            finish(null,{...metadata,data:bytes.toString('base64')});
          }catch{finish(Object.assign(Error('直连暂未返回完整数据；原断点已保留，请续传原下载。'),{code:'CAMPUS_FILE_RECEIPT_INVALID'}));}
        });
      });
      req.on('error',()=>finish(Object.assign(Error('Campus file connection failed; no file bytes were redirected through VPS or Tail'),{code:'CONNECTION_FAILED'})));
      timer=setTimeout(()=>finish(Object.assign(Error('Campus file request timed out; keep the original operation identity'),{code:'TIMEOUT'})),timeoutMs);timer.unref?.();
      req.end(writing?args.bytes:undefined);
    }catch{finish(Error('Campus file request could not start; no fallback'));
    }
  });
}

export async function createPersonalFileTransport(call,{machine,context,path,action,identity={},agentFactory,send,platform=process.platform,nativeOptions={},probeEndpoint,now=()=>Date.now()/1000,monotonic=()=>performance.now(),renewalSleep,fixedRoute,preferredEndpoint,authorizationDeadline=Infinity}={}){
  const defaults=['linux','win32'].includes(platform)?campusNativeTransportOptions(nativeOptions):{agentFactory:pinnedUploadAgent,send:personalFileRequest};
  // Supplying a custom Agent keeps its existing request contract; callers can
  // still inject either or both hooks for isolated tests or an explicit client.
  send??=agentFactory?personalFileRequest:defaults.send;
  agentFactory??=defaults.agentFactory;
  let request={machine,...context,path,action,...identity};
  let ticketStarted;
  const ticket=(expiresAt=Infinity)=>requestPersonalFileTicket((...args)=>{ticketStarted=monotonic();return call(...args);},request,{now,sleep:renewalSleep,expiresAt:Math.min(expiresAt,authorizationDeadline)});
  let grant=personalFileGrant((await ticket()).result,path,action,now()),closed=false;
  const validity=value=>value.ttl??Math.min(300,value.expiresAt-now());
  let grantDeadline=ticketStarted+Math.max(0,validity(grant))*1000;
  const remainingGrant=()=>Math.max(0,Math.min((grantDeadline-monotonic())/1000,
    grant.ttl===undefined?grant.expiresAt-now():Infinity));
  // A single-chunk file needs no second ticket just to negotiate 16 MiB.
  if(grant.maxChunkBytes===MAX_CHUNK&&grant.chunkBytes!==MAX_CHUNK&&(action==='put'?identity.totalSize:grant.file?.size)>CHUNK){
    const previous=grant;request={...request,maxChunkBytes:MAX_CHUNK};
    grant=personalFileGrant((await ticket(now()+remainingGrant())).result,path,action,now());
    grantDeadline=ticketStarted+Math.max(0,validity(grant))*1000;
    if(grant.chunkBytes!==MAX_CHUNK||grant.endpoint!==previous.endpoint||grant.certificateSha256!==previous.certificateSha256
      )
      fail('直连地址或TLS证书改变，尚未发送文件；请重试原传输。');
    fixedEndpoints(approvedCampusEndpoints(previous),approvedCampusEndpoints(grant));
  }
  const fixed={size:grant.file?.size,endpoint:grant.endpoint,pin:grant.certificateSha256,machine:grant.machine};
  let endpoints=approvedCampusEndpoints(grant);
  const assertFixed=value=>{
    if(!value)return;
    if(value.endpoint!==fixed.endpoint||value.pin!==fixed.pin
      ||action==='get'&&(value.size!==fixed.size))fail('直连地址、TLS证书或文件大小改变；原传输已暂停，请按原编号查询。');
    fixedEndpoints(value.endpoints,endpoints);
  };
  assertFixed(fixedRoute);
  const probe=probeEndpoint??((value,endpoint,{signal}={})=>probeDirectUploadRoute({...value,dialEndpoint:endpoint.endpoint,probeTimeoutMs:4000},{signal}));
  const preferred=endpoints.find(row=>row.endpoint===preferredEndpoint);
  let selected=grant.routes?await chooseCampusEndpoint(grant,preferred?[preferred,...endpoints.filter(row=>row!==preferred)]:endpoints,{probe,parallel:!preferred&&!probeEndpoint&&['linux','win32'].includes(platform)}):endpoints[0];
  const makeAgent=()=>agentFactory(grant.certificateSha256,{dialEndpoint:selected.endpoint,serverName:new URL(grant.endpoint).hostname});
  let agent=makeAgent();
  const refresh=async()=>{
    const next=personalFileGrant((await ticket(now()+remainingGrant())).result,path,action,now());
    if(next.endpoint!==fixed.endpoint||next.certificateSha256!==fixed.pin
      ||action==='get'&&(next.file.size!==fixed.size))fail('直连地址、TLS证书或文件大小改变；原传输已暂停，请按原编号查询。');
    fixedEndpoints(endpoints,approvedCampusEndpoints(next));endpoints=approvedCampusEndpoints(next);grant=next;grantDeadline=ticketStarted+Math.max(0,validity(grant))*1000;
    if(!endpoints.some(row=>row.endpoint===selected.endpoint)){await agent.destroy();selected=await chooseCampusEndpoint(grant,endpoints,{probe});agent=makeAgent();}
    return next.file;
  };
  return {
    get chunkBytes(){return grant.chunkBytes;},
    async prepare(){if(remainingGrant()<=120)await refresh();return grant.chunkBytes;},
    get routeIdentity(){return {...fixed,endpoints};},
    get selectedEndpoint(){return selected.endpoint;},
    get file(){return grant.file;},
    async observe(){if(closed)fail('Campus file transport is closed');return refresh();},
    async request(args){
      if(closed)fail('Campus file transport is closed');
      if(remainingGrant()<=120){
        await refresh();
      }
      const dispatch=()=>send(grant,agent,action,{...args,...(selected.endpoint!==grant.endpoint?{dialEndpoint:selected.endpoint}:{})});
      try{return await dispatch();}
      catch(error){
        if(endpoints.length<2||!campusConnectionFailure(error))throw error;
        await agent.destroy();selected=await chooseCampusEndpoint(grant,endpoints,{probe,exclude:selected.endpoint});agent=makeAgent();
        if(action==='get')return dispatch();
        // Existing callers inspect the original upload and its byte offset before
        // repeating an uncertain write, now using the other pinned endpoint.
        throw error;
      }
    },
    async close(){closed=true;await agent.destroy();}
  };
}

