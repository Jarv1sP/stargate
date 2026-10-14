import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const job='11111111-1111-4111-8111-111111111111';
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'output-pages-cli-')),session=join(root,'session');
  const principal={userId:'demo-user-1',username:'fixture',role:'member'},calls=[];
  let oldNode=false;
  const server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const part of req)raw+=part;
      const {operation,args}=JSON.parse(raw);calls.push({operation,args});
      res.setHeader('Content-Type','application/json');
      if(operation==='state')return res.end(JSON.stringify({state:{demo:false,gpuqConnected:true,machines:[{id:'gpu-1',cards:4}],users:[],jobs:[]}}));
      assert.equal(operation,'files.list');
      const result=oldNode?{entries:[]}:{protocol:1,path:args.path,entries:[{name:args.cursor?'last.npy':'first.npy',type:'file',size:4}],returned:1,total:1248,hasMore:!args.cursor,nextCursor:args.cursor?null:'fixture-next-cursor',retention:{status:'UNCONFIRMED',expiresAt:null}};
      res.end(JSON.stringify({result}));
    }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  await writeFile(session,JSON.stringify({url,token:'test-only',principal,machine:'gpu-1',projectsByMachine:{'gpu-1':'fixture'}}),{mode:0o600});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const cli=(extra=[],json=true)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--max-old-space-size=128',process.env.OUTPUT_PAGES_TEST_CLI||fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--url',url,'--session-file',session,...(json?['--json']:[]),'files','float32','--job',job,'--project','fixture',...extra],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  return {calls,cli,setOld:()=>{oldNode=true;}};
}

test('real CLI sends original job/project plus exact cursor and numeric limit',async t=>{
  const f=await fixture(t),first=await f.cli(['--limit','1000']);assert.equal(first.code,0,first.stderr);
  const value=JSON.parse(first.stdout).data;assert.equal(value.total,1248);assert.equal(value.nextCursor,'fixture-next-cursor');
  const second=await f.cli(['--cursor',value.nextCursor,'--limit','248']);assert.equal(second.code,0,second.stderr);
  assert.equal(JSON.parse(second.stdout).data.nextCursor,null);
  assert.deepEqual(f.calls.at(-1),{operation:'files.list',args:{machine:'gpu-1',path:'float32',project:'fixture',area:'output',runId:job,cursor:'fixture-next-cursor',limit:248}});
});

test('real CLI explains continuation and unknown retention in human output',async t=>{
  const f=await fixture(t),value=await f.cli([],false);assert.equal(value.code,0,value.stderr);
  assert.match(value.stdout,/共 1248/);assert.match(value.stdout,/--cursor fixture-next-cursor/);assert.match(value.stdout,/到期时间未确认/);
});

test('real CLI rejects invalid pages before reading or dispatching',async t=>{
  const f=await fixture(t);
  for(const extra of [['--limit','0'],['--limit','1001'],['--limit','1.5']]){
    const value=await f.cli(extra);assert.equal(value.code,1,value.stdout);
  }
  assert.equal(f.calls.length,0);
});
