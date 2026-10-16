const CHUNK=1024*1024;
export const DATASET_DIRECT_HELP='数据集只走校园网直连，避免挤占 VPS 带宽。请连上校园网后用原命令重试，原 key 会续传。';
// The web pages keep upload keys themselves, so their advice is to try the same files again.
export const BROWSER_DATASET_HELP='数据集只走校园网直连，避免挤占 VPS 带宽。连上校园网后再试一次，会从断点继续。';
const BROWSER_RESUME_HINT='重新上传同一个文件会从断点继续。';
export const CAMPUS_CONNECTION_HELP='校园直连暂时不可用，请用原命令重试，原 key 和偏移已保留。';
export const campusRetryable=error=>error?.name!=='AbortError'&&![401,403,404].includes(error?.status)&&!['EACCES','EPERM','ENOENT','ENOTDIR'].includes(error?.code)&&(
  error instanceof TypeError||error?.name==='TimeoutError'||error?.code==='READ_UNAVAILABLE'||/暂时无法读取/.test(error?.message??'')||['DNS_FAILED','TCP_TIMEOUT','TCP_REFUSED','CAMPUS_UNAVAILABLE','PHYSICAL_CONNECT_FAILED','PHYSICAL_ROUTE_UNAVAILABLE','NETWORK_CHANGED','ROUTE_UNCONFIRMED','CAMPUS_ADDRESS_REQUIRED','PHYSICAL_BIND_DENIED','NATIVE_START_FAILED','NATIVE_EXITED','ACK_UNCONFIRMED','RESPONSE_INTERRUPTED','CONNECTION_FAILED','CONNECTION_REFUSED','NETWORK_UNREACHABLE','TIMEOUT','ETIMEDOUT','ECONNRESET','EPIPE','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','HANDSHAKE_TIMEOUT','HANDSHAKE_EOF'].includes(error?.code)||[429,502,503,504].includes(error?.status));
