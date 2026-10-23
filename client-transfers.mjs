import {lstat,open,readdir,mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,resolve,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {uploadPersonalFile,campusRetryable} from './dist/personal-upload.js';
import {createPersonalFileTransport} from './client-personal-file-campus.mjs';
import {dataPath,sameDatasetFile} from './client-file-path.mjs';
import {recoverOriginalWrite,uncertainWrite} from './client-http.mjs';
import {downloadResultFile} from './client-result-download.mjs';
import {selectTransferRoute} from './client-transfer-route.mjs';
const safe=value=>String(value??'').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>'\\u{'+c.codePointAt(0).toString(16)+'}');
export function transferText(row){const result=row.result||{},bytes=result.bytes??row.bytes??(Number.isFinite(result.totalBytes)&&Number.isFinite(result.remainingBytes)?result.totalBytes-result.remainingBytes:'?'),total=result.totalBytes??row.totalBytes;return `${safe(row.id)} · ${safe(row.kind)} · ${safe(row.from?row.from+' → '+row.machine:row.machine)} · ${safe(row.state)}\n  ${bytes} / ${total??'?'} bytes${result.path?' · '+safe(result.path):''}${row.error||result.error?'\n  '+safe(row.error||result.error):''}`;}
export async function uploadLocalFile(call,{machine,context,path,local,key=randomUUID(),transferId,via,route,initialGrant,stateDirectory,probe,notify=message=>process.stderr.write(message+'\n'),progress=()=>{},transportFactory=createPersonalFileTransport,lstatFile=lstat,openFile=open,platform=process.platform}){
  dataPath(path);const named=await lstatFile(local,{bigint:true});if(!named.isFile()||named.isSymbolicLink()||named.size>BigInt(Number.MAX_SAFE_INTEGER))throw Error('请选择普通文件，链接不会上传。');
  const file=await openFile(local,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let transport;
  const scope={machine,...context,path,key,...(transferId?{transferId}:{})};
  try{
    const info=await file.stat({bigint:true});if(!sameDatasetFile(named,info,{pathToHandle:true,platform}))throw Error('本地路径改变，原上传已保留。');
    const size=Number(info.size),automatic=via!=='direct'&&context.area!=='dataset';let selected;
    try{selected=route??await selectTransferRoute({area:context.area,via,action:'put',stateFile:stateDirectory&&join(stateDirectory,key+'.route.json'),probe,getGrant:async()=>(await call('files.direct-ticket',{...scope,action:'put',uploadId:key,totalSize:size,overwrite:true})).result});}
    catch(error){error.key=key;error.message+='\n上传编号：'+key+'；续传请沿用原编号。';throw error;}
    via=selected.via;initialGrant??=selected.grant;
    const request=async(operation,args)=>{
      const send=async()=>{
        if(operation==='data.upload.chunk'&&via!=='relay'){
          try{
            transport ||= await transportFactory(call,{machine,context,path,action:'put',initialGrant,identity:{uploadId:key,totalSize:size}});
            return {result:await transport.request({offset:args.offset,bytes:Buffer.from(args.data,'base64'),final:false})};
          }catch(error){
            if(!automatic||!campusRetryable(error))throw error;
            let row;try{row=(await call('data.upload.status',scope)).result;}catch{throw error;}
            const bytes=Buffer.from(args.data,'base64'),end=args.offset+bytes.length;
            if(!Number.isSafeInteger(row?.offset)||row.offset<args.offset||row.offset>end)throw error;
            via=selected.via='relay';await selected.save?.(via);notify('校园直连失败，改经 VPS 继续');
            if(row.offset===end)return {result:row};
            return call(operation,{...args,offset:row.offset,data:bytes.subarray(row.offset-args.offset).toString('base64')});
          }
        }
        return call(operation,args);
      };
      if(operation==='data.upload.status')return (await send()).result;
      return (await recoverOriginalWrite(send,{shouldRecover:uncertainWrite,canReplay:true,query:signal=>call('data.upload.status',scope,signal),classify:reply=>{
        const row=reply.result;
        if(row?.state==='ABSENT')return operation==='data.upload.begin'?{absent:true}:undefined;
        if(operation==='data.upload.begin')return {value:reply};
        if(operation==='data.upload.finish'){if(row?.state==='COMPLETE')return {value:reply};if(row?.offset===size)return {absent:true};}
        if(operation==='data.upload.chunk'){const next=args.offset+Buffer.from(args.data,'base64').length;if(row?.offset===next)return {value:reply};if(row?.offset===args.offset)return {absent:true};}
      },unresolved:error=>Object.assign(error,{key,message:error.message+'\n上传结果未知，请保留 --key '+key})})).result;
    };
    const result=await uploadPersonalFile({call:request,machine,...context,path,key,transferId,size,overwrite:true,chunkBytes:512*1024,...(context.area==='code'?{ownerExecutable:!!(Number(info.mode)&0o100)}:{}),read:async(offset,length)=>{const bytes=Buffer.alloc(length),part=await file.read(bytes,0,length,offset);return bytes.subarray(0,part.bytesRead);},onProgress:row=>progress({path,...row})});
    return {...result,machine,path,bytes:size};
  }finally{await file.close();await transport?.close();}
}
export async function uploadLocalTree(call,{machine,context,local,remote='.',key=randomUUID(),stateDirectory,transferId,via,probe,inspectOnly=false,progress=()=>{},uploadFile=uploadLocalFile,exclude=()=>false}){
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(key))throw Error('上传编号必须是完整 UUID。');
  const keyFile=stateDirectory?join(stateDirectory,key+'.json'):null;let keys={};
  if(keyFile)try{keys=JSON.parse(await readFile(keyFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const save=async()=>{if(!keyFile)return;await mkdir(dirname(keyFile),{recursive:true,mode:0o700});const temporary=keyFile+'.'+randomUUID()+'.new';await writeFile(temporary,JSON.stringify(keys),{mode:0o600});await rename(temporary,keyFile);};
  let count=0,bytes=0,selected;const files=[];
  const single=(await lstat(local)).isFile();
  async function visit(source,path){
    if(exclude(basename(source)))return;
    const info=await lstat(source);if(info.isSymbolicLink())throw Error('链接不会上传：'+source);
    if(info.isDirectory()){for(const name of (await readdir(source)).sort())await visit(join(source,name),path==='.'?name:path+'/'+name);return;}
    if(!info.isFile())throw Error('请选择普通文件或目录：'+source);dataPath(path);
    let result;
    if(inspectOnly){
      const originalKey=keys[path]||(single?key:null);
      result=originalKey?(await call('data.upload.status',{machine,...context,path,key:originalKey})).result:
        {key:null,state:'UNKNOWN',message:'没有该文件的原上传编号，状态未知；请使用原本地上传记录查询。'};
    }else{
      keys[path] ||= single?key:randomUUID();await save();
      selected??=await selectTransferRoute({area:context.area,via,action:'put',stateFile:stateDirectory&&join(stateDirectory,key+'.route.json'),probe,getGrant:async()=>(await call('files.direct-ticket',{machine,...context,path,action:'put',uploadId:keys[path],totalSize:info.size,overwrite:true})).result});
      result=await uploadFile(call,{machine,context,local:source,path,key:keys[path],transferId,via,route:selected,initialGrant:selected.grant,progress});
    }
    if(selected)delete selected.grant;
    files.push({path,...result});count++;bytes+=info.size;
  }
  progress({key,state:'STARTING'});try{await visit(resolve(local),remote);}catch(error){error.key=key;error.message+='\n上传编号：'+key+'；用原命令加 --key '+key+' 续传。';throw error;}
  return {machine,...context,key,uploaded:count,files,bytes,state:inspectOnly?'STATUS':'COMPLETE'};
}
export async function uploadTransfer(call,{machine,name,dataset=name,directory,key=randomUUID(),via='auto',stateDirectory,progress=()=>{}}){
  const row=(await call('transfers.create',{key,kind:'upload',machine,reference:{dataset}})).result;
  progress('HANDLE',{transferId:row.id,key});
  const result=await uploadLocalTree(call,{machine,context:{area:'dataset',dataset},local:directory,remote:'.',key,via,stateDirectory,transferId:row.id,progress:value=>progress('UPLOADING',value)});
  await call('transfers.progress',{id:row.id,bytes:result.bytes,complete:true});return {...result,transferId:row.id,state:'SUCCEEDED'};
}
export async function downloadTransfer(call,{machine,dataset,destination,path='.',key=randomUUID(),origin,userId,via,progress=()=>{}}){
  const row=(await call('transfers.create',{key,kind:'download',machine,reference:{dataset,path}})).result;progress('HANDLE',{transferId:row.id,key});
  try{const result=await downloadResultFile(call,{machine,context:{area:'dataset',dataset},path,destination,origin,userId,via,directory:path==='.',onProgress:value=>progress('DOWNLOADING',value)});await call('transfers.progress',{id:row.id,bytes:result.bytes,complete:true});return {...result,key,transferId:row.id,state:'SUCCEEDED'};}
  catch(error){error.message+='\n传输编号：'+row.id+'；重试沿用 --key '+key;throw error;}
}
