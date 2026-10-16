import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const key='11111111-1111-4111-8111-111111111111';
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'project-copy-cli-')),session=join(root,'session'),calls=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const request=JSON.parse(raw);calls.push(request);res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({result:{id:key,key,state:'SUCCEEDED',project:'demo'}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  await writeFile(session,JSON.stringify({url,token:'fixture-only',principal:{userId:'alice',username:'alice',role:'member'},machine:'gpu-1',projectsByMachine:{'gpu-1':'demo'}}));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const cli=(args)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--url',url,'--session-file',session,'--json',...args],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  return {cli,calls};
}

test('project copy dispatches the project environment to the named target using the original transfer key',async t=>{
  const f=await fixture(t),result=await f.cli(['project','copy','demo','--from','gpu-1','--to','gpu-2','--name','demo-copy','--key',key,'--detach']);
  assert.equal(result.code,0,result.stderr);
  assert.equal(f.calls.at(-1).operation,'transfers.create');
  assert.deepEqual(f.calls.at(-1).args,{key,kind:'copy',from:'gpu-1',machine:'gpu-2',name:'demo-copy',reference:{project:'demo',ownerId:'alice',environment:true}});
});

test('automatic training sends the selected source workspace even when target candidates exclude that server',async t=>{
  const f=await fixture(t),result=await f.cli(['run','--machine','auto','--candidates','gpu-2','--key',key,'--','python','train.py']);
  assert.equal(result.code,0,result.stderr);
  const {operation,args}=f.calls.at(-1);assert.equal(operation,'jobs.submit');
  assert.equal(args.sourceMachine,'gpu-1');assert.equal(args.project,'demo');
  assert.deepEqual(args.machineSelection,{mode:'auto',candidates:['gpu-2']});
});
