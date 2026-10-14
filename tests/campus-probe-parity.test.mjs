import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {chooseCampusEndpoint,approvedCampusEndpoints} from '../client-campus-endpoints.mjs';
import {createPersonalFileTransport} from '../client-personal-file-campus.mjs';
import {probeDirectUploadRoute} from '../client-direct-upload.mjs';
const grant={machine:'fixture-node',endpoint:'https://campus.example:18441',certificateSha256:'a'.repeat(64),revision:'b'.repeat(64),routes:[{id:'primary',kind:'campus-direct',endpoint:'https://campus.example:18441'}]};
const capability={protocol:'dataset-upload-v1',listenerReady:true,machine:grant.machine,revision:grant.revision};
const secret='fixture-secret-that-must-never-be-sent';
test('Raw HTTPS socket errors retain their cause without exposing the error text',async()=>{
  await assert.rejects(probeDirectUploadRoute(grant,{agentFactory:()=>({destroy(){}}),request:()=>{
    const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>req.emit('error',Object.assign(Error(secret),{code:'EHOSTUNREACH'})));return req;
  }}),error=>error.code==='NETWORK_UNREACHABLE'&&!error.message.includes(secret));
});
test('Windows push uses the anonymous pinned HTTPS capabilities probe',async t=>{
  const root=await mkdtemp(join(tmpdir(),'same-campus-probe-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const key=join(root,'key.pem'),cert=join(root,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
  const certificateSha256=createHash('sha256').update(execFileSync('openssl',['x509','-in',cert,'-outform','DER'])).digest('hex');
  let calls=0,wrong={};const server=createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{
    calls++;assert.equal(req.method,'GET');assert.equal(req.url,'/capabilities');assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...capability,...wrong}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const endpoint='https://127.0.0.1:'+server.address().port;
  const value={...grant,endpoint,certificateSha256,routes:[{id:'primary',kind:'campus-direct',endpoint}],available:true,kind:'campus-direct',routeId:'primary',protocol:'personal-file-campus-v1',grantId:'11111111-1111-4111-8111-111111111111',ticket:secret,expiresAt:Math.floor(Date.now()/1000)+300,chunkBytes:1048576};
  const push=()=>createPersonalFileTransport(async()=>({result:value}),{machine:grant.machine,platform:'win32',path:'source',action:'put',context:{project:'fixture'},identity:{uploadId:value.grantId,totalSize:1,sha256:'c'.repeat(64)},agentFactory:()=>({destroy:async()=>{}})});
  await (await push()).close();
  wrong={revision:'c'.repeat(64)};await (await push()).close();
  assert.equal(calls,2);
});
