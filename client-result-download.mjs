import {unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {downloadFile} from './client-file-download.mjs';
import {downloadDirectory,hasDirectoryDownload} from './client-directory-download.mjs';
import {createPersonalFileTransport} from './client-personal-file-campus.mjs';
import {selectTransferRoute} from './client-transfer-route.mjs';
export async function downloadResultFile(call,options,{directDownload,transportFactory=createPersonalFileTransport,probe}={}){
  const {via,directory=false,...file}=options;if(via!==undefined&&!['auto','direct','portal'].includes(via))throw Error('下载通道使用 --via direct 或 --via portal。');
  const stateFile=resolve(file.destination)+'.gpuctl-route.json';let selected,complete=false;
  const download=directDownload||(async(call,args)=>{
    let transport;
    try{
      return await downloadFile(async(operation,request)=>{
        if(operation!=='files.get')return call(operation,request);
        // The file journal selects the original scope and offset before route selection.
        const {machine,path,offset,...context}=request;
        if(context.area==='output')return call(operation,request);
        selected??=await selectTransferRoute({area:context.area,via,action:'get',stateFile,probe,getGrant:async()=>(await call('files.direct-ticket',{machine,...context,path,action:'get'})).result});
        if(selected.via==='portal')return call(operation,request);
        transport ||= await transportFactory(call,{machine,context,path,action:'get',initialGrant:selected.grant});
        delete selected.grant;
        return {result:await transport.request({offset})};
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
