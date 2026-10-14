const CHUNK=1024*1024;
const encode=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);};
// One file, one original key, offset resume, atomic finish on the node.
export async function uploadPersonalFile({call,machine,area='code',project,ownerId,dataset,transferId,ownerExecutable,path,size,read,overwrite=false,key=crypto.randomUUID(),chunkBytes=CHUNK,signal,onProgress=()=>{},timeoutMs=7200000,wait=()=>new Promise(resolve=>setTimeout(resolve,1000))}){
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
  }catch(error){error.key=key;error.message+='\n上传编号：'+key+'；续传请沿用原编号。';throw error;}
}
export async function uploadBrowserFile(file,options){
  const {call,signal}=options;let grant;
  const scope={machine:options.machine,area:options.area||'code',...(options.project?{project:options.project}:{}),...(options.ownerId?{ownerId:options.ownerId}:{}),...(options.dataset?{dataset:options.dataset}:{}),path:options.path};
  return uploadPersonalFile({...options,size:file.size,read:async(offset,length)=>new Uint8Array(await file.slice(offset,offset+length).arrayBuffer()),call:async(operation,args)=>{
    if(operation!=='data.upload.chunk')return call(operation,args);
    if(!grant||grant.expiresAt*1000<=Date.now()+5000)grant=await call('files.direct-ticket',{...scope,action:'put',uploadId:args.key,totalSize:file.size});
    const endpoint=new URL(grant.endpoint);if(endpoint.protocol!=='https:')throw Error('校园直连需要 HTTPS 地址。');
    const url=new URL('/v1/files/'+encodeURIComponent(grant.grantId)+'/put',endpoint);url.searchParams.set('offset',args.offset);url.searchParams.set('final','false');
    const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+grant.ticket,'Content-Type':'application/octet-stream'},body:Uint8Array.from(atob(args.data),c=>c.charCodeAt(0)),signal});
    const value=await response.json();if(!response.ok)throw Error(value.error||'上传连接中断，请沿用原编号续传。');return value.result;
  }});
}
