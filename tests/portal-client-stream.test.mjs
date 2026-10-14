import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {standaloneClientInfo,standaloneClientRangeStream} from '../client-bundle.mjs';

test('real Portal serves concurrent native CLI downloads and installers with a 32 MiB heap',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuq-portal-stream-'));
  const bootstrap=join(root,'bootstrap.json');
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Local-Streaming-Test-2026!'}));
  const portal=new URL('../portal-server.mjs',import.meta.url).href;
  const program=`import {createPortalServer} from ${JSON.stringify(portal)};import {createInterface} from 'node:readline';const {server}=await createPortalServer({database:process.argv[1],bootstrap:process.argv[2],origin:'http://127.0.0.1',secure:false});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));console.log(JSON.stringify({port:server.address().port}));createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({maxRssKiB:process.resourceUsage().maxRSS}))).on('close',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});`;
  const child=spawn(process.execPath,['--max-old-space-size=32','--input-type=module','-e',program,join(root,'db'),bootstrap],{stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});let stderr='';const pending=[],queued=[];
  lines.on('line',line=>{const value=JSON.parse(line);pending.length?pending.shift().resolve(value):queued.push(value);});
  child.stderr.on('data',part=>stderr+=part);
  child.on('error',error=>{while(pending.length)pending.shift().reject(error);});
  child.on('close',code=>{while(pending.length)pending.shift().reject(Error('Portal exited '+code+': '+stderr));});
  const next=()=>queued.length?Promise.resolve(queued.shift()):new Promise((resolve,reject)=>pending.push({resolve,reject}));
  t.after(async()=>{child.stdin.end();if(child.exitCode===null){await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('close',()=>{clearTimeout(timer);resolve();});});}lines.close();await rm(root,{recursive:true,force:true});});
  const {port}=await next(),expected=await standaloneClientInfo('http://127.0.0.1');
  assert.equal(typeof expected.etag,'string');
  const request=(path,method='GET',headers={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{Host:'127.0.0.1',...headers}},async response=>{
      try{
        const sha=createHash('sha256');let bytes=0,text='';
        for await(const part of response){sha.update(part);bytes+=part.length;if(path.startsWith('/install.'))text+=part;}
        resolve({status:response.statusCode,bytes,sha256:sha.digest('hex'),headers:response.headers,text});
      }catch(error){reject(error);}
    });
    req.setTimeout(15000,()=>req.destroy(Error('Portal streaming request timed out')));req.on('error',reject);req.end();
  });
  const results=await Promise.all(['/gpuctl.mjs','/gpuctl.mjs','/gpuctl.mjs','/gpuctl.mjs'].map(path=>request(path)));
  for(const result of results){assert.equal(result.status,200);assert.equal(result.bytes,expected.bytes);assert.equal(Number(result.headers['content-length']),expected.bytes);assert.equal(result.headers['cache-control'],'no-store');}
  const head=await request('/gpuctl.mjs','HEAD');assert.equal(head.status,200);assert.equal(head.bytes,0);assert.equal(Number(head.headers['content-length']),expected.bytes);
  assert.equal(head.headers.etag,'"'+expected.etag+'"');assert.equal(head.headers['accept-ranges'],'bytes');
  const parts=[];for await(const part of standaloneClientRangeStream('http://127.0.0.1',{start:1031,end:2097}))parts.push(part);
  const partial=await request('/gpuctl.mjs','GET',{Range:'bytes=1031-2097','If-Range':'"'+expected.etag+'"','Accept-Encoding':'identity'});
  assert.equal(partial.status,206);assert.equal(partial.bytes,1067);assert.equal(partial.sha256,createHash('sha256').update(Buffer.concat(parts)).digest('hex'));
  assert.equal(partial.headers['content-range'],`bytes 1031-2097/${expected.bytes}`);
  const stale=await request('/gpuctl.mjs','GET',{Range:'bytes=1031-','If-Range':'"stale"'});assert.equal(stale.status,200);assert.equal(stale.bytes,expected.bytes);
  const invalid=await request('/gpuctl.mjs','GET',{Range:`bytes=${expected.bytes}-`});assert.equal(invalid.status,416);assert.equal(invalid.bytes,0);
  for(const path of ['/install.sh','/install.ps1']){const result=await request(path);assert.equal(result.status,200);assert.doesNotMatch(result.text,/__GPUQ_CLIENT_SHA256__|__GPUQ_PUBLIC_ORIGIN__/);}
  await new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port,path:'/gpuctl.mjs',headers:{Host:'127.0.0.1'}},response=>{response.once('data',()=>{response.destroy();resolve();});});req.on('error',reject);});
  const health=await request('/');assert.equal(health.status,200);
  const inventory=await request('/machines.js');assert.equal(inventory.status,401);assert.equal(inventory.bytes,0);
  child.stdin.write('memory\n');const memory=await next();
  assert.ok(memory.maxRssKiB<128*1024,'Portal exceeded 128 MiB RSS: '+memory.maxRssKiB);
  console.log(JSON.stringify({cliBytes:expected.bytes,parallelDownloads:4,portalMaxRssKiB:memory.maxRssKiB}));
});
