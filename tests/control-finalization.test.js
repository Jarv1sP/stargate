import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createWindowsControlFetch,finishPlatformControlTransport} from '../client-windows-control.mjs';
import {apiPost} from '../client-http.mjs';

const key='11111111-1111-4111-8111-111111111111',origin='https://portal.example';
test('successful finalization awaits shutdown without a warning',async()=>{
  let closed=false;const warnings=[];
  await finishPlatformControlTransport({close:async()=>{await new Promise(r=>setImmediate(r));closed=true;}},{warn:code=>warnings.push(code)});
  assert.equal(closed,true);assert.deepEqual(warnings,[]);
});
test('shutdown confirmation failure only emits its bounded code',async()=>{
  const warnings=[];
  await finishPlatformControlTransport({close:async()=>{throw Object.assign(Error('secret token /private/path'),{code:'NATIVE_EXIT_UNCONFIRMED'});}},{warn:code=>warnings.push(code)});
  assert.deepEqual(warnings,['NATIVE_EXIT_UNCONFIRMED']);
});
test('untrusted cleanup details and a broken warning sink never replace a result',async()=>{
  const warnings=[];
  await finishPlatformControlTransport({close:async()=>{throw Object.assign(Error('private token'),{code:'secret-token\nunsafe'});}},{warn:code=>warnings.push(code)});
  assert.deepEqual(warnings,['CONTROL_CLEANUP_UNCONFIRMED']);
  await finishPlatformControlTransport({close:async()=>{throw Error('private token');}},{warn:()=>{throw Error('stderr closed');}});
});
for(const operation of ['community.comments.create','projects.create','jobs.submit']){
  test(`${operation}: complete receipt survives shutdown failure and sends exactly once`,async()=>{
    let requests=0;const warnings=[];
    const transport=createWindowsControlFetch(origin,{agentFactory:()=>({
      request:async(_header,bytes)=>{requests++;assert.equal(JSON.parse(bytes).args.key,key);return {value:{status:200},raw:Buffer.from(JSON.stringify({result:{id:'original-operation',state:'READY'}}))};},
      destroy:async()=>{throw Object.assign(Error('private token'),{code:'NATIVE_EXIT_UNCONFIRMED'});}
    })});
    let result;
    try{result=await apiPost(origin,'call',{operation,args:{key}},{fetchImpl:transport.fetchImpl});}
    finally{await finishPlatformControlTransport(transport,{warn:code=>warnings.push(code)});}
    assert.deepEqual(result,{result:{id:'original-operation',state:'READY'}});assert.equal(requests,1);assert.deepEqual(warnings,['NATIVE_EXIT_UNCONFIRMED']);
  });
  test(`${operation}: lost ACK plus failed shutdown retains original uncertainty and key`,async()=>{
    let requests=0;const warnings=[];
    const transport=createWindowsControlFetch(origin,{agentFactory:()=>({
      request:async(_header,bytes)=>{requests++;assert.equal(JSON.parse(bytes).args.key,key);throw Object.assign(Error('fixture-private-token'),{code:'ACK_UNCONFIRMED',writeMayHaveReachedPeer:true});},
      destroy:async()=>{throw Object.assign(Error('private path'),{code:'NATIVE_EXIT_UNCONFIRMED'});}
    })});
    const work=async()=>{try{return await apiPost(origin,'call',{operation,args:{key}},{fetchImpl:transport.fetchImpl,sleep:async()=>{throw Error('mutation replay');}});}
      finally{await finishPlatformControlTransport(transport,{warn:code=>warnings.push(code)});}};
    await assert.rejects(work(),error=>/操作结果尚未确认/.test(error.message)&&!error.message.includes('private'));
    assert.equal(requests,1);assert.deepEqual(warnings,['NATIVE_EXIT_UNCONFIRMED']);
  });
}

function run(args){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
  child.on('error',reject);child.on('close',exit=>resolve({exit,stdout,stderr}));
});}
for(const mode of ['normal','shutdown-timeout','denied','lost-ack','pending-completion'])test(`actual CLI preserves business outcome: ${mode}`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stargate-control-result-'));
  try{
    const session=join(dir,'session.json'),proof=join(dir,'proof.json'),loader=join(dir,'loader.mjs');
    await writeFile(session,JSON.stringify({url:origin,token:'fixture-session-token',principal:{userId:'fixture-user',username:'member',role:'member'}}),{mode:0o600});
    const native=new URL('../client-campus-native.mjs',import.meta.url).href,fixture=new URL('./control-finalization-fixture.mjs',import.meta.url).href;
    const source=`export * from ${JSON.stringify(native+'?finalization-fixture-real')};\nimport {fixtureAgent,fixtureRuntime} from ${JSON.stringify(fixture)};\nexport const resolveCampusNativeRuntime=fixtureRuntime;\nexport const createCampusNativeAgent=(pin,options)=>fixtureAgent(pin,options,${JSON.stringify({mode,proof})});`;
    await writeFile(loader,`import {registerHooks} from 'node:module';registerHooks({load(url,context,next){if(url===${JSON.stringify(native)})return {format:'module',source:${JSON.stringify(source)},shortCircuit:true};return next(url,context);}});`,{mode:0o600});
    const command=mode==='pending-completion'?['completion',key]:['community','comment','53','--body','fixture comment','--key',key];
    const result=await run(['--import',pathToFileURL(loader).href,fileURLToPath(new URL('../cli.mjs',import.meta.url)),...command,'--url',origin,'--session-file',session,'--json']);
    const stats=JSON.parse(await readFile(proof,'utf8').catch(error=>{throw Error(`CLI did not reach the fixture (exit ${result.exit}): ${result.stdout}\n${result.stderr}`,{cause:error});}));
    assert.equal(stats.announcementReads,1);assert.equal(stats.calls.length,1);assert.notEqual(stats.calls[0].operation,'state');
    assert.doesNotMatch(result.stdout+result.stderr,/fixture-session-token|private path/);
    if(mode==='denied'||mode==='lost-ack'){
      assert.equal(result.exit,1);assert.equal(result.stdout,'');
      const failure=JSON.parse(result.stderr.trim().split('\n').find(line=>line.startsWith('{')));
      assert.equal(failure.ok,false);assert.match(failure.error,mode==='denied'?/HTTP 403.*fixture permission denied/:/操作结果尚未确认/);
      assert.doesNotMatch(failure.error,/NATIVE_EXIT_UNCONFIRMED/);
    }else{
      assert.equal(result.exit,mode==='pending-completion'?2:0,result.stderr);
      const reply=JSON.parse(result.stdout);assert.equal(reply.ok,true);
      if(mode==='pending-completion')assert.equal(reply.data.completed,false);
      else{assert.equal(reply.data.comment.id,'159');assert.equal(reply.data.submissionKey,key);}
      assert.doesNotMatch(result.stderr,/"ok":false/);
    }
    if(mode==='normal')assert.doesNotMatch(result.stderr,/Warning:/);
    else assert.equal(result.stderr.match(/Warning:/g)?.length,1,result.stderr);
    if(mode!=='pending-completion'){
      assert.equal(stats.calls[0].operation,'community.comments.create');assert.equal(stats.calls[0].args.key,key);
      assert.match(result.stderr,new RegExp(`Submission key: ${key}`));
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
