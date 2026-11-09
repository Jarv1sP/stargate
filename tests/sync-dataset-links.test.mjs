import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm,symlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {uploadLocalTree,uploadLocalFile} from '../client-transfers.mjs';
import {apiPost} from '../client-http.mjs';
import net from 'node:net';
import {bridgeClient} from '../execution-bridge.mjs';
import {uploadProjectFile} from '../dist/execution-ui.js';

const refusal=()=>Object.assign(Error('服务器上已改为数据集。'),{status:409,code:'DATASET_DIRECTORY_LINK',datasetLink:{path:'data/images',target:'/datasets/images/train'}});
const message='已跳过 data/images：服务器上已改为数据集 /datasets/images/train，本机这份可以删除';
async function tree(t){
 const root=await mkdtemp(join(tmpdir(),'sync-datasets-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'data/images/deep'),{recursive:true});await writeFile(join(root,'data/images/a'),'local data');await writeFile(join(root,'data/images/deep/b'),'more data');
 // Skipping the whole subtree must avoid even inspecting its remaining entries.
 if(process.platform!=='win32')await symlink('/does-not-exist',join(root,'data/images/z-link'));
 await mkdir(join(root,'data/images-other'));await writeFile(join(root,'data/images-other/code.py'),'print(1)');await writeFile(join(root,'train.py'),'print(2)');return root;
}
for(const via of ['relay','auto'])test(`project sync skips one migrated subtree and continues (${via})`,async t=>{
 const root=await tree(t),calls=[],notices=[];
 const call=async(op,args)=>{calls.push(args.path);if(args.path==='data/images/a')throw refusal();if(op==='data.upload.begin')return {result:{state:'UPLOADING',offset:0}};if(op==='data.upload.chunk')return {result:{offset:Buffer.from(args.data,'base64').length}};assert.equal(op,'data.upload.finish');return {result:{state:'COMPLETE'}};};
 const result=await uploadLocalTree(call,{machine:'fixture-node',context:{area:'code',project:'demo'},local:root,via,notify:m=>notices.push(m),uploadFile:(call,options)=>uploadLocalFile(call,{...options,transportFactory:async()=>({request:async({offset,bytes})=>({offset:offset+bytes.length}),close:async()=>{}})})});
 assert.equal(result.state,'COMPLETE');assert.equal(result.uploaded,2);assert.deepEqual(result.files.map(f=>f.path),['data/images-other/code.py','train.py']);
 assert.deepEqual(notices,[message]);assert.deepEqual(result.skipped,[{path:'data/images',target:'/datasets/images/train'}]);
 assert.equal(calls.filter(p=>p.startsWith('data/images/')).length,1);
});
test('non-dataset symlink errors still stop the upload',async t=>{
 const root=await tree(t);await assert.rejects(uploadLocalTree(async()=>{throw Object.assign(Error('Not a directory'),{status:400,code:'ENOTDIR'});},{machine:'fixture-node',context:{area:'code',project:'demo'},local:root,via:'relay',notify:()=>assert.fail('must not skip')}),/Not a directory/);
});
for(const kind of ['link','fifo','nested-link'])test(`a migrated directory discards an earlier local ${kind} error`,async t=>{
 if(process.platform==='win32')return t.skip('requires POSIX links or FIFO');
 const root=await tree(t),first=join(root,'data/images/0-first'),attempts=[],notices=[];
 if(kind==='fifo')await promisify(execFile)('mkfifo',[first]);
 else if(kind==='nested-link'){await mkdir(first);await symlink('/does-not-exist',join(first,'link'));}
 else await symlink('/does-not-exist',first);
 const result=await uploadLocalTree(()=>assert.fail('unexpected RPC'),{machine:'fixture-node',context:{area:'code',project:'demo'},local:root,via:'relay',notify:m=>notices.push(m),uploadFile:async(_call,args)=>{
  attempts.push(args.path);if(args.path.startsWith('data/images/'))throw refusal();return {state:'COMPLETE'};
 }});
 assert.equal(result.state,'COMPLETE');assert.equal(result.uploaded,2);assert.deepEqual(notices,[message]);
 assert.deepEqual(attempts,['data/images/a','data/images-other/code.py','train.py']);
});
for(const kind of ['link','fifo'])test(`a local ${kind} in a directory that is not skipped still fails`,async t=>{
 if(process.platform==='win32')return t.skip('requires POSIX links or FIFO');
 const root=await mkdtemp(join(tmpdir(),'sync-local-error-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=join(root,'a-first');if(kind==='fifo')await promisify(execFile)('mkfifo',[first]);else await symlink('/does-not-exist',first);
 await writeFile(join(root,'b-file'),'code');const attempts=[];
 await assert.rejects(uploadLocalTree(()=>assert.fail('unexpected RPC'),{machine:'fixture-node',context:{area:'code',project:'demo'},local:root,via:'relay',uploadFile:async(_call,args)=>{attempts.push(args.path);return {state:'COMPLETE'};}}),kind==='fifo'?/请选择普通文件或目录/ : /链接不会上传/);
 assert.deepEqual(attempts,['b-file']);
});
test('push-status reports saved skipped subtrees without walking them or changing the journal',async t=>{
 const root=await tree(t),stateDirectory=await mkdtemp(join(tmpdir(),'sync-skip-status-')),key='11111111-1111-4111-8111-111111111111';t.after(()=>rm(stateDirectory,{recursive:true,force:true}));
 const options={machine:'fixture-node',context:{area:'code',project:'demo'},local:root,via:'relay',key,stateDirectory,notify:()=>{}};
 const uploadFile=async(_call,args)=>{if(args.path.startsWith('data/images/'))throw refusal();return {state:'COMPLETE',key:args.key};};
 await uploadLocalTree(()=>assert.fail('unexpected RPC'),{...options,uploadFile});
 const journal=join(stateDirectory,key+'.json'),saved=await readFile(journal,'utf8'),before=await stat(journal),queried=[];
 const result=await uploadLocalTree(async(op,args)=>{assert.equal(op,'data.upload.status');queried.push(args.path);return {result:{state:'COMPLETE',key:args.key}};},{...options,inspectOnly:true});
 assert.deepEqual(result.files.filter(row=>row.state==='SKIPPED'),[{path:'data/images',state:'SKIPPED',datasetLink:{path:'data/images',target:'/datasets/images/train'}}]);
 assert.deepEqual(queried,['data/images-other/code.py','train.py']);assert.deepEqual(result.skipped,[{path:'data/images',target:'/datasets/images/train'}]);
 assert.equal(await readFile(journal,'utf8'),saved);assert.equal((await stat(journal)).mtimeMs,before.mtimeMs);
 // A fresh upload with the same key must recheck the server, rather than reuse an old skip.
 await rm(join(root,'data/images'),{recursive:true});await mkdir(join(root,'data/images'));await writeFile(join(root,'data/images/restored'),'restored');
 const resumed=await uploadLocalTree(()=>assert.fail('unexpected RPC'),{...options,uploadFile:async()=>({state:'COMPLETE'})});
 assert.equal(resumed.uploaded,3);assert.equal(resumed.skipped,undefined);
 const checked=[];const status=await uploadLocalTree(async(_op,args)=>{checked.push(args.path);return {result:{state:'COMPLETE'}};},{...options,inspectOnly:true});
 assert.ok(checked.includes('data/images/restored'));assert.equal(status.files.some(row=>row.state==='SKIPPED'),false);
});
test('HTTP preserves the dataset link refusal and directory details',async()=>{
 await assert.rejects(apiPost('https://portal.example.test','call',{operation:'data.upload.begin'},{fetchImpl:async()=>new Response(JSON.stringify({error:'服务器上已改为数据集。',code:'DATASET_DIRECTORY_LINK',datasetLink:refusal().datasetLink}),{status:409})}),e=>e.code==='DATASET_DIRECTORY_LINK'&&e.status===409&&e.datasetLink.path==='data/images');
});
test('web project upload skips the directory once across selected files',async()=>{
 const skipped=new Map(),notices=[];let calls=0;
 const call=async()=>{calls++;throw refusal();};
 for(const path of ['data/images/a','data/images/deep/b']){
  const result=await uploadProjectFile(new Blob(['local']),{machine:'fixture-node',project:'demo',area:'code',path},call,()=>{},{skipped,onSkip:m=>notices.push(m)});
  assert.equal(result.state,'SKIPPED');
 }
 assert.equal(calls,1);assert.deepEqual(notices,[message]);
 await assert.rejects(uploadProjectFile(new Blob(['local']),{machine:'fixture-node',project:'demo',area:'code',path:'other/a'},async()=>{throw Object.assign(Error('Not a directory'),{status:400});}),/Not a directory/);
});

test('node execution bridge preserves the domain refusal without replay',async t=>{
 const root=await mkdtemp(join(tmpdir(),'sync-dataset-bridge-')),socket=join(root,'bridge.sock');let calls=0;
 const server=net.createServer(client=>{client.on('data',()=>{});client.on('end',()=>{calls++;client.end(JSON.stringify({ok:false,error:'服务器上已改为数据集。',code:'DATASET_DIRECTORY_LINK',datasetLink:refusal().datasetLink}));});});
 await new Promise(resolve=>server.listen(socket,resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 await assert.rejects(bridgeClient(socket)('fixture-node','data.upload.begin',{}),e=>e.status===409&&e.code==='DATASET_DIRECTORY_LINK'&&e.datasetLink.target==='/datasets/images/train');assert.equal(calls,1);
});
