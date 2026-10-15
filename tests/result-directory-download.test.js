import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,lstat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {downloadFile} from '../client-file-download.mjs';
import {directoryDownloadReceipt,directoryDownloadStatus} from '../client-directory-download.mjs';
const {downloadResultFile}=await import(process.env.DIRECTORY_DOWNLOAD_SOURCE??'../client-result-download.mjs');

async function fixture(t,{count=3,pageSize=1000}={}){
 const root=await mkdtemp(join(tmpdir(),'e2e-directory-188-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=new Map(Array.from({length:count},(_,i)=>['render/'+String(i).padStart(4,'0')+'.bin',Buffer.from('frame-'+i)]));
 files.set('render/deep/manifest.json',Buffer.from('fixed manifest'));
 const directories=new Set(['render','render/deep','render/empty']),calls=[],ids=[];
 const options={machine:'fixture-node',context:{project:'paper',area:'output',runId:'11111111-1111-4111-8111-111111111111'},
  origin:'https://portal.example.test',userId:'fixture-owner',path:'render',destination:join(root,'download'),onDirectory:value=>ids.push(value.downloadId)};
 let failure,denied=false;
 const call=async(op,args)=>{
  calls.push({op,...args});
  assert.equal(args.machine,options.machine);assert.equal(args.project,options.context.project);assert.equal(args.runId,options.context.runId);assert.equal(args.area,'output');
  if(denied)throw Object.assign(Error('Forbidden'),{status:403});
  if(op==='files.list'){
   const state=await directoryDownloadStatus(options.destination);assert.ok(state.downloadId,'UUID must be queryable before enumerating or reading files');
   assert.ok(directories.has(args.path));
   const prefix=args.path+'/',entries=[];
   for(const dir of directories)if(dir.startsWith(prefix)&&!dir.slice(prefix.length).includes('/'))entries.push({name:dir.slice(prefix.length),type:'directory',size:0});
   for(const [path,bytes] of files)if(path.startsWith(prefix)&&!path.slice(prefix.length).includes('/'))entries.push({name:path.slice(prefix.length),type:'file',size:bytes.length});
   entries.sort((a,b)=>a.name.localeCompare(b.name));
   const start=Number(args.cursor??0),selected=entries.slice(start,start+pageSize),more=start+selected.length<entries.length;
   return {result:{protocol:1,path:args.path,entries:selected,total:entries.length,hasMore:more,nextCursor:more?String(start+selected.length):null}};
  }
  assert.equal(op,'files.get');
  if(directories.has(args.path))throw Object.assign(Error('Only unlinked regular files allowed'),{status:400});
  if(failure)failure(args);
  const bytes=files.get(args.path);assert.ok(bytes,`existing file ${args.path}`);
  const chunk=bytes.subarray(args.offset,args.offset+3);
  return {result:{protocol:2,path:args.path,size:bytes.length,offset:args.offset,data:chunk.toString('base64'),eof:args.offset+chunk.length===bytes.length}};
 };
 const download=extra=>downloadResultFile(call,{...options,...extra},{directDownload:downloadFile});
 return {root,files,directories,calls,ids,call,options,download,fail:fn=>{failure=fn;},deny:()=>{denied=true;}};
}

test('#188 directory pull downloads 625 files, nested and empty directories, with a UUID before any child',async t=>{
 const f=await fixture(t,{count:624,pageSize:200});
 const result=await f.download();assert.equal(result.files,625);assert.equal(result.state,'COMPLETE');assert.equal(result.scope,'local-client');
 assert.equal(result.downloadId,f.ids[0]);assert.equal((await directoryDownloadStatus(f.options.destination)).downloadId,result.downloadId);
 for(const [path,bytes] of f.files)assert.deepEqual(await readFile(join(f.options.destination,path.slice('render/'.length))),bytes);
 assert.ok((await lstat(join(f.options.destination,'empty'))).isDirectory());
 assert.ok(f.calls.some(row=>row.op==='files.list'&&row.cursor));assert.equal(f.calls.some(row=>!['files.get','files.list'].includes(row.op)),false);
});
test('directory interruption retains the UUID and exact partial offset for the original command',async t=>{
 const f=await fixture(t);let rejected=false;
 f.fail(args=>{if(!rejected&&args.path==='render/0000.bin'&&args.offset===3){rejected=true;throw Object.assign(Error('temporary disconnect'),{status:503});}});
 await assert.rejects(f.download(),error=>{assert.equal(error.download.downloadId,f.ids[0]);assert.match(error.download.statusCommand,/pull-status/);return true;});
 const before=await directoryDownloadStatus(f.options.destination);assert.equal(before.state,'PAUSED');
 const mark=f.calls.length;const value=await f.download();assert.equal(value.downloadId,before.downloadId);
 const resumed=f.calls.slice(mark).find(row=>row.op==='files.get'&&row.path==='render/0000.bin');assert.equal(resumed.offset,3);
 assert.equal((await directoryDownloadStatus(f.options.destination)).state,'COMPLETE');
});
test('directory download accepts the actual file size when the earlier listing is stale',async t=>{
 const f=await fixture(t);let changed=false;
 const call=async(op,args)=>{if(op==='files.get'&&args.path==='render/0000.bin'&&!changed){changed=true;f.files.set(args.path,Buffer.from('updated after listing'));}return f.call(op,args);};
 const value=await downloadResultFile(call,f.options,{directDownload:downloadFile});
 assert.equal(value.state,'COMPLETE');assert.equal(value.bytes,[...f.files.values()].reduce((n,b)=>n+b.length,0));
 assert.equal((await directoryDownloadStatus(f.options.destination)).totalBytes,value.bytes);
 for(const [path,bytes] of f.files)assert.deepEqual(await readFile(join(f.options.destination,path.slice('render/'.length))),bytes);
});
test('overlapping directory pages do not refuse or download the same child twice',async t=>{
 const f=await fixture(t,{pageSize:2});let first;
 const call=async(op,args)=>{const reply=await f.call(op,args);if(op==='files.list'&&args.path==='render'){if(args.cursor&&first)reply.result.entries.unshift(first);else first=reply.result.entries.find(row=>row.type==='file');}return reply;};
 const value=await downloadResultFile(call,f.options,{directDownload:downloadFile});
 assert.equal(value.files,f.files.size);assert.equal(value.state,'COMPLETE');
 assert.equal(f.calls.filter(row=>row.op==='files.get'&&row.path==='render/0000.bin'&&row.offset===0).length,1);
});
test('directory metadata receipts never collide with a same-named remote payload',async t=>{
 const f=await fixture(t);f.files.set('render/0000.bin.gpuctl-download.json',Buffer.from('payload, not metadata'));
 await f.download();assert.equal((await readFile(join(f.options.destination,'0000.bin.gpuctl-download.json'))).toString(),'payload, not metadata');
});
test('completed directory can be verified again under its original UUID',async t=>{
 const f=await fixture(t);const first=await f.download(),second=await f.download();assert.equal(second.downloadId,first.downloadId);assert.equal(second.bytes,first.bytes);
});
test('authorization denial does not become a directory download or Portal fallback',async t=>{
 const f=await fixture(t);f.deny();await assert.rejects(f.download(),{status:403});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].op,'files.get');await assert.rejects(lstat(directoryDownloadReceipt(f.options.destination)),{code:'ENOENT'});
});
test('directory refusal preserved inside DOWNLOAD_UNCONFIRMED detail still starts the directory download',async t=>{
 const f=await fixture(t);
 const wrapped=async(op,args)=>{try{return await f.call(op,args);}catch(error){
  if(error.status===400&&args.path==='render')throw Object.assign(Error('DOWNLOAD_UNCONFIRMED'),{status:400,download:{detail:error.message}});
  throw error;
 }};
 const result=await downloadResultFile(wrapped,f.options,{directDownload:downloadFile});
 assert.equal(result.state,'COMPLETE');assert.equal(result.downloadId,f.ids[0]);
});
test('an unrelated HTTP 400 never starts directory enumeration',async t=>{
 const f=await fixture(t),failure=Object.assign(Error('metadata temporarily busy'),{status:400});
 await assert.rejects(downloadResultFile(async()=>{throw failure;},f.options,{directDownload:downloadFile}),error=>error===failure);
 assert.equal(f.calls.length,0);assert.equal(f.ids.length,0);
});
test('authorization revoked during a directory download stops the next child and preserves progress',async t=>{
 const f=await fixture(t);f.fail(args=>{if(args.path==='render/0001.bin')throw Object.assign(Error('Forbidden'),{status:403});});
 await assert.rejects(f.download(),{status:403});const state=await directoryDownloadStatus(f.options.destination);assert.equal(state.completedFiles,1);assert.equal(state.state,'PAUSED');
 assert.equal(f.calls.some(row=>row.path==='render/0002.bin'&&row.op==='files.get'),false);
});
test('resume uses the saved original dataset and path under the current login',async t=>{
 const f=await fixture(t);f.fail(()=>{throw Error('pause');});await assert.rejects(f.download());const mark=f.calls.length;f.fail(null);
 await f.download({userId:'another-team-member'});assert.equal(f.calls.slice(mark).find(row=>row.op==='files.get').path,'render/0000.bin');
});
test('an unrelated existing destination is preserved',async t=>{
 const f=await fixture(t);await mkdir(f.options.destination);await writeFile(join(f.options.destination,'keep.txt'),'keep');
 await assert.rejects(f.download(),/Destination exists without a matching download receipt/);assert.equal((await readFile(join(f.options.destination,'keep.txt'))).toString(),'keep');
});
test('source symlinks and path escapes are rejected after issuing a queryable UUID',async t=>{
 const f=await fixture(t),call=async(op,args)=>op==='files.list'?{result:{protocol:1,path:args.path,entries:[{name:'../outside',type:'unsupported',size:1}],total:1,hasMore:false}}:f.call(op,args);
 await assert.rejects(downloadResultFile(call,f.options,{directDownload:downloadFile}),/Unsafe directory download path/);
 assert.equal((await directoryDownloadStatus(f.options.destination)).state,'PAUSED');
});
test('a local symlink inside a partial is not followed',async t=>{
 const f=await fixture(t);f.fail(()=>{throw Error('pause');});await assert.rejects(f.download());
 const row=await directoryDownloadStatus(f.options.destination),outside=join(f.root,'outside');await writeFile(outside,'untouched');
 const partial=f.options.destination+'.gpuctl-partial-'+row.downloadId;
 try{await symlink(outside,join(partial,'0000.bin'));}catch(e){if(process.platform==='win32'&&e.code==='EPERM'){t.skip('Windows symlink privilege unavailable');return;}throw e;}
 f.fail(null);await assert.rejects(f.download(),/Destination exists/);assert.equal((await readFile(outside)).toString(),'untouched');
});
test('single-file pull keeps its existing one-request read path',async t=>{
 const f=await fixture(t);await f.download({path:'render/0000.bin',destination:join(f.root,'file.bin')});
 assert.equal(f.calls.some(row=>row.op==='files.list'),false);assert.equal(f.ids.length,0);
});
test('explicit Portal directory download uses authorized result reads and never redirects automatically',async t=>{
 const f=await fixture(t);await downloadResultFile(f.call,{...f.options,via:'portal'});assert.ok(f.calls.some(row=>row.op==='files.get'));assert.equal(f.calls.some(row=>row.op==='files.result.get'),false);
});
test('pull-status reads the durable UUID offline without a login or network request',async t=>{
 const f=await fixture(t);await f.download();const cli=fileURLToPath(new URL('../cli.mjs',import.meta.url));
 const result=await promisify(execFile)(process.execPath,[cli,'pull-status',f.options.destination,'--json'],{env:{...process.env,GPUQ_URL:'https://unreachable.invalid'}});
 const row=JSON.parse(result.stdout);assert.equal(row.ok,true);assert.equal(row.data.downloadId,f.ids[0]);assert.equal(row.data.state,'COMPLETE');
});

