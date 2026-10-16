import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const CHUNK=1024**2,machine='fixture-node',jobId='11111111-1111-4111-8111-111111111111';
async function fixture(t,{area,status,failures}){
 const root=await mkdtemp(join(tmpdir(),'pull-cli-retry-')),destination=join(root,'output.bin'),bytes=Buffer.alloc(CHUNK+7,79),requests=[],journals=[];let errors=0;
 const server=createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  const {operation,args}=JSON.parse(body);res.setHeader('content-type','application/json');
  if(operation==='community.announcements.pending')return res.end(JSON.stringify({result:{posts:[]}}));
  if(operation==='state'){assert.deepEqual(args,{view:'summary',jobId});return res.end(JSON.stringify({state:{machines:[{id:machine}],jobs:[{id:jobId,machine,project:'vision',userId:'fixture-member'}],users:[]}}));}
  if(operation!=='files.get'){res.statusCode=500;return res.end(JSON.stringify({error:'unexpected fixture operation '+operation}));}
  requests.push(args);
  if((status===403||args.offset===CHUNK)&&errors++<failures){
   if(status!==403)journals.push(JSON.parse(await readFile(destination+'.gpuctl-download.json','utf8')));
   res.statusCode=status;return res.end(JSON.stringify({error:status===403?'没有权限读取这个文件。':'暂时无法读取，请稍后再查。'}));
  }
  res.end(JSON.stringify({result:{size:bytes.length,offset:args.offset,data:bytes.subarray(args.offset,args.offset+CHUNK).toString('base64')}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,session=join(root,'session.json');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 await writeFile(session,JSON.stringify({url:origin,token:'synthetic-session',principal:{userId:'fixture-member',role:'member'}}));
 const run=()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[process.env.PULL_RETRY_CLI||new URL('../cli.mjs',import.meta.url).pathname,'--session-file',session,'--url',origin,'--json','pull','weights.bin',destination,'--machine',machine,'--project','vision','--via','portal',...(area==='output'?['--job',jobId]:[])]);
  let out='',err='';child.stdout.on('data',part=>out+=part);child.stderr.on('data',part=>err+=part);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));child.stdin.end();
 });
 return {run,requests,journals,bytes,destination};
}
for(const area of ['code','output'])for(const status of [400,503])test(`actual ${area} pull retries ${status} file reads and exits successfully with complete bytes`,async t=>{
 const failures=status===400?2:3,f=await fixture(t,{area,status,failures}),result=await f.run();
 assert.equal(result.code,0,result.err);assert.deepEqual(await readFile(f.destination),f.bytes);assert.equal(JSON.parse(result.out).data.bytes,f.bytes.length);
 assert.deepEqual(f.requests.map(row=>row.offset),[0,...Array(failures+1).fill(CHUNK)]);for(const row of f.requests.slice(2))assert.deepEqual(row,f.requests[1]);
 assert.ok(f.requests.every(row=>row.area===area&&row.project==='vision'&&(area!=='output'||row.runId===jobId)));
 assert.equal(f.journals.length,failures);for(const journal of f.journals)assert.deepEqual(journal,f.journals[0]);
 await assert.rejects(lstat(f.destination+'.gpuctl-partial'),{code:'ENOENT'});await assert.rejects(lstat(f.destination+'.gpuctl-download.json'),{code:'ENOENT'});
});
for(const area of ['code','output'])test(`actual ${area} pull does not retry a permission error`,async t=>{
 const f=await fixture(t,{area,status:403,failures:99}),result=await f.run();assert.equal(result.code,1);assert.match(result.err,/没有权限/);assert.equal(f.requests.length,1);await assert.rejects(lstat(f.destination),{code:'ENOENT'});
});
