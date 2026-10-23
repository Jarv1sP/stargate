import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,utimes,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {uploadLocalTree} from '../client-transfers.mjs';

const parent='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222';
async function fixture(t,names=['fixture.txt']){
 const root=await mkdtemp(join(tmpdir(),'upload-status-keys-')),source=join(root,'source'),stateDirectory=join(root,'state');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(source);
 for(const name of names)await writeFile(join(source,name),'fixture');
 const requests=[],options={machine:'fixture-node',context:{area:'code',project:'fixture'},local:source,remote:'.',key:parent,stateDirectory};
 const call=async(operation,args)=>{assert.equal(operation,'data.upload.status');requests.push(args);return {result:{key:args.key,state:'COMPLETE',offset:7,totalSize:7}};};
 const journal=join(stateDirectory,parent+'.json');
 const seed=async keys=>{await mkdir(stateDirectory);await writeFile(journal,JSON.stringify(keys,null,2)+'\n');await utimes(journal,946684800,946684800);};
 return {root,source,stateDirectory,journal,options,call,requests,seed};
}
test('directory status without its original journal stays unknown and creates no keys or files',async t=>{
 const f=await fixture(t,['a.txt','b.txt']),result=await uploadLocalTree(f.call,{...f.options,inspectOnly:true});
 assert.deepEqual(f.requests,[]);assert.equal(result.key,parent);
 assert.deepEqual(result.files.map(row=>({path:row.path,key:row.key,state:row.state})),[
  {path:'a.txt',key:null,state:'UNKNOWN'},{path:'b.txt',key:null,state:'UNKNOWN'}
 ]);
 assert.ok(result.files.every(row=>/原.*上传.*编号|原.*上传.*记录/.test(row.message)));
 await assert.rejects(stat(f.stateDirectory),{code:'ENOENT'});
});
test('directory status reads known keys, leaves new files unknown and never rewrites the journal',async t=>{
 const f=await fixture(t,['a.txt','b.txt']);await f.seed({'a.txt':child});
 const text=await readFile(f.journal,'utf8'),before=await stat(f.journal);
 const result=await uploadLocalTree(f.call,{...f.options,inspectOnly:true});
 assert.deepEqual(f.requests.map(row=>row.key),[child]);
 assert.equal(result.files[0].state,'COMPLETE');assert.equal(result.files[0].key,child);
 assert.equal(result.files[1].state,'UNKNOWN');assert.equal(result.files[1].key,null);
 assert.equal(await readFile(f.journal,'utf8'),text);assert.equal((await stat(f.journal)).mtimeMs,before.mtimeMs);
});
test('single-file status can query its explicit original key without creating a journal',async t=>{
 const f=await fixture(t),result=await uploadLocalTree(f.call,{...f.options,local:join(f.source,'fixture.txt'),remote:'fixture.txt',inspectOnly:true});
 assert.deepEqual(f.requests.map(row=>row.key),[parent]);assert.equal(result.files[0].state,'COMPLETE');
 await assert.rejects(stat(f.stateDirectory),{code:'ENOENT'});
});
test('an actual directory upload still saves child keys for later read-only status',async t=>{
 const f=await fixture(t,['a.txt','b.txt']),writes=[];
 const result=await uploadLocalTree(f.call,{...f.options,via:'relay',uploadFile:async(_call,args)=>{
  writes.push({path:args.path,key:args.key});return {key:args.key,state:'COMPLETE',offset:7,totalSize:7};
 }});
 assert.equal(result.state,'COMPLETE');assert.equal(writes.length,2);
 const keys=JSON.parse(await readFile(f.journal,'utf8'));assert.deepEqual(keys,Object.fromEntries(writes.map(row=>[row.path,row.key])));
 assert.notEqual(keys['a.txt'],keys['b.txt']);assert.notEqual(keys['a.txt'],parent);
 await uploadLocalTree(f.call,{...f.options,inspectOnly:true});
 assert.deepEqual(f.requests.map(row=>row.key),writes.map(row=>row.key));
});
test('CLI push-status with a missing directory journal does not ask about invented upload IDs',async t=>{
 const f=await fixture(t),calls=[],server=createServer(async(req,res)=>{
  try{
   let raw='';for await(const chunk of req)raw+=chunk;const {operation,args}=JSON.parse(raw);calls.push(operation);
   res.setHeader('Content-Type','application/json');
   if(operation==='state')return res.end(JSON.stringify({state:{demo:false,gpuqConnected:true,machines:[{id:'fixture-node'}],users:[],jobs:[]}}));
   if(operation==='community.announcements.pending')return res.end(JSON.stringify({result:{posts:[]}}));
   assert.equal(operation,'data.upload.status');res.end(JSON.stringify({result:{key:args.key,state:'ABSENT'}}));
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const url='http://127.0.0.1:'+server.address().port,session=join(f.root,'session.json');
 await writeFile(session,JSON.stringify({url,token:'loopback-only',principal:{userId:'fixture',username:'fixture',role:'member'}}));
 const cli=process.env.UPLOAD_STATUS_TEST_CLI||fileURLToPath(new URL('../cli.mjs',import.meta.url));
 const result=await new Promise((resolve,reject)=>{
  const process_=spawn(process.execPath,[cli,'--url',url,'--session-file',session,'push-status',f.source,'.','--key',parent,'--machine','fixture-node','--project','fixture','--json'],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';process_.stdout.on('data',chunk=>stdout+=chunk);process_.stderr.on('data',chunk=>stderr+=chunk);process_.on('error',reject);process_.on('close',code=>resolve({code,stdout,stderr}));
 });
 assert.equal(result.code,0,result.stderr);
 assert.equal(calls.includes('data.upload.status'),false);assert.ok(calls.every(op=>['state','community.announcements.pending'].includes(op)));
 const value=JSON.parse(result.stdout).data;assert.equal(value.key,parent);assert.equal(value.files[0].state,'UNKNOWN');assert.equal(value.files[0].key,null);
 await assert.rejects(stat(session+'.uploads'),{code:'ENOENT'});
});