export async function retryCampusRequest(send,{signal,now=()=>performance.now(),sleep=(ms)=>new Promise((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(signal.reason);}signal?.addEventListener('abort',abort,{once:true});})}={}){
  const deadline=now()+60000;let first,delay=1000;
  for(;;){signal?.throwIfAborted();try{return await send();}catch(failure){
    const error=failure?.name==='TimeoutError'?Object.assign(Error(failure.message,{cause:failure}),{code:'TIMEOUT',receiptChecked:failure.receiptChecked}):failure;
    first??=error;if(error.receiptChecked||!campusRetryable(error))throw error;
    const remaining=deadline-now();if(remaining<=0)throw first;
    signal?.throwIfAborted();await sleep(Math.min(delay,remaining));signal?.throwIfAborted();if(now()>=deadline)throw first;delay=Math.min(16000,delay*2);
  }}
}
const encode=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);};
// One file, one original key, offset resume, atomic finish on the node.
export async function uploadPersonalFile({call,machine,area='code',project,ownerId,dataset,transferId,ownerExecutable,path,size,read,overwrite=false,key=crypto.randomUUID(),chunkBytes=CHUNK,signal,onProgress=()=>{},timeoutMs=7200000,wait=()=>new Promise(resolve=>setTimeout(resolve,1000)),resumeHint}){
  const scope={machine,area,...(project?{project}:{}),...(ownerId?{ownerId}:{}),...(dataset?{dataset}:{}),path,key,...(transferId?{transferId}:{})};
  const check=()=>signal?.throwIfAborted();
  const request=async(action,args={})=>{check();const value=await call('data.upload.'+action,{...scope,...args});check();return value;};
  const until=Date.now()+timeoutMs;
  const pending=async result=>{while(['UNKNOWN','DISPATCHING','COMMITTING'].includes(result.state)){if(Date.now()>=until)throw Error('结果未知，请按原上传编号查询或续传。');onProgress({...result,key,path,totalSize:size});await wait();result=await request('status');}return result;};
  try{
    onProgress({key,path,totalSize:size,offset:0,state:'STARTING'});
    let result=await pending(await request('begin',{totalSize:size,overwrite}));
    if(result.state==='COMPLETE'&&typeof ownerExecutable!=='boolean')return result;
    let offset=result.state==='COMPLETE'?size:result.offset;
    if(!Number.isSafeInteger(offset)||offset<0||offset>size)throw Error('上传偏移超出文件大小，请按原编号查询。');
    onProgress({...result,key,path,totalSize:size});
    while(offset<size){
      check();const bytes=await read(offset,Math.min(chunkBytes,size-offset));check();
      if(bytes.length!==Math.min(chunkBytes,size-offset))throw Error('本地文件大小改变，原断点已保留。');
      result=await pending(await request('chunk',{offset,data:encode(bytes)}));
      offset+=bytes.length;
      if(result.offset!==undefined&&result.offset!==offset)throw Error('上传偏移不对，请按原编号查询。');
      onProgress({...result,key,path,totalSize:size,offset});
    }
    result=await pending(await request('finish',{...(typeof ownerExecutable==='boolean'?{executable:ownerExecutable}:{})}));
    if(result.state!=='COMPLETE')throw Error('上传尚未完成，请按原编号查询或续传。');
    onProgress({...result,key,path,totalSize:size,offset:size});return result;
  }catch(error){error.key=key;if(!(error instanceof DOMException))error.message+='\n'+(resumeHint??'上传编号：'+key+'；续传请沿用原编号。');throw error;}
}
export async function selectBrowserTransferRoute(call,args,{route,signal}){
  if(route.via&&route.via!=='auto'&&(args.area!=='dataset'||route.via==='direct'))return;
  if(args.area!=='dataset'){route.via='direct';route.save?.('direct');return;}
  const grant=await call('files.direct-ticket',args);
  try{await fetch(new URL('/capabilities',grant.endpoint),{mode:'no-cors',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(1500)]):AbortSignal.timeout(1500)});}
  catch(error){signal?.throwIfAborted();throw Error(BROWSER_DATASET_HELP,{cause:error});}
  route.via='direct';route.save?.('direct');return grant;
}
export async function uploadBrowserFile(file,options){
  const {call,signal,route={},onRoute=message=>console.warn(message),key=crypto.randomUUID()}=options;
  const scope={machine:options.machine,area:options.area||'code',...(options.project?{project:options.project}:{}),...(options.ownerId?{ownerId:options.ownerId}:{}),...(options.dataset?{dataset:options.dataset}:{}),path:options.path};
  let grant;try{grant=await selectBrowserTransferRoute(call,{...scope,action:'put',uploadId:key,totalSize:file.size},{route,signal});}catch(error){error.key=key;throw error;}
  return uploadPersonalFile({...options,key,resumeHint:BROWSER_RESUME_HINT,size:file.size,read:async(offset,length)=>new Uint8Array(await file.slice(offset,offset+length).arrayBuffer()),call:async(operation,args)=>{
    if(operation!=='data.upload.chunk'||route.via==='relay')return call(operation,args);
    const bytes=Uint8Array.from(atob(args.data),c=>c.charCodeAt(0)),end=args.offset+bytes.length;
    const status=async error=>{let row;try{row=await call('data.upload.status',{...scope,key:args.key});}catch{error.receiptChecked=true;throw error;}
      if(!Number.isSafeInteger(row?.offset)||row.offset<args.offset||row.offset>end){error.receiptChecked=true;throw error;}return row;};
    try{return await retryCampusRequest(async()=>{
      if(!grant||grant.expiresAt*1000<=Date.now()+5000)grant=await call('files.direct-ticket',{...scope,action:'put',uploadId:args.key,totalSize:file.size});
      const url=new URL('/v1/files/'+encodeURIComponent(grant.grantId)+'/put',grant.endpoint);if(url.protocol!=='https:')throw Error('校园直连需要 HTTPS 地址。');url.searchParams.set('offset',args.offset);url.searchParams.set('final','false');
      try{
        const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+grant.ticket,'Content-Type':'application/octet-stream'},body:bytes,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
        const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error||'上传连接中断，请沿用原编号续传。'),{status:response.status});return value.result;
      }catch(error){if(campusRetryable(error)){const row=await status(error);if(row.offset===end)return row;}throw error;}
    },{...options.retry,signal});}catch(error){
      signal?.throwIfAborted();
      if(scope.area==='dataset'||!campusRetryable(error)){if(campusRetryable(error))error.message+='\n'+BROWSER_DATASET_HELP;throw error;}
      const row=await status(error);route.via='relay';route.save?.('relay');onRoute('校园直连失败，改经 VPS 继续');
      return row.offset===end?row:call(operation,{...args,offset:row.offset,data:encode(bytes.subarray(row.offset-args.offset))});
    }
  }});
}
