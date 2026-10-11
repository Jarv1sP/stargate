import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadWorkspaceFiles,downloadWorkspaceFile,WORKSPACE_DOWNLOAD_MEMORY_BYTES,workspaceRegistrationsHTML,workspacePath,workspaceEntriesHTML,dataWorkspaceHTML,publicationText} from '../dist/data-workspace.js';
import {terminalContext,terminalLaunchContext} from '../dist/terminal-ui.js';
const file=(name,size)=>{const blob=new Blob([new Uint8Array(size)]);Object.defineProperty(blob,'name',{value:name});return blob;};

test('data terminal is a distinct personal scope without project or ROOT inheritance',()=>{
  for(const role of ['admin','member'])assert.deepEqual(terminalLaunchContext({machine:'node-a',project:'experiment',entry:'data',role}),{machine:'node-a',hostAdmin:false,dataWorkspace:true});
  assert.throws(()=>terminalContext({machine:'node-a',dataWorkspace:true,project:'experiment'}),/混用/);
  assert.throws(()=>terminalContext({machine:'node-a',dataWorkspace:true,hostAdmin:true}),/混用/);
});

test('workspace paths reject traversal and only allow root for explicit browse/upload',()=>{
  assert.equal(workspacePath('.',{root:true}),'.');assert.equal(workspacePath('训练/a.zip'),'训练/a.zip');
  for(const path of ['.','/data2/a','../a','x/../a','x//a','x\\a','x\na',''])assert.throws(()=>workspacePath(path));
  assert.equal(workspacePath('汉'.repeat(85)),'汉'.repeat(85));assert.throws(()=>workspacePath('汉'.repeat(86)));
  assert.equal(workspacePath(['a'.repeat(255),'b'.repeat(255),'c'.repeat(255),'d'.repeat(255)].join('/')).length,1023);
  assert.throws(()=>workspacePath(['a'.repeat(255),'b'.repeat(255),'c'.repeat(255),'d'.repeat(255),'x'].join('/')));
});

test('raw uploads are bounded, ordered, acknowledge exact offsets and never unpack/publish',async()=>{
  const calls=[],progress=[];
  const result=await uploadWorkspaceFiles({machine:'node-a',files:[file('dataset.zip',2*1024**2+7),file('empty',0)],directory:'incoming',call:async(operation,args)=>{calls.push({operation,args});return {path:args.path,size:args.offset+Buffer.from(args.data,'base64').length};},onProgress:value=>progress.push(value)});
  assert.deepEqual(result,{files:2,bytes:2*1024**2+7});assert.equal(calls.length,4);
  assert.ok(calls.every(call=>call.operation==='datasets.workspace.put'&&Buffer.from(call.args.data,'base64').length<=1024**2));
  assert.deepEqual(calls.map(call=>call.args.offset),[0,1024**2,2*1024**2,0]);assert.ok(calls.every(call=>call.args.truncate===false));
  assert.equal(calls[0].args.path,'incoming/dataset.zip');assert.equal(progress.at(-1).bytes,result.bytes);
});

test('explicit overwrite truncates only the first chunk; ambiguous error is not retried',async()=>{
  const calls=[];await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('a.zip',2*1024**2+1)],overwrite:true,call:async(operation,args)=>{calls.push(args);if(args.offset)throw Error('response lost');return {path:args.path,size:1024**2};}}),/response lost/);
  assert.equal(calls.length,2);assert.deepEqual(calls.map(call=>call.truncate),[true,false]);
});

test('abort after durable put stops further chunks and suppresses success callbacks',async()=>{
  const controller=new AbortController();let calls=0,reports=0;
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('a.zip',2*1024**2)],signal:controller.signal,call:async(operation,args)=>{calls++;controller.abort();return {path:args.path,size:1024**2};},onProgress:()=>reports++}),/停止/);
  assert.equal(calls,1);assert.equal(reports,0);
});

