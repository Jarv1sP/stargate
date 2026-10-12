import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {parseCLIOptions,synchronizeProjectRun} from '../cli.mjs';

const OLD='a'.repeat(64),FRESH='b'.repeat(64),key='11111111-2222-4333-8444-555555555555';
async function fixture(t,{states=['PUBLISHING','READY'],before={}}={}){
  const directory=await mkdtemp(join(tmpdir(),'gpuq-run-sync-'));
  await writeFile(join(directory,'train.py'),'print("new code")\n');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const calls=[],uploaded=[];let started=false,index=0;
  const status=state=>({project:'alpha',publicationProtocol:1,state,latestReadyRelease:OLD,
    releases:[{release:OLD,state:'READY'},{release:FRESH,state:'READY'}],
    publication:{id:key,state,...(state==='READY'?{release:FRESH}:{})}});
  const call=async(operation,args)=>{
    calls.push({operation,args});
    if(operation==='files.upload.status')return {result:{protocol:2,state:'ABSENT',complete:false,path:args.path,receivedBytes:0}};
    if(operation==='files.put'){if(args.final)uploaded.push({path:args.path,size:args.totalSize,sha256:args.sha256});return {result:{complete:args.final,size:args.totalSize,sha256:args.sha256}};}
    if(operation.startsWith('projects.snapshot.')){
      assert.equal(args.release,FRESH);const raw=Buffer.from(JSON.stringify({schema:1,directories:[],files:uploaded}));
      return {result:operation.endsWith('.info')?{state:'READY',manifestBytes:raw.length,manifestSha256:createHash('sha256').update(raw).digest('hex'),entries:uploaded.length}: {offset:raw.length,size:raw.length,data:raw.toString('base64')}};
    }
    if(operation==='projects.publish'){started=true;assert.equal(args.key,key);return {result:status(states[index++])};}
    if(operation==='projects.status')return {result:started?status(states[Math.min(index++,states.length-1)]):{...status('READY'),...before}};
    throw Error('Unexpected operation');
  };
  const options={machine:'gpu-1',project:'alpha',directory,key,pollMs:1,timeoutMs:1000,progress:()=>{}};
  return {directory,calls,call,options};
}

