import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,stat,readFile,writeFile} from 'node:fs/promises';
import {createServer as httpServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server.mjs';
import {DEMO_ADMIN} from '../dist/service.js';

test('real CLI and browser API share accounts and permissions; reset revokes prior sessions',async()=>{
  const server=await createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;const dir=await mkdtemp(join(tmpdir(),'gpuq-cli-test-'));
  const cli=(args,password='',file='admin.json')=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,...args,'--url',url,'--json','--session-file',join(dir,file)],{stdio:['pipe','pipe','pipe']});
    let out='',err='';child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.on('error',reject);child.on('close',code=>resolve({code,out:out?JSON.parse(out):null,err}));child.stdin.end(password+'\n');
  });
  const post=async(path,data,token,extra={})=>{const r=await fetch(`${url}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...extra},body:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
  try{
    assert.equal((await post('call',{operation:'state'})).status,401);
    assert.equal((await post('login',DEMO_ADMIN,null,{Origin:'https://untrusted.invalid'})).status,403);
    assert.equal((await cli(['login','admin','--password-stdin'],DEMO_ADMIN.password)).code,0);
    assert.equal((await stat(join(dir,'admin.json'))).mode&0o777,0o600);
    assert.equal((await readFile(join(dir,'admin.json'),'utf8')).includes(DEMO_ADMIN.password),false);
    const created=await cli(['user','add','cli-user','--password-stdin'],'Password123');assert.equal(created.code,0);
    const userId=created.out.data.id;
    assert.equal((await cli(['grant','cli-user','--machine','gpu-1=2','--total','2'])).code,0);
    const browser=await post('login',{username:'cli-user',password:'Password123'});
    assert.equal(browser.data.state.users[0].limits['gpu-1'],2);
    const rejected=await post('call',{operation:'users.reset',args:{userId,password:'badrequest'}},browser.data.token);assert.equal(rejected.status,403);
    const submitted=await post('call',{operation:'request',args:{machine:'gpu-1',cards:1}},browser.data.token);assert.equal(submitted.status,200);
    const fromCLI=await cli(['state']);assert.equal(fromCLI.out.data.jobs[0].id,submitted.data.result.id);
    assert.equal((await cli(['login','cli-user','--password-stdin'],'Password123','member.json')).code,0);
    assert.equal((await cli(['request','gpu-1','--cards','2'],'','member.json')).code,1);
    assert.equal((await cli(['user','reset-password','cli-user','--password-stdin'],'Changed123')).code,0);
    assert.equal((await post('call',{operation:'state'},browser.data.token)).status,401);
    assert.equal((await cli(['state'],'','member.json')).code,1);
    assert.equal((await post('login',{username:'cli-user',password:'Password123'})).status,400);
    assert.equal((await post('login',{username:'cli-user',password:'Changed123'})).status,200);
    const page=await(await fetch(url)).text();assert.match(page,/GPUQ_LOCAL_API=true/);
    const organization=await fetch(url+'/project-management-ui.js');assert.equal(organization.status,200);assert.match(organization.headers.get('content-type'),/javascript/);assert.match(await organization.text(),/export function createProjectManagement/);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('CLI short card option never rewrites training argv after --',async()=>{
  let received;
  const server=httpServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);res.setHeader('content-type','application/json');if(body.operation==='state')res.end(JSON.stringify({state:{demo:false,machines:[{id:'gpu-4'}],users:[],jobs:[]}}));else{received=body.args;res.end(JSON.stringify({result:{id:'test-job'}}));}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`,dir=await mkdtemp(join(tmpdir(),'gpuq-argv-')),cache=join(dir,'session.json');
  try{
    await writeFile(cache,JSON.stringify({url,token:'test-only',principal:{userId:'demo-user-1',role:'member'},machine:'gpu-4'}));
    const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'--url',url,'--session-file',cache,'--json','run','--project','training','-g','2','--','python','train.py','-g','custom','--json']);let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>resolve({code,out,err}));});
    assert.equal(result.code,0,result.err);assert.equal(received.cards,2);assert.deepEqual(received.argv,['python','train.py','-g','custom','--json']);
    assert.equal(received.project,'training');assert.equal(Object.hasOwn(received,'release'),false);
  }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