test('inexact receipts, duplicate filenames and invalid names fail closed',async()=>{
  for(const receipt of [{path:'incoming/a',size:2},{path:'different',size:1},{}])await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('a',1)],call:async()=>receipt}),/确认/);
  for(const names of [['a','a'],['../a'],['sub/a']])await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:names.map(name=>file(name,1)),call:async()=>assert.fail('invalid input reached network')}));
});

test('all file sizes and fully joined paths are validated before the first upload',async()=>{
  let calls=0;const call=async()=>{calls++;assert.fail('invalid batch reached network');};
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('first',1),{name:'too-big.tar',size:100*1024**3+1}],call}),/100 GiB/);
  const directory=['a'.repeat(255),'b'.repeat(255),'c'.repeat(255),'d'.repeat(200)].join('/');
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',directory,files:[file('first',1),file('z'.repeat(255),1)],call}),/1024/);
  assert.equal(calls,0);
});

test('workspace list escapes server filenames, paths and sizes',()=>{
  const html=workspaceEntriesHTML({path:'.',entries:[{type:'directory',name:'" onclick="<bad>'},{type:'file',name:'<script>',size:10}]});
  assert.doesNotMatch(html,/<bad>|<script>|data-workspace-path=""/);assert.match(html,/&lt;script&gt;/);assert.match(dataWorkspaceHTML(),/不会自动解压/);assert.match(dataWorkspaceHTML(),/结束此机器上的所有数据终端/);
});

test('private cleanup buttons require explicit node capability and retain exact escaped targets',()=>{
  const entries=[{type:'directory',name:'old',size:0},{type:'file',name:'a"b',size:4},{type:'unsupported',name:'socket'}];
  for(const cleanupProtocol of [undefined,0,'1'])assert.doesNotMatch(workspaceEntriesHTML({entries,cleanupProtocol}),/data-workspace-remove/);
  const html=workspaceEntriesHTML({path:'incoming',entries,cleanupProtocol:1});
  assert.match(html,/data-workspace-remove="incoming\/old" data-recursive="true"/);
  assert.match(html,/data-workspace-remove="incoming\/a&quot;b" data-recursive="false"/);
  assert.equal((html.match(/data-workspace-remove=/g)||[]).length,2);
});

