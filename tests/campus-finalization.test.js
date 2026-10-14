import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {finishCampusOperation,probeCampusEndpoint,chooseCampusEndpoint} from '../client-campus-endpoints.mjs';
import {spawn} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';

const stopped=()=>Object.assign(Error('private ticket and path must not appear'),{code:'NATIVE_EXIT_UNCONFIRMED'});
const grant={machine:'fixture-node',revision:'a'.repeat(64),certificateSha256:'b'.repeat(64),endpoint:'https://campus.example'};
const endpoints=[{id:'node-lan',kind:'campus-direct',endpoint:'https://192.168.50.7'},{id:'primary',kind:'campus-direct',endpoint:grant.endpoint}];
const capabilities={protocol:'dataset-upload-v1',machine:grant.machine,revision:grant.revision,listenerReady:true};
async function warningsDuring(work){
  const messages=[],previous=process.stderr.write;
  process.stderr.write=function(message,...args){messages.push(String(message));const callback=args.at(-1);if(typeof callback==='function')callback();return true;};
  try{const result=await work();return {result,messages};}finally{process.stderr.write=previous;}
}
async function localFixture(t){
  const root=await mkdtemp(join(tmpdir(),'campus-finalization-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const local=join(root,'source'),payload=Buffer.from('verified payload'),sha256=createHash('sha256').update(payload).digest('hex');
  await writeFile(local,payload);return {root,local,payload,sha256};
}

test('final shutdown awaits completion; failure warns once with a safe bounded code',async()=>{
  let closed=false;const warnings=[];
  await finishCampusOperation(async()=>{await new Promise(resolve=>setImmediate(resolve));closed=true;},{warn:code=>warnings.push(code)});
  assert.equal(closed,true);assert.deepEqual(warnings,[]);
  await finishCampusOperation(async()=>{throw stopped();},{warn:code=>warnings.push(code)});
  assert.deepEqual(warnings,['NATIVE_EXIT_UNCONFIRMED']);
  await finishCampusOperation(async()=>{throw Object.assign(Error('private message'),{code:'PRIVATE_TICKET_123'});},{warn:code=>warnings.push(code)});
  assert.equal(warnings.at(-1),'NATIVE_CLEANUP_UNCONFIRMED');
  await finishCampusOperation(async()=>{throw stopped();},{warn:()=>{throw Error('closed stderr');}});
});
test('verified capabilities survive helper shutdown failure with one sanitized warning',async()=>{
  let requests=0,closed=0;
  const result=await warningsDuring(()=>probeCampusEndpoint(grant,endpoints[1],{agentFactory:pin=>{
    assert.equal(pin,grant.certificateSha256);
    return {request:async args=>{requests++;assert.equal(args.endpoint,grant.endpoint);assert.equal(args.certificateSha256,pin);return {value:{result:capabilities},raw:Buffer.alloc(0)};},destroy:async()=>{closed++;throw stopped();}};
  }}));
  assert.deepEqual(result.result,capabilities);assert.equal(requests,1);assert.equal(closed,1);
  assert.equal(result.messages.length,1);assert.match(result.messages[0],/NATIVE_EXIT_UNCONFIRMED/);assert.doesNotMatch(result.messages[0],/private ticket|path/);
});
test('probe preserves the first TLS failure when final shutdown also fails',async()=>{
  const original=Object.assign(Error('private handshake detail'),{code:'TLS_CHAIN_OR_NAME'});
  await warningsDuring(()=>assert.rejects(probeCampusEndpoint(grant,endpoints[1],{agentFactory:()=>({request:async()=>{throw original;},destroy:async()=>{throw stopped();}})}),error=>error===original));
});
test('a verified endpoint remains selectable after its probe helper close times out',async()=>{
  const result=await warningsDuring(()=>chooseCampusEndpoint(grant,[endpoints[1]],{probe:(g,e)=>probeCampusEndpoint(g,e,{agentFactory:()=>({request:async()=>({value:{result:capabilities},raw:Buffer.alloc(0)}),destroy:async()=>{throw stopped();}})})}));
  assert.equal(result.result,endpoints[1]);assert.equal(result.messages.length,1);
});
for(const mode of ['confirmed','denied'])test(`push ${mode}: control helper shutdown preserves the original business result`,async t=>{
 const f=await localFixture(t),session=join(f.root,'session'),proof=join(f.root,'proof'),loader=join(f.root,'loader.mjs'),origin='https://portal.example';
 await writeFile(session,JSON.stringify({url:origin,token:'fixture-session-token',principal:{userId:'fixture-user',role:'member'},machine:'fixture-node',projectsByMachine:{'fixture-node':'fixture-project'}}),{mode:0o600});
 const native=new URL('../client-campus-native.mjs',import.meta.url).href,fixture=new URL('./control-finalization-fixture.mjs',import.meta.url).href;
 const source=`export * from ${JSON.stringify(native+'?finalization-fixture-real')};import {fixtureAgent,fixtureRuntime} from ${JSON.stringify(fixture)};export const resolveCampusNativeRuntime=fixtureRuntime;export const createCampusNativeAgent=(pin,options)=>fixtureAgent(pin,options,${JSON.stringify({mode:'push-'+mode,proof,payload:f.payload.toString('base64')})});`;
 await writeFile(loader,`import {registerHooks} from 'node:module';registerHooks({load(url,context,next){if(url===${JSON.stringify(native)})return {format:'module',source:${JSON.stringify(source)},shortCircuit:true};return next(url,context);}});`);
 const out=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--import',pathToFileURL(loader).href,fileURLToPath(new URL('../cli.mjs',import.meta.url)),'push',f.local,'payload','--session-file',session,'--json','--via','relay']);let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
 const stats=JSON.parse(await readFile(proof,'utf8')),writes=stats.calls.filter(row=>row.operation==='data.upload.chunk');assert.equal(stats.announcementReads,1);assert.equal(writes.length,1);assert.equal(writes[0].args.offset,0);assert.deepEqual(Buffer.from(writes[0].args.data,'base64'),f.payload);
 const begin=stats.calls.find(row=>row.operation==='data.upload.begin').args;assert.equal(begin.totalSize,f.payload.length);assert.match(begin.key,/^[a-f0-9-]{36}$/);
 assert.equal(out.stderr.match(/Warning:/g)?.length,1);assert.match(out.stderr,/NATIVE_EXIT_UNCONFIRMED/);assert.doesNotMatch(out.stdout+out.stderr,/fixture-session-token|private ticket/);
 if(mode==='confirmed'){assert.equal(out.code,0,out.stderr);assert.equal(JSON.parse(out.stdout).data.uploaded,1);}
 else{assert.equal(out.code,1);assert.equal(out.stdout,'');const error=JSON.parse(out.stderr.split('\n').find(line=>line.startsWith('{')));assert.match(error.error,mode==='denied'?/HTTP 403.*fixture permission denied/:/上传身份或已确认偏移不一致/);}
});

test('a revision update keeps verified capabilities and safe shutdown warning',async()=>{
 const next={...capabilities,revision:'c'.repeat(64)};
 const result=await warningsDuring(()=>probeCampusEndpoint(grant,endpoints[1],{agentFactory:()=>({request:async()=>({value:{result:next},raw:Buffer.alloc(0)}),destroy:async()=>{throw stopped();}})}));
 assert.deepEqual(result.result,next);assert.equal(result.messages.length,1);assert.match(result.messages[0],/NATIVE_EXIT_UNCONFIRMED/);
});
