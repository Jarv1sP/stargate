import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseCLIOptions} from '../cli.mjs';
import {platformCall} from '../dist/workshop-platform.js';

test('project shared flags parse as booleans and the workshop forwards the member write',async()=>{
 assert.equal(parseCLIOptions(['project','create','vision','--shared']).options.shared,true);
 assert.equal(parseCLIOptions(['project','share','vision','--off']).options.off,true);
 const args={machine:'gpu-1',project:'vision',ownerId:'peer',shared:true},calls=[];
 await platformCall({call:async(operation,args)=>{calls.push({operation,args});return args;}},'platform.write',{operation:'projects.shared.set',args});
 assert.deepEqual(calls,[{operation:'projects.shared.set',args}]);
});

test('actual CLI creates, toggles and lists shared projects while --owner preserves addressing',async t=>{
 const root=await mkdtemp(join(tmpdir(),'project-shared-cli-')),session=join(root,'session'),calls=[];
 const rows=[{project:'vision',displayName:'共用实验',ownerId:'peer',ownerName:'成员乙',shared:true},{project:'private',ownerId:'self',ownerName:'成员甲',shared:false}];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const bytes of req)raw+=bytes;const request=JSON.parse(raw);calls.push(request);res.setHeader('content-type','application/json');
  if(request.operation==='state')return res.end(JSON.stringify({state:{machines:[{id:'gpu-1'}],users:[{id:'self',username:'alice'},{id:'peer',username:'bob'}],jobs:[]}}));
  if(request.operation==='community.announcements.pending')return res.end(JSON.stringify({result:{posts:[]}}));
  const result=request.operation==='projects.list'?{projects:rows}:{...request.args,state:'READY'};
  res.end(JSON.stringify({result}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 await writeFile(session,JSON.stringify({url,token:'fixture-only',principal:{userId:'self',username:'alice',role:'member'},machine:'gpu-1'}));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 const cli=argv=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--session-file',session,...argv],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
 });
 for(const [argv,operation,shared,ownerId] of [
  [['project','create','vision','--shared','--repo','https://example.test/team/repo.git'],'projects.create',true,undefined],
  [['project','create','ordinary'],'projects.create',undefined,undefined],
  [['project','share','vision','--owner','bob'],'projects.shared.set',true,'peer'],
  [['project','share','vision','--off','--owner','bob'],'projects.shared.set',false,'peer']
 ]){
  const result=await cli([...argv,'--json']);assert.equal(result.code,0,result.stderr);
  assert.equal(calls.at(-1).operation,operation);assert.equal(calls.at(-1).args.shared,shared);assert.equal(calls.at(-1).args.ownerId,ownerId);
 }
 const plain=await cli(['project','list']);assert.equal(plain.code,0,plain.stderr);const displayed=JSON.parse(plain.stdout).projects;
 assert.equal(displayed[0].ownerName,'共用');assert.equal(displayed[0].ownerId,'peer');assert.equal(displayed[1].ownerName,'成员甲');
 const json=await cli(['project','list','--json']);assert.equal(json.code,0,json.stderr);assert.deepEqual(JSON.parse(json.stdout).data.projects,rows);
 const help=await cli(['--help']);assert.match(help.stdout,/project create NAME.*--shared/);assert.match(help.stdout,/project share NAME.*--off/);
});
