import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';

async function run(program,args,options={}){
  const p=spawn(program,args,{...options,stdio:['ignore','pipe','pipe']});let out='',err='';
  p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);
  const code=await new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',resolve);});
  return {code,out,err};
}
const psQuote=s=>"'"+s.replaceAll("'","''")+"'";
const source=Buffer.from('// '+randomBytes(150000).toString('hex')+'\nconsole.log("fixture");\n');
const digest=createHash('sha256').update(source).digest('hex');

async function fixture(t,{compressed=false,wrongRange=false}={}){
  const calls=[],server=createServer((req,res)=>{
    calls.push({range:req.headers.range,encoding:req.headers['accept-encoding'],ifRange:req.headers['if-range']});
    const common={'ETag':'"'+digest+'"','X-GPUQ-Client-Bytes':String(source.length)};
    if(calls.length===1){
      const data=compressed?gzipSync(source):source;
      res.writeHead(200,{...common,'Content-Length':data.length,...compressed?{'Content-Encoding':'gzip'}:{}});
      res.write(data.subarray(0,Math.floor(data.length/2)));setTimeout(()=>res.destroy(),60);
    }else{
      const offset=Number(/^bytes=(\d+)-$/.exec(req.headers.range||'')?.[1]);
      if(!Number.isSafeInteger(offset)||offset<=0){res.writeHead(400);return res.end();}
      res.writeHead(206,{...common,'Content-Range':`bytes ${wrongRange?offset+1:offset}-${source.length-1}/${source.length}`,'Content-Length':source.length-offset});
      res.end(source.subarray(offset));
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {port:server.address().port,calls};
}

for(const wrongRange of [false,true])test(`PowerShell gzip interruption resumes decoded bytes; wrongRange=${wrongRange}`,{skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuq-resume-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {port,calls}=await fixture(t,{compressed:true,wrongRange}),destination=join(root,'client.mjs');
  const installer=fileURLToPath(new URL('../deploy/install-client.ps1',import.meta.url));
  // The isolated HTTP fixture replaces only origin resolution. Production
  // remains HTTPS-only, verifies certificates and rejects redirects.
  const command=`$ErrorActionPreference='Stop';. ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(installer)})));function Resolve-GpuqOrigin {param([string]$Value);return 'http://127.0.0.1:${port}'};$GpuqClientSha256='${digest}';Receive-GpuqClient -Origin 'https://fixture.example' -Destination ${psQuote(destination)}`;
  const result=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command]);
  assert.equal(result.code,wrongRange?1:0,result.out+'\n'+result.err);
  assert.equal(calls.length,2);assert.match(calls[0].encoding,/gzip/);assert.equal(calls[1].encoding,'identity');assert.equal(calls[1].ifRange,'"'+digest+'"');assert.match(calls[1].range,/^bytes=[1-9]\d*-$/);
  if(!wrongRange)assert.equal(createHash('sha256').update(await readFile(destination)).digest('hex'),digest);
});

for(const wrongRange of [false,true])test(`POSIX installer resumes exact prefix; wrongRange=${wrongRange}`,{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuq-sh-resume-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {port,calls}=await fixture(t,{wrongRange}),destination=join(root,'client.mjs');
  const installer=await readFile(new URL('../deploy/install-client.sh',import.meta.url),'utf8');
  const code=installer.split("<<'JS'\n")[1].split('\nJS\n')[0],program=join(root,'download.mjs');await writeFile(program,code);
  const curl=join(root,'curl');
  await writeFile(curl,`#!/usr/bin/env node\nconst fs=require('node:fs'),http=require('node:http');const a=process.argv.slice(2),h={};for(let i=0;i<a.length;i++)if(a[i]==='--header'){const p=a[++i].indexOf(':');h[a[i].slice(0,p)]=a[i].slice(p+1).trim();}http.get({hostname:'127.0.0.1',port:${port},path:'/gpuctl.mjs',headers:h},r=>{fs.writeFileSync(a[a.indexOf('--dump-header')+1],'HTTP/1.1 '+r.statusCode+' OK\\r\\n'+Object.entries(r.headers).map(([k,v])=>k+': '+v).join('\\r\\n')+'\\r\\n\\r\\n');r.pipe(process.stdout);r.on('aborted',()=>process.exitCode=18);r.on('error',()=>process.exitCode=18);}).on('error',()=>process.exitCode=56);\n`,{mode:0o700});
  const result=await run(process.execPath,[program,'https://fixture.example',destination,digest],{env:{...process.env,PATH:root+':'+process.env.PATH}});
  assert.equal(result.code===0,!wrongRange,result.out+'\n'+result.err);assert.equal(calls.length,2);assert.equal(calls[1].encoding,'identity');assert.equal(calls[1].ifRange,'"'+digest+'"');
  if(!wrongRange)assert.equal(createHash('sha256').update(await readFile(destination)).digest('hex'),digest);
});
