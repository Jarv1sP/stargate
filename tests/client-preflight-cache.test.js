import test from 'node:test';
import assert from 'node:assert/strict';
import {readCLIState} from '../client-state.mjs';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const state={machines:[{id:'example-node',cards:8}],demo:false,gpuqConnected:true,clientPolicy:{version:1},taskMetadata:{version:1},users:[{id:'own'}],jobs:[{id:'private-job'}]};
test('target commands discard stale display preflight instead of treating it as authority',async()=>{
 for(const command of ['push','pull','push-status','run','data'])assert.deepEqual(await readCLIState(()=>assert.fail('extra state RPC'),command,{cached:{identity:'old',state},identity:'new',remember:()=>assert.fail('display cache write')}),{machines:[],users:[]});
});

test('source CLI omits warm state and duplicate dataset lookups while the server still rejects unauthorized submission',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cli-preflight-cache-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const seen=[],server=createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;const call=JSON.parse(body);if(call.operation==='community.announcements.pending'){assert.deepEqual(call.args,{});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result:{posts:[]}}));return;}seen.push(call);
  res.setHeader('content-type','application/json');
  if(call.operation==='state')res.end(JSON.stringify({state,principal:{userId:'own'}}));
  else if(call.operation==='datasets.list')res.end(JSON.stringify({result:{datasets:[{dataset:'sample',size:3}]}}));
  else{res.statusCode=403;res.end('{"error":"Permission revoked"}');}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url='http://127.0.0.1:'+server.address().port,session=join(dir,'session.json');
 await writeFile(session,JSON.stringify({url,token:'isolated-token',principal:{userId:'own',role:'user'},machine:'example-node'}));
 const run=args=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'--url',url,'--session-file',session,'--json',...args],{stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',p=>out+=p);child.stderr.on('data',p=>err+=p);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
 });
 assert.equal((await run(['data','list'])).code,0);
 assert.deepEqual(seen.map(call=>call.operation),['datasets.list']);seen.length=0;
 assert.equal((await run(['data','list'])).code,0);
 assert.deepEqual(seen.map(call=>call.operation),['datasets.list']);seen.length=0;
 const result=await run(['run','--project','example-project','--key','11111111-1111-4111-8111-111111111111','--','true']);
 assert.equal(result.code,1);assert.match(result.out+result.err,/Permission revoked/);
 assert.deepEqual(seen.map(call=>call.operation),['jobs.submit']);
 assert.equal(seen[0].args.release,undefined);assert.equal(seen[0].args.project,'example-project');
});
