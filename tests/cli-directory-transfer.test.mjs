import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseCLIOptions} from '../cli.mjs';
import {uploadLocalFile,uploadLocalTree} from '../client-transfers.mjs';

test('CLI accepts repository and directory targets and reports unsupported options',()=>{
 assert.equal(parseCLIOptions(['project','create','vision','--repo','https://example.test/repo.git']).options.repo,'https://example.test/repo.git');
 assert.equal(parseCLIOptions(['data','import','https://example.test/data','file.bin','--dataset','images']).options.dataset,'images');
 const sync=parseCLIOptions(['run','--sync','--sync-dir','src','--candidates','fixture-node']);assert.equal(sync.options.sync,true);assert.equal(sync.options['sync-dir'],'src');assert.equal(sync.options.candidates,'fixture-node');
 for(const flag of ['--release','--inherit-release','--root','--data-workspace','--data-read','--source-root'])assert.throws(()=>parseCLIOptions(['run',flag,'old']),/Unknown option/);
});
test('single file upload keeps 512KiB chunks, original UUID, final execute intent, and resumes after a lost response',async t=>{
 const root=await mkdtemp(join(tmpdir(),'c3-directory-upload-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'train.sh'),bytes=Buffer.alloc(512*1024+3,7),key=randomUUID();await writeFile(source,bytes);await chmod(source,0o755);
 let offset=0,finished=0,lost=true;const chunks=[],calls=[];
 const call=async(op,args)=>{calls.push([op,args]);if(op==='data.upload.begin'||op==='data.upload.status')return {result:{state:'UPLOADING',key,offset,totalSize:bytes.length,extraFutureField:true}};if(op==='data.upload.chunk'){chunks.push(args);assert.equal(args.key,key);assert.equal(args.offset,offset);offset+=Buffer.from(args.data,'base64').length;if(lost){lost=false;throw Error('connection lost after writing');}return {result:{key,offset,state:'UPLOADING'}};}assert.equal(op,'data.upload.finish');finished++;assert.equal(args.executable,process.platform!=='win32');return {result:{key,state:'COMPLETE',size:bytes.length}};};
 const result=await uploadLocalFile(call,{machine:'node-a',context:{area:'code',project:'vision',ownerId:'member-b'},local:source,path:'train.sh',key,via:'relay'});
 assert.equal(result.bytes,bytes.length);assert.equal(finished,1);assert.deepEqual(chunks.map(row=>Buffer.from(row.data,'base64').length),[512*1024,3]);assert.equal(chunks[1].offset,512*1024);assert.ok(calls.every(([,args])=>args.ownerId==='member-b'&&args.area==='code'));
});
test('directory resume keeps one UUID for each relative file, and new uploads use new operation UUIDs',async t=>{
 const root=await mkdtemp(join(tmpdir(),'c3-directory-keys-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'files');await import('node:fs/promises').then(fs=>fs.mkdir(source));await writeFile(join(source,'a'),'one');await writeFile(join(source,'b'),'two');const seen=[],key=randomUUID(),stateDirectory=join(root,'states');
 const options={machine:'node-a',context:{area:'dataset',dataset:'images'},local:source,key,stateDirectory,via:'relay',uploadFile:async(_call,args)=>{seen.push(args);return {state:'COMPLETE',size:3};}};
 await uploadLocalTree(()=>assert.fail('unexpected RPC'),options);const first=seen.map(row=>row.key);seen.length=0;
 await uploadLocalTree(()=>assert.fail('unexpected RPC'),options);assert.deepEqual(seen.map(row=>row.key),first);assert.notEqual(first[0],first[1]);
 const saved=JSON.parse(await readFile(join(stateDirectory,key+'.json'),'utf8'));assert.equal(saved.a,first[0]);assert.equal(saved.b,first[1]);seen.length=0;
 await uploadLocalTree(()=>assert.fail('unexpected RPC'),{...options,key:undefined});assert.ok(seen.every(row=>!first.includes(row.key)));
});
test('a local symlink cannot escape the selected upload tree',async t=>{
 if(process.platform==='win32')return t.skip('symlink creation needs Windows privileges');const root=await mkdtemp(join(tmpdir(),'c3-directory-links-'));t.after(()=>rm(root,{recursive:true,force:true}));await import('node:fs/promises').then(async fs=>{await fs.mkdir(join(root,'files'));await fs.symlink('/etc/passwd',join(root,'files','escape'));});
 await assert.rejects(uploadLocalTree(()=>assert.fail('no upload should start'),{machine:'node-a',context:{area:'dataset',dataset:'images'},local:join(root,'files')}),/链接不会上传/);
});
