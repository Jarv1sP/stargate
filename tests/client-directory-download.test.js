import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,lstat,symlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {downloadPath} from '../client-directory-download.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'directory-download-')),calls=[];
 const files={'results/a.json':Buffer.from('abcdef'),'results/nested/b.json':Buffer.from('123456')};
 let fail=true,persistentFailure=false;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const bytes of req)raw+=bytes;
  const {operation,args}=JSON.parse(raw);calls.push({operation,args});
  if(operation==='state'){res.end(JSON.stringify({state:{demo:false,machines:[{id:'node-a'}],users:[],jobs:[]}}));return;}
  let result;
  if(operation==='files.list'){
   const entries=args.path==='.'?[{name:'results',type:'directory'}]:args.path==='results'?[{name:'a.json',type:'file'},{name:'nested',type:'directory'}]:[{name:'b.json',type:'file'}];
   const start=args.cursor?1:0,selected=entries.slice(start,start+1),hasMore=start+selected.length<entries.length;
   result={protocol:1,path:args.path,listingSha256:'a'.repeat(64),entries:selected,returned:selected.length,total:entries.length,hasMore,nextCursor:hasMore?'next':null};
  }else{
   assert.equal(operation,'files.get');const data=files[args.path];
   if(args.path.endsWith('b.json')&&args.offset===2&&(fail||persistentFailure)){fail=false;res.writeHead(persistentFailure?400:503);res.end(JSON.stringify({error:'interrupted'}));return;}
   const bytes=data.subarray(args.offset,args.offset+2);
   result={protocol:2,fingerprint:'b'.repeat(64),path:args.path,offset:args.offset,size:data.length,eof:args.offset+bytes.length===data.length,data:bytes.toString('base64')};
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const options={machine:'node-a',context:{project:'paper',area:'output',runId:'original-job'},path:'results',destination:join(dir,'out'),origin:'https://fixture.example',userId:'alice'};
 const call=async(operation,args)=>{const response=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',body:JSON.stringify({operation,args})});const value=await response.json();if(!response.ok)throw Error(value.error);return value;};
 return {dir,options,call,calls,files,url:'http://127.0.0.1:'+server.address().port,setPersistentFailure:value=>persistentFailure=value};
}
test('HTTP paginated directory download resumes partial file and preserves successful bytes',async t=>{
 const f=await fixture(t);await assert.rejects(downloadPath(f.call,f.options),/interrupted/);
 const first=join(f.options.destination,'a.json'),before=await lstat(first,{bigint:true});
 assert.equal((await readFile(first)).toString(),'abcdef');assert.equal((await readFile(join(f.options.destination,'nested/b.json'))).toString(),'12');
 f.calls.length=0;const result=await downloadPath(f.call,f.options);
 assert.equal(result.files,2);assert.equal(result.bytes,12);assert.equal(result.snapshot,false);
 assert.equal((await lstat(first,{bigint:true})).mtimeNs,before.mtimeNs);
 assert.equal(f.calls.find(x=>x.operation==='files.get'&&x.args.path.endsWith('a.json')).args.offset,6);
 assert.equal(f.calls.find(x=>x.operation==='files.get'&&x.args.path.endsWith('b.json')).args.offset,2);
 assert(f.calls.some(x=>x.operation==='files.list'&&x.args.cursor==='next'));
 assert.deepEqual(await readFile(join(f.options.destination,'nested/b.json')),f.files['results/nested/b.json']);
 assert(f.calls.every(x=>['files.list','files.get'].includes(x.operation)));
});
test('directory receipts reject another account without reading any file bytes',async t=>{
 const f=await fixture(t);await assert.rejects(downloadPath(f.call,f.options),/interrupted/);f.calls.length=0;
 await assert.rejects(downloadPath(f.call,{...f.options,userId:'bob'}),/another source or account/);
 assert(f.calls.every(x=>x.operation==='files.list'));
});
test('relative traversal and symlink destinations are rejected',async t=>{
 const f=await fixture(t);await assert.rejects(downloadPath(f.call,{...f.options,path:'../other'}),/relative/);
 await symlink(f.dir,f.options.destination);await assert.rejects(downloadPath(f.call,f.options),/identity/);
});
test('malformed page cannot silently truncate a directory',async t=>{
 const f=await fixture(t);await assert.rejects(downloadPath(async()=>({result:{protocol:1,path:'.',entries:[],total:2,returned:0,hasMore:false,listingSha256:'a'.repeat(64)}}),f.options),/count mismatch/);
});
test('actual CLI pull directory repeats the same command after HTTP interruption',async t=>{
 const f=await fixture(t),session=join(f.dir,'session');
 await writeFile(session,JSON.stringify({url:f.url,token:'fixture',principal:{userId:'alice',username:'alice',role:'member'},machine:'node-a'}));
 const run=()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--session-file',session,'--json','pull','results',f.options.destination,'--machine','node-a','--project','paper']);
  let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
 });
 f.setPersistentFailure(true);const first=await run();assert.equal(first.code,1,first.stdout);assert.match(first.stderr,/interrupted/);
 f.setPersistentFailure(false);const second=await run();assert.equal(second.code,0,second.stderr);const value=JSON.parse(second.stdout);assert.equal(value.data.files,2);assert.equal(value.data.snapshot,false);
 assert(f.calls.every(x=>['state','files.list','files.get'].includes(x.operation)));
});
