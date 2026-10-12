import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadWorkspaceFiles,downloadWorkspaceFile,WORKSPACE_DOWNLOAD_MEMORY_BYTES,workspacePath,workspaceEntriesHTML,dataWorkspaceHTML} from '../dist/data-workspace.js';
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

function uploader(hook=()=>{}){
  const rows=new Map(),calls=[];
  const call=async(operation,args)=>{
    calls.push({operation,args});let row=rows.get(args.key);
    if(operation==='data.upload.status')return [...rows.values()].find(r=>r.path===args.path)||{state:'ABSENT',path:args.path,receivedBytes:0};
    if(operation==='data.upload.begin'){row={...args,state:'UPLOADING',receivedBytes:0};rows.set(args.key,row);}
    if(operation==='data.upload.chunk'){
      assert.equal(args.offset,row.receivedBytes);
      row.receivedBytes+=Buffer.from(args.data,'base64').length;
    }
    if(operation==='data.upload.finish'){assert.equal(row.receivedBytes,row.totalSize);row.state='COMPLETE';}
    await hook(operation,args,row);return {...row};
  };
  return {call,calls,rows};
}
test('raw uploads use the resumable protocol, exact offsets and checksums, never publication',async()=>{
  const f=uploader(),progress=[];
  const result=await uploadWorkspaceFiles({machine:'node-a',files:[file('dataset.zip',2*1024**2+7),file('empty',0)],call:f.call,onProgress:v=>progress.push(v)});
  assert.deepEqual(result,{files:2,bytes:2*1024**2+7});
  const chunks=f.calls.filter(c=>c.operation==='data.upload.chunk');
  assert.deepEqual(chunks.map(c=>c.args.offset),[0,1024**2,2*1024**2]);
  assert.ok(chunks.every(c=>Buffer.from(c.args.data,'base64').length<=1024**2));
  assert.ok([...f.rows.values()].every(r=>r.state==='COMPLETE'&&/^[a-f0-9]{64}$/.test(r.sha256)));
  assert.equal(f.calls.some(c=>c.operation.startsWith('datasets.')),false);
  assert.equal(progress.at(-1).bytes,result.bytes);
});
test('explicit overwrite is bound at begin; a lost chunk reply never restarts or truncates',async()=>{
  const f=uploader((operation,args)=>{if(operation==='data.upload.chunk'&&args.offset)throw Error('response lost');});
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('a.zip',2*1024**2+1)],overwrite:true,call:f.call}),/response lost/);
  assert.equal(f.calls.filter(c=>c.operation==='data.upload.begin').length,1);
  assert.equal(f.calls.find(c=>c.operation==='data.upload.begin').args.overwrite,true);
  assert.equal(f.calls.some(c=>c.operation==='data.upload.finish'||'truncate' in c.args),false);
});
test('abort after durable write stops further chunks and success progress',async()=>{
  const controller=new AbortController();let afterAbort=0;
  const f=uploader(operation=>{if(operation==='data.upload.chunk')controller.abort();});
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('a.zip',2*1024**2)],signal:controller.signal,call:f.call,onProgress:()=>{if(controller.signal.aborted)afterAbort++;}}),/停止/);
  assert.equal(f.calls.filter(c=>c.operation==='data.upload.chunk').length,1);assert.equal(afterAbort,0);
});
test('inexact receipts, duplicate filenames and invalid names fail closed',async()=>{
  for(const receipt of [{path:'incoming/a',size:2},{path:'different',size:1},{}])await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('a',1)],call:async()=>receipt}),/确认|身份/);
  for(const names of [['a','a'],['../a'],['sub/a']])await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:names.map(name=>file(name,1)),call:async()=>assert.fail('invalid input reached network')}));
});

test('all file sizes and fully joined paths are validated before the first upload',async()=>{
  let calls=0;const call=async()=>{calls++;assert.fail('invalid batch reached network');};
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',files:[file('first',1),{name:'too-big.tar',size:Number.MAX_SAFE_INTEGER+1}],call}),/大小/);
  const directory=['a'.repeat(255),'b'.repeat(255),'c'.repeat(255),'d'.repeat(200)].join('/');
  await assert.rejects(uploadWorkspaceFiles({machine:'node-a',directory,files:[file('first',1),file('z'.repeat(255),1)],call}),/1024/);
  assert.equal(calls,0);
});

test('workspace list escapes server filenames, paths and sizes',()=>{
  const html=workspaceEntriesHTML({path:'.',entries:[{type:'directory',name:'" onclick="<bad>'},{type:'file',name:'<script>',size:10}]});
  assert.doesNotMatch(html,/<bad>|<script>|data-workspace-path=""/);assert.match(html,/&lt;script&gt;/);assert.match(dataWorkspaceHTML(),/不会自动解压/);assert.match(dataWorkspaceHTML(),/无需发布/);
});

test('personal storage no longer offers publication, registration or cache preparation',()=>{
  assert.doesNotMatch(dataWorkspaceHTML(),/data-workspace-publish|data-workspace-registrations/);
  assert.match(dataWorkspaceHTML(),/\/data\/mine/);
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
test('non-regular entries never offer downloads',()=>{
  assert.doesNotMatch(workspaceEntriesHTML({entries:[{name:'socket',type:'unsupported',size:0}]}),/data-workspace-download/);
});
