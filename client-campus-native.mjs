import {spawn} from 'node:child_process';
import {access,readFile,readdir,mkdir,writeFile,rename,chmod,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveCampusNativeRuntime,prepareWindowsNativeFolder} from './client-campus-native-runtime.mjs';
export {resolveCampusNativeRuntime} from './client-campus-native-runtime.mjs';

const CONTROL_CHUNK=1024**2,MAX=16*CONTROL_CHUNK,HEADER=65536,HASH=/^[a-f0-9]{64}$/;
// The separate native builder supplies this esbuild define. No network fetch,
// installed Go/curl dependency, privilege request or platform fallback exists.
const EMBEDDED=typeof STARGATE_CAMPUS_NATIVE_BUNDLE==='undefined'?null:STARGATE_CAMPUS_NATIVE_BUNDLE;
function rejectionDetails(value,privateValues=[]){
  const safe=(text,limit)=>typeof text==='string'&&Buffer.byteLength(text)<=limit&&!/[\p{Cc}\p{Cf}{}]/u.test(text)
    &&!/(?:bearer |private key)/i.test(text)&&!privateValues.some(secret=>secret?.length>=8&&text.toLowerCase().includes(secret.toLowerCase()))?text.trim():undefined;
  const reasonCode=safe(value.reasonCode,64),nodeError=safe(value.error,512);
  return {...(reasonCode&&/^[A-Za-z0-9_-]{1,64}$/.test(reasonCode)?{reasonCode}:{}),...(nodeError?{nodeError}:{})};
}
const failed=(code,status,writeMayHaveReachedPeer=false,details={})=>{
  const suffix=code==='HTTP_REJECTED'?[Number.isInteger(status)&&status>=100&&status<=599?`HTTP ${status}`:undefined,
    details.reasonCode&&`reasonCode=${details.reasonCode}`,details.nodeError&&`error=${details.nodeError}`].filter(Boolean).join('; '):'';
  return Object.assign(Error(`连接中断（${code}${suffix?'; '+suffix:''}），原 key 和偏移已保留。`),{code,status,writeMayHaveReachedPeer,...details});
};
const writing=op=>['put','control'].includes(op);
// Releasing an agent must not replace its operation result. Cached helpers
// persist across CLI processes; only old versions are removed on first write.
const cleanupTemporaryHelper=async(cleanup,timeoutMs=2000)=>{
  try{await bounded(Promise.resolve().then(cleanup),timeoutMs,'NATIVE_CLEANUP_UNCONFIRMED');}
  catch{/* Temporary-file cleanup must not replace the operation result. */}
};
export async function extractCampusNative(artifacts=EMBEDDED,{platform,arch=process.arch,resolveRuntime=resolveCampusNativeRuntime,prepareWindows=prepareWindowsNativeFolder,directory=tmpdir(),remove=rm}={}){
  const runtime=await resolveRuntime({...(platform?{platform}:{}),arch});
  for(let attempt=0;;attempt++){
    let windowsFolder;if(runtime.platform==='windows')windowsFolder=await prepareWindows(runtime);
    platform=runtime.platform;arch=windowsFolder?.arch||runtime.arch;
    if(!['linux','darwin','windows'].includes(platform)||!['x64','arm64'].includes(arch))throw failed('PLATFORM_UNSUPPORTED');
    if(artifacts==null&&arguments[0]===undefined){
      // Source CLI uses the native build input; the installed client embeds it.
      const path=new URL('./build/campus-native/embedded-artifacts.private.json',import.meta.url);
      try{artifacts=JSON.parse(await readFile(path,'utf8'));}catch{throw failed('SOURCE_NATIVE_BUILD_REQUIRED');}
    }
    try{
      const temporary=windowsFolder?.folder||directory,root=join(temporary,platform==='windows'?'stargate-campus':`stargate-campus-${process.getuid?.()??'user'}`);
      const version=encodeURIComponent(artifacts?.version).replace(/^\.+$/,'_'),folder=join(root,version),path=join(folder,platform==='windows'?'campus-http.exe':'campus-http');
      const binary={path,cleanup:async()=>{},platform,interop:runtime.interop};
      try{await access(path);return binary;}catch(error){if(error.code!=='ENOENT')throw error;}
      const item=artifacts?.artifacts?.[`${platform}-${arch}`];
      if(!item)throw failed('NATIVE_NOT_BUNDLED');
      await mkdir(folder,{recursive:true,mode:0o700});const pending=path+'.'+randomUUID()+'.tmp';
      try{
        await writeFile(pending,Buffer.from(item.base64,'base64'),{flag:'wx',mode:0o700});
        if(platform!=='windows'||runtime.interop)await chmod(pending,0o700);
        try{await rename(pending,path);}catch(error){try{await access(path);}catch{throw error;}}
      }finally{await remove(pending,{force:true}).catch(()=>{});}
      const versions=await readdir(root,{withFileTypes:true}).catch(()=>[]),legacy=await readdir(temporary,{withFileTypes:true}).catch(()=>[]);
      const retired=[...versions.filter(entry=>entry.isDirectory()&&entry.name!==version).map(entry=>join(root,entry.name)),
        ...legacy.filter(entry=>entry.isDirectory()&&/^stargate-campus-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entry.name)).map(entry=>join(temporary,entry.name))];
      await Promise.all(retired.map(path=>remove(path,{recursive:true,force:true}).catch(()=>{})));
      return binary;
    }catch(error){
      if(!windowsFolder?.invalidate)throw error;
      await windowsFolder.invalidate();if(attempt)throw error;
    }
  }
}

