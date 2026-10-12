import {lstat as fsLstat,open as fsOpen,readdir as fsReaddir} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createDirectDatasetTransport,probeDirectUploadRoute,RELAY_LIMIT_BYTES} from './client-direct-upload.mjs';
import {selectUploadRoute,uploadStorageMachine} from './dist/upload-routes.js';
import {allocateDatasetUpload,saveDatasetUploadIntent,confirmDatasetUploadInitialization,archiveUploadCapability,archiveUploadSpecification} from './dist/dataset-upload.js';
export const DATA_CHUNK=1024*1024;
const DATA_MANIFEST_LIMIT=64*1024*1024,DATA_ENTRY_LIMIT=500000;
const fail=message=>{throw Error(message);};
export function sameDatasetFile(a,b,{pathToHandle=false,platform=process.platform}={}){
  // Older Windows libuv lstat can return dev=0 or a 64-bit serial while fstat
  // returns the low 32 bits. Allow that only when pairing a path with a handle;
  // later path/path and handle/handle checks keep the complete device value.
  // BigInt stats preserve NTFS file IDs and sub-millisecond timestamps.
  const sameDevice=a.dev===b.dev||(pathToHandle&&platform==='win32'&&(a.dev===0n||BigInt.asUintN(32,a.dev)===BigInt.asUintN(32,b.dev)));
  return sameDevice&&a.ino===b.ino&&a.mode===b.mode&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
}
export function dataPath(path){if(!path||Buffer.byteLength(path)>4096||path.startsWith('/')||/[\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(p=>['','.','..','.ssh','.env','.git','.venv','anaconda3','miniconda3','.conda'].includes(p)))fail('Unsafe, credential or environment dataset path: '+path);return path;}

export async function scanLocalDataset(root,progress,{lstat=fsLstat,open=fsOpen,readdir=fsReaddir,platform=process.platform}={}){
  const sameFile=(a,b,options={})=>sameDatasetFile(a,b,{...options,platform});
  dataPath(basename(resolve(root)));
  const directories=[],files=[],local=new Map(),directoryStamps=new Map();let totalBytes=0,manifestEstimate=42,hashed=0;
  const account=entry=>{manifestEstimate+=Buffer.byteLength(JSON.stringify(entry))+1;if(manifestEstimate>DATA_MANIFEST_LIMIT)fail('Dataset manifest exceeds 64 MiB; split it by data scope');if(directories.length+files.length>DATA_ENTRY_LIMIT)fail('Dataset manifest exceeds 500,000 entries');};
  const top=await lstat(root,{bigint:true});if(!top.isDirectory()||top.isSymbolicLink())fail('data upload requires a real local directory, not a file or symlink');
  const verifyDirectory=async(folder,{info,names},message)=>{
    if(!sameFile(info,await lstat(folder,{bigint:true})))fail(message);
    // NTFS can coalesce directory timestamps. Compare the actual namespace,
    // not just metadata; keep both stat checks around the directory read.
    const current=(await readdir(folder)).sort();
    if(current.length!==names.length||current.some((name,index)=>name!==names[index])||!sameFile(info,await lstat(folder,{bigint:true})))fail(message);
  };
  async function visit(folder,prefix=''){
    const before=await lstat(folder,{bigint:true});if(!before.isDirectory()||before.isSymbolicLink())fail('Local directory changed or is a symlink');
    const names=(await readdir(folder)).sort();directoryStamps.set(folder,{info:before,names});
    for(const name of names){
      const path=dataPath(prefix?prefix+'/'+name:name),filename=join(folder,name),info=await lstat(filename,{bigint:true});
      if(info.isSymbolicLink())fail('Symlink dataset upload is not supported: '+path);
      if(info.isDirectory()){directories.push(path);account(path);await visit(filename,path);continue;}
      if(!info.isFile()||info.nlink!==1n)fail('Only regular, single-link dataset files are supported: '+path);
      const size=Number(info.size);if(!Number.isSafeInteger(size)||!Number.isSafeInteger(totalBytes+size))fail('Dataset size exceeds safe integer range');totalBytes+=size;
      const file=await open(filename,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);let sha256,handleInfo;
      try{handleInfo=await file.stat({bigint:true});if(!handleInfo.isFile()||!sameFile(info,handleInfo,{pathToHandle:true}))fail('Local file changed before hashing: '+path);const hash=createHash('sha256'),buffer=Buffer.alloc(DATA_CHUNK);let offset=0;while(offset<size){const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,size-offset),offset);if(!bytesRead)fail('Local file changed during hashing: '+path);hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;progress('HASHING',{path,bytes:hashed+offset});}if(!sameFile(handleInfo,await file.stat({bigint:true})))fail('Local file changed during hashing: '+path);sha256=hash.digest('hex');}finally{await file.close();}
      const entry={path,size,sha256};files.push(entry);account(entry);local.set(path,{filename,info,handleDev:handleInfo.dev});hashed+=size;
    }
    await verifyDirectory(folder,directoryStamps.get(folder),'Local directory changed during scan: '+folder);
  }
  await visit(root);directories.sort();files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const manifest=Buffer.from(JSON.stringify({schema:1,directories,files}));if(manifest.length>DATA_MANIFEST_LIMIT)fail('Dataset manifest exceeds 64 MiB');
  const openEntry=async entry=>{const {filename,info,handleDev}=local.get(entry.path),handleInfo={...info,dev:handleDev},file=await open(filename,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0)|(fsConstants.O_NONBLOCK||0));if(!sameFile(handleInfo,await file.stat({bigint:true}))){await file.close();fail('Local file changed after hashing: '+entry.path);}return {
    read:async(offset,chunkBytes=DATA_CHUNK)=>{if(![DATA_CHUNK,16*DATA_CHUNK].includes(chunkBytes))fail('Invalid dataset file chunk size');const buffer=Buffer.alloc(Math.min(chunkBytes,entry.size-offset)),{bytesRead}=await file.read(buffer,0,buffer.length,offset);if(!bytesRead&&offset<entry.size)fail('Local file changed during upload: '+entry.path);return buffer.subarray(0,bytesRead);},
    verify:async()=>{if(!sameFile(handleInfo,await file.stat({bigint:true}))||!sameFile(info,await lstat(filename,{bigint:true})))fail('Local file changed during upload: '+entry.path);},close:()=>file.close()};};
  const verify=async()=>{for(const [folder,stamp] of directoryStamps)await verifyDirectory(folder,stamp,'Local directory changed; no publication was requested');for(const {filename,info} of local.values())if(!sameFile(info,await lstat(filename,{bigint:true})))fail('Local file changed; no publication was requested');};
  return {manifest,manifestSha256:createHash('sha256').update(manifest).digest('hex'),files,totalBytes,entries:files.length+directories.length,openEntry,verify};
}

