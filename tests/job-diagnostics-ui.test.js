import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticsHTML,createJobDiagnostics,allocationHistoryHTML} from '../dist/job-diagnostics-ui.js';
const JOB='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const fixture=()=>({jobId:JOB,state:'PARTIAL',schedulerState:'RUNNING',workerErrorEvidence:true,attempts:[{id:'A1',state:'FAILED',gpu_indices:[2],gpu_uuids:['GPU-test'],started_at:1,finished_at:2,failure_reason:'worker exited'}],captures:[{updatedAt:3,runnerExit:{exitCode:137},resources:{peaks:{'memory.peak':1024**3,'pids.peak':100},counters:{'memory.events':{oom:1,oom_kill:1},'pids.events':{max:2}}},logs:[{source:'ray/session/logs/worker.err',text:'RuntimeError: test',truncated:true}]}]});

test('exact lease history keeps actual acquisition/release separate from attempt times and marks truncated/migrated rows',()=>{
  const data={...fixture(),historyAvailable:true,historyTruncated:true,historyNextBeforeId:3,allocationHistory:[{id:4,attempt_id:'A1',gpu_index:2,gpu_uuid:'GPU-real',acquired_at:123.25,released_at:456.75,release_reason:'attempt finalized',source:'observed'},{id:3,attempt_id:'A0',gpu_index:1,gpu_uuid:'GPU-active',acquired_at:120,released_at:null,source:'migrated_active'}]};
  const html=diagnosticsHTML(data);for(const text of ['GPU-real','GPU-active','分配时间','释放时间 / 原因','attempt finalized','尚无释放记录','升级时补记的活动租约','继续查询游标：3','运行过程历史','GPU-test','.250','.750'])assert.ok(html.includes(text),text);
});
test('schema9 or absent history never borrows attempt timestamps or treats empty history as zero time',()=>{
  for(const value of [undefined,false]){const html=allocationHistoryHTML({...fixture(),historyAvailable:value,allocationHistory:[{gpu_uuid:'MUST_NOT_SHOW',acquired_at:1,released_at:2}]});assert.match(html,/旧任务未记录精确租约时间/);assert.doesNotMatch(html,/MUST_NOT_SHOW|1970|分配时间<\/th>/);}
  assert.match(allocationHistoryHTML({historyAvailable:true,allocationHistory:[]}),/不代表 GPU 占用时长为零/);
});
test('lease identifiers/reasons are escaped and missing release is not reported as still using GPU',()=>{
  const html=allocationHistoryHTML({historyAvailable:true,allocationHistory:[{id:'<script>',attempt_id:'<img>',gpu_index:0,gpu_uuid:'<svg>',acquired_at:1,released_at:null,release_reason:'<button onclick=bad>'}]});
  assert.doesNotMatch(html,/<script>|<img>|<svg>|<button onclick|正在占用/);assert.match(html,/&lt;button/);assert.match(html,/尚无释放记录/);
});

test('diagnostic view shows worker errors, resource events and durable UUID/index/start/end separately from RUNNING',()=>{
  const data=fixture(),html=diagnosticsHTML(data);
  for(const text of ['部分可用','调度状态：RUNNING','worker 错误线索','OOM / OOM kill / PID 拒绝','1 / 1 / 2','1.00 GiB','GPU-test','开始 / 结束','RuntimeError: test','已截断'])assert.ok(html.includes(text),text);
  assert.equal(data.schedulerState,'RUNNING');assert.match(html,/不冒充精确设备分配/);
  const empty=diagnosticsHTML({state:'UNAVAILABLE',schedulerState:'CANCELED'});assert.match(empty,/没有可用采集/);assert.match(empty,/未知/);assert.match(empty,/尚无运行历史/);
});

test('successful jobs with shutdown error keywords remain success and are only flagged as possible evidence',()=>{
  const data=fixture();data.state='COMPLETE';data.schedulerState='SUCCEEDED';data.captures[0].runnerExit.exitCode=0;
  data.captures[0].logs=[{source:'worker.err',text:'RpcError: End of file during shutdown'}];
  const html=diagnosticsHTML(data);
  assert.match(html,/调度状态：SUCCEEDED/);assert.match(html,/也可能来自正常退出日志/);
  assert.match(html,/日志线索不会自动判定任务失败/);assert.equal(data.schedulerState,'SUCCEEDED');
});

test('diagnostic logs, source names and attempt fields never inject HTML',()=>{
  const data=fixture();data.attempts[0].gpu_uuids=['<script>uuid</script>'];data.attempts[0].failure_reason='<img src=x onerror=bad>';
  data.captures[0].logs[0]={source:'<button onclick=bad>',text:'<script>alert(1)</script>'};
  const html=diagnosticsHTML(data);assert.doesNotMatch(html,/<script>|<img|<button onclick/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;button/);
});

