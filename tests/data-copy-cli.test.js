import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

test('CLI starts and resumes the same explicit directory copy without user SSH credentials',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'data-copy-cli-')),session=join(dir,'session'),calls=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});
    res.setHeader('Content-Type','application/json');
    if(operation==='state')res.end(JSON.stringify({state:{demo:false,machines:[{id:'gpu-1'},{id:'gpu-2'}],users:[],jobs:[]}}));
    else res.end(JSON.stringify({result:{key:args.key,state:operation==='data.copy.status'?'SUCCEEDED':'RUNNING'}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  await writeFile(session,JSON.stringify({url,token:'test-only',principal:{userId:'demo-user-1',username:'alice',role:'member'},machine:'gpu-2'}));
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const run=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--session-file',session,'--json',...args]);
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  const key=randomUUID();
  const start=await run(['data','copy','ImageNet train','datasets/imagenet','--from','gpu-1','--to','gpu-2','--source-root','hdd','--key',key]);
  assert.equal(start.code,0,start.stderr);
  assert.deepEqual(calls.find(c=>c.operation==='data.copy.start').args,
    {machine:'gpu-2',from:'gpu-1',scope:'hdd',path:'ImageNet train',destination:'datasets/imagenet',key});
  for(const action of ['status','resume','cancel']){
    const result=await run(['data','copy-'+action,key,'--machine','gpu-2']);
    assert.equal(result.code,0,result.stderr);
    assert.deepEqual(calls.find(c=>c.operation==='data.copy.'+action).args,{machine:'gpu-2',key});
  }
  assert.equal(calls.some(c=>c.operation.startsWith('datasets.')||c.operation==='jobs.submit'),false);
});
