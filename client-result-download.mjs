import {downloadFile} from './client-file-download.mjs';
import {downloadDirectory,hasDirectoryDownload} from './client-directory-download.mjs';
import {createPersonalFileTransport} from './client-personal-file-campus.mjs';
export async function downloadResultFile(call,options,{directDownload,transportFactory=createPersonalFileTransport}={}){
  const {via,directory=false,...file}=options;if(via!==undefined&&!['auto','direct','portal'].includes(via))throw Error('下载通道使用 --via direct 或 --via portal。');
  const download=directDownload||(file.context?.area==='output'||via==='portal'?downloadFile:async(call,args)=>{
    let transport;
    try{
      return await downloadFile(async(operation,request)=>{
        if(operation!=='files.get')return call(operation,request);
        // The file journal selects the original scope and offset before a ticket is issued.
        const {machine,path,offset,...context}=request;
        transport ||= await transportFactory(call,{machine,context,path,action:'get'});
        return {result:await transport.request({offset})};
      },{...args,getChunkBytes:()=>transport?.chunkBytes||1024**2});
    }finally{await transport?.close();}
  });
  if(directory||file.path==='.'||await hasDirectoryDownload(file.destination))return downloadDirectory(call,file,download);
  try{return await download(call,file);}
  catch(error){if(error.status===400&&/Only unlinked regular files allowed|Is a directory|EISDIR|普通文件|这是目录/.test(error.download?.detail??error.message??''))return downloadDirectory(call,file,download);if(error.code==='CAMPUS_ENDPOINT_UNAVAILABLE')error.message+='\n校外可在原下载命令加 --via portal，经 HTTPS 门户下载。';throw error;}
}
