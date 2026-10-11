import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {createLocalDatasetTools} from '../client-data-upload.mjs';

const chunk=1024*1024;
async function fixture(t){
  const dir=await fs.mkdtemp(join(tmpdir(),'gpuq-data-workspace-cli-')),session=join(dir,'session.json'),calls=[],files=new Map();let loseReply=false,publication='PUBLISHING',cleanupState='QUEUED';
  const server=createServer(async(req,res)=>{try{
    let raw='';for await(const part of req)raw+=part;const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});res.setHeader('Content-Type','application/json');
    if(operation==='state'){res.end(JSON.stringify({state:{demo:false,gpuqConnected:true,machines:[{id:'gpu-1'}],users:[],jobs:[]}}));return;}
    assert.equal(args.machine,'gpu-1');assert.equal(Object.hasOwn(args,'project'),false);assert.equal(Object.hasOwn(args,'hostAdmin'),false);
    let result;
    if(operation==='datasets.workspace.put'){
      assert.ok(Buffer.byteLength(raw)<1500000);const bytes=Buffer.from(args.data,'base64');assert.ok(bytes.length<=chunk);
      const exists=files.has(args.path),before=files.get(args.path)||Buffer.alloc(0);
      if(args.offset===0&&exists&&args.truncate!==true)throw Error('File already exists; use --overwrite explicitly');
      const prefix=args.truncate?Buffer.alloc(0):before;assert.equal(args.offset,prefix.length);files.set(args.path,Buffer.concat([prefix,bytes]));
      if(loseReply){loseReply=false;throw Error('Simulated response lost after durable write');}
      result={size:files.get(args.path).length};
    }else if(operation==='datasets.workspace.list')result={path:args.path,entries:[{name:'archive.zip',type:'file'}]};
    else if(operation==='datasets.workspace.publish')result={operationId:args.key,state:'PUBLISHING'};
    else if(operation==='datasets.workspace.status')result={operationId:args.operationId,state:publication};
    else if(operation==='datasets.workspace.remove-plan')result={protocol:1,path:args.path,recursive:args.recursive,state:'PREVIEW',freedBytes:null};
    else if(operation==='datasets.workspace.remove'){
      if(loseReply){loseReply=false;throw Error('Simulated response lost after cleanup accepted');}
      result={protocol:1,key:args.key,path:args.path,recursive:args.recursive,state:cleanupState,freedBytes:null};
    }else if(operation==='datasets.workspace.remove-status')result={protocol:1,key:args.key,path:'old',recursive:true,state:cleanupState,freedBytes:null};
    else throw Error('Unexpected operation '+operation);
    res.end(JSON.stringify({result}));
  }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(session,JSON.stringify({url,token:'test-only',principal:{userId:'demo-user-1',username:'tester',role:'member'},machine:'gpu-1',projectsByMachine:{'gpu-1':'selected-project'}}));
  const cli=args=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--url',url,'--session-file',session,'--json',...args]);let stdout='',stderr='';p.stdout.on('data',s=>stdout+=s);p.stderr.on('data',s=>stderr+=s);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr,result:stdout?JSON.parse(stdout).data:null}));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  return {dir,calls,files,cli,lose:()=>{loseReply=true;},publication:value=>{publication=value;},cleanup:value=>{cleanupState=value;}};
}

test('cleanup is preview-first, explicit and uses the original key after a lost reply without opening a terminal',async t=>{
  const f=await fixture(t),key=randomUUID();
  const preview=await f.cli(['data','rm','old','--recursive']);assert.equal(preview.code,0,preview.stderr);assert.equal(preview.result.state,'PREVIEW');
  assert.deepEqual(f.calls.at(-1),{operation:'datasets.workspace.remove-plan',args:{machine:'gpu-1',path:'old',recursive:true}});
  const before=f.calls.length;f.lose();
  const lost=await f.cli(['data','rm','old','--recursive','--yes','--key',key]);assert.equal(lost.code,1);assert.match(lost.stderr,new RegExp(key));
  assert.deepEqual(f.calls.slice(before).filter(row=>row.operation!=='state'),[{operation:'datasets.workspace.remove',args:{machine:'gpu-1',path:'old',recursive:true,key}}]);
  f.cleanup('UNKNOWN');const unknown=await f.cli(['data','rm-status',key]);assert.equal(unknown.code,3);assert.equal(unknown.result.key,key);
  f.cleanup('FAILED');assert.equal((await f.cli(['data','rm-status',key])).code,1);
  f.cleanup('SUCCEEDED');assert.equal((await f.cli(['data','rm','old','--recursive','--yes','--key',key])).code,0);
  assert.equal(f.calls.at(-1).args.key,key);
  assert.equal(f.calls.some(row=>row.operation.startsWith('terminal.')),false);
});

test('cleanup rejects root, project, traversal and unauthorized target before mutation',async t=>{
  const f=await fixture(t);
  for(const args of [
    ['data','rm','.','--yes'],['data','rm','../other','--yes'],['data','rm','/data2/old','--yes'],
    ['data','rm','old','--yes','--root'],['data','rm','old','--yes','--project','other'],
    ['data','rm','old','--yes','--machine','gpu-4'],['data','rm','old','--yes','--dry-run'],
    ['data','rm-status',randomUUID(),'--yes'],
  ]){
    const before=f.calls.length,result=await f.cli(args);assert.equal(result.code,1,JSON.stringify(args));
    assert.equal(f.calls.slice(before).some(row=>row.operation!=='state'),false,JSON.stringify(args));
  }
});

