import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {readCLIState} from '../client-state.mjs';
test('only state displays and directory consumers fetch state; target RPCs authorize themselves',async()=>{
 for(const command of ['run','push','pull','project','data','watch','logs','completion'])assert.deepEqual(await readCLIState(()=>assert.fail('unneeded state RPC'),command),{machines:[],users:[]});
 for(const command of ['jobs','state','queue','users','grant'])await readCLIState(async(op,args)=>{assert.equal(op,'state');assert.deepEqual(args,['jobs','state','queue'].includes(command)?{}:{view:'summary'});return {state:{}};},command);
});
test('cold source CLI sends only the intended operation and honors immediate server denial',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cli-summary-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const requests=[],server=createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;const call=JSON.parse(body);requests.push(call);
  res.setHeader('content-type','application/json');
  if(call.operation==='community.announcements.pending')res.end(JSON.stringify({result:{posts:[]}}));
  else if(call.operation==='state')res.end(JSON.stringify({state:{summaryVersion:1,machines:[{id:'gpu-0',cards:8}],users:[{id:'builtin-admin',username:'admin',role:'admin',enabled:true,limits:{'gpu-0':8},total:8},{id:'peer-user',username:'bob',role:'member',enabled:true,total:0,limits:{}}],demo:false,gpuqConnected:false,taskMetadata:{version:1}}}));
  else{res.statusCode=403;res.end('{"error":"Isolated test stops before mutation"}');}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url='http://127.0.0.1:'+server.address().port,sessionFile=join(dir,'session.json'),source=join(dir,'input.txt');
 const freshSession={url,token:'isolated-token',principal:{userId:'builtin-admin',username:'admin',role:'admin'},machine:'gpu-0',projectsByMachine:{'gpu-0':'e2e-summary'}};await writeFile(source,'isolated preflight only');
 for(const argv of [['project','create','e2e-summary'],['push',source,'input.txt'],['push',source,'input.txt','--owner','bob'],['run','--project','e2e-summary','-g','1','--','nvidia-smi']]){
  requests.length=0;
  await writeFile(sessionFile,JSON.stringify(freshSession)); // Exercise cold preflight, not the separate warm-cache contract.
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--session-file',sessionFile,'--url',url,...argv],{stdio:['ignore','pipe','pipe']});
   let stderr='';child.stderr.on('data',part=>stderr+=part);child.stdout.resume();child.on('error',reject);child.on('close',code=>resolve({code,stderr}));
  });
  assert.equal(result.code,1);assert.deepEqual(requests.filter(row=>row.operation==='community.announcements.pending'),[{operation:'community.announcements.pending',args:{},client:{name:'gpuctl',protocol:2}}]);
  const intended=requests.filter(row=>!['community.announcements.pending','state'].includes(row.operation));if(argv.includes('--owner')){assert.equal(requests.filter(row=>row.operation==='state').length,1);assert.equal(intended[0].args.ownerId,'peer-user');}
  assert.equal(intended.length,1,argv.join(' ')+': '+result.stderr);assert.equal(intended[0].operation,({'project create':'projects.create','push':'data.upload.begin','run':'jobs.submit'})[argv.slice(0,argv[0]==='project'?2:1).join(' ')]);assert.match(result.stderr,/Isolated test stops before mutation/);
 }
});
test('push-status and upload-status finish a per-file scan that crosses one minute',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cli-upload-status-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const local=await mkdtemp(join(dir,'files-')),clock=join(dir,'clock'),preload=join(dir,'clock.mjs');
 await writeFile(join(local,'a.txt'),'a');await writeFile(join(local,'b.txt'),'b');
 await writeFile(preload,"import {readFileSync} from 'node:fs';globalThis.performance.now=()=>Number(readFileSync("+JSON.stringify(clock)+",'utf8'));\n");
 const operations=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);operations.push(body.operation);
  if(body.operation==='data.upload.status')await writeFile(clock,'70000');
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({result:body.operation==='community.announcements.pending'?{posts:[]}:{state:'COMPLETE',offset:1,totalSize:1}}));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const url='http://127.0.0.1:'+server.address().port,session=join(dir,'session.json');
 await writeFile(session,JSON.stringify({url,token:'fixture-token',principal:{userId:'fixture'},machine:'gpu-0',projectsByMachine:{'gpu-0':'fixture'}}));
 for(const command of ['push-status','upload-status']){
  operations.length=0;await writeFile(clock,'0');
  const argv=[command,...(command==='upload-status'?['gpu-0']:[]),local,'.','--key','11111111-1111-4111-8111-111111111111'];
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['--import',preload,fileURLToPath(new URL('../cli.mjs',import.meta.url)),...argv,'--url',url,'--session-file',session,'--json'],{stdio:['ignore','pipe','pipe']});
   let out='',err='';child.stdout.on('data',part=>out+=part);child.stderr.on('data',part=>err+=part);
   child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
  });
  assert.equal(result.code,0,result.err+result.out);assert.equal(JSON.parse(result.out).data.files.length,2);
  assert.deepEqual(operations,['community.announcements.pending','data.upload.status','data.upload.status']);
 }
});