const bounded=(promise,timeoutMs,code)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(failed(code)),timeoutMs);
  Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});
// Share bootstrap work within a process. Agents keep separate pipes, grants,
// sockets and request queues; releasing them leaves the cached helper in place.
export function createSharedNativeExtractor(extract=extractCampusNative){
  const active=new Map();
  return async(artifacts,options)=>{
    let entry=active.get(artifacts);
    if(!entry){entry={users:0,promise:Promise.resolve().then(()=>extract(artifacts,options))};active.set(artifacts,entry);}
    entry.users++;
    let binary;
    try{binary=await entry.promise;}catch(error){entry.users--;if(active.get(artifacts)===entry)active.delete(artifacts);throw error;}
    let released=false;
    return {...binary,async cleanup(){
      if(released)return;released=true;
      if(--entry.users===0){if(active.get(artifacts)===entry)active.delete(artifacts);await binary.cleanup();}
    }};
  };
}
const extractSharedNative=createSharedNativeExtractor();
export function createCampusNativeAgent(pin,{artifacts=EMBEDDED??undefined,spawnProcess=spawn,extract=extractSharedNative,timeoutMs=35000,shutdownTimeoutMs=2000,admissionRetryBudgetMs=120000,control=false}={}){
  if(control?pin!==undefined:!HASH.test(pin||''))throw failed('INVALID_PIN');
  if(!Number.isSafeInteger(shutdownTimeoutMs)||shutdownTimeoutMs<10||shutdownTimeoutMs>5000)throw failed('INVALID_SHUTDOWN_BOUND');
  if(!Number.isSafeInteger(admissionRetryBudgetMs)||admissionRetryBudgetMs<1||admissionRetryBudgetMs>120000)throw failed('INVALID_RETRY_BOUND');
  let child,binary,starting,closed=false,stopped=false,firstFailure,pending,buffer=Buffer.alloc(0),frameLength=0,received=0,frameValue,queue=Promise.resolve(),cleanup,exitDone=Promise.resolve(),closing,killTimer,killStarted=false;
  let admissionWait;
  const cleanupOwn=()=>cleanup??=cleanupTemporaryHelper(()=>binary?.cleanup(),shutdownTimeoutMs);
  const stop=error=>{
    firstFailure??=error;
    stopped=true;if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null;}
    if(admissionWait){clearTimeout(admissionWait.timer);admissionWait.reject(error);admissionWait=null;}
    if(child&&!killStarted){killStarted=true;child.stdin.end();
      killTimer=setTimeout(()=>child.kill('SIGKILL'),Math.floor(shutdownTimeoutMs/2));killTimer.unref?.();}
  };
  const start=()=>starting??=(async()=>{
    binary=await extract(artifacts);if(closed){await cleanupOwn();throw failed('CLOSED');}
    // Ticket/body never enter argv, environment, stderr, telemetry or files.
    child=spawnProcess(binary.path,[],{stdio:['pipe','pipe','pipe'],env:{}});
    exitDone=new Promise(resolve=>child.once('close',()=>{clearTimeout(killTimer);cleanupOwn().catch(()=>{});resolve();}));
    child.stdin.on('error',()=>stop(failed('ACK_UNCONFIRMED',undefined,writing(pending?.op))));
    child.stdout.on('error',()=>stop(failed('NATIVE_FRAME_INVALID',undefined,writing(pending?.op))));
    child.stderr.on('data',()=>stop(failed('NATIVE_DIAGNOSTIC_REJECTED',undefined,writing(pending?.op))));
    child.on('error',()=>stop(failed('NATIVE_START_FAILED')));
    child.on('exit',()=>{if(!closed)stop(failed('NATIVE_EXITED',undefined,writing(pending?.op)));});
    child.stdout.on('data',part=>{
      if(stopped)return;
      if(!pending||(frameLength?received:buffer.length)+part.length>pending.responseLimit+HEADER+4)return stop(failed('NATIVE_FRAME_INVALID',undefined,writing(pending?.op)));
      if(frameLength){
        if(received+part.length>frameLength)return stop(failed('NATIVE_FRAME_INVALID',undefined,writing(pending?.op)));
        part.copy(buffer,received);received+=part.length;
      }else{
        buffer=Buffer.concat([buffer,part]);if(buffer.length<4)return;const n=buffer.readUInt32BE(0);
        if(n<1||n>HEADER)return stop(failed('NATIVE_FRAME_INVALID',undefined,writing(pending?.op)));if(buffer.length<4+n)return;
        try{frameValue=JSON.parse(buffer.subarray(4,4+n).toString());}catch{return stop(failed('NATIVE_FRAME_INVALID',undefined,writing(pending?.op)));}
        if(!Number.isSafeInteger(frameValue.bodyBytes)||frameValue.bodyBytes<0||frameValue.bodyBytes>pending.responseLimit)return stop(failed('NATIVE_FRAME_INVALID',undefined,writing(pending?.op)));
        frameLength=4+n+frameValue.bodyBytes;received=buffer.length;
        if(received>frameLength)return stop(failed('NATIVE_FRAME_INVALID',undefined,writing(pending?.op)));
        const allocated=Buffer.allocUnsafe(frameLength);buffer.copy(allocated);buffer=allocated;
      }
      if(received<frameLength)return;
      const n=buffer.readUInt32BE(0),value=frameValue,raw=buffer.subarray(4+n,frameLength),entry=pending;
      buffer=Buffer.alloc(0);frameLength=0;received=0;frameValue=undefined;pending=null;clearTimeout(entry.timer);
      if(!value.ok){const code=typeof value.code==='string'&&/^[A-Z_]{1,64}$/.test(value.code)?value.code:'NATIVE_REJECTED';
        const busy=!control&&code==='HTTP_REJECTED'&&value.status===429;
        const retryAfterMs=Number.isSafeInteger(value.retryAfterMs)&&value.retryAfterMs>=1&&value.retryAfterMs<=120000?value.retryAfterMs:1000;
        const error=failed(code,value.status,value.writeMayHaveReachedPeer===true,{...(code==='HTTP_REJECTED'?rejectionDetails(value,entry.privateValues):{}),
          ...(busy?{admissionRejected:true,retryAfterMs}:{})});
        entry.reject(error);if(!busy)stop(error);return;}
      entry.resolve({value,raw});
    });
  })();
  const request=(header,bytes=Buffer.alloc(0))=>{
    const work=queue.then(async()=>{
      if(closed||stopped)throw firstFailure??failed('SESSION_STOPPED');await start();if(closed||stopped)throw firstFailure??failed('SESSION_STOPPED');
      if(control?header.op!=='control':header.op==='control')throw failed('INVALID_FRAME');
      const personal=['get','put'].includes(header.op);
      const chunkBytes=personal?header.grant.chunkBytes:CONTROL_CHUNK;
      if(![CONTROL_CHUNK,MAX].includes(chunkBytes)||!Buffer.isBuffer(bytes)||bytes.length>chunkBytes)throw failed('INVALID_CHUNK');
      // Snapshot scope/UUID/offset once. Only a verified, explicit admission
      // refusal may repeat these exact bytes; unknown ACKs never reach here.
      const fixed=JSON.parse(JSON.stringify({...header,bodyBytes:bytes.length}));
      let retries=0,deadline;
      for(;;){
      if(closed||stopped)throw firstFailure??failed('SESSION_STOPPED');
      const meta=Buffer.from(JSON.stringify(fixed));if(meta.length>16384)throw failed('INVALID_FRAME');
      const size=Buffer.alloc(4);size.writeUInt32BE(meta.length);
      try{return await new Promise((resolve,reject)=>{
        const bound=Math.min(timeoutMs,deadline===undefined?Infinity:Math.max(1,deadline-Date.now()));
        const timer=setTimeout(()=>stop(failed('ACK_UNCONFIRMED',undefined,writing(header.op))),bound);timer.unref?.();pending={op:header.op,responseLimit:control?64*CONTROL_CHUNK:personal&&header.op==='get'?chunkBytes:CONTROL_CHUNK,resolve,reject,timer,
          privateValues:[header.grant?.ticket,header.grant?.grantId,header.uploadId,...(header.grant?.ticket||'').split('.')]};
        // Exactly one write; failures are reconciled by the existing journal.
        child.stdin.write(Buffer.concat([size,meta,bytes]),error=>{if(error)stop(failed('ACK_UNCONFIRMED',undefined,writing(header.op)));});
      });}catch(error){
        if(error.admissionRejected!==true)throw error;
        deadline??=Date.now()+admissionRetryBudgetMs;
        if(++retries>8||Date.now()+error.retryAfterMs>=deadline){stop(error);throw error;}
        await new Promise((resolve,reject)=>{admissionWait={reject,timer:setTimeout(()=>{admissionWait=null;resolve();},error.retryAfterMs)};});
      }
      }
    });queue=work.catch(()=>{});return work;
  };
  return {pin,request,destroy(){return closing??=(async()=>{
    closed=true;stop(failed('CLOSED'));
    if(starting)await bounded(starting.catch(()=>{}),shutdownTimeoutMs,'NATIVE_START_EXIT_UNCONFIRMED');
    if(binary&&!child)cleanupOwn();
    await bounded(exitDone,shutdownTimeoutMs,'NATIVE_EXIT_UNCONFIRMED');
    if(cleanup)await cleanup;
  })();}};
}