test('data put chunks one file into personal data without extraction, publication or selected project context',async t=>{
  const f=await fixture(t),source=join(f.dir,'images.zip'),content=randomBytes(chunk+37);await fs.writeFile(source,content);
  const response=await f.cli(['data','put',source,'incoming/images.zip']);assert.equal(response.code,0,response.stderr);
  assert.deepEqual(response.result,{machine:'gpu-1',path:'/data2/incoming/images.zip',bytes:content.length,extracted:false,published:false});
  assert.deepEqual(f.files.get('incoming/images.zip'),content);
  const puts=f.calls.filter(c=>c.operation!=='state');assert.deepEqual(puts.map(c=>c.operation),['datasets.workspace.put','datasets.workspace.put']);
  assert.equal(puts[0].args.truncate,false);assert.equal(Object.hasOwn(puts[1].args,'truncate'),false);assert.deepEqual(puts.map(c=>c.args.offset),[0,chunk]);
  const zero=join(f.dir,'empty.zip');await fs.writeFile(zero,'');assert.equal((await f.cli(['data','put',zero])).code,0);assert.equal(f.files.get('empty.zip').length,0);
});

test('data put requires explicit overwrite and never retries an ambiguous write',async t=>{
  const f=await fixture(t),source=join(f.dir,'data.zip');await fs.writeFile(source,'new');f.files.set('data.zip',Buffer.from('old'));
  const denied=await f.cli(['data','put',source]);assert.equal(denied.code,1);assert.match(denied.stderr,/already exists/);assert.equal(f.files.get('data.zip').toString(),'old');
  assert.equal((await f.cli(['data','put',source,'--overwrite'])).code,0);assert.equal(f.files.get('data.zip').toString(),'new');
  const before=f.calls.length;f.lose();const lost=await f.cli(['data','put',source,'lost.zip']);assert.equal(lost.code,1);assert.match(lost.stderr,/response lost/);
  assert.deepEqual(f.calls.slice(before).filter(c=>c.operation!=='state').map(c=>c.operation),['datasets.workspace.put']);
  assert.equal(f.files.get('lost.zip').toString(),'new');
});

test('data workspace CLI preserves relative paths and publication handles, rejects privilege and project options',async t=>{
  const f=await fixture(t),source=join(f.dir,'a.zip');await fs.writeFile(source,'a');
  for(const extra of [['--root'],['--as','admin'],['--project','other'],['--data','sample@'+'a'.repeat(64)],['--machine','gpu-4']]){
    const before=f.calls.length;assert.equal((await f.cli(['data','put',source,...extra])).code,1);assert.equal(f.calls.slice(before).some(c=>c.operation!=='state'),false);
  }
  for(const path of ['../bad','/data2/a','a//b','a\\b','a/./b','x'.repeat(256)])assert.equal((await f.cli(['data','put',source,path])).code,1);
  const listing=await f.cli(['data','files']);assert.equal(listing.code,0);assert.equal(f.calls.at(-1).args.path,'.');
  const key=randomUUID(),pub=await f.cli(['data','publish','prepared/images','--name','images','--key',key]);assert.equal(pub.code,0,pub.stderr);assert.equal(pub.result.operationId,key);
  assert.deepEqual(f.calls.at(-1),{operation:'datasets.workspace.publish',args:{machine:'gpu-1',path:'prepared/images',name:'images',key}});
  for(const path of ['.','../outside','/data2/private'])assert.equal((await f.cli(['data','publish',path,'--name','images'])).code,1);
  assert.equal((await f.cli(['data','workspace-status',key])).code,0);assert.equal(f.calls.at(-1).args.operationId,key);
  assert.equal((await f.cli(['data','workspace-status'])).code,0);assert.equal(Object.hasOwn(f.calls.at(-1).args,'operationId'),false);
  f.publication('FAILED');assert.equal((await f.cli(['data','workspace-status',key])).code,1);f.publication('UNKNOWN');assert.equal((await f.cli(['data','workspace-status',key])).code,3);
  assert.equal((await f.cli(['data','workspace-status','bad'])).code,1);
});

test('data put supports old Windows path/handle device pairing but rejects subsequent identity changes and oversized files',async t=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'gpuq-workspace-stat-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const path=join(dir,'image.zip');await fs.writeFile(path,'payload');
  const copy=(info,changes)=>Object.assign(Object.create(Object.getPrototypeOf(info)),info,changes);
  const client=(overrides={})=>createLocalDatasetTools({platform:'win32',lstat:async(...args)=>copy(await fs.lstat(...args),{dev:0n}),open:fs.open,...overrides});
  const calls=[],call=async(operation,args)=>{calls.push({operation,args});return {result:{size:args.offset+Buffer.from(args.data,'base64').length}};};
  assert.equal((await client().putWorkspaceData(call,'gpu-1',path,'image.zip',false)).bytes,7);assert.equal(calls.length,1);
  let reads=0;calls.length=0;
  await assert.rejects(client({lstat:async(...args)=>copy(await fs.lstat(...args),{dev:reads++?1n:0n})}).putWorkspaceData(call,'gpu-1',path,'image.zip',false),/changed during upload/);assert.equal(calls.length,0);
  await assert.rejects(client({lstat:async(...args)=>copy(await fs.lstat(...args),{dev:0n,size:100n*1024n**3n+1n})}).putWorkspaceData(call,'gpu-1',path,'image.zip',false),/100 GiB/);assert.equal(calls.length,0);
});
