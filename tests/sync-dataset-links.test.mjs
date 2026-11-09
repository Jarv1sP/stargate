import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
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
