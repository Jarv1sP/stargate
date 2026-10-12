import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validProject,readyReleases,trainingProject,trainingTarget,trainingReceiptMatches,datasetReferences,uploadProjectFile,taskTable} from '../dist/execution-ui.js';
import {terminalContext,terminalLaunchContext} from '../dist/terminal-ui.js';
import {maintenanceBlocks} from '../dist/maintenance-state.js';

const release='a'.repeat(64),future='b'.repeat(64);
const absentUpload={inspect:async args=>({protocol:2,state:'ABSENT',path:args.path})};
test('project upload exposes recovery only after the node confirms the exact recovery protocol',async()=>{
  const puts=[],support=[],context={machine:'node-a',project:'vision',area:'code',path:'train.py'},id='a1234567-1234-4234-8234-123456789abc';
  await uploadProjectFile(new Blob(['abc']),context,async args=>{puts.push(args);return {complete:true,size:3,sha256:args.sha256};},undefined,{
    inspect:async args=>({...args,protocol:2,state:'UPLOADING',uploadId:id,receivedBytes:2,resumable:true}),onRecoverySupport:value=>support.push(value)
  });
  assert.deepEqual(support,[true]);assert.equal(puts.length,1);assert.equal(puts[0].uploadId,id);assert.equal(puts[0].offset,2);assert.equal(Buffer.from(puts[0].data,'base64').toString(),'c');
});
test('unsupported recovery keeps ordinary project upload and never retries a lost write',async()=>{
  for(const failure of [Object.assign(Error('Unknown operation'),{status:502}),Object.assign(Error('not found'),{status:404}),Object.assign(Error('not supported'),{code:'UNSUPPORTED'})]){
    const context={machine:'node-a',project:'vision',area:'code',path:'train.py'},puts=[],support=[];let reads=0;
    const options={inspect:async()=>{reads++;throw failure;},onRecoverySupport:value=>support.push(value)};
    await uploadProjectFile(new Blob(['abc']),context,async args=>{puts.push(args);return {complete:true,size:3,sha256:args.sha256};},undefined,options);
    assert.deepEqual(support,[false]);assert.equal(reads,1);assert.equal(puts.length,1);assert.equal(puts[0].offset,0);assert.equal(puts[0].final,true);assert.equal(Object.hasOwn(puts[0],'truncate'),false);
    reads=0;puts.length=0;support.length=0;
    await assert.rejects(uploadProjectFile(new Blob(['abc']),context,async args=>{puts.push(args);throw new TypeError('reply lost');},undefined,options),/这台服务器暂不支持续传，请重新上传/);
    assert.deepEqual(support,[false]);assert.equal(reads,1);assert.equal(puts.length,1,'An unsupported node never replays the write or pretends to resume');
  }
});
test('recovery refusal and unavailable status do not downgrade authorization or uncertain uploads',async()=>{
  for(const failure of [Object.assign(Error('Unknown operation'),{status:403}),Object.assign(Error('not found'),{status:401}),new TypeError('connection reset'),Object.assign(Error('timeout'),{code:'REQUEST_TIMEOUT'})]){
    let writes=0;const support=[];
    await assert.rejects(uploadProjectFile(new Blob(['abc']),{machine:'node-a',project:'vision',area:'code',path:'x'},async()=>writes++,undefined,{inspect:async()=>{throw failure;},onRecoverySupport:value=>support.push(value)}));
    assert.equal(writes,0);assert.deepEqual(support,[],'Unknown availability is not an unsupported-node fallback');
  }
});
test('automatic training selection is distinct from fixed development context and requires OCI',()=>{
  const machines=[{id:'gpu-1'},{id:'gpu-2'}],project={project:'vision',environmentMode:'oci'};
  assert.deepEqual(trainingTarget('current','gpu-1',null,'',machines),{machine:'gpu-1'});
  assert.deepEqual(trainingTarget('auto','gpu-1',project,'gpu-2, gpu-1',machines),{machine:'auto',machineSelection:{mode:'auto',candidates:['gpu-1','gpu-2']}});
  assert.deepEqual(trainingTarget('auto','gpu-1',project,'',machines),{machine:'auto',machineSelection:{mode:'auto'}});
  for(const candidate of ['gpu-3','gpu-1,gpu-1'])assert.throws(()=>trainingTarget('auto','gpu-1',project,candidate,machines));
  for(const value of [null,{environmentMode:'shared'},{environmentMode:'isolated'}])assert.throws(()=>trainingTarget('auto','gpu-1',value,'',machines));
});
test('AUTO receipt confirms the selected authorized machine, fixed release and exact candidates',()=>{
  const machines=[{id:'gpu-1'},{id:'gpu-2'}],args={machine:'auto',key:'k',project:'vision',release,cards:1,machineSelection:{mode:'auto',candidates:['gpu-2','gpu-1']}},
    job={...args,id:'11111111-2222-4333-8444-555555555555',userId:'u',machine:'gpu-2',machineSelection:{mode:'auto',candidates:['gpu-1','gpu-2']}};
  assert.equal(trainingReceiptMatches(job,args,'u',machines),true);
  for(const patch of [{machine:'auto'},{machine:'gpu-3'},{release:future},{cards:2},{project:'other'},{userId:'foreign'},{key:'other'},{machineSelection:{mode:'auto'}},{machineSelection:{mode:'auto',candidates:{}}}])assert.equal(trainingReceiptMatches({...job,...patch},args,'u',machines),false);
  assert.equal(trainingReceiptMatches({...job,machine:'gpu-1'},{...args,machine:'gpu-1'},'u',machines),true);
});
test('project slug validation is exact and never coerces paths or array values',()=>{
  for(const value of ['vision','a','vision-baseline_2','a'.repeat(48)])assert.equal(validProject(value),true);
  for(const value of ['',null,undefined,['vision'],{},'../vision','1vision','Vision',' vision','vision/next','a'.repeat(49)])assert.equal(validProject(value),false);
});
test('training selects the persistent project without any release or dataset gate',()=>{
  const project={project:'vision',state:'DRAFT',releases:[]};
  assert.deepEqual(trainingProject(project),{project:'vision'});
  assert.deepEqual(trainingProject({...project,state:'PUBLISHING'}),{project:'vision'});
  assert.equal(Object.hasOwn(trainingProject(project),'release'),false);
  assert.throws(()=>trainingProject(null),/项目/);
  assert.throws(()=>trainingProject({project:'../other'}),/项目/);
});
test('dataset references survive project-mode training and reject incomplete or path-shaped values',()=>{
  assert.deepEqual(datasetReferences('sample@'+release+'\nother@'+future),[{dataset:'sample',version:release},{dataset:'other',version:future}]);
  assert.deepEqual(datasetReferences(''),[]);
  for(const value of ['sample@latest','../sample@'+release,'sample@'+release+'@extra'])assert.throws(()=>datasetReferences(value));
});
test('project upload chunks share a UUID, exact full-file SHA, length and final fence without truncate',async()=>{
  const bytes=Buffer.alloc(1048576+7,42),file=new Blob([bytes]),calls=[],progress=[];
  await uploadProjectFile(file,{machine:'gpu-1',project:'vision',area:'code',path:'train.py'},async args=>{calls.push(args);return {complete:args.final,size:args.offset+Buffer.from(args.data,'base64').length,sha256:args.sha256};},(offset,total)=>progress.push([offset,total]),absentUpload);
  assert.equal(calls.length,2);assert.match(calls[0].uploadId,/^[a-f0-9-]{36}$/);
  assert.equal(calls[0].uploadId,calls[1].uploadId);assert.equal(calls[0].sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.ok(calls.every(call=>call.totalSize===bytes.length&&call.sha256===calls[0].sha256&&call.project==='vision'&&call.area==='code'&&!Object.hasOwn(call,'truncate')));
  assert.deepEqual(calls.map(call=>[call.offset,call.final]),[[0,false],[1048576,true]]);
  assert.deepEqual(Buffer.concat(calls.map(call=>Buffer.from(call.data,'base64'))),bytes);assert.deepEqual(progress.at(-1),[bytes.length,bytes.length]);
});
test('zero-byte project upload still finalizes; retry keeps the original upload identity after status confirmation',async()=>{
  const context={machine:'gpu-1',project:'vision',area:'code',path:'empty.txt'},calls=[];
  await assert.rejects(uploadProjectFile(new Blob([]),context,async args=>{calls.push(args);throw Error('mock interrupted');},undefined,absentUpload),/interrupted/);
  await uploadProjectFile(new Blob([]),context,async args=>{calls.push(args);return {complete:true,size:0,sha256:args.sha256};},undefined,{inspect:async()=>({...calls[0],protocol:2,state:'UPLOADING',receivedBytes:0,resumable:true})});
  assert.equal(calls.length,2);assert.equal(calls[0].uploadId,calls[1].uploadId);
  assert.ok(calls.every(call=>call.final&&call.totalSize===0&&call.offset===0&&call.data===''));
});
test('project upload rejects output writes, oversized files and inconsistent length before any chunk',async()=>{
  let sent=0;const send=async()=>sent++,context={machine:'gpu-1',project:'vision',area:'code',path:'x'};
  await assert.rejects(uploadProjectFile(new Blob(['x']),{...context,area:'output'},send),/开发草稿/);
  await assert.rejects(uploadProjectFile({size:100*1024*1024+1},context,send),/100 MiB/);
  await assert.rejects(uploadProjectFile({size:1,arrayBuffer:async()=>new ArrayBuffer(0)},context,send),/长度/);
  assert.equal(sent,0);
});
test('project upload cannot report success without an exact final verified receipt',async()=>{
  const file=new Blob(['abc']),context={machine:'gpu-1',project:'vision',area:'code',path:'file.txt'},sha256=createHash('sha256').update('abc').digest('hex');
  const valid={complete:true,size:3,sha256};
  for(const receipt of [undefined,null,{}, {...valid,complete:false},{...valid,complete:'true'},{...valid,size:2},{...valid,size:'3'},{...valid,sha256:'f'.repeat(64)}]){
    const progress=[];await assert.rejects(uploadProjectFile(file,context,async()=>receipt,value=>progress.push(value),absentUpload),/尚未确认完整文件/);
    assert.deepEqual(progress,[],'a rejected final receipt must not announce completed bytes');
  }
});
test('project upload resumes from node-confirmed bytes and never resends the accepted prefix',async()=>{
 const bytes=Buffer.alloc(1048576+7,42),file=new Blob([bytes]),context={machine:'node-a',project:'vision',area:'code',path:'train.py'},id='a1234567-1234-4234-8234-123456789abc',puts=[],queries=[];
 const result=await uploadProjectFile(file,context,async args=>{puts.push(args);return {path:args.path,complete:true,size:args.totalSize,sha256:args.sha256};},undefined,{inspect:async args=>{queries.push(args);return {...args,uploadId:id,protocol:2,state:'UPLOADING',receivedBytes:1048576,resumable:true};}});
 assert.equal(result.uploadId,id);assert.equal(puts.length,1);assert.equal(puts[0].uploadId,id);assert.equal(puts[0].offset,1048576);assert.equal(Buffer.from(puts[0].data,'base64').length,7);
 assert.equal(queries.length,1);assert.equal(queries[0].sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(queries[0].uploadId,undefined,'initial discovery binds exact content, never invents a different ID');
});
test('lost chunk reply first observes the same ID and resumes only the acknowledged offset',async()=>{
 const file=new Blob([Buffer.alloc(1048576+7,42)]),context={machine:'node-a',project:'vision',area:'code',path:'train.py'},puts=[],queries=[];
 let original;
 await uploadProjectFile(file,context,async args=>{puts.push(args);original=args;if(puts.length===1)throw new TypeError('connection reset');return {complete:true,size:args.totalSize,sha256:args.sha256};},undefined,{inspect:async args=>{queries.push(args);return original?{...args,protocol:2,state:'UPLOADING',receivedBytes:1048576,resumable:true}:{protocol:2,state:'ABSENT',path:args.path};}});
 assert.deepEqual(puts.map(args=>args.offset),[0,1048576]);assert.equal(queries[1].uploadId,puts[0].uploadId);assert.equal(puts[1].uploadId,puts[0].uploadId);assert.equal(queries.length,2);
});
test('complete uploads are read-only; a pending completion sends only the original empty final block',async()=>{
 for(const completionPending of [false,true]){
  const file=new Blob(['abc']),context={machine:'node-a',project:'vision',area:'code',path:'x'},id='a1234567-1234-4234-8234-123456789abc',puts=[];
  await uploadProjectFile(file,context,async args=>{puts.push(args);return {complete:true,size:3,sha256:args.sha256};},undefined,{inspect:async args=>({...args,uploadId:id,protocol:2,state:'COMPLETE',complete:true,size:3,receivedBytes:3,completionPending})});
  assert.equal(puts.length,completionPending?1:0);if(completionPending){assert.equal(puts[0].uploadId,id);assert.equal(puts[0].offset,3);assert.equal(puts[0].data,'');assert.equal(puts[0].final,true);}
 }
});
test('unknown, changed, legacy and wrong upload identities never start or reset any upload',async()=>{
 const file=new Blob(['abc']),context={machine:'node-a',project:'vision',area:'code',path:'x'};
 for(const patch of [{protocol:1},{state:'UNKNOWN'},{state:'CONFLICT'},{path:'other'},{sha256:'f'.repeat(64)},{uploadId:'invalid'},{receivedBytes:-1},{receivedBytes:4},{resumable:false,legacy:true},{project:'other'},{machine:'node-b'}]){
  let puts=0;await assert.rejects(uploadProjectFile(file,context,async()=>puts++,undefined,{inspect:async args=>({...args,protocol:2,state:'UPLOADING',uploadId:'a1234567-1234-4234-8234-123456789abc',receivedBytes:1,resumable:true,...patch})}),/未确认|已变化|不能安全续传/);assert.equal(puts,0);
 }
});
test('uncertain recovery cannot roll offset back, swap ID or silently restart an absent upload',async()=>{
 for(const patch of [{state:'ABSENT'},{uploadId:'b1234567-1234-4234-8234-123456789abc'},{receivedBytes:0},{receivedBytes:4}]){
  const file=new Blob(['abc']),context={machine:'node-a',project:'vision',area:'code',path:'x'},id='a1234567-1234-4234-8234-123456789abc';let reads=0,puts=0;
  await assert.rejects(uploadProjectFile(file,context,async()=>{puts++;throw new TypeError('reply lost');},undefined,{inspect:async args=>({...args,protocol:2,state:'UPLOADING',uploadId:id,receivedBytes:1,resumable:true,...(++reads>1?patch:{})})}),/未确认/);
  assert.equal(puts,1);assert.equal(reads,2);
 }
});
test('status denial and context cancellation send no writes, and unknown recovery remains bounded',async()=>{
 const context={machine:'node-a',project:'vision',area:'code',path:'x'},file=new Blob(['abc']);let writes=0;
 await assert.rejects(uploadProjectFile(file,context,async()=>writes++,undefined,{inspect:async()=>{throw Object.assign(Error('not authorized'),{status:403});}}),/not authorized/);assert.equal(writes,0);
 const controller=new AbortController();await assert.rejects(uploadProjectFile(file,context,async()=>writes++,undefined,{signal:controller.signal,inspect:async args=>{controller.abort();return {protocol:2,state:'ABSENT',path:args.path};}}),error=>error.name==='AbortError');assert.equal(writes,0);
 let original,queries=0;await assert.rejects(uploadProjectFile(file,context,async args=>{writes++;original=args;throw new TypeError('reply lost');},undefined,{inspect:async args=>{queries++;return original?{...args,protocol:2,state:'UPLOADING',resumable:true,receivedBytes:0}:{protocol:2,state:'ABSENT',path:args.path};}}),/reply lost/);assert.equal(writes,4);assert.equal(queries,4);
});
test('maintenance allows upload progress inspection without enabling a resumed write',()=>{
 const data={operationalMaintenance:{version:1,global:{reason:'repair'},machines:{}}},principal={role:'member'},context={machine:'node-a',project:'vision',area:'code',path:'x'};
 assert.equal(maintenanceBlocks('files.upload.status',context,data,principal),null);assert.ok(maintenanceBlocks('files.put',context,data,principal));
});
test('terminal identity carries the selected project but never combines it with host root',()=>{
  assert.deepEqual(terminalContext({machine:'gpu-1',project:'vision'}),{machine:'gpu-1',project:'vision',hostAdmin:false});
  assert.deepEqual(terminalContext({machine:'gpu-1',project:''}),{machine:'gpu-1',hostAdmin:false});
  assert.deepEqual(terminalContext({machine:'gpu-1',hostAdmin:true}),{machine:'gpu-1',hostAdmin:true});
  assert.throws(()=>terminalContext({machine:'gpu-1',project:'vision',hostAdmin:true}),/ROOT/);
  for(const machine of ['',undefined,'auto'])assert.throws(()=>terminalContext({machine}));
  assert.throws(()=>terminalContext({machine:'gpu-1',project:['vision']}));
});
test('daily terminal entry is always private for members and administrators',()=>{
  for(const role of ['admin','member',undefined]){
    assert.deepEqual(terminalLaunchContext({machine:'gpu-1',role}),{machine:'gpu-1',hostAdmin:false});
    assert.deepEqual(terminalLaunchContext({machine:'gpu-1',role,project:'vision',hostAdmin:true}),{machine:'gpu-1',project:'vision',hostAdmin:false});
  }
});
test('host maintenance is an explicit admin-only entry with no inherited project',()=>{
  assert.deepEqual(terminalLaunchContext({machine:'gpu-2',role:'admin',project:'vision',entry:'host'}),{machine:'gpu-2',hostAdmin:true});
  for(const role of ['member',undefined,null,'administrator'])assert.throws(()=>terminalLaunchContext({machine:'gpu-2',role,entry:'host'}),/仅管理员/);
  for(const entry of ['root',true,null,{}])assert.throws(()=>terminalLaunchContext({machine:'gpu-2',role:'admin',entry}),/入口无效/);
});
test('project job table preserves full identity and escapes dynamic fields including GPU indices',()=>{
  const html=taskTable([{id:'job" onmouseover="bad',name:'<img src=x>',username:'<owner>',machine:'gpu-1',cards:1,assignedIndices:['<bad>'],state:'SUCCEEDED',project:'<project>',release,error:'<error>'}]);
  assert.doesNotMatch(html,/<img|<owner>|<project>|<bad>|<error>|data-job-output="job" onmouseover=/);
  assert.match(html,/data-job-output=/);assert.ok(html.includes(release));assert.match(html,/取消<\/button>/);
});
