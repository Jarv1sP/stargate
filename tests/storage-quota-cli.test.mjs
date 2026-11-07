import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('quota CLI reads the Portal snapshot: both disks, project parts, every project, people and unknown',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'storage-quota-cli-')),session=join(dir,'session.json'),calls=[],G=1024**3,checkedAt=new Date(Date.now()-4*60000).toISOString();
 let volumes=[{kind:'workspace',media:'ssd',fs:'1',usedBytes:100,totalBytes:1000,availableBytes:900},{kind:'datasets',media:null,fs:null,usedBytes:null,totalBytes:null,availableBytes:null}];
 let projects={checkedAt,complete:true,projects:[{project:'demo',ownerId:'fixture-owner',ownerName:'成员甲',size:3*G,complete:true,outputs:{size:null,complete:false},environment:{size:2*G,complete:true}},
  {project:'demo',ownerId:'peer',ownerName:'成员乙',shared:true,size:40*G,complete:true,outputs:{size:8*G,complete:true},environment:{size:0,complete:true}}],
  disks:[{mountPoint:'/fixture/data0',accounting:'quota',items:[{kind:'project',ownerId:'peer',ownerName:'成员乙',project:'demo',files:40*G,outputs:8*G,environment:0},{kind:'images',ownerId:'fixture-owner',ownerName:'成员甲',bytes:6*G}]}]};
 const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;const request=JSON.parse(text);calls.push(request);res.setHeader('content-type','application/json');
  if(request.operation==='state')return res.end(JSON.stringify({state:{machines:[{id:'fixture-machine'}],jobs:[],users:[{id:'peer',username:'peer'}]},principal:{userId:'fixture-owner',role:'member'}}));
  if(request.operation==='community.announcements.pending')return res.end(JSON.stringify({result:{posts:[]}}));
  assert.equal(request.operation,'storage.snapshot');assert.equal(request.args.machine,'fixture-machine');
  res.end(JSON.stringify({result:{machines:[{machine:'fixture-machine',checkedAt,refreshing:false,quota:{volumes,checkedAt},datasets:{datasets:[]},projects,futureField:'ignored'}]}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 await writeFile(session,JSON.stringify({url,token:'synthetic-session',principal:{userId:'fixture-owner',role:'member'}}));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 const run=extra=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[process.env.EXTERNAL_CLI||new URL('../cli.mjs',import.meta.url).pathname,'project','quota','--machine','fixture-machine','--session-file',session,...extra]);let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end();});
 const plain=await run([]);assert.equal(plain.code,0,plain.stderr);assert.match(plain.stdout,/工作区 · SSD/);assert.match(plain.stdout,/已用 100 B \/ 总量 1,000 B；可用 900 B/);assert.match(plain.stdout,/数据集 · 数据盘\n  已用 未知/);assert.match(plain.stdout,/统计于 4 分钟前/);assert.doesNotMatch(plain.stdout,/项目 demo|未启用|内核项目配额|文件／目录/);
 assert.ok(calls.every(row=>row.operation!=='projects.quota'),'the CLI never asks the node for a separate reading');
 const own=await run(['--project','demo']);assert.equal(own.code,0,own.stderr);
 assert.match(own.stdout,/项目 demo（成员甲）：合计 至少 5 GiB；文件 3 GiB · 输出 未知 · 环境 2 GiB\n统计于 4 分钟前/);
 const shared=await run(['--project','demo','--owner','peer']);assert.equal(shared.code,0,shared.stderr);assert.match(shared.stdout,/项目 demo（共用 · 创建人 成员乙）：合计 48 GiB；文件 40 GiB · 输出 8 GiB · 环境 0 B/);
 const all=await run(['--all']);assert.equal(all.code,0,all.stderr);
 assert.match(all.stdout,/本机项目（按合计排序）：\n  demo（共用 · 创建人 成员乙）：合计 48 GiB[^\n]*\n  demo（成员甲）：合计 至少 5 GiB/);
 assert.match(all.stdout,/按人汇总：\n  成员乙：合计 48 GiB；项目 48 GiB · 镜像与容器引擎 0 B\n  成员甲：合计 6 GiB；项目 0 B · 镜像与容器引擎 6 GiB/);
 const json=await run(['--project','demo','--json']);assert.equal(json.code,0,json.stderr);const data=JSON.parse(json.stdout).data;
 assert.deepEqual(data.volumes,volumes);assert.deepEqual(data.projectUsage.total,{size:5*G,complete:false});assert.deepEqual(data.projectUsage.outputs,{size:null,complete:false});
 projects={error:'暂时读不到，请稍后刷新。',projects:[],checkedAt:null};
 const unknown=await run(['--project','demo','--all']);assert.equal(unknown.code,0,unknown.stderr);
 assert.match(unknown.stdout,/项目 demo：合计 未知；文件 未知 · 输出 未知 · 环境 未知/);assert.match(unknown.stdout,/本机项目（按合计排序）：\n  未知，请稍后重试。/);assert.match(unknown.stdout,/统计时间未知/);assert.doesNotMatch(unknown.stdout,/合计 0/);
 volumes=[{kind:'shared',media:'hdd',fs:'9223372036854775815',usedBytes:100,totalBytes:1000,availableBytes:900}];
 const one=await run([]);assert.equal(one.code,0,one.stderr);assert.equal((one.stdout.match(/已用 /g)||[]).length,1);assert.match(one.stdout,/HDD · 工作区与数据集共用/);assert.doesNotMatch(one.stdout,/SSD|未知/);
 for(const [media,label] of [['ssd','SSD'],['mixed','混合盘'],[null,'数据盘']]){
  volumes=[{...volumes[0],media}];const measured=await run([]);assert.equal(measured.code,0,measured.stderr);assert.ok(measured.stdout.includes(label+' · 工作区与数据集共用'));
 }
 volumes=[];const missing=await run([]);assert.match(missing.stdout,/盘容量未知，请稍后重试。/);
});
