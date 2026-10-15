import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {open} from 'node:fs/promises';

const PLACEHOLDER='__GPUQ_PUBLIC_ORIGIN__';
const CLIENT_FILE=new URL('./build/gpuctl.mjs',import.meta.url);
const INSTANCE_ID=randomUUID();
export const CLIENT_DOWNLOAD_IDLE_MS=120000;

// Only public artifact downloads may be excluded from business draining.
// Authenticated GETs (including file bytes) remain business requests.
export function isClientDownload(req){
  return ['GET','HEAD'].includes(req.method)&&req.url.split('?')[0]==='/gpuctl.mjs';
}

export function watchClientDownload(res,{idleTimeout=CLIENT_DOWNLOAD_IDLE_MS,onIdle=()=>{}}={}){
  const socket=res.socket,startBytes=socket.bytesWritten;
  let written=startBytes,lastProgress=performance.now(),timer,closed=false;
  const state=()=>{
    const now=performance.now(),bytes=socket.bytesWritten;
    if(bytes!==written){written=bytes;lastProgress=now;}
    const idleMs=Math.max(0,Math.floor(now-lastProgress));
    return {bytesWritten:Math.max(0,written-startBytes),idleMs,stalled:idleMs>=idleTimeout};
  };
  const close=()=>{closed=true;clearTimeout(timer);res.removeListener('finish',close);res.removeListener('close',close);};
  const check=()=>{
    if(closed)return;
    const {idleMs,stalled}=state();
    if(stalled){close();onIdle();res.destroy();return;}
    timer=setTimeout(check,Math.min(1000,idleTimeout-idleMs));timer.unref();
  };
  res.once('finish',close);res.once('close',close);check();
  return {state,close};
}

const unavailable=error=>error.code==='ENOENT'
  ?Object.assign(Error('Standalone client is not built; run npm run build:client before starting the portal.'),{status:503})
  :error;

// Byte replacement keeps binary payloads bounded even when a JSON literal
// crosses a read boundary. Readable.from supplies response backpressure and
// closes the underlying file iterator when a download is disconnected.
export function standaloneClientStream(origin=PLACEHOLDER,{file=CLIENT_FILE,chunkBytes=65536}={}){
  const literal=Buffer.from(JSON.stringify(PLACEHOLDER));
  const replacement=Buffer.from(JSON.stringify(origin));
  async function* rendered(){
    let tail=Buffer.alloc(0),found=false;
    try{
      for await(const chunk of createReadStream(file,{highWaterMark:chunkBytes})){
        const data=tail.length?Buffer.concat([tail,chunk]):chunk;
        let at=0,index;
        while((index=data.indexOf(literal,at))!==-1){
          found=true;
          if(index>at)yield data.subarray(at,index);
          yield replacement;
          at=index+literal.length;
        }
        const end=Math.max(at,data.length-literal.length+1);
        if(end>at)yield data.subarray(at,end);
        tail=data.subarray(end);
      }
      if(!found)throw Error('Built client is missing its public origin placeholder');
      if(tail.length)yield tail;
    }catch(error){throw unavailable(error);}
  }
  return Readable.from(rendered(),{objectMode:false,highWaterMark:65536});
}

export async function standaloneClientInfo(origin=PLACEHOLDER,{file=CLIENT_FILE}={}){
  let handle;
  try{
    handle=await open(file,'r');const {size}=await handle.stat(),tail=Buffer.alloc(Math.min(size,4096));
    await handle.read(tail,0,tail.length,size-tail.length);
    const footer=/\n\/\/ STARGATE_BUILD_INFO (.+)\n$/.exec(tail.toString('utf8'));
    if(!footer)throw Object.assign(Error('Standalone client build info is missing; run npm run build:client.'),{status:503});
    const metadata=JSON.parse(footer[1]),bytes=size+metadata.originSlots*(Buffer.byteLength(JSON.stringify(origin))-Buffer.byteLength(JSON.stringify(PLACEHOLDER)));
    return {etag:encodeURIComponent(metadata.revision||INSTANCE_ID),bytes};
  }catch(error){throw unavailable(error);}finally{await handle?.close();}
}

// Offsets refer to the rendered, uncompressed artifact, including the origin
// replacement. Closing the range closes the underlying bounded file iterator.
export function standaloneClientRangeStream(origin,{start=0,end,...options}={}){
  async function* ranged(){
    let offset=0;
    for await(const chunk of standaloneClientStream(origin,options)){
      const next=offset+chunk.length;
      if(next>start){
        const from=Math.max(0,start-offset),to=end===undefined?chunk.length:Math.min(chunk.length,end-offset+1);
        if(to>from)yield chunk.subarray(from,to);
      }
      offset=next;
      if(end!==undefined&&offset>end)return;
    }
  }
  return Readable.from(ranged(),{objectMode:false,highWaterMark:65536});
}

export function clientByteRange(value,total){
  const match=/^bytes=(\d*)-(\d*)$/.exec(value||'');
  if(!match||!match[1]&&!match[2])return null;
  let start,end;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,total-suffix);end=total-1;}
  else {start=Number(match[1]);end=match[2]?Number(match[2]):total-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=total||end<start)return null;
  return {start,end:Math.min(end,total-1)};
}
