import {randomUUID,createHash} from 'node:crypto';
import {authorizationPolicy,MACHINES} from './dist/model.js';
import {executionCall} from './execution.mjs';
import {snapshotSyncCall} from './snapshot-sync.mjs';
import {assertTrainingPreparation,bindTrainingPreparation,trainingPreparationCall} from './training-preparation.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,hash=/^[a-f0-9]{64}$/;
const done=new Set(['SUCCEEDED','CANCELED']),states=new Set(['RUNNING','RETRYING','VERIFYING','CANCELING','UNKNOWN','SUCCEEDED','FAILED','PAUSED','CANCELED']);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const fields=(args,allowed)=>{if(Object.keys(args).some(k=>!allowed.includes(k)))fail('传输参数无效。');};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId=value=>{if(typeof value!=='string'||!uuid.test(value))fail('需提供完整传输 UUID。');return value;};
const lanes=new WeakMap();
// Never derived from HTTP arguments. Only the archive orchestrator can open a
// copy to the configured cold store without a compute grant on that machine.
const archiveAdmission=Symbol('trusted archive admission');
// Older orchestrated copies used an ordinary upload admission. They may resume
// that SAME stopped transfer, but cannot acquire the newer archive lane.
const legacyArchiveAdmission=Symbol('trusted legacy archive resume');
const trainingAdmission=Symbol('trusted durable training preparation');
function laneState(service){let state=lanes.get(service);if(!state){state={pending:0,users:new Map(),rows:new Map()};lanes.set(service,state);}return state;}
async function inLane(service,owner,key,run){
  const state=laneState(service),lane=state.rows.get(key)||{tail:Promise.resolve(),pending:0},count=state.users.get(owner)||0;
  if(state.pending>=8||count>=2||lane.pending>=2)fail('传输请求正在处理，请稍后刷新。',429);
  state.pending++;state.users.set(owner,count+1);lane.pending++;state.rows.set(key,lane);
  const result=lane.tail.then(run);lane.tail=result.catch(()=>{});
  try{return await result;}finally{state.pending--;lane.pending--;const left=state.users.get(owner)-1;if(left)state.users.set(owner,left);else state.users.delete(owner);if(!lane.pending)state.rows.delete(key);}
}
const rowKey=row=>JSON.stringify([row.owner_id,row.client_key]);
function info(value){
  if(value?.state!=='READY'||!hash.test(value.manifestSha256||'')||!Number.isSafeInteger(value.manifestBytes)||value.manifestBytes<1||value.manifestBytes>64*1024**2||!Number.isSafeInteger(value.totalBytes)||value.totalBytes<0||!Number.isSafeInteger(value.entries)||value.entries<0||value.entries>500000)fail('快照尚未就绪或清单无效。',409);
  return Object.fromEntries(['state','manifestBytes','manifestSha256','totalBytes','entries'].map(k=>[k,value[k]]));
}
function load(service,id){const row=service.db.prepare('SELECT * FROM transfers WHERE id=?').get(validId(id));if(!row)fail('传输不存在。',404);return {...row,data:JSON.parse(row.data)};}
function targetCall(service,row,operation,args){
  const binding=row.data.trainingPreparation;
  if(!binding){
    // A damaged/missing transfer projection is not proof this was legacy.
    // The independently durable original job intent must also be absent.
    const jobs=service.store.jobs;
    if(Object.hasOwn(row.data,'trainingPreparation')||Array.isArray(jobs)&&jobs.some(job=>job.trainingPreparations?.some(value=>
      value.preparation?.kind==='transfer'&&value.preparation.id===row.id)))
      fail('原训练准备回执缺失；不会把标记过的任务降回旧 worker。',409);
    // Legacy standalone transfer/archive services have no durable training
    // enqueue/store. A real training-capable service losing its registry is
    // unknown, not evidence that an original marked transfer was legacy.
    if(!Array.isArray(jobs)&&!(jobs===undefined&&typeof service.enqueue!=='function'))
      fail('训练任务登记不可用；不会猜测原传输属于旧 worker。',409);
    return service.bridge(row.data.machine,operation,args);
  }
  if(binding.job.userId!==row.owner_id||binding.preparation.id!==row.id||binding.preparation.targetMachine!==row.data.machine||
     binding.preparation.sourceMachine!==row.data.from||binding.preparation.kind!=='transfer'||
     binding.preparation.reference.dataset!==row.data.reference.dataset||binding.preparation.reference.version!==row.data.reference.version)
    fail('新训练准备的原传输身份不符；不会回退旧 worker。',409);
  return trainingPreparationCall(service,binding,operation,args);
}
function view(row){
  const {sourceTicket,sourceRelease,trainingPreparation,...safe}=row.data;
  return {id:row.id,state:row.state,createdAt:row.created_at,updatedAt:row.updated_at,...safe,
    ...(sourceRelease?{sourceRelease:{state:sourceRelease.state,...(sourceRelease.state==='PENDING'?{message:sourceTicket?'源租约收尾尚未确认；保护继续保留，后台会重试。':'源授权回执缺失；保护继续保留，需管理员核对。'}:{})}}:{})};
}
function transaction(service,fn){service.db.exec('BEGIN IMMEDIATE');try{const result=fn();service.db.exec('COMMIT');return result;}catch(e){service.db.exec('ROLLBACK');throw e;}}
function save(service,row,state,actor,operation){
  if(service.closing)fail('服务正在关闭。',503);
  // A cancel intent can arrive while a serialized operation is awaiting I/O.
  // Never let that older operation overwrite the durable fence.
  const current=load(service,row.id);
  if(current.data.cancelRequested){row.data.cancelRequested=true;if(!done.has(state)&&state!=='UNKNOWN')state='CANCELING';}
  transaction(service,()=>{service.db.prepare('UPDATE transfers SET state=?,data=?,updated_at=? WHERE id=?').run(state,JSON.stringify(row.data),Date.now(),row.id);if(state!==row.state||operation!=='transfers.sync')service.audit(actor,operation,row.id,state);});return load(service,row.id);
}
function authorized(service,user,machine){if(!MACHINES.some(m=>m.id===machine)||!service.store.get(user.id).limits[machine])fail('这台机器未授权。',403);}
function authorizedCopy(service,user,data){
  if(data.managedArchive===1){
    const policy=service.storageArchivePolicy;
    if(!policy?.enabled||data.kind!=='copy'||data.machine!==policy.machine||data.from===data.machine)fail('长期归档配置已改变。',403);
    if(data.archiveLane!==undefined)archiveLane(service,data);
    authorized(service,user,data.from);
  }else{
    authorized(service,user,data.machine);
    if(data.from&&!user.limits[data.from]&&!service.archiveSourceAllowed?.(user.id,data.from,data.reference)&&!service.datasetIngressSourceAllowed?.(user.id,data.from,data.reference))fail('源机器或数据版本未授权。',403);
  }
}
function archiveLane(service,data){
  const policy=service.storageArchivePolicy,value=data.archiveLane;
  if(!policy?.enabled||!value||Object.keys(value).sort().join(',')!=='authority,schema,targetMachine'||
    value.schema!==1||value.targetMachine!==policy.machine||value.authority!==policy.authority||data.machine!==policy.machine)
    fail('归档传输未绑定当前固定存储；不会重标旧传输。',409);
  return structuredClone(value);
}
function legacyArchiveBinding(service,principal,row,binding){
  const data=row.data,request=binding.request,ticket=data.sourceTicket;
  if(row.owner_id!==principal.userId||data.owner?.id!==principal.userId||row.client_key!==request.key||
    data.kind!=='copy'||data.managedArchive!==1||Object.hasOwn(data,'archiveLane')||Object.hasOwn(data,'allowRelay')||
    digest(service.storageArchivePolicy)!==digest(binding.policy)||
    data.from!==request.from||data.machine!==request.machine||data.name!==request.name||
    !data.reference||Object.keys(data.reference).sort().join(',')!=='dataset,kind,version'||
    data.reference.kind!=='datasets'||data.reference.dataset!==request.dataset||data.reference.version!==request.version||
    !Number.isInteger(data.timeoutSec)||data.timeoutSec<1||data.timeoutSec>604800||
    data.sourceRelease?.protocol!==1||!['HELD','PENDING','RELEASED'].includes(data.sourceRelease.state)||
    !ticket||Object.keys(ticket).sort().join(',')!=='entries,id,manifestBytes,manifestSha256,state,token,totalBytes'||
    ticket.id!==row.id||typeof ticket.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ticket.token)||
    digest(info(ticket))!==digest(binding.info)||!service.archiveIntentAllowed?.(principal.userId,request))
    fail('旧归档的原始发布意图或源租约不匹配；不会重标传输。',409);
  // Reconstruct the historical insertion order, not a new-schema digest. A
  // new transfer with its archiveLane merely removed must still be rejected.
  const payload={kind:data.kind,machine:data.machine,reference:data.reference,from:data.from,timeoutSec:data.timeoutSec,name:data.name,managedArchive:1};
  if(row.digest!==digest(payload))fail('旧归档的固定内容校验不匹配；不会重标传输。',409);
  authorizedCopy(service,service.store.get(principal.userId),data);
}
function pinnedSnapshot(service,principal,operation,args,row){
  const user=service.store.get(principal.userId);
  // This reference was resolved and persisted with the transfer's digest.
  // Re-mapping on each chunk could silently switch an in-flight download.
  const context=Object.create(service);
  if(row?.data.downloadProtection?.protocol===1)context.bridge=(machine,op,request)=>{
    const {hostAdmin,dataset,version,...safe}=request;
    return service.bridge(machine,'storage.download.'+op.split('.').at(-1),{...safe,id:row.id,reference:{dataset,version}});
  };
  return snapshotSyncCall(context,principal,user,operation,args,machine=>authorized(service,user,machine),{physical:true});
}
function access(service,principal,row){
  if(row.owner_id!==principal.userId)fail('传输不存在或属于其他账号。',404);
  const user=service.store.users.find(u=>u.id===principal.userId);if(!user?.enabled)fail('账号已暂停。',403);
  // Match create/prepare: stored member quotas are not an admin's effective
  // machine grants. Ownership and the current enabled account remain required.
  authorizedCopy(service,service.store.get(principal.userId),row.data);
}
function releaseConfirmation(row,value){
  const data=row.data,keys=['schema','id','userId','sourceMachine','targetMachine','reference','manifestSha256','attempt','state','confirmedStopped'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(',')||
    value.schema!==1||value.id!==row.id||value.userId!==row.owner_id||value.sourceMachine!==data.from||value.targetMachine!==data.machine||
    value.manifestSha256!==data.sourceTicket?.manifestSha256||value.confirmedStopped!==true||value.state!==row.state||!done.has(value.state)||
    !Number.isSafeInteger(value.attempt)||value.attempt<0||value.attempt===0&&value.state!=='CANCELED'||
    !value.reference||Object.keys(value.reference).sort().join(',')!=='dataset,kind,version'||
    ['kind','dataset','version'].some(key=>value.reference[key]!==data.reference[key]))throw Error('Source release confirmation mismatch');
  return structuredClone(value);
}
function unpreparedConfirmation(row,value){
  const expected={schema:1,mode:'unprepared-cancel-v1',id:row.id,userId:row.owner_id,
    sourceMachine:row.data.from,targetMachine:row.data.machine,reference:row.data.reference,
    attempt:0,state:'CANCELED',confirmedStopped:true};
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).sort().join(',')!==Object.keys(expected).sort().join(',')||
    Object.entries(expected).some(([key,want])=>key!=='reference'&&value[key]!==want)||
    !value.reference||Object.keys(value.reference).sort().join(',')!=='dataset,kind,version'||
    ['kind','dataset','version'].some(key=>value.reference[key]!==expected.reference[key]))throw Error('Unprepared source confirmation mismatch');
  return structuredClone(value);
}
async function releaseSource(service,row,actor='transfer-reconcile'){
  if(row.data.kind==='download'&&done.has(row.state)&&row.data.downloadProtection?.protocol===1&&row.data.downloadProtection.state!=='RELEASED'){
    row.data.downloadProtection={protocol:1,state:'PENDING'};
    row=save(service,row,row.state,actor,'transfers.download-release-pending');
    try{
      const state=row.state==='SUCCEEDED'?'COMPLETED':'CANCELED';
      const result=await service.bridge(row.data.machine,'storage.download.finish',{id:row.id,userId:row.owner_id,reference:{dataset:row.data.reference.dataset,version:row.data.reference.version},state});
      if(result?.id!==row.id||result.state!==state||result.released!==true)throw Error('Download release not confirmed');
      row.data.downloadProtection={protocol:1,state:'RELEASED'};
      row=save(service,row,row.state,actor,'transfers.download-released');
    }catch(error){if(error.transferFence)throw error;}
    return row;
  }
  // Only new, explicitly lease-aware copies participate. Never infer a source
  // lease from old terminal history or from a bearer ticket by itself.
  if(row.data.kind!=='copy'||!done.has(row.state)||row.data.sourceRelease?.protocol!==1||row.data.sourceRelease.state==='RELEASED')return row;
  const pending=row.data.sourceRelease.state==='PENDING';
  row.data.sourceRelease={...row.data.sourceRelease,state:'PENDING'};
  row=save(service,row,row.state,actor,pending?'transfers.sync':'transfers.source-release-pending');
  try{
    // Only an existing explicit cancel intent can close a PREPARING/no-ticket
    // source. Both nodes fence the exact ID; neither a new grant nor dispatch
    // is attempted. Issued tickets with a lost reply still remain protected.
    if(!row.data.sourceTicket){
      if(row.state!=='CANCELED'||row.data.cancelRequested!==true)throw Error('Source preparation was not confirmed');
      let proof=row.data.sourceRelease.unpreparedConfirmation;
      if(!proof){
        proof=unpreparedConfirmation(row,await targetCall(service,row,'transfers.confirm-unprepared-cancel',{
          id:row.id,userId:row.owner_id,sourceMachine:row.data.from,reference:row.data.reference}));
        row.data.sourceRelease.unpreparedConfirmation=proof;
        row=save(service,row,row.state,actor,'transfers.unprepared-cancel-confirmed');
      }else proof=unpreparedConfirmation(row,proof);
      const result=await service.bridge(row.data.from,'transfers.release-unprepared-source',{id:row.id,userId:row.owner_id,confirmation:proof});
      if(result?.id!==row.id||result.released!==true)throw Error('Unprepared source release not confirmed');
      row.data.sourceRelease={protocol:1,state:'RELEASED'};
      return save(service,row,row.state,actor,'transfers.source-released');
    }
    let confirmation=row.data.sourceRelease.confirmation;
    if(!confirmation){
      const value=await targetCall(service,row,'transfers.confirm-source-release',{
        id:row.id,userId:row.owner_id,sourceMachine:row.data.from,reference:row.data.reference,
        manifestSha256:row.data.sourceTicket.manifestSha256});
      confirmation=releaseConfirmation(row,value);
      row.data.sourceRelease.confirmation=confirmation;
      row=save(service,row,row.state,actor,'transfers.source-release-confirmed');
    }else confirmation=releaseConfirmation(row,confirmation);
    const result=await service.bridge(row.data.from,'transfers.release-source',{id:row.id,userId:row.owner_id,confirmation});
    if(result?.id!==row.id||result.released!==true)throw Error('Source release receipt mismatch');
    row.data.sourceRelease={protocol:1,state:'RELEASED'};
    return save(service,row,row.state,actor,'transfers.source-released');
  }catch(error){
    if(error.transferFence)throw error;
    // Transfer result stays terminal, while its independent cleanup remains
    // durable/retryable. Never expose node errors, tickets or confirmations.
    return row;
  }
}
async function sync(service,row,actor='transfer-reconcile'){
  if(done.has(row.state))return releaseSource(service,row,actor);
  const data=row.data;let state=row.state;
  try{
    if(data.cancelRequested){
      // Reconcile the ORIGINAL cancellation, not a new execution. An early
      // CANCELING/UNKNOWN receipt must eventually become confirmed terminal.
      if(data.kind==='copy'){
        const result=await targetCall(service,row,'transfers.cancel',{id:row.id,userId:row.owner_id});
        if(result.id!==row.id||!states.has(result.state))throw Error('Cancel receipt mismatch');
        data.result=result;state=['CANCELED','SUCCEEDED'].includes(result.state)?result.state:result.state==='UNKNOWN'?'UNKNOWN':'CANCELING';
      }else if(data.kind==='upload'){
        const result=await service.bridge(data.machine,'datasets.upload.pause',{uploadId:data.uploadId||row.client_key,userId:row.owner_id,hostAdmin:false});
        data.result=result;state=result.state==='READY'?'SUCCEEDED':'CANCELED';
      }else state='CANCELED';
    }else if(data.kind==='copy'){
      const result=await targetCall(service,row,'transfers.status',{id:row.id,userId:row.owner_id});
      if(result.id!==row.id||!states.has(result.state))throw Error('Node receipt mismatch');
      data.result=result;state=result.state;
    }else if(data.kind==='upload'&&data.uploadId){
      const result=await service.bridge(data.machine,'datasets.upload.status',{uploadId:data.uploadId,userId:row.owner_id,hostAdmin:false});
      data.result=result;state=result.state==='READY'?'SUCCEEDED':result.state==='DISCARDED'?'CANCELED':['SEALING','PUBLISHING'].includes(result.state)?'VERIFYING':result.state==='FAILED'?'FAILED':'WAITING_CLIENT';
    }
    if(!(data.kind==='download'&&state==='FAILED'))delete data.error;
  }catch(error){if(error.transferFence)throw error;state='UNKNOWN';data.error='原节点回执未确认；不会自动改机器或重复启动。';}
  return releaseSource(service,save(service,row,state,actor,'transfers.sync'),actor);
}
async function dispatch(service,principal,row){
  const data=row.data,user=service.store.get(principal.userId);
  // Repeating create uses the SAME node ID / upload key. Never mint a second
  // execution after an ambiguous request. Source grant is durably saved first.
  if(data.kind==='copy'){
    const lane=data.managedArchive===1?archiveLane(service,data):null;
    if(!data.sourceTicket){
      const result=await service.bridge(data.from,'transfers.source.prepare',{id:row.id,reference:data.reference,userId:user.id,hostAdmin:principal.role==='admin',timeoutSec:data.timeoutSec,targetMachine:data.machine});
      if(result?.id!==row.id||typeof result.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(result.token))fail('源授权回执不匹配。',502);
      data.sourceTicket={id:row.id,token:result.token,...info(result)};
      if(data.sourceRelease?.protocol===1)data.sourceRelease={protocol:1,state:'HELD'};
      row=save(service,row,'DISPATCHING',principal.username,'transfers.source-prepared');
    }
    if(lane)archiveLane(service,data); // Recheck after source preparation I/O.
    const result=await targetCall(service,row,'transfers.start',{id:row.id,userId:user.id,sourceMachine:data.from,source:data.sourceTicket,reference:data.reference,name:data.name,timeoutSec:data.timeoutSec,...(lane?{archiveLane:lane}:{})});
    if(result.id!==row.id||!states.has(result.state))fail('节点传输回执不匹配。',502);
    row.data.result=result;return releaseSource(service,save(service,row,result.state,principal.username,'transfers.dispatched'),principal.username);
  }
  if(data.kind==='upload'){
    // Managed transfers own their pre-existing machine/digest. They are not a
    // new standalone data-upload admission and may never be silently moved.
    const local=Object.assign(Object.create(service),{datasetUploadIngress:undefined});
    const result=await executionCall(local,principal,'datasets.upload.begin',{machine:data.machine,key:row.client_key,name:data.name,...data.manifest,...(data.allowRelay===true?{allowRelay:true}:{})});
    row.data.uploadId=validId(result.uploadId);row.data.result=result;
    return save(service,row,result.state==='READY'?'SUCCEEDED':'WAITING_CLIENT',principal.username,'transfers.upload-start');
  }
  if(data.downloadProtection?.protocol===1){
    const result=await service.bridge(data.machine,'storage.download.open',{id:row.id,userId:user.id,reference:{dataset:data.reference.dataset,version:data.reference.version}});
    if(result?.id!==row.id||result.state!=='OPEN')fail('下载保活尚未确认。',502);
    data.downloadProtection={protocol:1,state:'HELD'};
    row=save(service,row,'DISPATCHING',principal.username,'transfers.download-held');
  }
  row.data.snapshot=info(await pinnedSnapshot(service,principal,'datasets.snapshot.info',{machine:data.machine,dataset:data.reference.dataset,version:data.reference.version},row));
  return save(service,row,'WAITING_CLIENT',principal.username,'transfers.download-ready');
}
export function installTransfers(service){
  service.trainingTransferCall=(principal,args,binding)=>transferCall(service,principal,'transfers.create',args,()=>{}, {[trainingAdmission]:binding});
  service.db.exec(`CREATE TABLE IF NOT EXISTS transfers(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,client_key TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(owner_id,client_key));CREATE INDEX IF NOT EXISTS transfers_state ON transfers(state,updated_at);`);
  service.transfersReconciling=false;
  service.transferCall=(principal,operation,args)=>transferCall(service,principal,operation,args);
  service.archiveTransferCall=async(principal,args,{resume=false}={})=>{
    const policy=service.storageArchivePolicy;
    if(!policy?.enabled||args.kind!=='copy'||args.machine!==policy.machine||args.from===args.machine||!service.archiveIntentAllowed?.(principal.userId,args))fail('归档传输缺少固定发布意图。',403);
    const current=service.transferSnapshotByKey(principal.userId,args.key);
    if(resume&&current&&['FAILED','PAUSED'].includes(current.state)){
      if(Object.hasOwn(current,'archiveLane'))return transferCall(service,principal,'transfers.resume',{id:current.id},()=>{},archiveAdmission);
      const row=load(service,current.id),binding={request:structuredClone(args),policy:structuredClone(policy),info:info(row.data.sourceTicket)};
      legacyArchiveBinding(service,principal,row,binding);
      return transferCall(service,principal,'transfers.resume',{id:current.id},()=>{legacyArchiveBinding(service,principal,load(service,current.id),binding);},{[legacyArchiveAdmission]:binding});
    }
    // Legacy ambiguous/canceling receipts must be observed on their original
    // node, not replayed through new-schema create (or granted a new lane).
    if(current&&(current.managedArchive===1&&!Object.hasOwn(current,'archiveLane')||!['DISPATCHING','UNKNOWN'].includes(current.state)))return transferCall(service,principal,'transfers.status',{id:current.id});
    return transferCall(service,principal,'transfers.create',args,()=>{},archiveAdmission);
  };
  const snapshot=(owner,column,id)=>{
    if(service.closing||typeof owner!=='string'||typeof id!=='string'||!uuid.test(id))return null;
    const row=service.db.prepare(`SELECT * FROM transfers WHERE ${column}=? AND owner_id=?`).get(id,owner);
    return row?view({...row,data:JSON.parse(row.data)}):null;
  };
  service.transferSnapshot=(owner,id)=>snapshot(owner,'id',id);
  service.transferSnapshotByKey=(owner,key)=>snapshot(owner,'client_key',key);
  service.reconcileTransfers=async()=>{
    // A full-platform maintenance window freezes background observations too:
    // an idle WAITING_CLIENT upload must not become UNKNOWN, rewrite its saved
    // node result, or refresh timestamps merely because its executor is stopped.
    // Keep every existing row/protection intact. Explicit owner status, cancel
    // and finalization still use their original guarded interfaces below.
    if(service.closing||!service.bridge||service.transfersReconciling||service.globalMaintenanceActive?.())return;service.transfersReconciling=true;
    try{const rows=service.db.prepare("SELECT * FROM transfers WHERE (state NOT IN ('SUCCEEDED','CANCELED','PAUSED','FAILED') AND json_extract(data,'$.kind') != 'download') OR (state IN ('SUCCEEDED','CANCELED') AND ((json_extract(data,'$.kind') = 'copy' AND json_extract(data,'$.sourceRelease.protocol') = 1 AND json_extract(data,'$.sourceRelease.state') != 'RELEASED') OR (json_extract(data,'$.kind') = 'download' AND json_extract(data,'$.downloadProtection.protocol') = 1 AND json_extract(data,'$.downloadProtection.state') != 'RELEASED'))) ORDER BY updated_at LIMIT 4").all();await Promise.all(rows.map(row=>inLane(service,row.owner_id,rowKey(row),async()=>{if(!service.closing&&!service.globalMaintenanceActive?.())await sync(service,load(service,row.id));}).catch(()=>{})));}finally{service.transfersReconciling=false;}
  };
  service.transferTimer=setInterval(()=>service.reconcileTransfers().catch(()=>{}),15000);service.transferTimer.unref();
}
// Both HTTP and internal preparation callers use this same bounded lane.
// Database transactions below are synchronous; remote I/O never owns the
// global account/scheduler queue. Every RPC is fenced before AND after await.
export async function transferCall(service,principal,operation,args,assertCurrent=()=>{},admission){
  if(!args||typeof args!=='object'||Array.isArray(args))fail('传输参数无效。');
  args=structuredClone(args);principal={...principal};
  let maintenanceArgs=args;
  const policy=authorizationPolicy(service.store.get(principal.userId));
  const check=()=>{
    if(service.closing)throw Object.assign(Error('服务正在关闭。'),{status:503,transferFence:true});
    try{assertCurrent();const user=service.store.get(principal.userId);if(!user.enabled||user.username!==principal.username||principal.role==='admin'&&user.role!=='admin'||authorizationPolicy(user)!==policy)fail('账号授权已改变，请重新操作。',403);}
    catch(error){error.transferFence=true;error.status??=403;throw error;}
    try{service.assertMaintenanceAllowed?.(operation,maintenanceArgs,principal);}catch(error){error.transferFence=true;throw error;}
  };
  check();let key;
  if(operation==='transfers.create')key=JSON.stringify([principal.userId,validId(args.key)]);
  else if(['transfers.list','transfers.capabilities'].includes(operation))key=JSON.stringify([principal.userId,operation]);
  else{const row=load(service,args.id);access(service,principal,row);key=rowKey(row);maintenanceArgs={...args,machine:row.data.machine,from:row.data.from};check();}
  // Persist before waiting for this transfer's active RPC; the node also has a
  // permanent cancel marker, fencing an already in-flight start on arrival.
  if(operation==='transfers.cancel'){
    fields(args,['id']);const row=load(service,args.id);if(!done.has(row.state)){row.data.cancelRequested=true;save(service,row,'CANCELING',principal.username,operation);}
  }
  return inLane(service,principal.userId,key,async()=>{
    const current=()=>{
      check();
      if(!['transfers.cancel','transfers.status','transfers.list','transfers.capabilities'].includes(operation)){
        const row=operation==='transfers.create'?service.db.prepare('SELECT data FROM transfers WHERE owner_id=? AND client_key=?').get(principal.userId,args.key):load(service,args.id);
        const data=typeof row?.data==='string'?JSON.parse(row.data):row?.data;
        if(data?.cancelRequested)throw Object.assign(Error('传输已终止或正在取消。'),{status:409,transferFence:true});
      }
    };
    // A narrow per-call view lets existing upload/snapshot validators use the
    // same bridge without bypassing the policy fence or mutating shared hooks.
    const context=Object.create(service);
    context[archiveAdmission]=admission===archiveAdmission||!!admission?.[legacyArchiveAdmission];
    context[legacyArchiveAdmission]=admission?.[legacyArchiveAdmission];
    context[trainingAdmission]=admission?.[trainingAdmission];
    context.bridge=async(...request)=>{current();try{return await service.bridge(...request);}finally{current();}};
    check();try{return await transferOperation(context,principal,operation,args);}finally{check();}
  });
}
async function transferOperation(service,principal,operation,args){
  if(!service.bridge)fail('节点执行桥尚未配置。',503);
  const user=service.store.get(principal.userId);if(!user.enabled)fail('账号已暂停。',403);
  if(operation==='transfers.capabilities'){
    fields(args,['machine']);authorized(service,user,args.machine);
    const unavailable={machine:args.machine,enabled:false,sourceReady:false,sources:[],protocol:'lan-transfer-v1'};
    try{
      const value=await service.bridge(args.machine,'transfers.capabilities',{userId:user.id});
      if(value?.protocol!=='lan-transfer-v1'||typeof value.enabled!=='boolean'||typeof value.sourceReady!=='boolean'||!Array.isArray(value.sources))return unavailable;
      const sources=[...new Set(value.sources)].filter(id=>id!==args.machine&&MACHINES.some(m=>m.id===id)&&(user.limits[id]>0||service.archiveMachineVisible?.(user.id,id)||service.datasetIngressMachineVisible?.(user.id,id)));
      return {...unavailable,enabled:value.enabled,sourceReady:value.sourceReady,sources:value.enabled?sources:[]};
    }catch(error){if(error.transferFence)throw error;return unavailable;}
  }
  if(operation==='transfers.list'){
    fields(args,['cursor','limit']);const cursor=args.cursor??0,limit=args.limit??25;
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isInteger(limit)||limit<1||limit>50)fail('传输分页参数无效。');
    const rows=service.db.prepare('SELECT * FROM transfers WHERE owner_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(user.id,cursor||Number.MAX_SAFE_INTEGER,limit+1);
    return {transfers:rows.slice(0,limit).map(r=>view({...r,data:JSON.parse(r.data)})),nextCursor:rows.length>limit?rows[limit-1].seq:null};
  }
  if(operation==='transfers.create'){
    fields(args,['key','kind','machine','from','dataset','version','name','timeoutSec','manifest','allowRelay']);validId(args.key);
    if(!['copy','upload','download'].includes(args.kind))fail('请选择 upload、download 或 copy。');
    if(!service[archiveAdmission])authorized(service,user,args.machine);
    const payload={kind:args.kind,machine:args.machine};
    if(args.kind==='upload'){
      if(args.from!==undefined||args.dataset!==undefined||args.version!==undefined||args.timeoutSec!==undefined)fail('上传只接受本机固定清单。');
      if(args.allowRelay!==undefined&&typeof args.allowRelay!=='boolean')fail('中转确认必须是明确的布尔值。');
      if(args.allowRelay===true)payload.allowRelay=true;
      const manifest=args.manifest;info({state:'READY',...manifest});fields(manifest,['manifestBytes','manifestSha256','totalBytes','entries']);payload.manifest=manifest;
    }else{
      if(args.allowRelay!==undefined||args.manifest!==undefined||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.dataset||'')||!hash.test(args.version||''))fail('需固定完整数据集版本。');payload.reference={kind:'datasets',dataset:args.dataset,version:args.version};
    }
    if(args.kind==='copy'){
      if(args.from===args.machine)fail('源节点和目标节点应不同。');payload.from=args.from;payload.timeoutSec=args.timeoutSec??86400;
      if(!Number.isInteger(payload.timeoutSec)||payload.timeoutSec<1||payload.timeoutSec>604800)fail('传输期限为 1–604800 秒。');
    }else if(args.from!==undefined)fail('只在 copy 中使用 from。');
    if(args.kind!=='download'){
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(args.name||''))fail('目标名称需为 1–40 位字母、数字、短横线或下划线。');payload.name=args.name;
    }else if(args.name!==undefined||args.timeoutSec!==undefined)fail('下载不接受服务器任务参数。');
    if(payload.reference&&service.datasetPhysicalReference){
      const mapped=service.datasetPhysicalReference(user.id,payload.from||payload.machine,{dataset:args.dataset,version:args.version});
      if(!mapped||Object.keys(mapped).sort().join(',')!=='dataset,version'||typeof mapped.dataset!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(mapped.dataset)||mapped.version!==args.version)fail('数据集逻辑引用尚未确认。',409);
      payload.reference={kind:'datasets',dataset:mapped.dataset,version:mapped.version};
    }
    if(service[archiveAdmission]){
      if(!service.archiveIntentAllowed?.(user.id,args))fail('归档发布意图已改变。',403);
      payload.managedArchive=1;
      payload.archiveLane={schema:1,targetMachine:service.storageArchivePolicy.machine,authority:service.storageArchivePolicy.authority};
    }
    authorizedCopy(service,user,payload);
    let previous=service.db.prepare('SELECT id,digest FROM transfers WHERE owner_id=? AND client_key=?').get(user.id,args.key),row;
    if(previous){
      row=load(service,previous.id);
      if(previous.digest!==digest(payload)){
        // Transport consent is durable authorization, not dataset content. A
        // subsequent direct/auto client may omit it without replacing data.
        // Reconstruct the old insertion order for already persisted digests.
        const priorPayload={kind:payload.kind,machine:payload.machine,...(row.data.allowRelay===true?{allowRelay:true}:{}),manifest:payload.manifest,name:payload.name};
        if(args.kind!=='upload'||previous.digest!==digest(priorPayload))
          fail('同一重试键不能修改传输内容。',409);
        if(payload.allowRelay===true&&row.data.allowRelay!==true&&!done.has(row.state)&&!row.data.cancelRequested){
          row.data.allowRelay=true;
          transaction(service,()=>{service.db.prepare('UPDATE transfers SET digest=?,data=?,updated_at=? WHERE id=?').run(digest(payload),JSON.stringify(row.data),Date.now(),row.id);service.audit(principal.username,'transfers.relay-consent',row.id,'explicit');});
        }
      }
      // Idempotent create never re-enters control RPCs for a canceled row;
      // status/reconcile own any outstanding source cleanup.
      if(service[trainingAdmission]){
        if(row.data.trainingPreparation?.job.id!==service[trainingAdmission].jobId)fail('旧传输不能取得新训练准入。',409);
        assertTrainingPreparation(service,row.data.trainingPreparation);
        // Even the same create key observes its original target after a lost
        // ACK; it does not replay source preparation or worker start.
        return view(await sync(service,row,principal.username));
      }
      if(done.has(row.state)||row.data.cancelRequested)return view(row);
    }
    else{
      // A managed legacy upload has an immutable machine/digest and remains
      // resumable above. New data must use the warehouse admission protocol;
      // transfers.create may not bypass it and admit a selected SSD directly.
      if(args.kind==='upload'&&service.datasetIngressPolicy?.enabled===true)
        fail('新数据集请使用数据仓库上传入口（gpuctl data upload）；旧传输仍可按原编号继续。',409);
      if(service.db.prepare('SELECT COUNT(*) n FROM transfers').get().n>=10000)fail('传输历史已达上限，请联系管理员归档。',429);
      if(service.db.prepare("SELECT COUNT(*) n FROM transfers WHERE owner_id=? AND state NOT IN ('SUCCEEDED','CANCELED','PAUSED','FAILED')").get(user.id).n>=20)fail('请先处理现有传输任务。',429);
      const admission=service[trainingAdmission];
      const existingIntent=admission&&service.store.jobs.find(job=>job.id===admission.jobId)?.trainingPreparations?.find(value=>
        value.preparation.kind==='transfer'&&JSON.stringify(value.preparation.logicalReference)===JSON.stringify(admission.logicalReference));
      const id=existingIntent?.preparation.id||randomUUID(),now=Date.now();let trainingPreparation;
      if(service[trainingAdmission]){
        if(payload.kind!=='copy'||payload.managedArchive!==undefined)fail('新训练准入只允许固定缓存准备。',409);
        const binding=service[trainingAdmission];
        const job=service.store.jobs.find(row=>row.id===binding.jobId);
        if(job?.userId!==user.id||job.machine!==payload.machine)fail('训练准备账号或目标不符。',403);
        trainingPreparation=await bindTrainingPreparation(service,binding.jobId,{id,kind:'transfer',sourceMachine:payload.from,
          logicalReference:binding.logicalReference,reference:{dataset:payload.reference.dataset,version:payload.reference.version}});
        if(trainingPreparation.preparation.id!==id)fail('准备意图已存在；不会生成第二传输。',409);
      }
      transaction(service,()=>{service.db.prepare('INSERT INTO transfers(id,owner_id,client_key,digest,state,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?)').run(id,user.id,args.key,digest(payload),'DISPATCHING',now,now,JSON.stringify({...payload,owner:{id:user.id,username:user.username,name:user.name},...(trainingPreparation?{trainingPreparation}:{}),...(payload.kind==='copy'?{sourceRelease:{protocol:1,state:'UNCONFIRMED'}}:{}),...(payload.kind==='download'&&service.storageArchivePolicy?.enabled?{downloadProtection:{protocol:1,state:'UNCONFIRMED'}}:{})}));service.audit(principal.username,operation,id,'DISPATCHING');});row=load(service,id);
    }
    try{return view(await dispatch(service,principal,row));}catch(error){
      if(error.transferFence)throw error;
      row=load(service,row.id);
      const cacheDownloadRefused='可回收缓存不支持无租约的旧下载或 sync data；请从受保护原件读取，或使用节点间 transfer copy。';
      if(row.data.kind==='download'&&error?.message===cacheDownloadRefused){
        row.data.error=cacheDownloadRefused;
        return view(save(service,row,'FAILED',principal.username,'transfers.download-protected-source-required'));
      }
      row.data.error='节点传输初始化未确认，请核对原任务。';return view(save(service,row,'UNKNOWN',principal.username,'transfers.dispatch-unknown'));
    }
  }
  const row=load(service,args.id);access(service,principal,row);
  if(operation==='transfers.status'){fields(args,['id']);return view(await sync(service,row,principal.username));}
  if(operation==='transfers.cancel'){
    fields(args,['id']);if(done.has(row.state))return view(await releaseSource(service,row,principal.username));
    row.data.cancelRequested=true;
    let current=save(service,row,'CANCELING',principal.username,operation);
    if(row.data.kind==='copy'){
      try{const result=await targetCall(service,row,'transfers.cancel',{id:row.id,userId:user.id});if(result.id!==row.id||!states.has(result.state))fail('取消回执不匹配。',502);current.data.result=result;return view(await releaseSource(service,save(service,current,result.state,principal.username,'transfers.cancel-result'),principal.username));}catch(error){if(error.transferFence)throw error;current.data.error='取消回执未确认；核对原传输，不会重启。';return view(save(service,current,'UNKNOWN',principal.username,'transfers.cancel-unknown'));}
    }
    if(row.data.kind==='upload'){
      try{const result=await service.bridge(row.data.machine,'datasets.upload.pause',{uploadId:row.data.uploadId||row.client_key,userId:user.id,hostAdmin:false});if(result.state==='READY')return view(save(service,current,'SUCCEEDED',principal.username,'transfers.canceled-ready'));}catch(error){if(error.transferFence)throw error;current.data.error='上传后台校验是否已停尚未确认；重试取消。';return view(save(service,current,'UNKNOWN',principal.username,'transfers.cancel-unknown'));}
    }
    return view(await releaseSource(service,save(service,current,'CANCELED',principal.username,'transfers.canceled'),principal.username));
  }
  if(operation==='transfers.resume'){
    fields(args,['id']);if(done.has(row.state)||row.data.cancelRequested)fail('完成或取消的传输不能恢复。',409);
    if(row.data.managedArchive===1&&!service[archiveAdmission])fail('请在数据集页面重试长期归档，后台会按顺序恢复同一传输。',409);
    if(row.data.managedArchive===1){
      if(service[legacyArchiveAdmission]){
        legacyArchiveBinding(service,principal,row,service[legacyArchiveAdmission]);
        if(row.data.sourceRelease.state!=='HELD')fail('旧归档源租约未处于保留状态。',409);
      }else archiveLane(service,row.data);
    }
    if(row.data.kind!=='copy')return view(save(service,row,'WAITING_CLIENT',principal.username,operation));
    const current=await sync(service,row,principal.username);
    if(!['PAUSED','FAILED'].includes(current.state))fail('先确认原任务已经停止；UNKNOWN 不会启动新尝试。',409);
    const ticket=await service.bridge(row.data.from,'transfers.source.prepare',{id:row.id,reference:row.data.reference,userId:user.id,hostAdmin:principal.role==='admin',timeoutSec:row.data.timeoutSec,targetMachine:row.data.machine,renew:true});
    if(ticket?.id!==row.id||typeof ticket.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ticket.token))fail('源授权回执不匹配。',502);
    const source={id:row.id,token:ticket.token,...info(ticket)};
    if(Object.keys(current.data.sourceTicket).some(k=>k!=='token'&&current.data.sourceTicket[k]!==source[k]))fail('恢复只能读取原固定版本。',409);
    if(row.data.managedArchive===1){
      if(service[legacyArchiveAdmission])legacyArchiveBinding(service,principal,current,service[legacyArchiveAdmission]);
      else archiveLane(service,row.data);
    }
    current.data.sourceTicket=source;const saved=save(service,current,'DISPATCHING',principal.username,'transfers.resume-intent');
    try{const result=await targetCall(service,row,'transfers.resume',{id:row.id,userId:user.id,source});if(result.id!==row.id||!states.has(result.state))fail('恢复回执不匹配。',502);saved.data.result=result;return view(await releaseSource(service,save(service,saved,result.state,principal.username,operation),principal.username));}
    catch(error){if(error.transferFence)throw error;saved.data.error='恢复回执未确认；核对同一任务，不会重复启动。';return view(save(service,saved,'UNKNOWN',principal.username,'transfers.resume-unknown'));}
  }
  if(operation==='transfers.io'){
    fields(args,['id','action','path','offset','data','routeId']);if(done.has(row.state)||row.data.cancelRequested)fail('此传输已结束或正在取消。',409);
    if(args.routeId!==undefined&&(row.data.kind!=='upload'||args.action!=='direct-ticket'))fail('仅上传票据可指定批准的通道。');
    let result;
    if(row.data.kind==='upload'){
      if(!row.data.uploadId)fail('上传初始化未确认，请重复原 create。',409);
      if(!['status','manifest','seal','chunk','commit','direct-ticket','direct-revoke'].includes(args.action))fail('上传操作无效。');
      const {id,action,...request}=args;
      const local=Object.assign(Object.create(service),{datasetUploadIngress:undefined});
      result=await executionCall(local,principal,'datasets.upload.'+action,{machine:row.data.machine,uploadId:row.data.uploadId,...request});
      // A short-lived credential is returned only to its authenticated caller,
      // never copied into persisted transfer history, progress, or audit data.
      if(['direct-ticket','direct-revoke'].includes(action))return result;
      row.data.result=result;save(service,row,result.state==='READY'?'SUCCEEDED':['SEALING','PUBLISHING'].includes(result.state)?'VERIFYING':result.state==='FAILED'?'FAILED':'WAITING_CLIENT',principal.username,'transfers.sync');
    }else if(row.data.kind==='download'){
      if(!['info','manifest','get'].includes(args.action))fail('下载仅允许读取固定快照。');
      const {id,action,...request}=args;result=await pinnedSnapshot(service,principal,'datasets.snapshot.'+action,{machine:row.data.machine,dataset:row.data.reference.dataset,version:row.data.reference.version,...request},row);
    }else fail('LAN 传输由节点后台执行，不通过客户端搬运。');
    return result;
  }
  if(operation==='transfers.progress'){
    fields(args,['id','bytes','complete']);if(row.data.kind!=='download'||done.has(row.state)||row.data.cancelRequested)fail('下载进度不可更新。');
    if(!Number.isSafeInteger(args.bytes)||args.bytes<0||args.bytes>row.data.snapshot?.totalBytes||typeof args.complete!=='boolean'||args.complete&&args.bytes!==row.data.snapshot.totalBytes)fail('下载进度无效。');
    row.data.result={bytes:args.bytes,totalBytes:row.data.snapshot.totalBytes,clientReported:true};
    return view(await releaseSource(service,save(service,row,args.complete?'SUCCEEDED':'WAITING_CLIENT',principal.username,'transfers.sync'),principal.username));
  }
  fail('未知传输操作。');
}
