import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,rm,stat,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const RELEASE='a'.repeat(64),OLDER='b'.repeat(64),JOB='11111111-2222-4333-8444-555555555555';
const principal={userId:'demo-user-1',username:'tester',role:'member'};
const terminalOpen=args=>({id:args.id||args.key,clientId:args.clientId,mode:args.mode,hostAdmin:args.hostAdmin,writerToken:randomUUID(),leaseExpiresAt:Date.now()/1000+30});
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-projects-cli-')),session=join(dir,'session.json'),calls=[],requests=[];
  let releases=[{release:RELEASE,state:'READY'},{release:OLDER,state:'READY'}],latest=RELEASE;
  const custom=new Map();
  const state={demo:false,gpuqConnected:true,machines:[{id:'gpu-1'},{id:'gpu-2'}],users:[],jobs:[]};
  const server=createServer(async(req,res)=>{
    requests.push(req.url);
    try{
      let raw='';for await(const data of req)raw+=data;
      const body=JSON.parse(raw);res.setHeader('Content-Type','application/json');
      if(req.url==='/api/login'){res.end(JSON.stringify({token:'new-test-token',principal,state}));return;}
      const {operation,args={}}=body;calls.push({operation,args});
      if(operation==='state'){res.end(JSON.stringify({state}));return;}
      if(custom.has(operation)){const value=await custom.get(operation)(args);res.end(JSON.stringify({result:value}));return;}
      const result=operation==='projects.list'?{projects:[{project:'alpha',state:'READY',releases,latestReadyRelease:latest}]}:
        operation.startsWith('projects.')?{project:args.project,state:'READY',releases,latestReadyRelease:latest,environmentMode:args.environmentMode||'shared'}:
        operation==='files.list'?{entries:[]}:
        operation==='files.get'?{path:args.path,size:10,offset:args.offset,data:Buffer.from('checkpoint').toString('base64'),eof:true}:
        operation==='files.upload.status'?{protocol:2,state:'ABSENT',complete:false,path:args.path,receivedBytes:0}:
        operation==='files.put'&&args.project?{complete:args.final,size:args.offset+Buffer.from(args.data,'base64').length,...(args.final?{sha256:args.sha256}:{})}:
        operation==='jobs.submit'?{id:JOB,state:'QUEUED',machine:args.machine,cards:args.cards}:{};
      res.end(JSON.stringify({result}));
    }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  const save=extra=>writeFile(session,JSON.stringify({url,token:'test-only',principal,machine:'gpu-1',...extra}),{mode:0o600});
  await save({});
  const cli=(args,input='',preload=null,human=false)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[...(preload?['--import',preload]:[]),new URL('../cli.mjs',import.meta.url).pathname,'--url',url,'--session-file',session,...(human?[]:['--json']),...args]);
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);
    child.on('close',code=>resolve({code,data:human?null:stdout?JSON.parse(stdout).data:null,stderr,stdout}));child.stdin.end(input);
  });
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  return {dir,session,calls,requests,cli,save,custom,setReleases:(value,head)=>{releases=value;latest=head;}};
}
test('non-training --machine auto fails locally without requests or changing the original session',async t=>{
  const f=await fixture(t),before=await readFile(f.session,'utf8');
  const message='开发容器需要指定服务器；自动选择只用于提交训练（gpuctl run --machine auto）';
  for(const args of [['project','create','alpha'],['project','use','alpha'],['project','status','alpha'],['ssh'],['push','.'],['pull','result.txt','local.txt'],['data','shell'],['exec','--','true'],['queue']]){
    const flag=args[0]==='exec'?['exec','--machine','auto','--','true']:[...args,'--machine','auto'];
    const value=await f.cli(flag);assert.notEqual(value.code,0);assert.ok(value.stderr.includes(message),value.stderr);
    assert.deepEqual(f.calls,[],'no state, authorization, terminal or write request may be sent');
    assert.deepEqual(f.requests,[],'not even login or another HTTP endpoint may be requested');
    assert.equal(await readFile(f.session,'utf8'),before,'original session, projects and handles stay intact');
  }
  const alias=await f.cli(['project','create','alpha','--on','auto'], '',null,true);
  assert.notEqual(alias.code,0);assert.ok(alias.stderr.includes(message));assert.deepEqual(f.calls,[]);
  assert.deepEqual(f.requests,[]);
});

