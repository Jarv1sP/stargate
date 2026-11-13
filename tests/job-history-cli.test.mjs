import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('CLI lists and restores only task records, with no training or output mutation',async t=>{
  const root=await mkdtemp(join(tmpdir(),'history-cli-')),calls=[],id='11111111-1111-4111-8111-111111111111';
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);calls.push(body);
    const result=body.operation==='community.announcements.pending'?{posts:[]}:body.operation==='jobs.history.list'?
      {jobs:[{id,name:'已结束训练',machine:'gpu-1',state:'SUCCEEDED',historyPurgeAt:'2026-06-08T00:00:00Z'}],nextCursor:'9'}:
      {id,restored:true,message:'已恢复任务记录，不会重跑训练。'};
    res.setHeader('content-type','application/json');res.end(JSON.stringify(body.operation==='state'?
      {state:{machines:[{id:'gpu-1',cards:8}],users:[]}}:{result}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+server.address().port,session=join(root,'session.json');
  await writeFile(session,JSON.stringify({url,token:'synthetic',principal:{userId:'fixture'}}));
  async function run(args){return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'--url',url,'--session-file',session,...args]);let out='',err='';
    child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
  });}
  let result=await run(['jobs','trash','--machine','gpu-1','--cursor','10']);assert.equal(result.code,0,result.err);assert.match(result.out,/已结束训练/);assert.match(result.out,/--cursor 9/);
  assert.deepEqual(calls.find(c=>c.operation==='jobs.history.list').args,{machine:'gpu-1',cursor:'10'});
  result=await run(['jobs','restore',id]);assert.equal(result.code,0,result.err);assert.match(result.out,/不会重跑训练/);
  assert.deepEqual(calls.find(c=>c.operation==='jobs.history.restore').args,{jobId:id});
  assert.ok(calls.every(c=>['state','community.announcements.pending','jobs.history.list','jobs.history.restore'].includes(c.operation)));
  assert.ok(calls.filter(c=>c.operation==='state').every(c=>c.args.view==='summary'));
});
