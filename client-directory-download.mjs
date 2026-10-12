import {mkdir,lstat,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,posix} from 'node:path';
import {downloadFile} from './client-file-download.mjs';

const fail=message=>{throw Error(message);};
const safeName=name=>typeof name==='string'&&name.length>0&&!['.','..'].includes(name)&&!/[\\/\x00-\x1f\x7f]/.test(name);
async function list(call,options,path){
 const entries=[],seen=new Set();let cursor,listing,total;
 do{
  const page=(await call('files.list',{machine:options.machine,...options.context,path,limit:1000,...(cursor?{cursor}:{})})).result;
  if(page?.protocol!==1||page.path!==path||!Array.isArray(page.entries)||!Number.isSafeInteger(page.total)||page.total<0||page.returned!==page.entries.length
   ||typeof page.hasMore!=='boolean'||! /^[a-f0-9]{64}$/.test(page.listingSha256||''))fail('Directory listing is incomplete; no truncated listing was accepted');
  listing??=page.listingSha256;total??=page.total;
  if(listing!==page.listingSha256||total!==page.total)fail('Directory changed while listing; original downloads preserved');
  for(const entry of page.entries){if(!safeName(entry.name)||seen.has(entry.name)||!['file','directory','unsupported'].includes(entry.type))fail('Invalid directory entry');seen.add(entry.name);entries.push(entry);}
  if(page.hasMore){if(typeof page.nextCursor!=='string'||!page.nextCursor||page.nextCursor===cursor||!page.entries.length)fail('Incomplete directory pagination');cursor=page.nextCursor;}
  else cursor=null;
 }while(cursor);
 if(entries.length!==total)fail('Directory listing count mismatch');
 return entries;
}
async function ensureDirectory(path){
 try{await mkdir(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 if(!(await lstat(path)).isDirectory())fail('Download destination is not a real directory');
}

// Direct recursive reads, not a frozen snapshot. Every file keeps its existing
// fingerprint-bound receipt, including successful files, so rerunning resumes.
export async function downloadPath(call,options){
 const path=options.path;
 if(typeof path!=='string'||path!=='.'&&path.split('/').some(part=>!safeName(part)))fail('Use a relative file or directory path');
 if(path!=='.'){
  const parent=posix.dirname(path),name=posix.basename(path),entry=(await list(call,options,parent)).find(row=>row.name===name);
  if(!entry)fail('Download source does not exist');
  if(entry.type==='file')return downloadFile(call,options);
  if(entry.type!=='directory')fail('Only regular files and directories can be downloaded');
 }
 const destination=resolve(options.destination),receipt=join(destination,'.gpuctl-directory.json');
 const identity={protocol:1,origin:options.origin,userId:options.userId,machine:options.machine,context:options.context||{},path};
 try{
  await mkdir(destination,{mode:0o700});
  await writeFile(receipt,JSON.stringify(identity),{flag:'wx',mode:0o600});
 }catch(error){
  if(error.code!=='EEXIST')throw error;
  if(!(await lstat(destination)).isDirectory()||!(await lstat(receipt)).isFile()||(await lstat(receipt)).isSymbolicLink())fail('Directory download identity is missing or unsafe');
  if(JSON.stringify(JSON.parse(await readFile(receipt,'utf8')))!==JSON.stringify(identity))fail('Directory download belongs to another source or account');
 }
 let files=0,bytes=0;
 const walk=async(remote,local)=>{
  const entries=await list(call,options,remote);
  for(const entry of entries){
   if(entry.name==='.gpuctl-directory.json'||entry.name.endsWith('.gpuctl-download.json'))fail('Source uses a reserved download receipt name');
   if(entry.type==='unsupported')fail('Unsupported source entry; original downloads preserved');
   const nextRemote=remote==='.'?entry.name:remote+'/'+entry.name,nextLocal=join(local,entry.name);
   if(entry.type==='directory'){await ensureDirectory(nextLocal);await walk(nextRemote,nextLocal);}
   else{const value=await downloadFile(call,{...options,path:nextRemote,destination:nextLocal,retainReceipt:true});files++;bytes+=value.bytes;}
  }
 };
 await walk(path,destination);
 return {downloaded:options.destination,files,bytes,snapshot:false,resume:'Repeat the same command; keep .gpuctl download receipts'};
}