function domFixture(t){
  const nodes=new Map(),downloads=[],errors=[],calls=[],viewed=[],oldDocument=globalThis.document;
  class Element{
    constructor(tag='div'){this.tag=tag;this.listeners=new Map();this.hidden=false;this.disabled=false;this.open=false;this._text='';this._html='';}
    set id(id){this._id=id;nodes.set('#'+id,this);}get id(){return this._id;}
    set textContent(text){this._text=text;this._html='';}get textContent(){return this._text;}
    set innerHTML(html){this._html=html;this._text='';for(const match of html.matchAll(/id="([^"]+)"/g)){const item=new Element();item.id=match[1];}}
    get innerHTML(){return this._html;}
    querySelector(selector){return selector==='pre'?pre:nodes.get(selector);}
    addEventListener(event,fn){this.listeners.set(event,fn);}
    async fire(event){return this.listeners.get(event)?.();}
    setAttribute(name,value){this[name]=value;}
    before(){}after(){}append(){}
    showModal(){this.open=true;}close(){if(this.open){this.open=false;this.fire('close');}}
    click(){if(this.tag==='a')downloads.push({href:this.href,name:this.download});else return this.fire('click');}
  }
  const pre=new Element('pre'),dialog=new Element('dialog');
  globalThis.document={querySelector:selector=>nodes.get(selector),head:new Element('head'),createElement:tag=>new Element(tag),dispatchEvent:event=>{if(event.type==='gpuq-attention-viewed')viewed.push(event.detail);return true;}};
  t.after(()=>{globalThis.document=oldDocument;});
  const store={principal:{userId:'owner',role:'member'},call:async(op,args)=>{calls.push({op,args});return op==='jobs.logs'?{text:'main log'}:fixture();}};
  const control=createJobDiagnostics(store,()=>dialog,error=>errors.push(error));control.install();
  return {store,control,dialog,pre,nodes,calls,errors,downloads,viewed};
}

test('log window exposes diagnostics and JSON download without altering job status',async t=>{
  const f=domFixture(t);await f.control.openLogs(JOB);assert.equal(f.pre.textContent,'main log');assert.equal(f.dialog.open,true);
  await f.nodes.get('#job-diagnostic-open').fire('click');assert.match(f.nodes.get('#job-diagnostic-view').innerHTML,/GPU-test/);assert.equal(f.nodes.get('#job-diagnostic-download').disabled,false);
  await f.nodes.get('#job-diagnostic-download').fire('click');assert.equal(f.downloads[0].name,'gpuq-diagnostics-'+JOB+'.json');
  assert.deepEqual(f.calls.map(c=>c.op),['jobs.logs','jobs.diagnostics']);
  assert.ok(f.viewed.length>=2);assert.ok(f.viewed.every(row=>row.kind==='job'&&row.userId==='owner'&&row.id===JOB),'view notifications carry the current account and displayed task');
});

test('late responses cannot leak across logout, role change or another job',async t=>{
  const f=domFixture(t);let resolve;
  f.store.call=()=>new Promise(r=>resolve=r);const pending=f.control.openLogs(JOB);
  f.store.principal=null;f.control.sync();resolve({text:'PRIVATE OLD USER'});await pending;
  assert.equal(f.pre.textContent,'');assert.equal(f.dialog.open,false);
  f.store.principal={userId:'owner',role:'admin'};f.store.call=async()=>({text:'admin log'});await f.control.openLogs(JOB);
  f.store.principal.role='member';f.control.sync();assert.equal(f.pre.textContent,'');
  f.store.call=async()=>({text:'new log'});await f.control.openLogs(JOB);
  f.store.call=()=>new Promise(r=>resolve=r);const diagnostic=f.nodes.get('#job-diagnostic-open').fire('click');
  f.control.reset();resolve(fixture());await diagnostic;assert.equal(f.nodes.get('#job-diagnostic-view').innerHTML,'');assert.equal(f.nodes.get('#job-diagnostic-download').disabled,true);
});

test('diagnostic failure keeps main log readable and overlapping requests do not strand its loading state',async t=>{
  const f=domFixture(t);let resolveLog;
  f.store.call=op=>op==='jobs.logs'?new Promise(resolve=>resolveLog=resolve):Promise.resolve(fixture());
  const main=f.control.openLogs(JOB);await f.nodes.get('#job-diagnostic-open').fire('click');resolveLog({text:'late main log'});await main;
  await f.nodes.get('#job-log-view').fire('click');assert.equal(f.pre.hidden,false);assert.equal(f.pre.textContent,'late main log');
  f.store.call=async()=>{throw Error('offline');};await f.nodes.get('#job-diagnostic-open').fire('click');assert.match(f.nodes.get('#job-diagnostic-view').textContent,/offline/);assert.equal(f.pre.textContent,'late main log');
});

test('reopening the same job preserves confirmed logs during a failed refresh, but a different account clears them',async t=>{
  const f=domFixture(t);await f.control.openLogs(JOB);assert.equal(f.pre.textContent,'main log');
  f.dialog.close();let reject;f.store.call=()=>new Promise((_,no)=>reject=no);
  const pending=f.control.openLogs(JOB);assert.equal(f.pre.textContent,'main log');reject(Error('offline'));await pending;
  assert.equal(f.pre.textContent,'main log');assert.match(f.nodes.get('#job-view-status').textContent,/offline/);
  f.store.principal=null;f.control.sync();assert.equal(f.pre.textContent,'');
  f.store.principal={userId:'other',role:'member'};f.store.call=async()=>{throw Error('offline');};await f.control.openLogs(JOB);
  assert.doesNotMatch(f.pre.textContent,/main log/);
});
