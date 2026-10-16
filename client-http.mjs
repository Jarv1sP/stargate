import {campusRetryable,retryCampusRequest} from './dist/personal-upload.js';
// Reads share one minute retry budget. Writes are sent once here; recovery of
// an owner-bound original key is handled by recoverOriginalWrite below.
const READS=new Set(['data.upload.status','state','storage.snapshot','datasets.list','projects.list','projects.status','projects.quota','projects.label.get','projects.group.get','projects.catalog','projects.retire.list','files.get','files.list','terminal.status','jobs.logs','jobs.watch','jobs.diagnostics','jobs.completion','transfers.list','transfers.status','cloud.info','cloud.import.list','cloud.import.status','cloud.files.list','cloud.files.status','community.posts.list','community.posts.get','community.comments.list']);
const TRANSIENT=new Set([502,503,504]);
READS.add('community.announcements.pending');
const safe=value=>String(value).replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,600);
const error=(message,status,code)=>Object.assign(Error(message),{status,...(code?{code}:{})});
const transientRead=(status,data)=>campusRetryable({status,code:data?.code,message:data?.error})||status===400&&
  /\[Errno 11\]|Resource temporarily unavailable|RPC_BUSY|CACHE_BUSY|lock.*busy|锁.*忙|锁.*占用/i.test(`${data?.code||''} ${data?.error||''}`);
const wait=(ms,signal)=>new Promise((resolve,reject)=>{
  if(signal.aborted)return reject(signal.reason);
  const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();};
  const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
  const timer=setTimeout(done,ms);signal.addEventListener('abort',abort,{once:true});
});
export const uncertainWrite=failure=>failure?.writeMayHaveReachedPeer!==false&&failure?.receiptChecked!==true&&
  (failure?.status===undefined||TRANSIENT.has(failure.status));

/** One original request, then its original readback. Replay is possible only
 * when the caller proves absence AND the server deduplicates that same key. */
export async function recoverOriginalWrite(send,{query,classify,canReplay=false,unresolved,shouldRecover=uncertainWrite,signal,sleep=wait}){
  let failure;
  const write=send;
  try{return await write();}catch(error){if(!shouldRecover(error))throw error;failure=error;}
  for(let retry=0;retry<2;retry++){
    let observation;
    const deadline=AbortSignal.timeout(10000),readSignal=signal?AbortSignal.any([signal,deadline]):deadline;
    for(let attempt=0;;attempt++){
      signal?.throwIfAborted();
      try{observation=classify(await query(readSignal));break;}
      catch(failure){
        signal?.throwIfAborted();if([401,403].includes(failure.status)||failure.code==='LOCAL_FILE_CHANGED')throw failure;
        // apiPost already spent its read budget. Only bare read adapters need
        // the same bounded retry here; never restart an exhausted HTTP read.
        if(attempt===2||readSignal.aborted||failure.code==='READ_UNAVAILABLE'||
          !(failure instanceof TypeError||transientRead(failure.status,{error:failure.message,code:failure.code})))break;
        try{await sleep(attempt?600:200,readSignal);}catch(cause){signal?.throwIfAborted();if(!readSignal.aborted)throw cause;}
        signal?.throwIfAborted();if(readSignal.aborted)break;
      }
    }
    if(observation&&Object.hasOwn(observation,'value'))return observation.value;
    if(retry===0&&canReplay&&observation?.absent===true){
      try{return await write();}catch(error){if(!shouldRecover(error))throw error;failure=error;}
    }else break;
  }
  const pending=unresolved?unresolved(failure):failure;
  pending.receiptChecked=true;
  throw pending;
}

export function commandPost(base,{continuous=false,...options}={}){
  const now=options.now||(()=>performance.now());
  let deadlineAt;
  return (path,body,signal)=>{
    if(!continuous)deadlineAt??=now()+60000;
    return apiPost(base,path,body,{...options,signal,now,deadlineAt});
  };
}

export async function apiPost(base,path,body,{token,signal,fetchImpl=fetch,sleep=wait,now=()=>performance.now(),deadlineAt}={}){
  const target=new URL(`/api/${path}`,base),operation=path==='call'?body?.operation:path;
  const read=path==='call'&&(READS.has(operation)||operation==='outputs.delete'&&body.args?.dryRun===true),payload=JSON.stringify({...body,client:{name:'gpuctl',protocol:2}});
  signal?.throwIfAborted();
  const timeout=read?(deadlineAt===undefined?60000:Math.min(60000,Math.ceil(deadlineAt-now()))):40000;
  if(timeout<=0)throw error('暂时无法读取，请稍后再查。',undefined,'READ_UNAVAILABLE');
  const deadline=AbortSignal.timeout(timeout);
  const combined=signal?AbortSignal.any([signal,deadline]):deadline;
  let lastReadFailure;
  const send=async()=>{
    let response,data,decoded=false,cause;
    try{
      response=await fetchImpl(target,{method:'POST',redirect:'error',signal:combined,
        headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:payload});
      try{data=await response.json();decoded=!!data&&typeof data==='object'&&!Array.isArray(data);}
      catch(error){if(!(error instanceof SyntaxError))throw error;}
    }catch(error){cause=error;}
    if(signal?.aborted)throw signal.reason;
    const temporary=!!cause&&(combined.aborted||campusRetryable(cause)||cause.status===undefined&&cause.code===undefined)||response&&!response.ok&&transientRead(response.status,data);
    if(read&&cause&&!temporary)throw cause;
    if(read&&temporary){
      throw lastReadFailure=error(`${safe(operation)}：${response?'HTTP '+response.status+' — ':''}暂时无法读取，请稍后再查。`,response?.status,'READ_UNAVAILABLE');
    }
    if(cause)throw error(`${safe(operation)}：${combined.aborted?'请求已取消或超时':'网络连接中断'}。操作结果尚未确认，原请求编号保留。`);
    if(!response.ok){
      const detail=decoded&&typeof data.error==='string'?safe(data.error):TRANSIENT.has(response.status)?'服务暂时不可用或正在更新':response.status===404?'API 路径不存在，请检查服务地址':'服务返回了非 JSON 错误响应';
      const failure=error(`${safe(operation)}：HTTP ${response.status} — ${detail}${!read&&TRANSIENT.has(response.status)?'；操作结果尚未确认，原请求编号保留。':''}`,response.status);
      if(operation==='terminal.open'&&response.status===400&&decoded&&data.code==='TERMINAL_OPEN_REJECTED')failure.code=data.code;
      if(response.status===426&&decoded&&data.code==='CLIENT_UPGRADE_REQUIRED'){failure.code=data.code;failure.message=data.error;}
      throw failure;
    }
    if(!decoded)throw error(`${safe(operation)}：HTTP ${response.status}，API 未返回有效 JSON。请检查服务地址或网关；不能据此判定数据或操作失败。`,read?response.status:undefined);
    return data;
  };
  try{return read?await retryCampusRequest(send,{signal:combined,sleep:ms=>sleep(ms,combined),now,timeoutMs:timeout}):await send();}
  catch(failure){signal?.throwIfAborted();if(read&&combined.aborted&&lastReadFailure)throw lastReadFailure;throw failure;}
}
