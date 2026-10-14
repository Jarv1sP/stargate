#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo '请先安装 Node.js 22.13 或更新版本，然后重试。'; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))process.exit(1)' || { echo 'Node.js 版本过旧，需要 22.13+。'; exit 1; }
mkdir -p "$HOME/.local/share/gpuq-console" "$HOME/.local/bin"
origin='__GPUQ_PUBLIC_ORIGIN__'
case "$origin" in https://*) ;; *) echo 'Download this installer from your running GPUQ portal.'; exit 1;; esac
temporary=$(mktemp "$HOME/.local/share/gpuq-console/.client.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
node --input-type=module - "$origin" "$temporary" <<'JS'
import {open,readFile,unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const [origin,destination]=process.argv.slice(2),limit=64*1024*1024;
const file=await open(destination,'w'),deadline=Date.now()+900000;
let total=0,expectedBytes=0,done=false,shown=-10,etag=null;
const networkErrors=new Set([18,28,52,55,56,92,95]);
function headers(text){
  const blocks=text.trim().split(/\r?\n\r?\n/),last=blocks.filter(s=>/^HTTP\/\S+ \d{3}/.test(s)).at(-1)||'';
  const status=Number(/^HTTP\/\S+ (\d{3})/.exec(last)?.[1]);
  const fields=Object.fromEntries(last.split(/\r?\n/).slice(1).map(line=>{const p=line.indexOf(':');return [line.slice(0,p).toLowerCase(),line.slice(p+1).trim()];}));
  return {status,...fields};
}
try{
  for(let attempt=0;attempt<8&&!done;attempt++){
    const remaining=Math.ceil((deadline-Date.now())/1000);
    if(remaining<=0)throw Error('Client download exceeded its 15-minute budget.');
    const suffix=randomUUID(),part=destination+'.part-'+suffix,head=destination+'.headers-'+suffix;
    const chunkFile=await open(part,'wx',0o600);await (await open(head,'wx',0o600)).close();
    const args=['-fsS','--proto','=https','--max-time',String(remaining),'--connect-timeout','120','--speed-time','120','--speed-limit','1','--max-filesize',String(limit),'--dump-header',head];
    if(total){args.push('--header',`Range: bytes=${total}-`,'--header','Accept-Encoding: identity');if(etag)args.push('--header',`If-Range: ${etag}`);}
    else args.push('--compressed');
    args.push(`${origin}/gpuctl.mjs`);
    const download=spawn('curl',args,{stdio:['ignore','pipe','inherit']});
    const exited=new Promise((resolve,reject)=>{download.once('error',reject);download.once('exit',(code,signal)=>resolve({code,signal}));});exited.catch(()=>{});
    let count=0;
    try{
      for await(const bytes of download.stdout){
        count+=bytes.length;if(count>limit)throw Error('Client download exceeds 64 MiB.');
        let offset=0;while(offset<bytes.length){const {bytesWritten}=await chunkFile.write(bytes,offset,bytes.length-offset);if(!bytesWritten)throw Error('Client download could not be saved.');offset+=bytesWritten;}
        if(!expectedBytes){const h=headers(await readFile(head,'utf8'));const size=Number(h['x-gpuq-client-bytes']);if(Number.isSafeInteger(size)&&size>0&&size<=limit)expectedBytes=size;}
        if(expectedBytes){const percent=Math.min(100,Math.floor(100*(total+count)/expectedBytes));if(percent>=shown+10){console.error(`Download ${percent}%`);shown=percent;}}
      }
      const {code,signal}=await exited;
      const h=headers(await readFile(head,'utf8'));
      if(h.status!==200&&h.status!==206){if(!h.status&&networkErrors.has(code))continue;throw Error(`Client download failed (HTTP ${h.status||'unknown'}); redirects are not permitted.`);}
      if(h.status===206){
        const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(h['content-range']||'');
        if(!total||!range||Number(range[1])!==total||Number(range[2])!==Number(range[3])-1||Number(range[3])>limit||Number(range[3])<=total||h['content-encoding']&&h['content-encoding']!=='identity')throw Error('Invalid client resume range or artifact identity.');
        expectedBytes=Number(range[3]);
      }else{
        etag=h.etag||null;
        if(total){if(h['content-encoding']&&h['content-encoding']!=='identity')throw Error('Server did not honor the identity resume request.');await file.truncate(0);total=0;}
        const size=Number(h['x-gpuq-client-bytes']||(!h['content-encoding']?h['content-length']:0));
        if(!Number.isSafeInteger(size)||size<0||size>limit)throw Error('Invalid client size.');expectedBytes=size;
      }
      if(total+count>limit||expectedBytes&&total+count>expectedBytes)throw Error('Client download exceeds its size limit.');
      await chunkFile.close();
      for await(const bytes of createReadStream(part)){
        let offset=0;while(offset<bytes.length){const {bytesWritten}=await file.write(bytes,offset,bytes.length-offset,total+offset);if(!bytesWritten)throw Error('Client download could not be saved.');offset+=bytesWritten;}total+=bytes.length;
      }
      done=total>0&&(expectedBytes?total===expectedBytes:code===0&&!signal);
      if(!done&&!networkErrors.has(code))throw Error('Client download failed; the previous installation is unchanged.');
      if(!done){console.error(`Connection interrupted; resume at ${total} bytes`);await new Promise(resolve=>setTimeout(resolve,500));}
    }finally{
      download.stdout.destroy();download.kill();await chunkFile.close().catch(()=>{});await Promise.all([unlink(part),unlink(head)]);
    }
  }
  if(!done)throw Error('Client download exceeded its retry budget; the previous installation is unchanged.');
  await file.sync();
}finally{await file.close();}
JS
node --input-type=module --check < "$temporary"
mv "$temporary" "$HOME/.local/share/gpuq-console/gpuctl.mjs"
chmod 700 "$HOME/.local/share/gpuq-console/gpuctl.mjs"
ln -sf "$HOME/.local/share/gpuq-console/gpuctl.mjs" "$HOME/.local/bin/gpuctl"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) case "${SHELL:-}" in */zsh) profile="$HOME/.zshrc";; *) profile="$HOME/.bashrc";; esac
     line='export PATH="$HOME/.local/bin:$PATH"'
     grep -Fqx "$line" "$profile" 2>/dev/null || printf '\n%s\n' "$line" >> "$profile"
     echo '请重新打开终端以加载 gpuctl 命令。';;
esac
echo '安装完成：gpuctl login → gpuctl state → gpuctl use 机器名 → gpuctl ssh'
