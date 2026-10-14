import {spawn} from 'node:child_process';
import {mkdtemp,open,chmod,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {constants as fsConstants} from 'node:fs';
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
  return Object.assign(Error(`Campus physical transport stopped (${code}${suffix?'; '+suffix:''}); keep the original operation identity; no VPS or Tail fallback`),{code,status,writeMayHaveReachedPeer,...details});
};
const writing=op=>['put','control'].includes(op);
const warnNativeCleanup=error=>{
  const code=typeof error?.code==='string'&&/^[A-Z_0-9]{1,64}$/.test(error.code)?error.code:'NATIVE_CLEANUP_UNCONFIRMED';
  process.stderr.write(`Warning: campus helper temporary-file cleanup failed (${code}); original result unchanged.\n`);
};
// A private temporary-file failure must not replace a business result. Process
// exit is still checked separately, and the folder identity guard stays intact.
const cleanupTemporaryHelper=async(cleanup,warn,timeoutMs=2000)=>{
  try{await bounded(Promise.resolve().then(cleanup),timeoutMs,'NATIVE_CLEANUP_UNCONFIRMED');}
  catch(error){try{warn(error);}catch{/* A closed stderr must not change the result either. */}}
};
export async function extractCampusNative(artifacts=EMBEDDED,{platform,arch=process.arch,resolveRuntime=resolveCampusNativeRuntime,prepareWindows=prepareWindowsNativeFolder,warn=warnNativeCleanup}={}){
  const runtime=await resolveRuntime({...(platform?{platform}:{}),arch});
  let windowsFolder;if(runtime.platform==='windows')windowsFolder=await prepareWindows(runtime);
  platform=runtime.platform;arch=windowsFolder?.arch||runtime.arch;
  const cleanupWindows=()=>cleanupTemporaryHelper(()=>windowsFolder?.cleanup(),warn);
  if(!['linux','windows'].includes(platform)||!['x64','arm64'].includes(arch)){await cleanupWindows();throw failed('PLATFORM_UNSUPPORTED');}
  if(artifacts==null&&arguments[0]===undefined){
    // Source CLI uses the same verified output as npm run build:client.
    // npm run cli runs that build first; an installed one-file client embeds it.
    const path=new URL('./build/campus-native/embedded-artifacts.private.json',import.meta.url);
    let fd;
    try{fd=await open(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);const info=await fd.stat();
      if(!info.isFile()||info.nlink!==1||info.size>64*1024**2||(info.mode&0o022)||process.getuid&&![0,process.getuid()].includes(info.uid))throw Error();
      artifacts=JSON.parse(await fd.readFile('utf8'));
    }catch{await cleanupWindows();throw failed('SOURCE_NATIVE_BUILD_REQUIRED');}finally{await fd?.close();}
  }
  const item=artifacts?.schema===1&&artifacts.protocol==='campus-native-https-v1'?artifacts.artifacts?.[`${platform}-${arch}`]:null;
  if(!item||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>20*1024**2||typeof item.base64!=='string'){await cleanupWindows();throw failed('NATIVE_NOT_BUNDLED');}
  if(item.base64.length>28*1024**2){await cleanupWindows();throw failed('NATIVE_ARTIFACT_INVALID');}
  const bytes=Buffer.from(item.base64,'base64');
  if(bytes.length!==item.bytes){await cleanupWindows();throw failed('NATIVE_ARTIFACT_INVALID');}
  const folder=windowsFolder?.folder||await mkdtemp(join(tmpdir(),'stargate-campus-'));if(!windowsFolder)await chmod(folder,0o700);const path=join(folder,windowsFolder?'campus-http.exe':'campus-http');
  const cleanup=windowsFolder?.cleanup||(()=>rm(folder,{recursive:true,force:true}));
  try{
    const fd=await open(path,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
    if(!windowsFolder||runtime.interop)await chmod(path,0o700);const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||!windowsFolder&&((info.mode&0o7777)!==0o700||process.getuid&&info.uid!==process.getuid()))throw failed('NATIVE_ARTIFACT_INVALID');
    return {path,cleanup,platform:runtime.platform,interop:runtime.interop};
  }catch(error){await cleanupTemporaryHelper(cleanup,warn);throw error;}
}

const bounded=(promise,timeoutMs,code)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(failed(code)),timeoutMs);
  Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});