test('publication receipts report current readiness and require admin inspection for unknown outcomes',()=>{
  for(const state of ['NOT_READY','UNREGISTERED','UNAVAILABLE']){
    const text=publicationText({state,publicationState:'READY'});assert.doesNotMatch(text,/服务器正在|已发布：|可在下方选择/);
  }
  assert.match(publicationText({state:'NOT_READY'}),/服务器缓存.*不再就绪/);
  assert.match(publicationText({state:'UNREGISTERED'}),/登记已删除/);
  assert.match(publicationText({state:'UNAVAILABLE'}),/无权.*管理员/);
  assert.match(publicationText({state:'UNKNOWN'}),/暂不可编辑.*管理员.*不要重复发布/);
});
test('raw browser files require explicit relay consent above the shared 256 MiB boundary',async()=>{
  const selected=size=>({name:'data.zip',size,slice(){throw Error('read-started');}}),call=async()=>assert.fail('No network expected in size-only fixture');
  for(const allowRelay of [undefined,false,'true'])await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[selected(256*1024**2+1)],allowRelay,call}),/确认 VPS 中转/);
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[selected(256*1024**2)],call}),/read-started/);
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[selected(256*1024**2+1)],allowRelay:true,call}),/read-started/);
  assert.match(dataWorkspaceHTML(),/个人数据上传通道/);assert.match(dataWorkspaceHTML(),/data-workspace-relay-consent/);
});
const downloadReply=(args,size=1024**2+3)=>({path:args.path,offset:args.offset,size,eof:args.offset+1024**2>=size,data:Buffer.alloc(Math.max(0,Math.min(1024**2,size-args.offset)),7).toString('base64')});
test('personal download streams exact bounded chunks using only workspace.get, including empty files',async()=>{
  for(const size of [0,1,1024**2+3]){
    const calls=[],writes=[],progress=[];
    const result=await downloadWorkspaceFile({machine:'node-a',path:'incoming/a.bin',call:async(operation,args)=>{calls.push({operation,args});return downloadReply(args,size);},write:bytes=>writes.push(bytes),onProgress:value=>progress.push(value)});
    assert.deepEqual(result,{path:'incoming/a.bin',bytes:size});assert.equal(writes.reduce((sum,row)=>sum+row.length,0),size);
    assert.deepEqual(calls.map(row=>row.args.offset),size>1024**2?[0,1024**2]:[0]);assert(calls.every(row=>row.operation==='datasets.workspace.get'&&row.args.machine==='node-a'&&row.args.path==='incoming/a.bin'));
    assert.deepEqual(progress.at(-1),{bytes:size,totalBytes:size});assert(writes.every(row=>row.length<=1024**2));
  }
});
test('personal download rejects wrong paths, offsets, sizes, eof and malformed chunks before writing',async()=>{
  for(const patch of [{path:'other'}, {offset:1},{size:-1},{size:'1'},{eof:true},{eof:'false'},{data:'?'},{data:'A==='},{data:'AA=='},{data:Buffer.alloc(1024**2+1).toString('base64')}]){
    let reads=0,writes=0;
    await assert.rejects(downloadWorkspaceFile({machine:'node-a',path:'a',call:async(_,args)=>{reads++;return {...downloadReply(args),...patch};},write:()=>writes++}));
    assert.equal(reads,1);assert.equal(writes,0);
  }
  let writes=0,reads=0;
  await assert.rejects(downloadWorkspaceFile({machine:'node-a',path:'a',call:async(_,args)=>{reads++;return downloadReply(args,args.offset?1024**2+4:1024**2+3);},write:()=>writes++}),/不一致/);
  assert.equal(reads,2);assert.equal(writes,1,'a resized file cannot append an unverified second chunk');
});
test('unsupported streaming bounds memory before collecting a large file, and errors are never retried',async()=>{
  let reads=0,writes=0;
  await assert.rejects(downloadWorkspaceFile({machine:'node-a',path:'a',limitBytes:WORKSPACE_DOWNLOAD_MEMORY_BYTES,call:async(_,args)=>{reads++;return downloadReply(args,WORKSPACE_DOWNLOAD_MEMORY_BYTES+1);},write:()=>writes++}),/100 MiB/);
  assert.equal(reads,1);assert.equal(writes,0);
  await assert.rejects(downloadWorkspaceFile({machine:'node-a',path:'a',call:async()=>{reads++;throw Object.assign(Error('server denied'),{status:403});},write:()=>writes++}),/server denied/);
  assert.equal(reads,2);assert.equal(writes,0);
});
test('abort after a read or a saved chunk suppresses further chunks and success progress',async()=>{
  for(const point of ['read','write']){
    const controller=new AbortController();let reads=0,writes=0,progress=0;
    await assert.rejects(downloadWorkspaceFile({machine:'node-a',path:'a',signal:controller.signal,call:async(_,args)=>{reads++;if(point==='read')controller.abort();return downloadReply(args);},write:()=>{writes++;if(point==='write')controller.abort();},onProgress:()=>progress++}),/停止/);
    assert.equal(reads,1);assert.equal(writes,point==='read'?0:1);assert.equal(progress,0);
  }
});
test('empty registrations need a confirmed list, render no version operations, and escape labels',()=>{
  const html=workspaceRegistrationsHTML({datasets:[{dataset:'empty-id',name:'<unsafe>',versions:[]},{dataset:'ready-id',versions:[{version:'a'.repeat(64)}]},{dataset:'unknown-id'}]});
  assert.match(html,/&lt;unsafe&gt;.*没有登记版本/);assert.doesNotMatch(html,/ready-id|unknown-id|<unsafe>|button/);assert.equal(workspaceRegistrationsHTML({datasets:[]} ),'<li>没有空登记。</li>');assert.throws(()=>workspaceRegistrationsHTML({}),/暂未确认/);
  assert.doesNotMatch(workspaceEntriesHTML({entries:[{name:'socket',type:'unsupported',size:0}]}),/data-workspace-download/);
});