test('sync flag stays before argv separator; Windows paths are literal option values',()=>{
  const parsed=parseCLIOptions(['run','--sync','--sync-dir','C:\\研究代码 & notes\\项目','--','python','train.py','--sync']);
  assert.equal(parsed.options.sync,true);assert.equal(parsed.options['sync-dir'],'C:\\研究代码 & notes\\项目');
  assert.deepEqual(parsed.training,['python','train.py','--sync']);
});
test('verified upload then own publication pins its release, never latest old READY',async t=>{
  const f=await fixture(t);assert.equal(await synchronizeProjectRun(f.call,f.options),FRESH);
  assert.deepEqual(f.calls.map(c=>c.operation),['projects.status','files.upload.status','files.put','projects.publish','projects.status','projects.snapshot.info','projects.snapshot.manifest','projects.snapshot.info']);
  assert.ok(f.calls.every(c=>c.args.machine==='gpu-1'&&c.args.project==='alpha'&&!('hostAdmin'in c.args)&&!('userId'in c.args)));
});
test('legacy capability or busy/unknown project rejects before local upload',async t=>{
  for(const before of [{publicationProtocol:undefined},{publicationProtocol:2},{state:'PUBLISHING'},{state:'UNKNOWN'},{state:'SYNCING'}]){
    const f=await fixture(t,{before});await assert.rejects(synchronizeProjectRun(f.call,f.options));
    assert.deepEqual(f.calls.map(c=>c.operation),['projects.status']);
  }
});
test('partial or wrong upload receipt never triggers publish',async t=>{
  for(const response of [{complete:false},{complete:true,size:0,sha256:OLD}]){
    const f=await fixture(t),call=(op,args)=>op==='files.put'?Promise.resolve({result:response}):f.call(op,args);
    await assert.rejects(synchronizeProjectRun(call,f.options),/confirm/);
    assert.equal(f.calls.some(c=>c.operation==='projects.publish'),false);
  }
});
test('all failure and unconfirmed publication states stop, despite older READY',async t=>{
  for(const state of ['FAILED','UNKNOWN','DRAFT','SYNCING']){
    const f=await fixture(t,{states:['PUBLISHING',state]});await assert.rejects(synchronizeProjectRun(f.call,f.options),/no job was submitted/);
    assert.equal(f.calls.filter(c=>c.operation==='projects.publish').length,1);
  }
});
test('replaced publication, absent proof and invalid committed release cannot pass',async t=>{
  for(const change of [{publication:{id:randomUUID(),state:'READY',release:FRESH}},{publication:undefined},{publication:{id:key,state:'READY',release:'latest'}},{publication:{id:key,state:'READY',release:'c'.repeat(64)}}]){
    const f=await fixture(t,{states:['READY']}),call=async(op,args)=>{
      const response=await f.call(op,args);return op==='projects.publish'?{result:{...response.result,...change}}:response;
    };
    await assert.rejects(synchronizeProjectRun(call,f.options));
  }
});
test('lost publication reply does not resend publish or choose a READY fallback',async t=>{
  const f=await fixture(t);await assert.rejects(synchronizeProjectRun(async(op,args)=>{
    const response=await f.call(op,args);if(op==='projects.publish')throw Error('connection lost');return response;
  },f.options),/connection lost/);
  assert.equal(f.calls.filter(c=>c.operation==='projects.publish').length,1);
  assert.equal(f.calls.filter(c=>c.operation==='projects.status').length,1);
});
test('a concurrent edit before publication cannot make different code pass as this sync',async t=>{
  const f=await fixture(t),raw=Buffer.from(JSON.stringify({schema:1,directories:[],files:[{path:'train.py',size:999,sha256:OLD}]}));
  await assert.rejects(synchronizeProjectRun(async(op,args)=>{
    if(op==='projects.snapshot.info')return {result:{state:'READY',manifestBytes:raw.length,manifestSha256:createHash('sha256').update(raw).digest('hex'),entries:1}};
    if(op==='projects.snapshot.manifest')return {result:{offset:raw.length,size:raw.length,data:raw.toString('base64')}};
    return f.call(op,args);
  },f.options),/differs from the uploaded/);
});
test('bounded publication wait exits without a new worker or a job',async t=>{
  const f=await fixture(t,{states:['PUBLISHING']});
  await assert.rejects(synchronizeProjectRun(f.call,{...f.options,timeoutMs:15,pollMs:100}),/timed out/);
  assert.equal(f.calls.filter(c=>c.operation==='projects.publish').length,1);
});
test('empty or excluded-only directories cannot silently submit the previous draft',async t=>{
  const f=await fixture(t);await rm(join(f.directory,'train.py'));
  await writeFile(join(f.directory,'.env'),'not uploaded');
  await assert.rejects(synchronizeProjectRun(f.call,f.options),/No code/);
  assert.equal(f.calls.some(c=>c.operation==='files.put'||c.operation==='projects.publish'),false);
});
test('symlink input rejected without publication; no host shell is involved',async t=>{
  const f=await fixture(t);await symlink(join(f.directory,'train.py'),join(f.directory,'linked.py'));
  await assert.rejects(synchronizeProjectRun(f.call,f.options),/Symlink/);
  assert.equal(f.calls.some(c=>c.operation==='projects.publish'),false);
});
test('an earlier uploaded file changing while a later file uploads prevents publication',async t=>{
  const f=await fixture(t);await writeFile(join(f.directory,'zz-last.py'),'last');
  await assert.rejects(synchronizeProjectRun(async(op,args)=>{
    const response=await f.call(op,args);if(op==='files.put'&&args.path==='zz-last.py')await writeFile(join(f.directory,'train.py'),'changed after upload');return response;
  },f.options),/tree changed/);
  assert.equal(f.calls.some(c=>c.operation==='projects.publish'),false);
});

