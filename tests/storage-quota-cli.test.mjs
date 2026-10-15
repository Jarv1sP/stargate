import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('quota CLI renders both disks, partial project bytes and unknown without the old hard-quota shape',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'storage-quota-cli-')),session=join(dir,'session.json'),calls=[];
 let usage={size:3,complete:false};
 const volumes=[{kind:'workspace',usedBytes:100,totalBytes:1000,availableBytes:900},{kind:'datasets',usedBytes:null,totalBytes:null,availableBytes:null}];
 const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;const request=JSON.parse(text);calls.push(request);res.setHeader('content-type','application/json');
  if(request.operation==='state')return res.end(JSON.stringify({state:{machines:[{id:'fixture-machine'}],jobs:[],users:[]},principal:{userId:'fixture-owner',role:'member'}}));
  if(request.operation==='community.announcements.pending')return res.end(JSON.stringify({result:{posts:[]}}));
  assert.equal(request.operation,'projects.quota');res.end(JSON.stringify({result:{volumes,...(request.args.project?{projectUsage:{project:request.args.project,...usage}}:{}),futureField:'ignored'}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 await writeFile(session,JSON.stringify({url,token:'synthetic-session',principal:{userId:'fixture-owner',role:'member'}}));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 const run=extra=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[process.env.EXTERNAL_CLI||new URL('../cli.mjs',import.meta.url).pathname,'project','quota','--machine','fixture-machine','--session-file',session,...extra]);let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end();});
 const plain=await run([]);assert.equal(plain.code,0,plain.stderr);assert.match(plain.stdout,/工作区盘（SSD）/);assert.match(plain.stdout,/已用 100 B \/ 总量 1,000 B；可用 900 B/);assert.match(plain.stdout,/数据集盘（HDD）\n  已用 未知/);assert.doesNotMatch(plain.stdout,/未启用|内核项目配额|文件／目录/);
 const partial=await run(['--project','demo']);assert.equal(partial.code,0,partial.stderr);assert.match(partial.stdout,/项目 demo 文件用量：至少 3 B/);assert.equal(calls.filter(r=>r.operation==='projects.quota').at(-1).args.project,'demo');
 usage={size:null,complete:false};const unknown=await run(['--project','demo']);assert.match(unknown.stdout,/项目 demo 文件用量：未知/);
 const json=await run(['--json']);assert.equal(json.code,0,json.stderr);assert.deepEqual(JSON.parse(json.stdout).data.volumes,volumes);
});
