import {MACHINES} from './dist/model.js';

// Retired workflow: no dispatch/cancel path. Retain all records and audit;
// observe only commands dispatched before retirement. Admin host.* is separate.
export const MAINTENANCE_LIMITS=Object.freeze({page:50,outputBytes:65536});
export const MAINTENANCE_RETIRED_MESSAGE='维护申请已停用，不能再提交、审批或执行。需要系统维护请联系管理员；管理员可使用独立 ROOT 终端或 gpuctl exec。历史记录仍可查看。';
const DONE=new Set(['RETURNED','WITHDRAWN','SUCCEEDED','FAILED','CANCELED','TIMED_OUT']);
const NODE_STATES=new Set(['RUNNING','CANCELING','SUCCEEDED','FAILED','CANCELED','TIMED_OUT','UNKNOWN']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
// Operational admission is independent of the retired privilege-request flow.
// This row is not part of account snapshots, so an unrelated rollback cannot
// remove a maintenance decision. No deadline or automatic unlock exists.
const READ_OR_STOP=new Set([
  'data.roots','data.copy.status','data.copy.cancel','data.upload.status',
  'storage.usage.mine','storage.usage.users','storage.upload.locate',
  'jobs.logs','jobs.watch','jobs.diagnostics','jobs.completion','jobs.reconcile-resources','jobs.cancel','logs','watch','diagnostics','cancel','tasks.display.get',
  'files.list','files.get','files.upload.status','files.upload.list','files.upload.cancel','projects.list','projects.quota','projects.status','projects.verify','projects.local-import.status','projects.local-import.cancel','host.status',
  'datasets.list','datasets.catalog','datasets.capacity','datasets.overview','datasets.files.list','datasets.training.capabilities','datasets.status',
  'datasets.cache.capabilities','datasets.cache.status','datasets.cache.cancel',
  'storage.cache-action.capabilities','storage.cache-action.status','storage.cache-action.cancel',
  'datasets.archive.cancel-intent',
  'projects.label.get','projects.group.get','projects.catalog','projects.retire.plan','projects.retire.status',
  'projects.sync.status','projects.sync.cancel',
  'datasets.delete.status','datasets.delete.cancel','storage.dataset-delete.cancel','storage.dataset-delete.status','storage.dataset-delete.capabilities','storage.dataset-delete.locations',
  'datasets.workspace.list','datasets.workspace.get','datasets.workspace.status','datasets.upload.status','datasets.upload.list','datasets.upload.admission.status',
  'datasets.upload.routes','datasets.upload.pause','datasets.upload.direct-revoke','datasets.import.list','datasets.import.status','datasets.import.cancel',
  'datasets.storage.status','datasets.storage.plan','terminal.close','terminal.detach','terminal.status',
  'transfers.list','transfers.status','transfers.capabilities','transfers.cancel','transfers.progress',
  'transfers.confirm-source-release','transfers.release-source','storage.lease.cancel','storage.download.finish',
  'cloud.info','cloud.import.list','cloud.import.status','cloud.import.cancel',
  'cloud.files.info','cloud.files.list','cloud.files.status','cloud.files.cancel'
]);
const maintenanceError=(machine,value)=>Object.assign(Error(`${machine?'服务器 '+machine:'全平台'}维护中：${value.reason}。新任务、终端输入和数据写入已暂停，请等待管理员明确恢复；仍可查看历史、日志或取消任务。`),{status:503,code:'MAINTENANCE_ACTIVE'});
function maintenanceState(service){
  const value=JSON.parse(service.db.prepare('SELECT data FROM operational_maintenance WHERE id=1').get().data);
  if(value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!value.machines||typeof value.machines!=='object'||Array.isArray(value.machines)||Object.keys(value.machines).some(id=>!MACHINES.some(m=>m.id===id)))throw Error('维护状态损坏，需管理员核查；未自动解除。');
  for(const entry of [value.global,...Object.values(value.machines)])if(entry!==null&&(!entry||typeof entry.reason!=='string'||!entry.reason.trim()||entry.reason.length>300||typeof entry.since!=='string'))throw Error('维护状态损坏，需管理员核查；未自动解除。');
  return value;
}
function operationalCall(service,principal,operation,args){
  if(operation==='maintenance.status'){
    fields(args,[]);return service.operationalMaintenance(principal);
  }
  if(principal.role!=='admin')fail('仅管理员可设置或解除维护状态。',403);
  fields(args,['scope','enabled','reason','revision']);
  if(args.scope!=='all'&&!MACHINES.some(m=>m.id===args.scope)||typeof args.enabled!=='boolean'||!Number.isSafeInteger(args.revision)||args.revision<0)fail('维护范围、状态或版本无效。');
  const reason=args.reason;
  if(args.enabled&&(typeof reason!=='string'||!reason.trim())||reason!==undefined&&(typeof reason!=='string'||reason.length>300||/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(reason)))fail('维护原因须为 1–300 字的单行文本，不含控制字符。');
  service.db.exec('BEGIN IMMEDIATE');
  try{
    const value=maintenanceState(service);
    if(value.revision!==args.revision)fail('维护状态已由其他窗口修改，请刷新后确认。',409);
    const entry=args.enabled?{reason:reason.trim(),since:new Date().toISOString()}:null;
    if(args.scope==='all')value.global=entry;
    else if(entry)value.machines[args.scope]=entry;
    else delete value.machines[args.scope];
    value.revision++;
    service.db.prepare('UPDATE operational_maintenance SET data=? WHERE id=1').run(JSON.stringify(value));
    service.audit(principal.username,operation,args.scope,JSON.stringify({enabled:args.enabled,reason:reason?.trim()||'',revision:value.revision}));
    service.db.exec('COMMIT');return service.operationalMaintenance(principal);
  }catch(error){service.db.exec('ROLLBACK');throw error;}
}
function fields(args,names){if(Object.keys(args).some(k=>!names.includes(k)))fail('维护操作参数无效。');}
function uuid(value){if(typeof value!=='string'||!UUID.test(value))fail('需要完整 UUID 编号。');return value;}
function user(service,principal){
  const current=service.store.users.find(u=>u.id===principal.userId);
  if(!current?.enabled||(current.role||'member')!==principal.role)fail('账号权限已改变，请重新登录。',403);
  return current;
}
function load(service,id){const row=service.db.prepare('SELECT * FROM maintenance_requests WHERE id=?').get(uuid(id));if(!row)fail('记录不存在或无权查看。',404);return row;}
function access(service,principal,row){
  const current=user(service,principal);
  if(principal.role==='admin')return row;
  if(row.owner_id!==current.id)fail('记录不存在或无权查看。',404);
  const machine=JSON.parse(row.data).payload.machine;
  if(!MACHINES.some(m=>m.id===machine)||!service.store.get(current.id).limits[machine])fail('这台机器未授权。',403);
  return row;
}
function view(row,detail=true){
  const data=JSON.parse(row.data),{script,reason,...payload}=data.payload;
  return {id:row.id,...payload,owner:data.owner,state:row.state,revision:row.revision,retired:true,readOnly:true,actionable:false,
    createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),scriptSha256:data.scriptSha256,
    ...(data.decision?{decision:data.decision}:{}),...(detail?{script,reason,...(data.approver?{execution:{id:data.executionKey,approvedBy:data.approver}}:{}),...(data.result?{result:data.result}:{}),...(data.error?{error:data.error}:{})}:{})};
}
function bounded(value){return typeof value==='string'?new TextDecoder().decode(Buffer.from(value).subarray(0,MAINTENANCE_LIMITS.outputBytes),{stream:true}):'';}
function resultValue(value,key){
  if(!value||value.id!==key||!NODE_STATES.has(value.state))throw Error('节点命令回执不匹配，需核对原操作。');
  return {state:value.state,stdout:bounded(value.stdout),stderr:bounded(value.stderr),exitCode:Number.isInteger(value.exitCode)?value.exitCode:null,
    signal:Number.isInteger(value.signal)?value.signal:null,timedOut:value.timedOut===true,cancelRequested:value.cancelRequested===true,
    truncated:{stdout:value.truncated?.stdout===true||Buffer.byteLength(value.stdout||'')>MAINTENANCE_LIMITS.outputBytes,
      stderr:value.truncated?.stderr===true||Buffer.byteLength(value.stderr||'')>MAINTENANCE_LIMITS.outputBytes},
    ...(typeof value.error==='string'?{error:value.error.slice(0,400)}:{}),checkedAt:new Date().toISOString()};
}
async function sync(service,row){
  if(DONE.has(row.state)||row.state==='PENDING')return row;
  const data=JSON.parse(row.data);if(!data.approver)return row;
  let state='UNKNOWN';
  try{
    // Fixed status operation, original execution key and original actor only.
    const result=await service.bridge(data.payload.machine,'host.status',{id:data.executionKey,userId:data.approver.id,username:data.approver.username,hostAdmin:true});
    data.result=resultValue(result,data.executionKey);state=data.result.state;delete data.error;
  }catch{data.error='原操作结果尚未确认；仅查询原执行记录，不会重新执行或自动停止。';}
  service.db.exec('BEGIN IMMEDIATE');
  try{
    const written=service.db.prepare('UPDATE maintenance_requests SET data=?,state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(JSON.stringify(data),state,Date.now(),row.id,row.revision);
    if(written.changes!==1)fail('记录已改变，请刷新后重试。',409);
    if(state!==row.state)service.audit('maintenance-reconcile','maintenance.sync',row.id,JSON.stringify({state,digest:row.digest}));
    service.db.exec('COMMIT');return load(service,row.id);
  }catch(error){service.db.exec('ROLLBACK');throw error;}
}
// Initialize only the persisted admission state before any startup retention.
// Account/bridge-dependent interfaces remain installed later, after restore.
export function installMaintenanceState(service){
  service.db.exec('CREATE TABLE IF NOT EXISTS operational_maintenance (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)');
  service.db.prepare('INSERT OR IGNORE INTO operational_maintenance VALUES(1,?)').run(JSON.stringify({version:1,revision:0,global:null,machines:{}}));
  maintenanceState(service); // Invalid persisted state is never treated as off.
  service.globalMaintenanceActive=()=>maintenanceState(service).global!==null;
  service.maintenanceFor=machine=>{const value=maintenanceState(service);return value.global||value.machines[machine]||null;};
}
export function installMaintenance(service){
  installMaintenanceState(service);
  service.operationalMaintenance=principal=>{
    const value=maintenanceState(service),limits=service.store.get(principal.userId).limits;
    return {...value,machines:Object.fromEntries(Object.entries(value.machines).filter(([id])=>principal.role==='admin'||limits[id]))};
  };
  service.assertMaintenanceAllowed=(operation,args={},principal)=>{
    // The bridge calls this again with its trusted actor, immediately before
    // dispatch. Client-supplied role/hostAdmin alone never grants an exemption.
    const actor=principal&&service.store.users.find(u=>u.id===principal.userId);
    const admin=actor?.enabled&&actor.role==='admin'&&principal.role==='admin';
    if(admin&&(operation.startsWith('host.')||operation.startsWith('terminal.')&&args.hostAdmin===true))return;
    if(READ_OR_STOP.has(operation)||operation==='terminal.exchange'&&(args.input===undefined||args.input==='')||operation==='transfers.io'&&['status','direct-revoke'].includes(args.action))return;
    if(service.warehouseMaintenanceUploadAllowed?.(operation,args,principal)===true)return;
    const machines=[args.machine,args.from,args.sourceMachine,args.targetMachine,args.source?.machine,args.job?.machine].filter(id=>typeof id==='string');
    if(args.jobId){const job=service.store.jobs.find(job=>job.id===args.jobId&&(admin||job.userId===principal?.userId));if(job)machines.push(job.machine);}
    const value=maintenanceState(service);
    if(value.global)throw maintenanceError(null,value.global);
    for(const machine of machines)if(value.machines[machine]){
      const visible=admin||actor?.enabled&&(service.store.get(actor.id).limits[machine]||service.archiveMachineVisible?.(actor.id,machine));
      if(principal&&!visible)throw Object.assign(Error('这台机器未授权。'),{status:403,code:'MAINTENANCE_ACTIVE'});
      throw maintenanceError(machine,value.machines[machine]);
    }
  };
  const bridge=service.bridge;
  if(bridge)service.bridge=(machine,operation,args)=>{
    const actor=service.store.users.find(user=>user.id===(args.userId||args.job?.userId));
    service.assertMaintenanceAllowed(operation,{...args,machine},actor?{userId:actor.id,role:actor.role||'member'}:null);
    return bridge(machine,operation,args);
  };
  service.db.exec(`CREATE TABLE IF NOT EXISTS maintenance_requests (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,client_key TEXT NOT NULL,
    digest TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL,
    UNIQUE(owner_id,client_key));
    CREATE INDEX IF NOT EXISTS maintenance_owner ON maintenance_requests(owner_id,seq);
    CREATE INDEX IF NOT EXISTS maintenance_state ON maintenance_requests(state,updated_at);`);
  service.maintenanceReconciling=false;
  service.reconcileMaintenance=async()=>{
    if(service.closing||!service.bridge||service.maintenanceReconciling||service.globalMaintenanceActive())return;
    service.maintenanceReconciling=true;
    try{
      const rows=service.db.prepare("SELECT id FROM maintenance_requests WHERE state IN ('DISPATCHING','RUNNING','CANCELING','UNKNOWN') ORDER BY updated_at LIMIT 4").all();
      if(!rows.length){clearInterval(service.maintenanceTimer);service.maintenanceTimer=null;return;}
      for(const {id} of rows){if(service.closing||service.globalMaintenanceActive())break;await service.enqueue(async()=>{if(!service.closing&&!service.globalMaintenanceActive())await sync(service,load(service,id));});}
    }finally{service.maintenanceReconciling=false;}
  };
  // No new requests can appear; fresh installations need no polling timer.
  if(service.db.prepare("SELECT 1 FROM maintenance_requests WHERE state IN ('DISPATCHING','RUNNING','CANCELING','UNKNOWN') LIMIT 1").get()){
    service.maintenanceTimer=setInterval(()=>service.reconcileMaintenance().catch(()=>{}),15000);service.maintenanceTimer.unref();
  }
}
export async function maintenanceCall(service,principal,operation,args){
  const current=user(service,principal);
  if(['maintenance.status','maintenance.set'].includes(operation))return operationalCall(service,principal,operation,args);
  // Reject before loading an ID or accepting old approval tokens. Only these
  // exact read operations survive; unknown/legacy writes always return 410.
  if(!['maintenance.list','maintenance.get'].includes(operation))fail(MAINTENANCE_RETIRED_MESSAGE,410);
  if(operation==='maintenance.list'){
    fields(args,['cursor','limit']);const limit=args.limit??MAINTENANCE_LIMITS.page;
    if(!Number.isInteger(limit)||limit<1||limit>MAINTENANCE_LIMITS.page)fail('每页数量须为 1–50。');
    if(args.cursor!==undefined&&(typeof args.cursor!=='string'||!/^\d{1,15}$/.test(args.cursor)||!Number.isSafeInteger(Number(args.cursor))))fail('列表游标无效。');
    const machines=MACHINES.filter(m=>service.store.get(current.id).limits[m.id]).map(m=>m.id);
    if(principal.role!=='admin'&&!machines.length)return {items:[],nextCursor:null,retired:true,readOnly:true};
    const own=principal.role==='admin'?'':' AND owner_id=? AND json_extract(data,\'$.payload.machine\') IN ('+machines.map(()=>'?').join(',')+')';
    const rows=service.db.prepare('SELECT * FROM maintenance_requests WHERE seq<?'+own+' ORDER BY seq DESC LIMIT ?')
      .all(Number(args.cursor??Number.MAX_SAFE_INTEGER),...(principal.role==='admin'?[]:[current.id,...machines]),limit+1);
    return {items:rows.slice(0,limit).map(row=>view(row,false)),nextCursor:rows.length>limit?String(rows[limit-1].seq):null,retired:true,readOnly:true};
  }
  fields(args,['id']);let row=access(service,principal,load(service,args.id));
  if(service.bridge)row=await sync(service,row);
  return view(row);
}
