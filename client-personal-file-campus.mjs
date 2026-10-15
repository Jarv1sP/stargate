import {approvedCampusEndpoints,finishCampusOperation} from './client-campus-endpoints.mjs';
import {request as httpsRequest} from 'node:https';
import {pinnedUploadAgent} from './client-direct-upload.mjs';
import {campusNativeTransportOptions} from './client-campus-native.mjs';
import {CAMPUS_CONNECTION_HELP,DATASET_DIRECT_HELP,campusRetryable,retryCampusRequest} from './dist/personal-upload.js';

const CHUNK=1024**2,MAX_CHUNK=16*CHUNK;
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=message=>{throw Object.assign(Error(message),{code:'CAMPUS_FILE_IDENTITY_CHANGED'});};
const transient=error=>error?.name!=='AbortError'&&!['ABORT_ERR','OPERATION_CANCELLED'].includes(error?.code)
  &&(error?.status===undefined||[429,502,503,504].includes(error.status)||error.status===400&&
    /\[Errno 11\]|Resource temporarily unavailable|\bbusy\b|active reader or lifecycle operation|锁.*(?:忙|占用)/i.test(error.message??''));
const RENEW_DELAYS=[1000,2000,4000,8000,16000,16000,16000,16000,16000,16000];
// Renew the same scope; only the node decides whether a ticket has expired.
export async function requestPersonalFileTicket(call,request,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const deadline=performance.now()+120000;
  let last;
  for(let attempt=0;attempt<=RENEW_DELAYS.length;attempt++){
    const remaining=deadline-performance.now();
    if(remaining<=0)break;
    try{return await call('files.direct-ticket',request,AbortSignal.timeout(Math.max(1,Math.ceil(remaining))));}
    catch(error){
      last=error;if(!transient(error))throw error;
      const delay=RENEW_DELAYS[attempt];
      if(delay===undefined||delay>=deadline-performance.now())break;
      await sleep(delay);
    }
  }
  throw last??Object.assign(Error('Campus file renewal window ended; keep the original operation identity'),{code:'CAMPUS_RENEWAL_EXHAUSTED'});
}
export function personalFileGrant(value,path,action){
  if(!value?.endpoint)throw Object.assign(Error(value?.message||'节点校园入口暂不可用。'),{code:'CAMPUS_UNAVAILABLE'});
  if(!value
    ||!UUID.test(value.grantId||'')||!HASH.test(value.certificateSha256||'')
    ||![CHUNK,MAX_CHUNK].includes(value.chunkBytes)||value.chunkBytes===MAX_CHUNK&&value.maxChunkBytes!==MAX_CHUNK
    ||value.maxChunkBytes!==undefined&&![CHUNK,MAX_CHUNK].includes(value.maxChunkBytes)
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
      req.on('error',error=>finish(Object.assign(Error(error.message,{cause:error}),{code:error.code||'CONNECTION_FAILED'})));
      timer=setTimeout(()=>finish(Object.assign(Error('Campus file request timed out; keep the original operation identity'),{code:'TIMEOUT'})),timeoutMs);timer.unref?.();
      req.end(writing?args.bytes:undefined);
    }catch{finish(Error('Campus file request could not start; no fallback'));
    }
  });
}

