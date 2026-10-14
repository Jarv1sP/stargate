// Reads share one short retry budget. Writes are sent once here; recovery of
// an owner-bound original key is handled by recoverOriginalWrite below.
const READS=new Set(['data.upload.status','state','datasets.list','projects.list','projects.status','projects.quota','projects.label.get','projects.group.get','projects.catalog','projects.retire.list','files.get','files.list','terminal.status','jobs.logs','jobs.watch','jobs.diagnostics','jobs.completion','transfers.list','transfers.status','cloud.info','cloud.import.list','cloud.import.status','cloud.files.list','cloud.files.status','community.posts.list','community.posts.get','community.comments.list']);
const TRANSIENT=new Set([502,503,504]);
READS.add('community.announcements.pending');
const safe=value=>String(value).replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,600);
const error=(message,status,code)=>Object.assign(Error(message),{status,...(code?{code}:{})});
const transientRead=(status,data)=>TRANSIENT.has(status)||status===429||status===400&&
  /\[Errno 11\]|Resource temporarily unavailable|RPC_BUSY|CACHE_BUSY|lock.*busy|锁.*忙|锁.*占用/i.test(`${data?.code||''} ${data?.error||''}`);
const wait=(ms,signal)=>new Promise((resolve,reject)=>{
  if(signal.aborted)return reject(signal.reason);
  const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();};
  const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
  const timer=setTimeout(done,ms);signal.addEventListener('abort',abort,{once:true});
});
export const uncertainWrite=failure=>failure?.receiptChecked!==true&&
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

export async function apiPost(base,path,body,{token,signal,fetchImpl=fetch,sleep=wait}={}){
  const target=new URL(`/api/${path}`,base),operation=path==='call'?body?.operation:path;
  const read=path==='call'&&(READS.has(operation)||operation==='outputs.delete'&&body.args?.dryRun===true),payload=JSON.stringify({...body,client:{name:'gpuctl',protocol:2}});
  const deadline=AbortSignal.timeout(read?10000:40000);
  const combined=signal?AbortSignal.any([signal,deadline]):deadline;
  for(let attempt=0;;attempt++){
    let response,data,decoded=false,cause;
    try{
      response=await fetchImpl(target,{method:'POST',redirect:'error',signal:combined,
        headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:payload});
      try{data=await response.json();decoded=!!data&&typeof data==='object'&&!Array.isArray(data);}
      catch(error){if(!(error instanceof SyntaxError))throw error;}
    }catch(error){cause=error;}
    if(signal?.aborted)throw signal.reason;
    const temporary=!!cause||response&&transientRead(response.status,data);
    if(read&&temporary){
      if(attempt<2&&!combined.aborted){
        try{await sleep(attempt?600:200,combined);}catch(cause){signal?.throwIfAborted();if(!combined.aborted)throw cause;}
        signal?.throwIfAborted();if(!combined.aborted)continue;
      }
      throw error(`${safe(operation)}：${response?'HTTP '+response.status+' — ':''}暂时无法读取，请稍后再查。`,response?.status,'READ_UNAVAILABLE');
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
  }
}

// Terminal close may be recovered by reading the original session. Inputs are never replayed.
export function callWithReceipt(call,operation,args,{principal}={}){
  const fixed=structuredClone(args),quote=value=>"'"+String(value).replaceAll("'","'\"'\"'")+"'";
  let query,classify,command,canReplay=false,key=fixed.key||fixed.operationId||fixed.uploadId||fixed.id||fixed.jobId;
  if(operation==='terminal.close'){
    const {clientId,writerToken,...scope}=fixed;
    query=()=>call('terminal.status',scope);
    canReplay=clientId===undefined&&writerToken===undefined;
    classify=reply=>{
      const row=reply.result;
      if(row?.id!==fixed.id||row.state!=='STOPPED')return;
      return {value:reply};
    };
    command=`gpuctl terminal status ${fixed.id} --machine ${quote(fixed.machine)}${fixed.project?' --project '+quote(fixed.project):''}${fixed.ownerId?' --owner USERNAME':''}`;
  }else return call(operation,fixed);
  return recoverOriginalWrite(()=>call(operation,fixed),{query,classify,canReplay,
    unresolved:failure=>Object.assign(Error(`${failure.message}\n原编号：${key}。查询：${command}`),{status:failure.status,code:failure.code,key,statusCommand:command})});
}
