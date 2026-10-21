import {missing} from './client-file-download.mjs';
import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const protocol='project-directory-download-v1';
const fail=message=>{throw Error(message);};
export const directoryDownloadReceipt=destination=>resolve(destination)+'.gpuctl-directory.json';
async function readRecord(path){
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  const before=await file.stat({bigint:true});
  if(!before.isFile()||before.nlink!==1n)fail('Unsafe directory download receipt; preserved');
  const value=JSON.parse(await file.readFile('utf8'));
  return value;
 }finally{await file.close();}
}
export async function directoryDownloadStatus(destination){
 const row=await readRecord(directoryDownloadReceipt(destination));
 return {protocol,scope:'local-client',downloadId:row.id,state:row.state,source:row.identity,
  files:row.files?.length??null,completedFiles:row.completedFiles,bytes:row.bytes,totalBytes:row.totalBytes??null,
  updatedAt:row.updatedAt,...(row.error?{error:row.error}:{})};
}
export async function hasDirectoryDownload(destination){return !!await missing(directoryDownloadReceipt(destination));}
async function realDirectory(path){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())fail('Download directory is not an ordinary directory: '+path);}
const childPath=(root,path)=>root==='.'?path:root+'/'+path;
const remotePath=value=>{
 if(typeof value!=='string'||!value||value.startsWith('/')||/[\\\x00-\x1f\x7f]/.test(value)||value.split('/').some(s=>!s||s==='.'||s==='..'))fail('Unsafe directory download path');
 // These names cannot represent the original path on Windows, even when join
 // normalizes them into an apparently safe child path.
 if(process.platform==='win32'&&value.split('/').some(s=>/[<>:"|?*]/.test(s)||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))fail('Source path cannot be represented on Windows: '+value);
 return value;
};
async function inventory(call,options){
 const files=[],directories=[];
 const queue=[''];
 for(let i=0;i<queue.length;i++){
  const relative=queue[i],path=relative?childPath(options.path,relative):options.path;
  let cursor;const cursors=new Set(),names=new Set();
  do{
   const page=(await call('files.list',{machine:options.machine,...options.context,path,limit:1000,...(cursor?{cursor}:{})})).result;
   if(!Array.isArray(page?.entries))fail('没有收到目录列表，请按原下载编号重试。');
   for(const item of page.entries){
    const name=remotePath(item.name);if(name.includes('/'))fail('Invalid directory entry path');if(names.has(name))continue;names.add(name);
    const entry=relative?relative+'/'+name:name;
    if(item.type==='directory'){directories.push(entry);queue.push(entry);}
    else if(item.type==='file'&&Number.isSafeInteger(item.size)&&item.size>=0)files.push({path:entry,size:item.size});
    else fail('Directory contains a symlink or nonregular file: '+entry);
   }
   if(page.hasMore){if(typeof page.nextCursor!=='string'||!page.nextCursor||cursors.has(page.nextCursor))fail('Invalid directory page cursor');cursors.add(page.nextCursor);cursor=page.nextCursor;}
   else cursor=null;
  }while(cursor);
 }
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);directories.sort();
 const totalBytes=files.reduce((sum,file)=>sum+file.size,0);if(!Number.isSafeInteger(totalBytes))fail('Directory byte count is not exact');
 return {files,directories,totalBytes};
}

// A client-owned journal, not a new dataset or a server-side mutable snapshot.
// Every child uses the existing owner-authorized fixed-file download protocol.
export async function downloadDirectory(call,options,downloadFile){
 const target=resolve(options.destination),receipt=directoryDownloadReceipt(target);
 const identity={origin:options.origin??null,userId:options.userId??null,machine:options.machine,
  ownerId:options.context?.ownerId??options.userId??null,project:options.context?.project??null,area:options.context?.area??null,dataset:options.context?.dataset??null,runId:options.context?.runId??null,path:options.path==='.'?'.':remotePath(options.path),destination:target};
 let row;
 const save=async(first=false)=>{
  row.updatedAt=new Date().toISOString();const temporary=receipt+'.'+randomUUID()+'.new';
  const file=await open(first?receipt:temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify(row));await file.sync();}finally{await file.close();}
  if(!first)try{await rename(temporary,receipt);}finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 };
 if(await missing(receipt)){
  row=await readRecord(receipt);options={...options,machine:row.identity.machine,path:row.identity.path==='.'?'.':remotePath(row.identity.path),context:Object.fromEntries(Object.entries({project:row.identity.project,area:row.identity.area,dataset:row.identity.dataset,runId:row.identity.runId,ownerId:row.identity.ownerId??row.identity.userId}).filter(([,v])=>v!=null))};
 }else{
  if(await missing(target))fail('Destination already exists; choose a new directory, no files were overwritten');
  await mkdir(dirname(target),{recursive:true});
  row={protocol,id:randomUUID(),identity,state:'LISTING',files:null,completedFiles:0,bytes:0};await save(true);
 }
 const statusCommand='gpuctl pull-status '+JSON.stringify(target)+' --json';
 const partial=target+'.gpuctl-partial-'+row.id,records=partial+'.receipts';
 options.onDirectory?.({downloadId:row.id,receipt,statusCommand});
 try{
  const plan=row.files?{files:row.files,directories:row.directories,totalBytes:row.totalBytes}:await inventory(call,options);
  const installed=row.installed===true||['COMPLETE','FINALIZING'].includes(row.state);
  Object.assign(row,plan,{state:'DOWNLOADING',completedFiles:0,bytes:0});delete row.error;await save();
  const root=await missing(target)?target:partial;
  if(root===target&&!installed)fail('Destination appeared during download; no overwrite performed');
  await mkdir(root,{recursive:true,mode:0o700});await realDirectory(root);
  await mkdir(records,{recursive:true,mode:0o700});await realDirectory(records);
  for(const folder of row.directories){await mkdir(join(root,folder),{recursive:true,mode:0o700});await realDirectory(join(root,folder));}
  for(const [index,entry] of row.files.entries()){
   const local=join(root,remotePath(entry.path));await realDirectory(dirname(local));
   const value=await downloadFile(call,{...options,path:childPath(options.path,entry.path),destination:local,
    receiptPath:join(records,index+'.json'),keepReceipt:true,expectedSize:entry.size});
   if(value.bytes!==entry.size)fail('文件大小与目录列表不符：'+entry.path+'；已保留下载进度，请确认源文件未改动后重试。');
   row.bytes+=value.bytes;row.completedFiles++;await save();
   options.onProgress?.({downloadId:row.id,path:entry.path,bytes:row.bytes,totalBytes:row.totalBytes,completedFiles:row.completedFiles,files:row.files.length});
  }
  if(root!==target){if(await missing(target))fail('Destination appeared during download; no overwrite performed');row.state='FINALIZING';await save();await rename(partial,target);}
  row.state='COMPLETE';row.installed=true;await save();
  return {downloaded:target,downloadId:row.id,scope:'local-client',state:row.state,bytes:row.bytes,files:row.files.length,receipt};
 }catch(error){
  row.state='PAUSED';row.error=String(error.message??error).slice(0,1000);await save().catch(()=>{});
  error.download={...error.download,downloadId:row.id,scope:'local-client',receipt,partial,statusCommand,action:'resume-original'};
  error.message+='\n目录下载：'+row.id+'；查询：'+statusCommand+'；重新执行原 pull 命令续传。';throw error;
 }
}