test('run --machine auto retains the existing AUTO submission contract',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const value=await f.cli(['run','--machine','auto','--release',RELEASE,'-g','1','--','python','train.py']);
  assert.equal(value.code,0,value.stderr);
  const submit=f.calls.find(call=>call.operation==='jobs.submit');assert.ok(submit);
  assert.equal(submit.args.machine,'auto');assert.deepEqual(submit.args.machineSelection,{mode:'auto'});
  assert.equal(submit.args.project,'alpha');assert.equal(submit.args.release,RELEASE);
  assert.match(submit.args.key,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.equal(f.calls.some(call=>['projects.create','terminal.open','files.put'].includes(call.operation)),false);
});

test('project lifecycle CLI exposes CAS labels, grouping and original-key soft retirement without mutable path guesses',async t=>{
 const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
 f.custom.set('projects.label.get',args=>({...args,displayName:args.project,revision:3}));
 f.custom.set('projects.label.set',args=>({...args,revision:args.revision+1}));
 f.custom.set('projects.status',args=>({...args,state:'READY',lifecycle:{state:'ACTIVE',revision:2}}));
 const label=await f.cli(['project','label','--display-name','中文项目']);assert.equal(label.code,0,label.stderr);assert.equal(f.calls.at(-1).args.revision,3);
 const archive=await f.cli(['project','archive']);assert.equal(archive.code,0,archive.stderr);assert.deepEqual(f.calls.at(-1),{operation:'projects.archive',args:{machine:'gpu-1',project:'alpha',revision:2}});
 assert.equal((await f.cli(['project','catalog','--full'])).code,0);assert.deepEqual(f.calls.at(-1),{operation:'projects.catalog',args:{includeArchived:true}});
 const group=await f.cli(['project','group',JOB,'--display-name','Project','--members','1/alpha,2/beta','--revision','0']);assert.equal(group.code,0,group.stderr);assert.deepEqual(f.calls.at(-1).args.members,[{machine:'gpu-1',project:'alpha'},{machine:'gpu-2',project:'beta'}]);
 assert.equal((await f.cli(['project','group',JOB,'--display-name','Project','--members','none','--revision','1'])).code,0);assert.deepEqual(f.calls.at(-1).args.members,[]);
 const retire=await f.cli(['project','retire','--key',JOB,'--revision','2','--manifest-sha256',RELEASE]);assert.equal(retire.code,0,retire.stderr);assert.match(retire.stderr,/original|retire-status/);assert.equal(f.calls.at(-1).args.key,JOB);
 assert.equal((await f.cli(['project','retire-status',JOB,'--project','alpha'])).code,0);
 for(const args of [['retire'],['retire','--key',JOB],['group','gggggggg-gggg-gggg-gggg-gggggggggggg'],['archive','--root'],['label','--display-name','name','--revision','-1'],['retire-status',JOB]])assert.equal((await f.cli(['project',...args])).code,1);
 assert.equal(f.calls.some(c=>['projects.create','projects.publish','jobs.submit','files.put'].includes(c.operation)),false);
});