// Signature matches personalFileRequest; use this together with the factory
// above in createPersonalFileTransport. Original UUID/offset recovery
// stays in that caller. Closing the transport destroys its one native process.
export async function campusNativePersonalFileRequest(grant,agent,action,args){
  if(!agent||!['get','put'].includes(action)||!Number.isSafeInteger(args?.offset)||args.offset<0)throw failed('INVALID_REQUEST');
  if(![CONTROL_CHUNK,MAX].includes(grant.chunkBytes)||grant.chunkBytes===MAX&&grant.maxChunkBytes!==MAX)throw failed('INVALID_GRANT');
  if(action==='put'&&(typeof args.final!=='boolean'||!Buffer.isBuffer(args.bytes)||args.bytes.length>grant.chunkBytes))throw failed('INVALID_CHUNK');
  const fields=['endpoint','certificateSha256','grantId','ticket','chunkBytes'];
  const wire=Object.fromEntries(fields.map(key=>[key,grant[key]]));
  if(grant.maxChunkBytes!==undefined)wire.maxChunkBytes=grant.maxChunkBytes;
  if(action==='get')wire.file={size:grant.file?.size};
  const {value,raw}=await agent.request({op:action,...(args.dialEndpoint?{dialEndpoint:args.dialEndpoint}:{}),grant:wire,offset:args.offset,...(action==='put'?{final:args.final}:{})},action==='put'?args.bytes:Buffer.alloc(0));
  if(action==='put'){if(raw.length||!value.result||typeof value.result!=='object')throw failed('NATIVE_RECEIPT_INVALID');return value.result;}
  return {...value.metadata,data:raw.toString('base64')};
}
export function campusNativeTransportOptions(options={}){
  return {agentFactory:pin=>createCampusNativeAgent(pin,options),send:campusNativePersonalFileRequest};
}