// One verified executable per artifact in this CLI process. Agents retain
// separate pipes, grants, sockets and request queues; the last one removes it.
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
export function createCampusNativeAgent(pin,{artifacts=EMBEDDED??undefined,spawnProcess=spawn,extract=extractSharedNative,timeoutMs=35000,shutdownTimeoutMs=2000,admissionRetryBudgetMs=120000,control=false,warn=warnNativeCleanup}={}){
  if(control?pin!==undefined:!HASH.test(pin||''))throw failed('INVALID_PIN');
  if(!Number.isSafeInteger(shutdownTimeoutMs)||shutdownTimeoutMs<10||shutdownTimeoutMs>5000)throw failed('INVALID_SHUTDOWN_BOUND');
  if(!Number.isSafeInteger(admissionRetryBudgetMs)||admissionRetryBudgetMs<1||admissionRetryBudgetMs>120000)throw failed('INVALID_RETRY_BOUND');
  let child,binary,starting,closed=false,stopped=false,seq=0,pending,buffer=Buffer.alloc(0),frameLength=0,received=0,frameValue,queue=Promise.resolve(),cleanup,exitDone=Promise.resolve(),closing,killTimer,killStarted=false;
  let admissionWait;
  const cleanupOwn=()=>cleanup??=cleanupTemporaryHelper(()=>binary?.cleanup(),warn,shutdownTimeoutMs);
  const stop=error=>{
    stopped=true;if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null;}
    if(admissionWait){clearTimeout(admissionWait.timer);admissionWait.reject(error);admissionWait=null;}
    if(child&&!killStarted){killStarted=true;child.stdin.destroy();child.kill('SIGTERM');
      killTimer=setTimeout(()=>child.kill('SIGKILL'),Math.floor(shutdownTimeoutMs/2));killTimer.unref?.();}
  };
  const start=()=>starting??=(async()=>{
    binary=await extract(artifacts,{warn});if(closed){await cleanupOwn();throw failed('CLOSED');}
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
        entry.reject(failed(code,value.status,value.writeMayHaveReachedPeer===true,{...(code==='HTTP_REJECTED'?rejectionDetails(value,entry.privateValues):{}),
          ...(busy?{admissionRejected:true,retryAfterMs}:{})}));
        if(!busy)stop(failed('SESSION_STOPPED'));return;}
      entry.resolve({value,raw});
    });
  })();
  const request=(header,bytes=Buffer.alloc(0))=>{
    const work=queue.then(async()=>{
      if(closed||stopped)throw failed('SESSION_STOPPED');await start();if(closed||stopped)throw failed('SESSION_STOPPED');
      if(control?header.op!=='control':header.op==='control')throw failed('INVALID_FRAME');
      const personal=['get','put'].includes(header.op);
      const chunkBytes=personal?header.grant.chunkBytes:CONTROL_CHUNK;
      if(![CONTROL_CHUNK,MAX].includes(chunkBytes)||!Buffer.isBuffer(bytes)||bytes.length>chunkBytes)throw failed('INVALID_CHUNK');
      // Snapshot scope/UUID/offset once. Only a verified, explicit admission
      // refusal may repeat these exact bytes; unknown ACKs never reach here.
      const fixed=JSON.parse(JSON.stringify({...header,schema:1,bodyBytes:bytes.length}));
      let retries=0,deadline;
      for(;;){
      if(closed||stopped)throw failed('SESSION_STOPPED');const id=++seq;
      const meta=Buffer.from(JSON.stringify({...fixed,seq:id}));if(meta.length>16384)throw failed('INVALID_FRAME');
      const size=Buffer.alloc(4);size.writeUInt32BE(meta.length);
      try{return await new Promise((resolve,reject)=>{
        const bound=Math.min(timeoutMs,deadline===undefined?Infinity:Math.max(1,deadline-Date.now()));
        const timer=setTimeout(()=>stop(failed('ACK_UNCONFIRMED',undefined,writing(header.op))),bound);timer.unref?.();pending={seq:id,op:header.op,responseLimit:control?64*CONTROL_CHUNK:personal&&header.op==='get'?chunkBytes:CONTROL_CHUNK,resolve,reject,timer,
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
  if(!agent||agent.pin!==grant?.certificateSha256||!['get','put'].includes(action)||!Number.isSafeInteger(args?.offset)||args.offset<0)throw failed('INVALID_REQUEST');
  if(![CONTROL_CHUNK,MAX].includes(grant.chunkBytes)||grant.chunkBytes===MAX&&grant.maxChunkBytes!==MAX)throw failed('INVALID_GRANT');
  if(action==='put'&&(typeof args.final!=='boolean'||!Buffer.isBuffer(args.bytes)||args.bytes.length>grant.chunkBytes))throw failed('INVALID_CHUNK');
  const fields=['protocol','endpoint','certificateSha256','grantId','ticket','expiresAt','chunkBytes'];
  const wire=Object.fromEntries(fields.map(key=>[key,grant[key]]));
  for(const key of ['issuedAt','ttl'])if(grant[key]!==undefined)wire[key]=grant[key];
  if(grant.maxChunkBytes!==undefined)wire.maxChunkBytes=grant.maxChunkBytes;
  // Upload status carries receipt/state fields; they are not TLS identity.
  // The original caller and opaque issued ticket retain its upload UUID.
  wire.file=action==='get'?Object.fromEntries(['protocol','path','size'].map(key=>[key,grant.file?.[key]])):{path:grant.file?.path||''};
  const {value,raw}=await agent.request({op:action,...(args.dialEndpoint?{dialEndpoint:args.dialEndpoint}:{}),grant:wire,offset:args.offset,...(action==='put'?{final:args.final}:{})},action==='put'?args.bytes:Buffer.alloc(0));
  if(action==='put'){if(raw.length||!value.result||typeof value.result!=='object')throw failed('NATIVE_RECEIPT_INVALID');return value.result;}
  const m=value.metadata;
  if(!m||m.size!==grant.file?.size||m.offset!==args.offset||raw.length>grant.chunkBytes||m.offset+raw.length>m.size)throw failed('NATIVE_RECEIPT_INVALID');
  return {...m,data:raw.toString('base64')};
}
export function campusNativeTransportOptions(options={}){
  return {agentFactory:pin=>createCampusNativeAgent(pin,options),send:campusNativePersonalFileRequest};
}