test('member guide project-label command uses the real CLI option and rejects the misleading name alias before mutation',async t=>{
 const guide=await readFile(new URL('../docs/USER_GUIDE.md',import.meta.url),'utf8');
 const command=guide.match(/`gpuctl project label --display-name "([^"\n]+)"`/);
 assert.ok(command,'Member guide must document the actual --display-name option');
 assert.doesNotMatch(guide,/gpuctl project label --name(?:\s|`)/);
 const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
 f.custom.set('projects.label.get',args=>({...args,displayName:args.project,revision:3}));
 f.custom.set('projects.label.set',args=>({...args,revision:args.revision+1}));
 const value=await f.cli(['project','label','--display-name',command[1]]);
 assert.equal(value.code,0,value.stderr);assert.deepEqual(f.calls.at(-1),{operation:'projects.label.set',args:{machine:'gpu-1',project:'alpha',displayName:command[1],revision:3}});
 const before=f.calls.length,invalid=await f.cli(['project','label','--name',command[1]]);
 assert.equal(invalid.code,1);assert.deepEqual(f.calls.slice(before).map(c=>c.operation),['state'],'Invalid label alias may read authentication state but must never read or write a label');
});

test('project create/use is verified and remembered per machine; changing server never reuses another project',async t=>{
  const f=await fixture(t);
  assert.equal((await f.cli(['project','create','alpha'])).code,0);
  assert.deepEqual(f.calls.at(-1),{operation:'projects.create',args:{machine:'gpu-1',project:'alpha',environmentMode:'oci'}});
  assert.deepEqual(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine,{'gpu-1':'alpha'});
  assert.equal((await f.cli(['use','2'])).data.project,null);
  assert.equal((await f.cli(['project','use','beta'])).code,0);
  assert.deepEqual(f.calls.at(-1),{operation:'projects.status',args:{machine:'gpu-2',project:'beta'}});
  assert.equal((await f.cli(['use','1'])).data.project,'alpha');
  const cache=JSON.parse(await readFile(f.session,'utf8'));assert.deepEqual(cache.projectsByMachine,{'gpu-1':'alpha','gpu-2':'beta'});
  assert.equal((await stat(f.session)).mode&0o777,0o600);
  f.custom.set('projects.status',()=>{throw Error('project not found');});
  assert.equal((await f.cli(['project','use','missing'])).code,1);
  assert.equal(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine['gpu-1'],'alpha');
});

test('project list/status/publish use selected context; publication does not claim a submission key',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  assert.equal((await f.cli(['project','list'])).data.projects[0].project,'alpha');
  assert.deepEqual(f.calls.at(-1),{operation:'projects.list',args:{machine:'gpu-1'}});
  assert.equal((await f.cli(['project','status'])).code,0);
  assert.equal((await f.cli(['project','publish'])).code,0);
  assert.deepEqual(f.calls.at(-1),{operation:'projects.publish',args:{machine:'gpu-1',project:'alpha'}});
  assert.equal((await f.cli(['project','publish','--key',JOB])).code,1);
  assert.equal((await f.cli(['project','status','beta','--machine','2'])).code,0);
  assert.deepEqual(f.calls.at(-1),{operation:'projects.status',args:{machine:'gpu-2',project:'beta'}});
});

test('official same-host import is fixed-key, relative and draft-only; status/cancel use no local files',async t=>{
 const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
 f.custom.set('projects.local-import.begin',args=>({protocol:'project-local-import-v1',...args,state:'IMPORTING',draftChanged:false}));
 f.custom.set('projects.local-import.status',args=>({protocol:'project-local-import-v1',...args,state:'IMPORTED',draftChanged:true}));
 f.custom.set('projects.local-import.cancel',args=>({protocol:'project-local-import-v1',...args,state:'CANCELED',draftChanged:false}));
 const value=await f.cli(['project','import','source/code','incoming','--key',JOB]);
 assert.equal(value.code,0,value.stderr);assert.match(value.stderr,new RegExp(JOB));
 assert.deepEqual(f.calls.at(-1),{operation:'projects.local-import.begin',args:{machine:'gpu-1',project:'alpha',key:JOB,sourcePath:'source/code',destinationPath:'incoming'}});
 assert.equal((await f.cli(['project','import-status',JOB])).data.state,'IMPORTED');
 assert.equal((await f.cli(['project','import-cancel',JOB])).code,0);
 assert.equal(f.calls.some(c=>['files.put','projects.publish','jobs.submit'].includes(c.operation)),false);
 for(const args of [['import','/data1/legacy'],['import','source','../escape'],['import','source','--root'],['import-status','bad'],['import','source','--machine','foreign']])assert.equal((await f.cli(['project',...args])).code,1);
 f.custom.set('projects.local-import.begin',args=>({protocol:'project-local-import-v1',...args,key:randomUUID(),state:'IMPORTED',draftChanged:true}));
 assert.equal((await f.cli(['project','import','source','--key',JOB])).code,1);
});
test('pending upload cleanup discovers UUIDs without original source and never fabricates a target deletion',async t=>{
 const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
 f.custom.set('files.upload.list',args=>({protocol:1,project:args.project,uploads:[{uploadId:JOB,path:'bundle.tar',state:'UPLOADING',receivedBytes:1,totalSize:2,cancelable:true}]}));
 f.custom.set('files.upload.cancel',args=>({protocol:1,state:'CANCELED',uploadId:args.uploadId}));
 const listing=await f.cli(['project','uploads']);assert.equal(listing.code,0,listing.stderr);assert.equal(listing.data.uploads[0].uploadId,JOB);
 assert.equal((await f.cli(['project','upload-cancel',JOB])).code,0);
 assert.deepEqual(f.calls.at(-1),{operation:'files.upload.cancel',args:{machine:'gpu-1',project:'alpha',area:'code',uploadId:JOB}});
 for(const args of [['upload-cancel','bad'],['upload-cancel',JOB,'--root'],['uploads','extra']])assert.equal((await f.cli(['project',...args])).code,1);
 assert.equal(f.calls.some(c=>c.operation==='files.put'),false);
});
test('auto run pins the development release but sends opt-in target selection without changing saved context',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  for(const alias of ['--machine','--on']){
    const value=await f.cli(['run',alias,'auto','--release',RELEASE,'--candidates','2,1','--key',JOB,'-g','2','--','python','train.py']);
    assert.equal(value.code,0,value.stderr);
    assert.deepEqual(f.calls.at(-2),{operation:'projects.status',args:{machine:'gpu-1',project:'alpha'}});
    assert.deepEqual(f.calls.at(-1).args.machineSelection,{mode:'auto',candidates:['gpu-2','gpu-1']});
    assert.equal(f.calls.at(-1).args.machine,'auto');assert.equal(f.calls.at(-1).args.release,RELEASE);assert.equal(f.calls.at(-1).args.key,JOB);
    assert.equal(JSON.parse(await readFile(f.session,'utf8')).machine,'gpu-1');
  }
  for(const args of [['run','--machine','auto','--candidates','1,1'],['run','--machine','auto','--candidates','foreign'],['run','gpu-1','--machine','auto'],['run','--candidates','1']]){
    const before=f.calls.filter(c=>c.operation==='jobs.submit').length;
    assert.equal((await f.cli([...args,'--','true'])).code,1);assert.equal(f.calls.filter(c=>c.operation==='jobs.submit').length,before);
  }
});

test('immutable OCI project copy uses source/target and fixed key; status/cancel remain owner-scoped handles',async t=>{
  const f=await fixture(t);
  f.custom.set('projects.replicate',args=>({id:args.key,...args,state:'PREPARING',developmentChanged:false}));
  const copied=await f.cli(['project','copy','alpha','--from','1','--to','2','--release',RELEASE,'--key',JOB]);
  assert.equal(copied.code,0,copied.stderr);assert.equal(copied.data.developmentChanged,false);
  assert.deepEqual(f.calls.at(-1),{operation:'projects.replicate',args:{from:'gpu-1',machine:'gpu-2',project:'alpha',release:RELEASE,key:JOB}});
  for(const [command,operation] of [['copy-status','status'],['copy-cancel','cancel']]){
    assert.equal((await f.cli(['project',command,JOB])).code,0);
    assert.deepEqual(f.calls.at(-1),{operation:'projects.replication.'+operation,args:{id:JOB}});
  }
  const retryKey='00000000-0000-4000-8000-000000000123';
  const retried=await f.cli(['project','copy-retry',JOB,'--key',retryKey]);
  assert.equal(retried.code,0,retried.stderr);assert.match(retried.stderr,new RegExp(retryKey));
  assert.deepEqual(f.calls.at(-1),{operation:'projects.replication.retry',args:{id:JOB,key:retryKey}});
  for(const args of [['copy-retry','bad-id'],['copy-retry',JOB,'--key','bad-key'],['copy-retry',JOB,'--to','1']]){
    assert.equal((await f.cli(['project',...args])).code,1);assert.equal(f.calls.filter(c=>c.operation==='projects.replication.retry').length,1);
  }
  const before=f.calls.filter(c=>c.operation==='projects.replicate').length;
  for(const args of [['--from','1','--to','1','--release',RELEASE],['--from','1','--to','2'],['--from','foreign','--to','2','--release',RELEASE]])assert.equal((await f.cli(['project','copy','alpha',...args])).code,1);
  assert.equal(f.calls.filter(c=>c.operation==='projects.replicate').length,before);
});
test('project quota queries only the selected machine and preserves unknown disabled usage',async t=>{
 const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
 f.custom.set('projects.quota',()=>({enabled:false,enforcement:null,owner:principal.userId,volumes:null}));
 const value=await f.cli(['project','quota']);assert.equal(value.code,0,value.stderr);assert.equal(value.data.volumes,null);
 assert.deepEqual(f.calls.at(-1),{operation:'projects.quota',args:{machine:'gpu-1'}});
 for(const args of [['project','quota','alpha'],['project','quota','--project','alpha'],['project','quota','--env-mode','oci']]){
  const before=f.calls.filter(c=>c.operation==='projects.quota').length;assert.equal((await f.cli(args)).code,1);assert.equal(f.calls.filter(c=>c.operation==='projects.quota').length,before);
 }
});
test('quota cohort exclusion explains personal not-enabled state without claiming zero usage',async t=>{
 const f=await fixture(t);
 f.custom.set('projects.quota',()=>({enabled:false,enforcement:null,owner:principal.userId,volumes:null,reason:'OWNER_NOT_ACTIVATED'}));
 const value=await f.cli(['project','quota'],'',null,true);assert.equal(value.code,0,value.stderr);
 assert.match(value.stdout,/你的工作区尚未纳入/);assert.match(value.stdout,/不是零用量/);assert.doesNotMatch(value.stdout,/这台服务器尚未启用/);
});
test('project create defaults to personal OCI and rejects old mode flags without mutation',async t=>{
  const f=await fixture(t);
  for(const flags of [[],['--env-mode','oci']]){
    assert.equal((await f.cli(['project','create','clean',...flags])).code,0);
    assert.deepEqual(f.calls.at(-1),{operation:'projects.create',args:{machine:'gpu-1',project:'clean',environmentMode:'oci'}});
  }
  for(const args of [['project','create','bad','--env-mode','auto'],['project','create','bad','--env-mode','shared'],['project','create','bad','--env-mode','isolated'],['project','status','clean','--env-mode','isolated'],['project','publish','clean','--env-mode','isolated'],['ssh','--env-mode','isolated']]){
    const before=f.calls.filter(call=>call.operation!=='state').length;
    assert.equal((await f.cli(args)).code,1);assert.equal(f.calls.filter(call=>call.operation!=='state').length,before);
  }
  f.custom.set('projects.create',args=>({project:args.project,state:'DRAFT'}));
  const unsupported=await f.cli(['project','create','unsupported']);
  assert.equal(unsupported.code,1);assert.match(unsupported.stderr,/did not confirm.*personal container/);
  assert.notEqual(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine['gpu-1'],'unsupported');
});

test('terminal open/exchange/close preserve selected project and use top-level rows/cols',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const preload=join(f.dir,'fake-tty.mjs');
  await writeFile(preload,'Object.defineProperty(process.stdin,"isTTY",{value:true});process.stdin.setRawMode=()=>process.stdin;');
  f.custom.set('terminal.open',terminalOpen);
  f.custom.set('terminal.exchange',()=>({offset:0,data:'',exited:true}));
  f.custom.set('terminal.close',()=>({closed:true}));
  const result=await f.cli(['ssh'],'',preload);assert.equal(result.code,0,result.stderr);
  const calls=f.calls.filter(c=>c.operation.startsWith('terminal.'));assert.equal(calls.length,3);
  for(const c of calls){assert.equal(c.args.machine,'gpu-1');assert.equal(c.args.project,'alpha');assert.equal(c.args.hostAdmin,false);}
  assert.equal(calls[1].args.cols,110);assert.equal(calls[1].args.rows,32);assert.equal('size'in calls[1].args,false);
  f.calls.length=0;assert.equal((await f.cli(['ssh','--root'],'',preload)).code,0);
  for(const c of f.calls.filter(c=>c.operation.startsWith('terminal.'))){assert.equal(c.args.hostAdmin,true);assert.equal('project'in c.args,false);}
});
test('same login CLI invocations create separate clients and reconnect/takeover is explicit',async t=>{
  const f=await fixture(t),preload=join(f.dir,'isolated-tty.mjs');
  await writeFile(preload,'Object.defineProperty(process.stdin,"isTTY",{value:true});process.stdin.setRawMode=()=>process.stdin;');
  f.custom.set('terminal.open',terminalOpen);
  f.custom.set('terminal.exchange',()=>({offset:0,data:'',exited:true}));
  f.custom.set('terminal.close',()=>({closed:true}));
  for(let n=0;n<2;n++)assert.equal((await f.cli(['ssh'],'',preload)).code,0);
  const opens=f.calls.filter(call=>call.operation==='terminal.open');
  assert.equal(opens.length,2);assert.notEqual(opens[0].args.clientId,opens[1].args.clientId);assert.notEqual(opens[0].args.key,opens[1].args.key);
  for(const call of opens){assert.equal(call.args.mode,'new');assert.equal('id'in call.args,false);}
  assert.equal((await f.cli(['ssh','--reconnect',JOB,'--takeover'],'',preload)).code,0);
  const reconnect=f.calls.filter(call=>call.operation==='terminal.open').at(-1).args;
  assert.equal(reconnect.id,JOB);assert.equal(reconnect.mode,'reconnect');assert.equal(reconnect.takeover,true);
  const invalid=await f.cli(['ssh','--takeover'],'',preload);assert.equal(invalid.code,1);assert.match(invalid.stderr,/requires --reconnect/);
});

test('Ctrl+] releases the writer lease instead of closing the retained PTY',async t=>{
  const f=await fixture(t),preload=join(f.dir,'detach-tty.mjs');
  await writeFile(preload,'Object.defineProperty(process.stdin,"isTTY",{value:true});process.stdin.setRawMode=value=>{if(value)setTimeout(()=>process.stdin.emit("data",Buffer.from([29])),30);return process.stdin;};');
  f.custom.set('terminal.open',terminalOpen);
  f.custom.set('terminal.exchange',()=>({offset:0,data:'',exited:false}));
  f.custom.set('terminal.detach',()=>({detached:true}));
  const result=await f.cli(['ssh'],'',preload);assert.equal(result.code,0,result.stderr);
  assert.equal(f.calls.some(call=>call.operation==='terminal.close'),false);
  assert.equal(f.calls.filter(call=>call.operation==='terminal.detach').length,1);
  assert.match(result.stderr,/--reconnect/);
});
test('terminal status/close are noninteractive exact-ID recovery commands, never open or stop a live terminal',async t=>{
 const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
 f.custom.set('terminal.status',args=>({protocol:'terminal-session-status-v1',id:args.id,state:'UNKNOWN',evidence:{confirmed:false}}));
 f.custom.set('terminal.close',args=>({protocol:'terminal-session-status-v1',id:args.id,state:'STOPPED',closed:true,metadataOnly:true}));
 assert.equal((await f.cli(['terminal','status',JOB])).data.state,'UNKNOWN');
 assert.deepEqual(f.calls.at(-1),{operation:'terminal.status',args:{machine:'gpu-1',project:'alpha',hostAdmin:false,id:JOB}});
 assert.equal((await f.cli(['terminal','close',JOB])).code,0);
 assert.equal((await f.cli(['terminal','status',JOB,'--root','--machine','2'])).code,0);
 assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-2',id:JOB,hostAdmin:true});
 assert.equal((await f.cli(['terminal','status',JOB,'--data-workspace'])).code,0);
 assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-1',id:JOB,hostAdmin:false,dataWorkspace:true});
 for(const args of [['status','bad'],['close',JOB,'--takeover'],['status',JOB,'--root','--project','alpha'],['status',JOB,'--data-workspace','--project','alpha'],['status',JOB,'--machine','foreign'],['status',JOB,'extra']])assert.equal((await f.cli(['terminal',...args])).code,1);
 f.custom.set('terminal.close',args=>({protocol:'terminal-session-status-v1',id:args.id,closed:true,state:'ALIVE',metadataOnly:false}));
 assert.equal((await f.cli(['terminal','close',JOB])).code,1);
 assert.ok(f.calls.filter(c=>c.operation.startsWith('terminal.')).every(c=>!('writerToken'in c.args)&&!('clientId'in c.args)&&!('input'in c.args)));
 assert.equal(f.calls.some(c=>['terminal.open','terminal.exchange'].includes(c.operation)),false);
});

test('run uses live workspace without publishing; exact argv and dataset refs preserved',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const result=await f.cli(['run','-g','2','--key',JOB,'--data','images@'+OLDER,'--','python','train.py','-g','private','--json']);
  assert.equal(result.code,0,result.stderr);
  assert.deepEqual(f.calls.at(-2),{operation:'projects.workspace',args:{machine:'gpu-1',project:'alpha'}});
  assert.deepEqual(f.calls.at(-1),{operation:'jobs.submit',args:{machine:'gpu-1',cards:2,minVramGiB:0,name:'train',argv:['python','train.py','-g','private','--json'],key:JOB,project:'alpha',datasets:[{dataset:'images',version:OLDER}],prepareData:true}});
  assert.equal(f.calls.some(c=>c.operation==='projects.publish'),false);
  assert.equal((await f.cli(['run','--release',OLDER,'--','python','train.py'])).code,0);
  assert.equal(f.calls.at(-1).args.release,OLDER);
});

test('run refuses missing or unready release before jobs.submit and never chooses another machine',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  f.setReleases([{release:RELEASE,state:'PUBLISHING'}],RELEASE);
  let result=await f.cli(['run','--release',RELEASE,'--','true']);assert.equal(result.code,1);assert.match(result.stderr,/project publish/);
  assert.equal(f.calls.some(c=>c.operation==='jobs.submit'),false);
  f.calls.length=0;result=await f.cli(['run','auto','--legacy','--','true']);assert.equal(result.code,1);assert.match(result.stderr,/手选服务器/);
  assert.equal(f.calls.some(c=>c.operation!=='state'),false);
  f.calls.length=0;result=await f.cli(['run','--legacy','--release',RELEASE,'--','true']);assert.equal(result.code,1);
  assert.equal(f.calls.some(c=>c.operation==='jobs.submit'),false);
});

test('project override is temporary and legacy jobs keep their old exact request shape',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  assert.equal((await f.cli(['run','--project','beta','--','true'])).code,0);assert.equal(f.calls.at(-1).args.project,'beta');
  assert.equal(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine['gpu-1'],'alpha');
  assert.equal((await f.cli(['run','--legacy','--key',JOB,'--','true'])).code,0);
  assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-1',cards:1,minVramGiB:0,name:'train',argv:['true'],key:JOB});
  assert.equal((await f.cli(['run','--legacy','--project','alpha','--','true'])).code,1);
});

test('project code upload uses full-file digest + stable upload id + final chunk and skips known secrets/envs',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const source=join(f.dir,'code'),bytes=Buffer.alloc(1024*1024+17,67);await mkdir(source);
  await writeFile(join(source,'train.py'),bytes);await writeFile(join(source,'.env'),'secret');await writeFile(join(source,'.env.example'),'example');
  await writeFile(join(source,'sample.pem'),'ordinary fixture');await mkdir(join(source,'.venv'));await writeFile(join(source,'.venv','ignored'),'local env');
  const result=await f.cli(['push',source]);assert.equal(result.code,0,result.stderr);assert.equal(result.data.uploaded,3);assert.equal(result.data.skipped,2);
  const all=f.calls.filter(c=>c.operation==='files.put').map(c=>c.args),chunks=all.filter(a=>a.path==='train.py');assert.equal(chunks.length,2);
  assert.equal(chunks[0].sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(chunks[0].uploadId,chunks[1].uploadId);
  assert.equal(chunks[0].final,false);assert.equal(chunks[1].final,true);assert.equal(chunks[1].offset,1024*1024);
  for(const c of chunks){assert.equal(c.project,'alpha');assert.equal(c.area,'code');assert.equal(c.totalSize,bytes.length);assert.equal('truncate'in c,false);}
  assert.equal(all.some(a=>a.path==='.env'),false);assert.equal(all.some(a=>a.path==='sample.pem'),true);assert.equal(all.some(a=>a.path==='.env.example'),true);
});
test('push-status hashes original local input and only queries the owned upload',async t=>{
 const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
 const source=join(f.dir,'bundle');await writeFile(source,'owned bytes');
 const result=await f.cli(['push-status',source,'bundle.tar']);
 assert.equal(result.code,0,result.stderr);assert.equal(result.data.readOnly,true);
 assert.equal(result.data.files[0].state,'ABSENT');
 const query=f.calls.find(c=>c.operation==='files.upload.status');assert.equal(query.args.path,'bundle.tar');
 assert.equal(query.args.sha256,createHash('sha256').update('owned bytes').digest('hex'));
 assert.equal(f.calls.some(c=>c.operation==='files.put'||c.operation==='projects.publish'||c.operation==='jobs.submit'),false);
});

test('empty project files finalize correctly; mutation during upload rejects without a final chunk',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const empty=join(f.dir,'empty');await writeFile(empty,'');assert.equal((await f.cli(['push',empty])).code,0);
  const zero=f.calls.at(-1).args;assert.equal(zero.final,true);assert.equal(zero.totalSize,0);assert.equal(zero.data,'');
  const source=join(f.dir,'change.py');await writeFile(source,Buffer.alloc(1024*1024+99,65));
  f.calls.length=0;f.custom.set('files.put',async()=>{await writeFile(source,'changed');return {};});
  const result=await f.cli(['push',source]);assert.equal(result.code,1);assert.match(result.stderr,/changed/);
  assert.equal(f.calls.filter(c=>c.operation==='files.put').some(c=>c.args.final),false);
});

test('project files over the former 4 GiB cap warn and recover an exact verified upload',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const source=join(f.dir,'dataset.bin'),fd=await open(source,'w');await fd.truncate(4*1024**3+1);await fd.close();
  f.custom.set('files.upload.status',args=>({protocol:2,state:'COMPLETE',complete:true,
    path:args.path,totalSize:args.totalSize,sha256:args.sha256,uploadId:JOB,
    size:args.totalSize,receivedBytes:args.totalSize,completionPending:false}));
  const result=await f.cli(['push',source]);assert.equal(result.code,0,result.stderr);assert.match(result.stderr,/超过 4 GiB.*仍允许上传/);
  const query=f.calls.find(c=>c.operation==='files.upload.status');
  assert.equal(query.args.totalSize,4*1024**3+1);assert.match(query.args.sha256,/^[a-f0-9]{64}$/);
  assert.equal(f.calls.some(c=>c.operation==='files.put'),false);
});

test('project upload does not claim success without matching server verification receipt',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const source=join(f.dir,'file');await writeFile(source,'verified');f.custom.set('files.put',()=>({complete:false}));
  const result=await f.cli(['push',source]);assert.equal(result.code,1);assert.match(result.stderr,/did not confirm/);
});

test('files/pull target only selected project outputs and reject output writes',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  assert.equal((await f.cli(['files'])).code,0);assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-1',path:'.',project:'alpha',area:'code'});
  assert.equal((await f.cli(['files','checkpoints','--job',JOB])).code,0);
  assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-1',path:'checkpoints',project:'alpha',area:'output',runId:JOB});
  const output=join(f.dir,'model.pt');assert.equal((await f.cli(['pull','--job',JOB,'model.pt',output])).code,0);
  assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-1',path:'model.pt',offset:0,project:'alpha',area:'output',runId:JOB});
  assert.equal(await readFile(output,'utf8'),'checkpoint');
  assert.equal((await f.cli(['push',output,'--job',JOB])).code,1);
  assert.equal((await f.cli(['files','--legacy','--job',JOB])).code,1);
});

test('legacy uploads retain truncate format; explicit files machine remains compatible',async t=>{
  const f=await fixture(t);await f.save({projectsByMachine:{'gpu-1':'alpha'}});
  const source=join(f.dir,'file');await writeFile(source,'legacy');assert.equal((await f.cli(['push',source,'--legacy'])).code,0);
  assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-1',path:'file',offset:0,truncate:true,data:Buffer.from('legacy').toString('base64')});
  assert.equal((await f.cli(['files','gpu-2','subdir'])).code,0);assert.deepEqual(f.calls.at(-1).args,{machine:'gpu-2',path:'subdir'});
});

test('login preserves per-machine projects only for the same principal',async t=>{
  const f=await fixture(t);const projectsByMachine={'gpu-1':'alpha','gpu-2':'beta'};await f.save({projectsByMachine});
  assert.equal((await f.cli(['login','tester','--password-stdin'],'test-only\n')).code,0);
  assert.deepEqual(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine,projectsByMachine);
  await f.save({principal:{...principal,userId:'demo-user-99'},projectsByMachine});
  assert.equal((await f.cli(['login','tester','--password-stdin'],'test-only\n')).code,0);
  assert.equal(JSON.parse(await readFile(f.session,'utf8')).projectsByMachine,undefined);
});

test('invalid slugs, releases and UUIDs fail before any API work',async t=>{
  const f=await fixture(t);
  for(const args of [['files','--project','../escape'],['run','--release','bad','--','true'],['pull','--job','not-an-id','x','y']]){
    assert.equal((await f.cli(args)).code,1);
  }
  assert.equal(f.calls.length,0);
  assert.equal((await f.cli(['project','create','bad/name'])).code,1);assert.equal(f.calls.some(c=>c.operation==='projects.create'),false);
});