test('real CLI loopback: upload directly to workspace and submit once without publishing',async t=>{
  const f=await fixture(t),directory=join(f.directory,'研究 project & space');await mkdir(directory);await writeFile(join(directory,'train.py'),'new');
  const session=join(f.directory,'session.json'),calls=[],principal={userId:'member-test',role:'member',username:'测试'};
  let publication=null,failed=false,lostSubmit=false;const uploaded=new Map();
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});
    res.setHeader('Content-Type','application/json');assert.equal(req.headers.authorization,'Bearer fixture-only');
    if(operation==='state')return res.end(JSON.stringify({state:{demo:false,gpuqConnected:true,machines:[{id:'gpu-1'}],users:[],jobs:[]}}));
    let result;
    if(operation==='projects.workspace'){
      if(failed){res.statusCode=409;return res.end(JSON.stringify({error:'workspace unavailable'}));}
      result={project:args.project,state:'AVAILABLE',workspace:{protocol:1,persistent:true}};
    }
    else if(operation==='files.upload.status')result={protocol:2,state:'ABSENT',complete:false,path:args.path,receivedBytes:0};
    else if(operation==='files.put'){uploaded.set(args.path,{path:args.path,size:args.totalSize,sha256:args.sha256});result={complete:args.final,size:args.totalSize,sha256:args.sha256};}
    else if(operation.startsWith('projects.snapshot.')){
      assert.equal(args.release,FRESH);const raw=Buffer.from(JSON.stringify({schema:1,directories:[],files:[...uploaded.values()]}));
      result=operation.endsWith('.info')?{state:'READY',manifestBytes:raw.length,manifestSha256:createHash('sha256').update(raw).digest('hex'),entries:uploaded.size}:{offset:raw.length,size:raw.length,data:raw.toString('base64')};
    }
    else if(operation==='projects.publish'){publication=args.key;result={publicationProtocol:1,state:'PUBLISHING',publication:{id:publication,state:'PUBLISHING'}};}
    else if(operation==='projects.status')result={publicationProtocol:1,state:failed&&publication?'FAILED':'READY',latestReadyRelease:OLD,releases:[{release:FRESH,state:'READY'},{release:OLD,state:'READY'}],...(publication?{publication:{id:publication,state:failed?'FAILED':'READY',...(failed?{}:{release:FRESH})}}:{})};
    else if(operation==='jobs.submit'){if(lostSubmit){req.socket.destroy();return;}result={id:key,machine:'gpu-1',state:'QUEUED',cards:1};}
    else throw Error('Unexpected '+operation);
    res.end(JSON.stringify({result}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  await writeFile(session,JSON.stringify({url,token:'fixture-only',principal,machine:'gpu-1',projectsByMachine:{'gpu-1':'alpha'}}),{mode:0o600});
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const cli=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--url',url,'--session-file',session,'--json',...args],{cwd:directory,windowsHide:true});
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  let result=await cli(['run','--sync','--key',key,'--','python','train.py','--name','hello & world']);assert.equal(result.code,0,result.stderr);
  assert.equal(calls.filter(c=>c.operation==='jobs.submit').length,1);
  assert.deepEqual(calls.at(-1).args,{machine:'gpu-1',cards:1,minVramGiB:0,name:'train',argv:['python','train.py','--name','hello & world'],key,project:'alpha'});
  assert.equal(calls.some(c=>c.operation==='projects.publish'||c.operation.startsWith('projects.snapshot.')),false);
  const before=await readFile(session,'utf8');calls.length=0;failed=true;
  result=await cli(['run','--sync','--sync-dir',directory,'--','python','train.py']);assert.equal(result.code,1);assert.equal(calls.some(c=>c.operation==='jobs.submit'),false);
  assert.equal(await readFile(session,'utf8'),before);
  for(const args of [['run','--sync','--legacy'],['run','--sync','--release',OLD],['run','--sync','--root'],['run','--sync','--job',key],['push','--sync'],['run','--sync-dir',directory]]){
    calls.length=0;assert.equal((await cli([...args,'--','true'])).code,1);assert.equal(calls.some(c=>['files.put','projects.publish','jobs.submit'].includes(c.operation)),false);
  }
  calls.length=0;failed=false;lostSubmit=true;
  result=await cli(['run','--sync','--key',key,'--','true']);assert.equal(result.code,1);assert.equal(calls.filter(c=>c.operation==='jobs.submit').length,1);
  assert.ok(calls.every(c=>!('hostAdmin'in c.args)&&!('userId'in c.args)));
});
