// Private node worker. Credentials stay on the node; bytes use an inherited FD.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createCloudDriveFilesTransport} from './clouddrive-files.mjs';
const CHUNK=256*1024;
const need=(ok,message)=>{if(!ok)throw Error(message);};
function privateRead(file){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const s=fs.fstatSync(fd);need(s.isFile()&&s.uid===process.getuid()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<=65536,'云文件私有配置不可用，请联系管理员。');return JSON.parse(fs.readFileSync(fd));}
  finally{fs.closeSync(fd);}
}
function remotePath(value){
  need(typeof value==='string'&&value.startsWith('/')&&!value.includes('\0')&&!value.split('/').includes('..'),'云端文件路径不可用，请刷新列表。');
  return path.posix.normalize(value);
}
export class CloudDirectory {
  constructor(transport,token,root='/'){this.transport=transport;this.token=token;this.root=remotePath(root);}
  async *files(signal){
    const todo=[this.root],seen=new Set();
    while(todo.length){
      signal?.throwIfAborted();const folder=todo.pop();if(seen.has(folder))continue;seen.add(folder);
      const reply=await this.transport.rpc('GetSubFiles',{path:folder,forceRefresh:false,checkExpires:true},{token:this.token,signal});
      for(const file of reply.subFiles||[]){
        if(file.isLocal===true)continue; // The cloud API must never expose local/system files.
        const name=remotePath(file.fullPathName);
        if(name!==this.root&&!name.startsWith(this.root==='/'?'/':this.root+'/'))continue;
        if(file.isDirectory){todo.push(name);continue;}
        const size=Number(file.size);if(!Number.isSafeInteger(size)||size<0)continue;
        if(typeof file.id==='string'&&file.id)yield {id:file.id,name:file.name,path:name,size};
      }
    }
  }
  async list(signal){const files=[];for await(const file of this.files(signal))files.push(file);return {files};}
  async status(request,signal){
    const file=await this.transport.rpc('FindFileByPath',{parentPath:path.posix.dirname(request.path),path:remotePath(request.path)},{token:this.token,signal});
    return {id:file.id||null,path:request.path,size:Number(file.size),bytes:request.size,
      state:file.id&&file.isLocal!==true&&Number(file.size)===request.size?'COMPLETE':'PENDING'};
  }
  async upload(request,source,{signal,progress=()=>{},handleReady=()=>{}}={}){
    const name=path.posix.basename(request.name);need(name&&name!=='.'&&name!=='..','请选择文件名。');
    const remote=path.posix.join(this.root,'file-'+request.operationId+'-'+name),parent=path.posix.dirname(remote);
    const rpc=(method,args)=>this.transport.rpc(method,args,{token:this.token,signal});
    let handle=request.fileHandle,bytes=request.offset||0;
    // The original key names this cloud upload. A completed retry only reads size.
    try{const file=await rpc('FindFileByPath',{parentPath:parent,path:remote});if(Number(file.size)===request.size)return {id:file.id||null,path:remote,size:request.size,bytes:request.size,state:file.id&&file.isLocal!==true?'COMPLETE':'PENDING'};}
    catch(error){if(error.grpcCode!==5&&error.code!==5)throw error;}
    if(!handle){const created=await rpc('CreateFile',{parentPath:parent,fileName:path.posix.basename(remote)});handle=String(created.fileHandle);bytes=0;await handleReady(handle);}
    for await(const part of source(bytes)){
      signal?.throwIfAborted();need(bytes+part.length<=request.size,'上传文件大小已变化，请新建上传。');
      const result=await rpc('WriteToFile',{fileHandle:handle,startPos:String(bytes),length:String(part.length),buffer:part,closeFile:false,uploadImmediately:false});
      need(Number(result.bytesWritten)===part.length,'云上传分块尚未写完，请按原编号续传。');bytes+=part.length;await progress(bytes);
    }
    need(bytes===request.size,'云上传尚未完成，请按原编号续传。');
    await rpc('CloseFile',{fileHandle:handle,uploadImmediately:false});
    const file=await rpc('FindFileByPath',{parentPath:parent,path:remote});
    need(Number(file.size)===request.size,'云上传大小尚未完整，请按原编号查询或续传。');
    return {id:file.id||null,path:remote,size:request.size,bytes,state:file.id&&file.isLocal!==true?'COMPLETE':'PENDING'};
  }
  async download(request,sink,{signal,progress=()=>{}}={}){
    let file;
    for await(const row of this.files(signal)){if(row.id===request.fileId){file=row;break;}}
    need(file,'云文件不存在，请刷新列表。');
    // Use the selected real file size for download/resume.
    need(file.size===request.size,'云文件大小已变化，请刷新列表并新建下载。');
    const offset=request.offset||0;need(Number.isSafeInteger(offset)&&offset>=0&&offset<=request.size,'续传偏移超出文件大小。');
    if(offset===request.size)return {id:file.id,size:file.size,bytes:offset,state:'COMPLETE'};
    const descriptor=await this.transport.rpc('GetDownloadUrlPath',{path:file.path,preview:false,lazy_read:false,get_direct_url:false},{token:this.token,signal});
    const response=await this.transport.read(descriptor.downloadUrlPath,{offset,signal});
    let bytes=offset;
    try{
      need(response.status===(offset?206:200),'云下载暂时不可用，请按原编号续传。');
      if(offset)need(new RegExp('^bytes '+offset+'-\\d+/'+request.size+'$').test(response.headers['content-range']||''),'云下载没有从原偏移继续，请按原编号重试。');
      if(response.headers['content-length']!==undefined)need(Number(response.headers['content-length'])===request.size-offset,'云下载大小不完整，请按原编号续传。');
      for await(const part of response.body){signal?.throwIfAborted();need(bytes+part.length<=request.size,'云下载超出文件大小。');await sink(part,bytes);bytes+=part.length;await progress(bytes);}
      need(bytes===request.size,'云下载尚未完成，请按原编号续传。');
      return {id:file.id,size:file.size,bytes,state:'COMPLETE'};
    }finally{response.close?.();}
  }
  close(){this.transport.close?.();}
}
export async function runCloudFileIO(request,{fd,adapter,emit=()=>{},signal}={}){
  if(request.action==='list')return adapter.list(signal);
  if(request.action==='status')return adapter.status(request,signal);
  if(request.action==='upload'){
    need(fs.fstatSync(fd).isFile(),'请选择普通文件。');
    return adapter.upload(request,async function*(offset){
      while(offset<request.size){signal?.throwIfAborted();const buffer=Buffer.allocUnsafe(Math.min(CHUNK,request.size-offset)),n=fs.readSync(fd,buffer,0,buffer.length,offset);need(n>0,'上传文件读取失败，请按原编号续传。');offset+=n;yield buffer.subarray(0,n);}
    },{signal,handleReady:async fileHandle=>emit({kind:'handle',fileHandle}),progress:async bytes=>emit({kind:'progress',bytes})});
  }
  need(request.action==='download','请选择云文件上传或下载。');
  need(typeof request.fileId==='string'&&request.fileId&&Number.isSafeInteger(request.size)&&request.size>=0,'请选择云文件及其大小。');
  const info=fs.fstatSync(fd);need(info.isFile()&&info.nlink===1,'下载临时文件不可用。');
  let last=0;
  const result=await adapter.download(request,async(part,offset)=>{
    let written=0;while(written<part.length){const n=fs.writeSync(fd,part,written,part.length-written,offset+written);need(n>0,'数据盘写入失败，请按原编号续传。');written+=n;}
  },{signal,progress:async bytes=>{if(Date.now()-last>=1000||bytes===request.size){last=Date.now();await emit({kind:'progress',bytes});}}});
  fs.fsyncSync(fd);need(fs.fstatSync(fd).size===request.size,'下载尚未完成，请按原编号续传。');return result;
}
export function workerAdapter(configPath){
  const config=privateRead(configPath);need(config.enabled===true,'云文件服务未启用，请联系管理员。');
  const token=privateRead(config.tokenFile).apiToken;need(typeof token==='string'&&token,'云文件服务登录失效，请联系管理员。');
  return new CloudDirectory(createCloudDriveFilesTransport({endpoint:config.endpoint,allowInsecureLoopback:config.allowInsecureLoopback===true}),token,config.cloud?.path||'/');
}
async function main(){
  const controller=new AbortController();process.once('SIGTERM',()=>controller.abort());let adapter;
  const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
  try{
    const chunks=[];let size=0;for await(const part of process.stdin){size+=part.length;need(size<=1024**2,'云文件请求正文过大。');chunks.push(part);}
    const request=JSON.parse(Buffer.concat(chunks));adapter=workerAdapter(process.argv[2]);
    const result=await runCloudFileIO(request,{fd:Number(process.env.GPUQ_CLOUD_FILE_FD),adapter,emit,signal:controller.signal});emit({kind:'result',result});
  }catch(error){emit({kind:'error',error:error.message?.includes('云')||error.message?.includes('下载')?error.message:'云文件状态暂时未知，请按原编号查询或续传。'});process.exitCode=1;}
  finally{adapter?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
