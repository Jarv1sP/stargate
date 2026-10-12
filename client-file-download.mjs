import {open,lstat,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const HASH=/^[a-f0-9]{64}$/;
const MAX=100*1024**3,CHUNK=1024**2;
const fail=message=>{throw Error(message);};
const stamp=info=>[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs,info.mode,info.nlink].map(String);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const safe=info=>info.isFile()&&info.nlink===1n&&(process.platform==='win32'||!(Number(info.mode)&0o077));
const missing=async path=>{try{return await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}};
async function checkpoint(path,value,previous){
  const current=await missing(path);
  if(previous?!current||!same(stamp(current),previous):current)fail('Download receipt changed; partial file preserved');
  const temporary=path+'.'+randomUUID()+'.new';
  const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
  try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
  try{await rename(temporary,path);}catch(error){await unlink(temporary).catch(()=>{});throw error;}
  return stamp(await lstat(path,{bigint:true}));
}

// A partial belongs to one authenticated account and exact remote file. It is
// never adopted from a pre-existing destination without this private receipt.
export async function downloadFile(call,{machine,context={},path,destination,origin,userId,retainReceipt=false}){
  const target=resolve(destination),receiptPath=target+'.gpuctl-download.json';
  const identity={origin,userId,machine,path,project:context.project??null,area:context.area??null,runId:context.runId??null};
  let receipt,receiptStamp,file,localStamp,offset=0,fingerprint,size,resumed=false;
  const digest=createHash('sha256');
  const saved=await missing(receiptPath),local=await missing(target);
  if(saved){
    if(!safe(saved)||saved.size>8192n||!local||!safe(local))fail('Unsafe or missing download partial; files preserved');
    const record=await open(receiptPath,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      if(!same(stamp(await record.stat({bigint:true})),stamp(saved)))fail('Download receipt changed');
      receipt=JSON.parse(await record.readFile('utf8'));
      if(!same(stamp(await record.stat({bigint:true})),stamp(saved)))fail('Download receipt changed');
    }finally{await record.close();}
    if(!receipt||Object.keys(receipt).sort().join(',')!=='fingerprint,identity,localStamp,offset,protocol,sha256,size'||receipt.protocol!==2||!same(receipt.identity,identity)
      ||!HASH.test(receipt.fingerprint||'')||!HASH.test(receipt.sha256||'')||!Number.isSafeInteger(receipt.size)||receipt.size<0||receipt.size>MAX
      ||!Number.isSafeInteger(receipt.offset)||receipt.offset<0||receipt.offset>receipt.size||BigInt(receipt.offset)!==local.size||!same(receipt.localStamp,stamp(local)))
      fail('Download identity or local partial changed; files preserved');
    receiptStamp=stamp(saved);offset=receipt.offset;fingerprint=receipt.fingerprint;size=receipt.size;resumed=true;
    file=await open(target,constants.O_RDWR|(constants.O_NOFOLLOW||0));
    try{
      localStamp=stamp(await file.stat({bigint:true}));
      if(!same(localStamp,stamp(local)))fail('Download partial changed');
      const buffer=Buffer.alloc(CHUNK);
      for(let position=0;position<offset;){
        const {bytesRead}=await file.read(buffer,0,Math.min(CHUNK,offset-position),position);
        if(!bytesRead)fail('Download partial is truncated');
        digest.update(buffer.subarray(0,bytesRead));position+=bytesRead;
      }
      if(digest.copy().digest('hex')!==receipt.sha256||!same(stamp(await file.stat({bigint:true})),localStamp))fail('Download partial checksum changed');
    }catch(error){await file.close();throw error;}
  }else if(local)fail('Destination exists without a matching download receipt; it was preserved');
  try{
    for(;;){
      const value=(await call('files.get',{machine,path,offset,...context,...(fingerprint?{fingerprint}:{})})).result;
      if(!value||value.path!==path||value.offset!==offset||!Number.isSafeInteger(value.size)||value.size<0||value.size>MAX||typeof value.eof!=='boolean'
        ||typeof value.data!=='string'||value.data.length>Math.ceil(CHUNK/3)*4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))fail('Invalid download chunk; partial preserved');
      const bytes=Buffer.from(value.data,'base64');
      if(size!==undefined&&size!==value.size||offset+bytes.length>value.size||value.eof!==(offset+bytes.length===value.size)||!bytes.length&&!value.eof)fail('Download size or offset changed; partial preserved');
      if(value.protocol===2){
        if(!HASH.test(value.fingerprint||'')||fingerprint&&fingerprint!==value.fingerprint)fail('Download source changed; partial preserved');
        fingerprint=value.fingerprint;
      }else if(fingerprint)fail('Node no longer confirms the original download identity; partial preserved');
      size=value.size;
      if(!file){file=await open(target,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL,0o600);localStamp=stamp(await file.stat({bigint:true}));}
      const current=await file.stat({bigint:true});
      if(!same(stamp(current),localStamp)||!same(stamp(await lstat(target,{bigint:true})),localStamp))fail('Local download file changed; partial preserved');
      for(let written=0;written<bytes.length;){
        const result=await file.write(bytes,written,bytes.length-written,offset+written);
        if(!result.bytesWritten)fail('Local download write made no progress');
        written+=result.bytesWritten;
      }
      digest.update(bytes);offset+=bytes.length;await file.sync();
      const writtenInfo=await file.stat({bigint:true});
      if(!safe(writtenInfo))fail('Unsafe local download file; partial preserved');
      localStamp=stamp(writtenInfo);
      if(fingerprint){
        receiptStamp=await checkpoint(receiptPath,{protocol:2,identity,fingerprint,size,offset,sha256:digest.copy().digest('hex'),localStamp},receiptStamp);
      }
      if(value.eof){
        // Confirm bytes on disk, including a concurrent edit during a write.
        // A stat taken after our write alone cannot distinguish that edit.
        const verified=createHash('sha256'),buffer=Buffer.alloc(CHUNK);
        for(let position=0;position<offset;){
          const {bytesRead}=await file.read(buffer,0,Math.min(CHUNK,offset-position),position);
          if(!bytesRead)fail('Local download file is truncated; partial preserved');
          verified.update(buffer.subarray(0,bytesRead));position+=bytesRead;
        }
        if(verified.digest('hex')!==digest.copy().digest('hex')||!same(stamp(await file.stat({bigint:true})),localStamp)
          ||!same(stamp(await lstat(target,{bigint:true})),localStamp))fail('Local download checksum changed; file and receipt preserved');
        if(receiptStamp){
          if(!same(stamp(await lstat(receiptPath,{bigint:true})),receiptStamp))fail('Download receipt changed; file preserved');
          if(!retainReceipt)await unlink(receiptPath);
        }
        return {downloaded:destination,bytes:offset,sha256:digest.digest('hex'),resumed};
      }
    }
  }finally{if(file)await file.close();}
}