test('explicit CLI portal pull keeps the chosen HTTPS route',async t=>{
 const f=await fixture(t),server=createServer(async(req,res)=>{
  let raw='';for await(const bytes of req)raw+=bytes;
  const {operation,args}=JSON.parse(raw);res.setHeader('content-type','application/json');
  if(operation==='community.announcements.pending')return res.end(JSON.stringify({result:{posts:[]}}));
  if(operation==='state')return res.end(JSON.stringify({state:{machines:[],users:[],jobs:[]}}));
  try{assert.ok(['files.get','files.list'].includes(operation),'default HTTPS must not request files.direct-ticket');res.end(JSON.stringify(await f.call(operation,args)));}
  catch(error){res.statusCode=error.status||500;res.end(JSON.stringify({error:error.message}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin='http://127.0.0.1:'+server.address().port,session=join(f.root,'session.json');
 await writeFile(session,JSON.stringify({url:origin,token:'owned-loopback-fixture',principal:{userId:f.options.userId,username:'fixture',role:'member'},machine:f.options.machine}),{mode:0o600});
 const cli=fileURLToPath(new URL('../cli.mjs',import.meta.url));
 const result=await promisify(execFile)(process.execPath,[cli,'--session-file',session,'--url',origin,'--json','pull','--via','portal',f.options.path,f.options.destination,'--machine',f.options.machine,'--project','paper','--job',f.options.context.runId]);
 const value=JSON.parse(result.stdout);assert.equal(value.ok,true);assert.equal(value.data.state,'COMPLETE');
 assert.equal(value.data.files,4);assert.equal(f.calls.some(row=>row.op==='files.direct-ticket'),false);
 for(const [path,bytes] of f.files)assert.deepEqual(await readFile(join(f.options.destination,path.slice('render/'.length))),bytes);
});
