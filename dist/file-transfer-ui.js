const join=(parent,name)=>parent==='.'?name:parent+'/'+name;
export function filePath(parent,name){if(typeof name!=='string'||!name||name.includes('/')||/[\\\x00-\x1f\x7f]/.test(name)||name==='.'||name==='..')throw Error('文件名超出了当前目录。');return join(parent,name);}
export async function readBrowserFile(call,scope,path,{signal,onProgress=()=>{}}={}){
  let offset=0,size,grant;const chunks=[];
  do{
    signal?.throwIfAborted();
    let bytes,metadata;
    if(scope.area==='output'){
      metadata=await call('files.get',{...scope,path,offset});bytes=Uint8Array.from(atob(metadata.data),c=>c.charCodeAt(0));
    }else{
      if(!grant||grant.expiresAt*1000<=Date.now()+5000)grant=await call('files.direct-ticket',{...scope,path,action:'get'});
      const url=new URL('/v1/files/'+encodeURIComponent(grant.grantId)+'/get',grant.endpoint);if(url.protocol!=='https:')throw Error('校园直连需要 HTTPS 地址。');url.searchParams.set('offset',offset);
      const response=await fetch(url,{headers:{Authorization:'Bearer '+grant.ticket},signal});if(!response.ok)throw Error('下载连接中断，请使用 CLI 续传原下载。');
      bytes=new Uint8Array(await response.arrayBuffer());metadata=JSON.parse(atob(response.headers.get('x-gpuq-file-metadata').replaceAll('-','+').replaceAll('_','/')));
    }
    size??=metadata.size;if(!Number.isSafeInteger(size)||size<0||metadata.size!==size||metadata.offset!==offset||offset+bytes.length>size||!bytes.length&&offset<size)throw Error('下载大小或偏移改变，请续传原下载。');
    chunks.push(bytes);offset+=bytes.length;onProgress({path,offset,size});
  }while(offset<size);
  return new Blob(chunks);
}
function save(blob,name){const link=document.createElement('a'),url=URL.createObjectURL(blob);link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
// PAX records preserve long or non-ASCII names in a standard tar download.
function tarHeader(name,size,type='0'){
  const bytes=new Uint8Array(512),text=new TextEncoder(),put=(at,value,length)=>bytes.set(text.encode(value).subarray(0,length),at),octal=(n,length)=>n.toString(8).padStart(length-1,'0')+'\0';
  put(0,name,100);put(100,'0000600\0',8);put(108,'0000000\0',8);put(116,'0000000\0',8);put(124,octal(size,12),12);put(136,octal(Math.floor(Date.now()/1000),12),12);bytes.fill(32,148,156);put(156,type,1);put(257,'ustar\0',6);put(263,'00',2);put(148,bytes.reduce((sum,n)=>sum+n,0).toString(8).padStart(6,'0')+'\0 ',8);return bytes;
}
function tarEntry(parts,path,blob,type='0'){
  const encoder=new TextEncoder();let record='path='+path+'\n',length=encoder.encode(record).length+3;
  for(;;){const actual=encoder.encode(length+' '+record).length;if(actual===length)break;length=actual;}
  const pax=encoder.encode(length+' '+record);parts.push(tarHeader('Path',pax.length,'x'),pax,new Uint8Array((512-pax.length%512)%512),tarHeader('Entry',blob.size,type),blob,new Uint8Array((512-blob.size%512)%512));
}
export async function downloadBrowserPath(call,scope,path,{directory=false,onProgress=()=>{},signal}={}){
  if(!directory){save(await readBrowserFile(call,scope,path,{onProgress,signal}),path.split('/').at(-1));return;}
  const parts=[],queue=[{path,relative:''}];
  for(let i=0;i<queue.length;i++){
    const current=queue[i];let cursor;
    do{
      const page=await call('files.list',{...scope,path:current.path,limit:1000,...(cursor?{cursor}:{})});
      for(const entry of page.entries||[]){
        const remote=filePath(current.path,entry.name),relative=filePath(current.relative||'.',entry.name);
        if(entry.type==='directory'){tarEntry(parts,relative+'/',new Blob([]),'5');queue.push({path:remote,relative});continue;}if(entry.type!=='file')continue;
        const blob=await readBrowserFile(call,scope,remote,{onProgress,signal});tarEntry(parts,relative,blob);
      }
      cursor=page.hasMore?page.nextCursor:null;
    }while(cursor);
  }
  parts.push(new Uint8Array(1024));save(new Blob(parts,{type:'application/x-tar'}),(path==='.'?scope.dataset||scope.project||'files':path.split('/').at(-1))+'.tar');
}
