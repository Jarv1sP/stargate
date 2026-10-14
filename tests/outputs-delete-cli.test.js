import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const job='11111111-1111-4111-8111-111111111111';
async function fixture(t,{incomplete=false,blocked=false}={}){
 const folder=await mkdtemp(join(tmpdir(),'outputs-delete-cli-')),session=join(folder,'session'),calls=[];
 const server=createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;const {operation,args}=JSON.parse(raw);if(operation==='community.announcements.pending'){assert.deepEqual(args,{});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result:{posts:[]}}));return;}calls.push({operation,args});res.setHeader('Content-Type','application/json');
 if(operation==='state')return res.end(JSON.stringify({state:{demo:false,gpuqConnected:true,machines:[],users:[],jobs:[]}}));
 assert.equal(operation,'outputs.delete');
 const result={state:'TRASHED',retainUntil:1800000000,protocol:'outputs-delete-v1',jobId:job,...args,files:2,bytes:123,freedBytes:4096,sharedBytes:0};
 if(incomplete||blocked){res.statusCode=409;return res.end(JSON.stringify({code:'OUTPUTS_DELETE_INCOMPLETE',error:'未全部删除：已删除 2 个文件，剩余数量未确认。INCOMPLETE',receipt:{...result,state:blocked?'BLOCKED':'INCOMPLETE',complete:false,remainingFiles:null,remainingBytes:null,remaining:['checkpoints/readonly.bin'],remainingTruncated:false,blocked:[{path:'checkpoints',reason:'permission denied'}]}}));}
 res.end(JSON.stringify({result}));
 }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 await writeFile(session,JSON.stringify({url,token:'test-only',principal:{userId:'demo-user-3',username:'fixture',role:'member'}}),{mode:0o600});
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});});
 const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[process.env.OUTPUTS_DELETE_TEST_CLI||fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--url',url,'--session-file',session,...args],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
 return {run,calls};
}
test('files rm uses original job and relative path, with no selected project or machine',async t=>{
 const f=await fixture(t),result=await f.run(['files','rm','checkpoints/model.pt','--job',job,'--dry-run','--json']);assert.equal(result.code,0,result.stderr);
 const request=f.calls.at(-1);assert.equal(request.operation,'outputs.delete');assert.deepEqual({...request.args,key:undefined},{jobId:job,path:'checkpoints/model.pt',recursive:false,dryRun:true,key:undefined});assert.ok(request.args.key);assert.equal(JSON.parse(result.stdout).data.bytes,123);
});
test('outputs delete and recursive file removal send one mutation and print released bytes',async t=>{
 const f=await fixture(t),all=await f.run(['outputs','delete','--job',job]);assert.equal(all.code,0,all.stderr);assert.match(all.stdout,/已删除，7 天内可在项目回收站恢复/);
 assert.deepEqual({...f.calls.at(-1).args,key:undefined},{jobId:job,path:'.',recursive:true,dryRun:false,key:undefined});
 const one=await f.run(['files','rm','checkpoints','--recursive','--job',job,'--dry-run']);assert.equal(one.code,0,one.stderr);assert.match(one.stdout,/将删除 2 个文件 · 123 B/);
 assert.equal(f.calls.filter(row=>row.operation==='outputs.delete').length,2);
});
test('CLI rejects missing job, traversal and arbitrary deletion context before API calls',async t=>{
 const f=await fixture(t);for(const args of [['outputs','delete'],['files','rm','../x','--job',job],['files','rm','/x','--job',job],['files','rm','x','--job',job,'--root'],['files','rm','x','--job',job,'--project','other']]){const result=await f.run(args);assert.equal(result.code,1,result.stdout);}
 assert.equal(f.calls.length,0);
});

test('failed output deletion reports the error and original key with no replay or success',async t=>{
 const f=await fixture(t,{incomplete:true}),result=await f.run(['outputs','delete','--job',job,'--json']);assert.equal(result.code,1);
 const value=JSON.parse(result.stderr);assert.equal(value.ok,false);assert.match(value.error,/原删除编号/);assert.equal(f.calls.filter(row=>row.operation==='outputs.delete').length,1);assert.equal(f.calls.at(-1).args.dryRun,false);assert.doesNotMatch(result.stdout,/已删除/);
});
test('blocked dry-run exits nonzero, prints the reason and never deletes',async t=>{
 const f=await fixture(t,{blocked:true}),result=await f.run(['outputs','delete','--job',job,'--dry-run']);
 assert.equal(result.code,1);assert.match(result.stderr,/INCOMPLETE/);assert.doesNotMatch(result.stdout,/已删除|将删除/);assert.equal(f.calls.filter(row=>row.operation==='outputs.delete').length,1);assert.equal(f.calls.at(-1).args.dryRun,true);
});