export async function scanLocalArchive(filename,capability,progress=()=>{},{lstat=fsLstat,open=fsOpen,platform=process.platform}={}){
  const cap=archiveUploadCapability(capability),path=dataPath(basename(resolve(filename)));
  const lower=path.toLowerCase(),format=cap?.formats.find(value=>lower.endsWith('.'+value)||value==='tar.gz'&&lower.endsWith('.tgz'));
  if(!format)fail('服务器尚未开通此压缩包格式');
  const info=await lstat(filename,{bigint:true}),size=Number(info.size);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n)fail('请选择单个普通压缩包文件');
  if(!Number.isSafeInteger(size)||size<1||cap.maxBytes!==null&&size>cap.maxBytes)fail('压缩包过大或为空');
  const same=(a,b,options={})=>sameDatasetFile(a,b,{...options,platform});
  const file=await open(filename,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0)|(fsConstants.O_NONBLOCK||0));let handleInfo,sha256;
  try{
    handleInfo=await file.stat({bigint:true});if(!handleInfo.isFile()||!same(info,handleInfo,{pathToHandle:true}))fail('压缩包在读取前已改变');
    const hash=createHash('sha256'),buffer=Buffer.alloc(DATA_CHUNK);let offset=0;
    while(offset<size){const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,size-offset),offset);if(!bytesRead)fail('压缩包读取不完整');hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;progress('HASHING',{bytes:offset,totalBytes:size});}
    if(!same(handleInfo,await file.stat({bigint:true}))||!same(info,await lstat(filename,{bigint:true})))fail('压缩包在读取中已改变');
    sha256=hash.digest('hex');
  }finally{await file.close();}
  const archive={protocol:1,fileName:path,format,bytes:size,sha256};
  if(!archiveUploadSpecification(archive,size,1))fail('压缩包规格无效');
  const entry={path,size,sha256},manifest=Buffer.from(JSON.stringify({schema:1,directories:[],files:[entry]}));
  const verify=async()=>{if(!same(info,await lstat(filename,{bigint:true})))fail('压缩包已改变，未请求发布');};
  return {manifest,manifestSha256:createHash('sha256').update(manifest).digest('hex'),files:[entry],totalBytes:size,entries:1,archive,verify,
    openEntry:async()=>{
      await verify();const handle=await open(filename,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0)|(fsConstants.O_NONBLOCK||0));
      if(!same(handleInfo,await handle.stat({bigint:true}))){await handle.close();fail('压缩包已改变');}
      return {read:async(offset,chunkBytes=DATA_CHUNK)=>{if(![DATA_CHUNK,16*DATA_CHUNK].includes(chunkBytes))fail('Invalid dataset file chunk size');const buffer=Buffer.alloc(Math.min(chunkBytes,size-offset));const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead&&offset<size)fail('压缩包读取不完整');return buffer.subarray(0,bytesRead);},
        verify:async()=>{await verify();if(!same(handleInfo,await handle.stat({bigint:true})))fail('压缩包已改变');},close:()=>handle.close()};
    }};
}
export async function uploadLocalDataset(call,{machine,name,userId,directory,progress=()=>{},keyStore,filesystem,admission,via='auto'}){
  const info=await (filesystem?.lstat||fsLstat)(directory,{bigint:true});
  if(!info.isFile()){
    if(archiveUploadCapability(admission?.archive))fail('这台仓库只接受压缩包');
    if(!['auto','direct','relay'].includes(via))fail('Upload route must be auto, direct or relay');
    return uploadDatasetSnapshot(call,{machine,name,userId,scan:await scanLocalDataset(directory,progress,filesystem),progress,keyStore,admission,via});
  }
  if(via==='relay')fail('压缩包只走校内直连');
  const response=await call('datasets.upload.routes',{machine}),capability=archiveUploadCapability(response.result?.archive);
  const scan=await scanLocalArchive(directory,capability,progress,filesystem);
  return uploadDatasetSnapshot(call,{machine,name,userId,scan,progress,keyStore,admission:{...admission,archive:capability},via:'direct'});
}
export function snapshotKey(identity){const h=createHash('sha256').update(JSON.stringify(identity)).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
export async function uploadDatasetSnapshot(call,{machine,name,userId,scan,progress,keyStore,admission,legacyTransfer=false,via='auto',directFactory=createDirectDatasetTransport,probeRoute=probeDirectUploadRoute}){
  if(!['auto','direct','relay'].includes(via))fail('Upload route must be auto, direct or relay');
  const key=snapshotKey([userId,machine,name,scan.manifestSha256]);
  let uploadId,state,direct,route,storageMachine,uploadIntent;
  const control=async(action,args={})=>(await call('datasets.upload.'+action,{machine,...(uploadId&&action!=='begin'&&(action!=='routes'||state?.placementProtocol===1)?{uploadId}:{}),...args})).result;
  const request=async(action,args={})=>{
    if(direct&&(action==='manifest'||action==='chunk'||action==='status'&&args.path!==undefined))return direct.request(action,args);
    if(args.bytes!==undefined){const {bytes,...other}=args;return control(action,{...other,data:bytes.toString('base64')});}
    return control(action,args);
  };
  const report=value=>{if(uploadIntent&&(value?.uploadId!==uploadIntent.uploadId||value.placementProtocol!==1||value.requestedMachine!==machine||value.storageMachine!==uploadIntent.storageMachine||value.storageTier!=='hdd'||value.legacyPlacement!==false||['name','manifestBytes','totalBytes','entries'].some(field=>value[field]!==uploadIntent.specification[field])))throw Object.assign(Error('Upload session does not match the saved warehouse admission'),{code:'MISMATCH'});confirmDatasetUploadInitialization(value,uploadIntent,machine);storageMachine=uploadStorageMachine(value,machine,storageMachine);state=value;progress(scan.archive?(value.phase||value.state):value.state,value);};
  const ready=()=>{if(state.state!=='READY'||!state.dataset||!/^[a-f0-9]{64}$/.test(state.version||''))fail('Server did not confirm a complete verified dataset');return {...state,machine,...(route?{route:{kind:route}}:{})};};
  const waitFor=async()=>{while(['SEALING','PUBLISHING'].includes(state.state)){await new Promise(resolve=>setTimeout(resolve,1500));report(await request('status'));}if(state.state==='FAILED')fail(state.error||'Dataset verification failed; repeat the same upload after fixing the cause');if(state.state==='DISCARDED')fail('Upload was discarded');};
  try{
  const persistedKey=keyStore?.get?.(key),stored=keyStore?.getHandle?.(key),savedIntent=await keyStore?.getIntent?.(key);
  if(persistedKey!==undefined&&persistedKey!==null&&(typeof persistedKey!=='string'||!persistedKey))fail('Saved legacy upload key is invalid');
  if(stored&&(typeof stored.uploadId!=='string'||!stored.uploadId||stored.machine!==machine||stored.name!==name||stored.manifestSha256!==scan.manifestSha256||stored.userId!==undefined&&stored.userId!==userId))fail('Saved upload handle belongs to another account, target or manifest');
  const begin={name,key:persistedKey||key,manifestBytes:scan.manifest.length,manifestSha256:scan.manifestSha256,totalBytes:scan.totalBytes,entries:scan.entries,...(scan.archive?{archive:scan.archive}:{}),...(via==='relay'?{allowRelay:true}:{})};
  const legacy=!savedIntent&&(legacyTransfer===true||typeof persistedKey==='string'&&!!persistedKey||stored?.uploadId&&stored.admissionProtocol!==1);
  if(!legacy){
    if(stored?.admissionProtocol===1&&!savedIntent)fail('Original admission intent is missing; no new upload was allocated');
    uploadIntent=await allocateDatasetUpload({call:async(op,args)=>(await call(op,args)).result,keyStore,baseKey:key,userId,machine,specification:{name,manifestBytes:scan.manifest.length,manifestSha256:scan.manifestSha256,totalBytes:scan.totalBytes,entries:scan.entries,...(scan.archive?{archive:scan.archive}:{})},capability:admission});
    begin.key=uploadIntent.uploadId;storageMachine=uploadIntent.storageMachine;uploadId=begin.key;
    if(stored&&stored.uploadId!==begin.key)fail('Saved handle differs from the issued upload UUID');
    if(uploadIntent.beginAttempted){uploadId=begin.key;report(await request('status'));}
    else uploadIntent=await saveDatasetUploadIntent(keyStore,key,{...uploadIntent,beginAttempted:true});
  }else if(stored?.uploadId){uploadId=stored.uploadId;report(await request('status'));}
  if(!uploadIntent||!state||!['READY','PUBLISHING'].includes(state.state)){
    try{report(await request('begin',begin));}
    catch(error){if([400,401,403,404,409,422,429].includes(error.status)||['MAINTENANCE_ACTIVE','MISMATCH'].includes(error.code))throw error;uploadId=begin.key;report(await request('status'));if(state.uploadId!==uploadId)fail('Server did not confirm the original begin UUID');if(state.state!=='READY')fail('Upload initialization receipt was lost; repeat the original command to inspect the same UUID before resuming');}
  }
  if(state.state==='DISCARDED'){if(uploadIntent)fail('Upload was discarded; its issued UUID will not be silently replaced');begin.key=randomUUID();await keyStore.set(key,begin.key);report(await request('begin',begin));}
  uploadId=state.uploadId;if(typeof uploadId!=='string'||!uploadId)fail('Server did not return an upload identifier');progress('HANDLE',{uploadId,machine,...(state.placementProtocol===1?{requestedMachine:machine,storageMachine,storageTier:state.storageTier}:{})});
  await keyStore?.setHandle?.(key,{uploadId,machine,name,manifestSha256:scan.manifestSha256,totalBytes:scan.totalBytes,entries:scan.entries,...(uploadIntent?{admissionProtocol:1,userId}:{})});
    if(!['READY','PUBLISHING'].includes(state.state)){
      const advertised=state.uploadTransport;
      if(via!=='relay'&&advertised?.directAvailable===true&&advertised.protocol!=='dataset-upload-v1')
        fail('Direct upload protocol is unconfirmed; no automatic VPS fallback was attempted');
      if(via!=='relay'&&advertised?.routeSelection===true&&advertised.directAvailable!==true&&!['not-configured','disabled'].includes(advertised.reason))
        fail('Configured upload listener is unavailable; no automatic VPS fallback was attempted');
      if(via!=='relay'&&advertised?.protocol==='dataset-upload-v1'&&advertised.directAvailable===true){
        const advertisedRoutes=advertised.routeSelection===true?await control('routes'):null;
        const archiveRoutes=scan.archive&&advertisedRoutes?{...advertisedRoutes,routes:advertisedRoutes.routes.filter(route=>route.kind==='campus-direct')}:advertisedRoutes;
        const selected=archiveRoutes?await selectUploadRoute(archiveRoutes,storageMachine,probeRoute):undefined;
        const ticketArgs=selected?{routeId:selected.id}:{};
        const first=await control('direct-ticket',ticketArgs);
        if(first?.available===true){let initial=true;direct=await directFactory(async()=>{if(initial){initial=false;return first;}return control('direct-ticket',ticketArgs);},{uploadId,route:selected});route=selected?.kind||'campus-direct';}
        else fail('Direct upload authorization is unconfirmed; no relay fallback was attempted');
      }
      if(scan.archive&&(!direct||route!=='campus-direct'))fail('校内直连暂不可用；保留原上传编号');
      if(!direct){
        if(via==='direct')fail('Direct upload is unavailable on this server; use a verified campus connection or cloud import');
        const limit=Number.isSafeInteger(advertised?.relayLimitBytes)&&advertised.relayLimitBytes>0?Math.min(RELAY_LIMIT_BYTES,advertised.relayLimitBytes):RELAY_LIMIT_BYTES;
        if(scan.totalBytes>limit&&via!=='relay')fail('This upload exceeds the 256 MiB portal-relay limit. Use campus direct upload or cloud import. To explicitly use VPS bandwidth, repeat with --via relay');
        route='vps-relay';
      }
      progress('ROUTE',{kind:route,explicit:via==='relay',relayLimitBytes:RELAY_LIMIT_BYTES,...(state.placementProtocol===1?{requestedMachine:machine,storageMachine,storageTier:state.storageTier}:{})});
    }
    if(state.state==='FAILED'&&state.resumeState==='SEALING')report(await request('seal'));
    if(state.state==='FAILED'&&state.resumeState==='PUBLISHING')report(await request('commit'));
    if(state.state==='FAILED'&&['RECEIVING_MANIFEST','UPLOADING'].includes(state.resumeState))state={...state,state:state.resumeState};
    if(state.state==='RECEIVING_MANIFEST'){
      let offset=state.manifestOffset;if(!Number.isSafeInteger(offset)||offset<0||offset>scan.manifest.length)fail('Invalid manifest resume offset');
      while(offset<scan.manifest.length){const bytes=scan.manifest.subarray(offset,offset+DATA_CHUNK),result=await request('manifest',{offset,bytes});if(result.offset!==offset+bytes.length)fail('Server did not confirm the manifest chunk');offset=result.offset;progress('RECEIVING_MANIFEST',{bytes:offset,totalBytes:scan.manifest.length});}
      report(await request('seal'));
    }
    await waitFor();if(state.state==='READY')return ready();if(state.state!=='UPLOADING')fail('Upload state is unconfirmed; repeat the same command to inspect and resume');
    let transferred=0;
    for(const entry of scan.files){
      const response=await request('status',{path:entry.path}),remote=response.file;
      if(!remote||remote.path!==entry.path||remote.size!==entry.size||remote.sha256!==entry.sha256||!Number.isSafeInteger(remote.offset)||remote.offset<0||remote.offset>entry.size)fail('Server file resume metadata does not match the manifest');
      const file=await scan.openEntry(entry);
      try{
        let offset=remote.offset,preferredChunk=DATA_CHUNK;
        if(!entry.size&&!remote.complete){const result=await request('chunk',{path:entry.path,offset:0,bytes:Buffer.alloc(0)});if(result.offset!==0||result.complete!==true)fail('Server did not confirm the empty file');}
        while(offset<entry.size){
          const maximum=direct?.chunkBytes??DATA_CHUNK;if(![DATA_CHUNK,16*DATA_CHUNK].includes(maximum))fail('Invalid dataset file chunk size');
          const chunkBytes=Math.min(maximum,preferredChunk),bytes=await file.read(offset,chunkBytes);
          if(!bytes.length||bytes.length>chunkBytes)fail('Snapshot source did not return a bounded next chunk');
          const started=performance.now(),result=await request('chunk',{path:entry.path,offset,bytes});
          if(result.offset!==offset+bytes.length)fail('Server did not confirm the file chunk');
          // Start conservatively on unknown/slow links; batch only confirmed
          // fast writes. No retry or route switch follows an ambiguous ACK.
          const elapsed=performance.now()-started;
          if(bytes.length>=DATA_CHUNK&&elapsed<500)preferredChunk=16*DATA_CHUNK;
          else if(elapsed>8000)preferredChunk=DATA_CHUNK;
          offset=result.offset;progress('UPLOADING',{path:entry.path,bytes:transferred+offset,totalBytes:scan.totalBytes});
        }
        await file.verify();
      }finally{await file.close();}transferred+=entry.size;
    }
    // A directory edit or any previously uploaded file change invalidates this local snapshot.
    await scan.verify();
    report(await request('commit'));await waitFor();return ready();
  }catch(error){if(!uploadId)throw error;const cause=Object.assign(Error(`${error.message}\nUpload: ${uploadId} on ${machine}. Repeat the same data upload command to resume; check with gpuctl data upload-status ${uploadId} --machine ${machine}. Do not assume an interrupted request canceled server verification.`),{uploadId,machine});if(error.status!==undefined)cause.status=error.status;if(error.code!==undefined)cause.code=error.code;throw cause;}finally{direct?.close();}
}

export function workspaceDataPath(path,{directory=false}={}){
  if(directory&&path==='.')return path;
  if(typeof path!=='string'||!path||Buffer.byteLength(path)>1024||/[\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||Buffer.byteLength(p)>255))fail('Use a relative path inside your private /data/mine');
  return path;
}
export async function putWorkspaceData(call,machine,local,path,overwrite,{lstat=fsLstat,open=fsOpen,platform=process.platform,via='auto'}={}){
  if(!['auto','relay'].includes(via))fail('data put currently uses VPS relay; use data upload for direct directory uploads');
  const sameFile=(a,b,options={})=>sameDatasetFile(a,b,{...options,platform});
  workspaceDataPath(path);
  const before=await lstat(local,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>100n*1024n**3n)fail('data put requires one regular unlinked file, at most 100 GiB');
  if(before.size>BigInt(RELAY_LIMIT_BYTES)&&via!=='relay')fail('This file exceeds 256 MiB and data put uses VPS relay. Prefer cloud import, or explicitly repeat with --via relay');
  process.stderr.write('传输路径：VPS 中转（个人数据空间单文件上传）\n');
  const file=await open(local,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0));let offset=0,last=0;
  try{
    const initial=await file.stat({bigint:true});
    if(!sameFile(before,initial,{pathToHandle:true}))fail('Local file changed before upload');
    const size=Number(initial.size),buffer=Buffer.alloc(DATA_CHUNK);
    do{
      const {bytesRead}=await file.read(buffer,0,Math.min(DATA_CHUNK,size-offset),offset);
      if(!bytesRead&&offset<size)fail('Local file changed during upload');
      if(!sameFile(initial,await file.stat({bigint:true}))||!sameFile(before,await lstat(local,{bigint:true})))fail('Local file changed during upload; partial remote file remains, not published');
      const result=(await call('datasets.workspace.put',{machine,path,offset,data:buffer.subarray(0,bytesRead).toString('base64'),...(offset===0?{truncate:overwrite===true}:{})})).result;
      if(result?.size!==offset+bytesRead)fail('Upload result is unconfirmed; inspect the remote file before using --overwrite to restart');
      offset+=bytesRead;
      if(Date.now()-last>1000||offset===size){last=Date.now();process.stderr.write(`${path} · ${offset} / ${size} bytes\n`);}
    }while(offset<size);
    if(!sameFile(initial,await file.stat({bigint:true}))||!sameFile(before,await lstat(local,{bigint:true})))fail('Local file changed during upload; remote file was not published');
    return {machine,path:'/data/mine/'+path,bytes:offset,extracted:false,published:false};
  }finally{await file.close();}
}
export function createLocalDatasetTools(filesystem={}){return {sameDatasetFile:(a,b,options={})=>sameDatasetFile(a,b,{...options,platform:filesystem.platform||process.platform}),scanLocalDataset:(root,progress)=>scanLocalDataset(root,progress,filesystem),uploadLocalDataset:(call,options)=>uploadLocalDataset(call,{...options,filesystem}),putWorkspaceData:(call,machine,local,path,overwrite)=>putWorkspaceData(call,machine,local,path,overwrite,filesystem)};}