export async function createPersonalFileTransport(call,{machine,context,path,action,identity={},initialGrant,agentFactory,send,platform=process.platform,nativeOptions={},retry,now=()=>Date.now()/1000,monotonic=()=>performance.now()}={}){
  const defaults=['linux','win32'].includes(platform)?campusNativeTransportOptions({admissionRetryBudgetMs:60000,...nativeOptions}):{agentFactory:pinnedUploadAgent,send:personalFileRequest};
  // Supplying a custom Agent keeps its existing request contract; callers can
  // still inject either or both hooks for isolated tests or an explicit client.
  send??=agentFactory?personalFileRequest:defaults.send;
  agentFactory??=defaults.agentFactory;
  let request={machine,...context,path,action,...identity};
  let ticketStarted=monotonic();
  const ticket=()=>requestPersonalFileTicket((...args)=>{ticketStarted=monotonic();return call(...args);},request);
  let grant=personalFileGrant(initialGrant??(await ticket()).result,path,action),closed=false;
  const validity=value=>value.ttl??Math.min(300,value.expiresAt-now());
  let grantDeadline=ticketStarted+Math.max(0,validity(grant))*1000;
  const remainingGrant=()=>Math.max(0,Math.min((grantDeadline-monotonic())/1000,
    grant.ttl===undefined?grant.expiresAt-now():Infinity));
  // A single-chunk file needs no second ticket just to negotiate 16 MiB.
  if(grant.maxChunkBytes===MAX_CHUNK&&grant.chunkBytes!==MAX_CHUNK&&(action==='put'?identity.totalSize:grant.file?.size)>CHUNK){
    request={...request,maxChunkBytes:MAX_CHUNK};
    grant=personalFileGrant((await ticket()).result,path,action);
    grantDeadline=ticketStarted+Math.max(0,validity(grant))*1000;
  }
  const fixedSize=grant.file?.size;
  let endpoints=approvedCampusEndpoints(grant);
  let selected=endpoints[0];
  const makeAgent=()=>agentFactory(grant.certificateSha256,{dialEndpoint:selected.endpoint,serverName:new URL(grant.endpoint).hostname});
  let agent=makeAgent();
  const refresh=async()=>{
    const next=personalFileGrant((await ticket()).result,path,action);
    if(action==='get'&&next.file.size!==fixedSize)fail('下载文件大小已改变，请重新下载；原文件和断点已保留。');
    const previous=grant,previousEndpoint=selected.endpoint;
    grant=next;endpoints=approvedCampusEndpoints(grant);grantDeadline=ticketStarted+Math.max(0,validity(grant))*1000;
    selected=endpoints.find(row=>row.endpoint===selected.endpoint)??endpoints[0];
    if(grant.endpoint!==previous.endpoint||grant.certificateSha256!==previous.certificateSha256||selected.endpoint!==previousEndpoint){await agent.destroy();agent=makeAgent();}
  };
  return {
    get chunkBytes(){return grant.chunkBytes;},
    async request(args){
      if(closed)fail('Campus file transport is closed');
      let firstError;
      try{return await retryCampusRequest(async()=>{
        if(remainingGrant()<=120)await refresh();
        const attempted=new Set();
        for(;;){
          attempted.add(selected.endpoint);
          try{return await send(grant,agent,action,{...args,...(selected.endpoint!==grant.endpoint?{dialEndpoint:selected.endpoint}:{})});}
          catch(error){
            if(!campusRetryable(error))throw error;
            firstError??=error;
            const remaining=endpoints.filter(row=>!attempted.has(row.endpoint));
            await finishCampusOperation(()=>agent.destroy());if(remaining.length)selected=remaining[0];agent=makeAgent();
            if(action==='put'&&error.writeMayHaveReachedPeer!==false){
              firstError.writeMayHaveReachedPeer=true;
              let row;try{row=(await call('data.upload.status',{machine,...context,path,key:identity.uploadId})).result;}catch{firstError.receiptChecked=true;throw firstError;}
              if(row?.offset===args.offset+args.bytes.length)return row;
              if(!Number.isSafeInteger(row?.offset)||row.offset<args.offset||row.offset>args.offset+args.bytes.length){firstError.receiptChecked=true;throw firstError;}
            }
            if(!remaining.length)throw firstError;
          }
        }
      },retry);}catch(error){if(campusRetryable(error))error.message+='\n'+(context?.area==='dataset'?DATASET_DIRECT_HELP:CAMPUS_CONNECTION_HELP);throw error;}
    },
    async close(){closed=true;await finishCampusOperation(()=>agent.destroy());}
  };
}

