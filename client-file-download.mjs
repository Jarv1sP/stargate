import {open,lstat,rename,unlink,link} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sameDatasetFile} from './client-file-path.mjs';

const CHUNK=1024**2,LARGE_FILE_BYTES=100*1024**3;
const fail=message=>{throw Error(message);};
const safe=info=>info.isFile()&&info.nlink===1n;
export const missing=async path=>{try{return await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}};
async function save(path,value){
  const temporary=path+'.'+randomUUID()+'.new',file=await open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
  try{await rename(temporary,path);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

// Resume the saved original request. Content is transported by
// TLS, bounded by size, and published atomically after the final byte.
export async function downloadFile(call,{machine,context={},path,destination,origin,userId,receiptPath:customReceipt,keepReceipt=false,getChunkBytes=()=>CHUNK,onWarning=size=>console.error(`下载文件超过 100 GiB（${size} B），仍允许分块下载；请确认本地磁盘空间。`)}){
  const target=resolve(destination),receiptPath=customReceipt??target+'.gpuctl-download.json',partial=target+'.gpuctl-partial';
  let identity={origin,userId,machine,path,ownerId:context.ownerId??userId,project:context.project??null,area:context.area??null,dataset:context.dataset??null,runId:context.runId??null};
  let offset=0,size,resumed=false,file;
  const saved=await missing(receiptPath),existing=await missing(target);
  if(saved){
    if(!safe(saved)||saved.size>8192n)fail('Unsafe download state; files preserved');
    const record=await open(receiptPath,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let value;
    try{if(!safe(await record.stat({bigint:true})))fail('Unsafe download state');value=JSON.parse(await record.readFile('utf8'));}finally{await record.close();}
    identity={...value.identity,origin,userId};machine=identity.machine;path=identity.path;context=Object.fromEntries(Object.entries({project:identity.project,area:identity.area,dataset:identity.dataset,runId:identity.runId,ownerId:identity.ownerId??value.identity.userId}).filter(([,v])=>v!=null));
    size=value.size;if(!Number.isSafeInteger(size)||size<0)fail('Invalid download size');resumed=true;
    if(existing){
      if(existing.size===BigInt(size)&&value.offset===size){
        // A crash between exclusive publication and unlink can leave the two
        // known names of this one inode. Recover only that pair; external
        // hard links remain outside the local path boundary.
        const pending=await missing(partial);
        if(pending&&existing.isFile()&&pending.isFile()&&existing.nlink===2n&&pending.nlink===2n&&sameDatasetFile(existing,pending))await unlink(partial);
        if(!safe(await lstat(target,{bigint:true})))fail('Unsafe local download file; preserved');
        if(!keepReceipt)await unlink(receiptPath);return {downloaded:destination,bytes:size,resumed};
      }
      if(!safe(existing))fail('Unsafe local download file; preserved');
      if(await missing(partial))fail('Two download partials exist; files preserved');
      await rename(target,partial);
    }
  }else if(existing||await missing(partial))fail('Destination exists without a matching download receipt; preserved');
  const prior=await missing(partial);
  if(prior){if(!safe(prior))fail('Unsafe local partial; preserved');offset=Number(prior.size);}
  try{
    for(;;){
      const value=(await call('files.get',{machine,path,offset,...context})).result;
      const bound=getChunkBytes();
      if(![CHUNK,16*CHUNK].includes(bound)||typeof value.data!=='string'||value.data.length>Math.ceil(bound/3)*4)fail('Download response exceeds its size bound');
      const bytes=Buffer.from(value.data,'base64');
      if(!Number.isSafeInteger(value.size)||value.size<0||size!==undefined&&size!==value.size||bytes.length>bound||offset+bytes.length>value.size||!bytes.length&&offset<value.size)fail('Download size changed; partial preserved');
      size=value.size;if(offset===0&&size>LARGE_FILE_BYTES)onWarning(size);
      if(!file){
        if(!saved)await save(receiptPath,{protocol:2,identity,size,offset:0});
        file=await open(partial,constants.O_RDWR|(prior?0:constants.O_CREAT|constants.O_EXCL)|(constants.O_NOFOLLOW||0),0o600);
      }
      const info=await file.stat({bigint:true}),named=await lstat(partial,{bigint:true});
      if(!safe(info)||!safe(named)||!sameDatasetFile(named,info,{pathToHandle:true}))fail('Download path changed or is linked; partial preserved');
      for(let written=0;written<bytes.length;){const part=await file.write(bytes,written,bytes.length-written,offset+written);if(!part.bytesWritten)fail('Local write made no progress');written+=part.bytesWritten;}
      offset+=bytes.length;
      if(offset===size){
        await file.sync();await file.close();file=null;
        await save(receiptPath,{protocol:2,identity,size,offset});
        await link(partial,target);await unlink(partial);
        if(!keepReceipt)await unlink(receiptPath);
        return {downloaded:destination,bytes:offset,resumed};
      }
    }
  }finally{await file?.close();}
}
