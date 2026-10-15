import {unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {downloadFile} from './client-file-download.mjs';
import {downloadDirectory,hasDirectoryDownload} from './client-directory-download.mjs';
import {createPersonalFileTransport} from './client-personal-file-campus.mjs';
import {selectTransferRoute} from './client-transfer-route.mjs';
import {campusRetryable} from './dist/personal-upload.js';
export async function downloadResultFile(call,options,{directDownload,transportFactory=createPersonalFileTransport,probe,notify=message=>process.stderr.write(message+'\n')}={}){
  const {via,directory=false,...file}=options;if(via!==undefined&&!['auto','direct','portal'].includes(via))throw Error('下载通道使用 --via direct 或 --via portal。');
  const stateFile=resolve(file.destination)+'.gpuctl-route.json';let selected,complete=false;
  const download=directDownload||(async(call,args)=>{
    let transport;
    try{
      return await downloadFile(async(operation,request)=>{
        if(operation!=='files.get')return call(operation,request);
        // The file journal selects the original scope and offset before route selection.
        const {machine,path,offset,...context}=request;
        selected??=await selectTransferRoute({area:context.area,via,action:'get',stateFile,probe,getGrant:async()=>(await call('files.direct-ticket',{machine,...context,path,action:'get'})).result});
        if(selected.via==='portal')return call(operation,request);
        try{
          transport ||= await transportFactory(call,{machine,context,path,action:'get',initialGrant:selected.grant});
          delete selected.grant;
          return {result:await transport.request({offset})};
        }catch(error){
          if(context.area==='dataset'||via==='direct'||!campusRetryable(error))throw error;
          selected.via='portal';await selected.save?.('portal');notify('校园直连失败，改经 VPS 继续');
          return call(operation,request);
        }
      },{...args,getChunkBytes:()=>transport?.chunkBytes||1024**2});
    }finally{await transport?.close();}
  });
  try{
    let result;
    if(directory||file.path==='.'||await hasDirectoryDownload(file.destination))result=await downloadDirectory(call,file,download);
    else try{result=await download(call,file);}
    catch(error){if(error.status===400&&/Only unlinked regular files allowed|Is a directory|EISDIR|普通文件|这是目录/.test(error.download?.detail??error.message??''))result=await downloadDirectory(call,file,download);else throw error;}
    complete=true;return result;
  }finally{if(complete&&selected)await unlink(stateFile).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
