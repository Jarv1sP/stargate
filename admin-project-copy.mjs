// Explicit administrator copies of a source owner's fixed OCI release.
// No user token, host path, live container, HOME or output enters this protocol.
import {createHash,randomUUID} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {projectReference,UUID} from './projects.mjs';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal=new Set(['SUCCEEDED','FAILED','CANCELED']);
const fields=['from','machine','sourceUserId','targetUserId','project','targetProject','release'];
const lanes=new WeakMap();
function identity(args){
  const ref=projectReference({project:args.project,release:args.release},{optional:false,release:true});
  projectReference({project:args.targetProject},{optional:false});
  if(![args.from,args.machine].every(id=>MACHINES.some(m=>m.id===id))||args.from===args.machine)
    fail('请选择不同的来源和目标服务器。');
  if(![args.sourceUserId,args.targetUserId].every(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id))||args.sourceUserId===args.targetUserId)
    fail('请选择不同的来源和目标账号。');
  return {from:args.from,machine:args.machine,sourceUserId:args.sourceUserId,targetUserId:args.targetUserId,...ref,targetProject:args.targetProject};
}
function authorized(service,actor,data){
  const admin=service.store.get(actor);
  if(!admin.enabled||admin.role!=='admin')fail('需要当前管理员身份。',403);
  if(!data)return admin;
  for(const [id,machines] of [[actor,[data.from,data.machine]],[data.sourceUserId,[data.from]],[data.targetUserId,[data.machine]]]){
    const user=service.store.get(id);
    if(!user.enabled||machines.some(m=>!(user.limits[m]>0)))fail('来源、目标账号或管理员没有服务器授权。',403);
  }
  return admin;
}
function read(service,id){
  const row=service.db.prepare('SELECT * FROM admin_project_copies WHERE id=?').get(id);
  if(!row)fail('管理员复制不存在。',404);
  return {...row,data:JSON.parse(row.data)};
}
function save(service,row,patch){
  if(service.closing)fail('服务正在关闭。',503);
  const current=read(service,row.id);
  const data={...current.data,...patch};
  if(terminal.has(current.data.state)){data.state=current.data.state;if(current.data.targetRelease)data.targetRelease=current.data.targetRelease;}
  if(data.cancelRequested&&!terminal.has(data.state))data.state='CANCELING';
  service.db.prepare('UPDATE admin_project_copies SET data=? WHERE id=?').run(JSON.stringify(data),row.id);
  return {...current,data};
}
function view(row){const {ticket,...data}=row.data;return {id:row.id,key:row.client_key,...data};}
function maintain(service,principal,data){
  service.assertMaintenanceAllowed?.('projects.publish',{machine:data.from},principal);
  service.assertMaintenanceAllowed?.('projects.create',{machine:data.machine},principal);
}
async function plan(service,principal,data,revalidate){
  authorized(service,principal.userId,data);
  const source=await service.bridge(data.from,'projects.copy.admin-probe',{hostAdmin:true,userId:data.sourceUserId,project:data.project,release:data.release});
  authorized(service,principal.userId,data);revalidate();
  const target=await service.bridge(data.machine,'projects.copy.admin-probe',{hostAdmin:true,userId:data.targetUserId,project:data.targetProject,from:data.from});
  authorized(service,principal.userId,data);revalidate();
  if(source?.adminCopyProtocol!==1||target?.adminCopyProtocol!==1||source.protocol!=='portable-project-v1'||target.protocol!=='portable-project-v1'||
    source.enabled!==true||target.enabled!==true||source.releaseReady!==true||source.release!==data.release||source.project!==data.project||
    target.project!==data.targetProject||target.targetAbsent!==true||source.environmentMode!=='oci'||target.environmentMode!=='oci'||
    !['amd64','arm64'].includes(source.architecture)||source.architecture!==target.architecture||!Array.isArray(target.sources)||!target.sources.includes(data.from)||
    !/^sha256:[a-f0-9]{64}$/.test(source.image||''))fail('跨账号复制能力、固定发布或目标空缺未确认。',409);
  const content={...data,image:source.image,architecture:source.architecture};
  for(const key of ['codeBytes','codeEntries','imageUnpackedBytes']){
    if(!Number.isSafeInteger(source[key])||source[key]<0)fail('来源容量未确认。',409);
    content[key]=source[key];
  }
  if(![target.availableBytes,target.reserveBytes].every(n=>Number.isSafeInteger(n)&&n>=0))fail('目标磁盘容量未确认。',409);
  const estimatedRequiredBytes=content.codeBytes+2*content.imageUnpackedBytes+16*1024**2;
  if(!Number.isSafeInteger(estimatedRequiredBytes)||estimatedRequiredBytes>target.availableBytes-target.reserveBytes)fail('目标磁盘容量不足。',409);
  return {protocol:1,planHash:digest(content),...content,scope:['code','oci-image'],excluded:['development-home','outputs','history'],
    capacity:{codeBytes:source.codeBytes,imageUnpackedBytes:source.imageUnpackedBytes,transportBytes:null,estimatedRequiredBytes,availableBytes:target.availableBytes,reserveBytes:target.reserveBytes},
    state:'PLANNED',developmentChanged:false};
}
function checkReceipt(row,result,target=false){
  const d=row.data;
  if(result?.id!==row.id||result.project!==(target?d.targetProject:d.project)||result.release!==d.release||
    !['READY','RUNNING','UNKNOWN','SUCCEEDED','FAILED','CANCELED'].includes(result.state))throw Error('Copy receipt mismatch');
  if(target&&result.state==='SUCCEEDED'&&!/^[a-f0-9]{64}$/.test(result.targetRelease||''))throw Error('Target release unconfirmed');
}
async function advance(service,id){
  let pending=lanes.get(service);if(!pending){pending=new Map();lanes.set(service,pending);}
  if(pending.has(id))return pending.get(id);
  const task=(async()=>{
    let row=read(service,id),d=row.data;
    if(terminal.has(d.state)&&d.cleanupComplete)return view(row);
    try{authorized(service,row.actor_id,d);}
    catch{if(!terminal.has(d.state))row=save(service,row,{cancelRequested:true,state:'CANCELING'});}
    d=row.data;
    const source={id,userId:d.sourceUserId},target={id,userId:d.targetUserId};
    try{
      if(d.cancelRequested||terminal.has(d.state)){
        let fenced=false;
        try{const r=await service.bridge(d.from,'projects.copy.revoke',source);fenced=r?.id===id&&r.sourceRevoked===true&&r.fenced===true;}catch{}
        const stopped=await service.bridge(d.machine,'projects.copy.cancel',target);
        if(stopped?.id!==id||stopped.cleaned!==true||!['CANCELED','FAILED','SUCCEEDED'].includes(stopped.state)||!fenced)return view(row);
        const released=await service.bridge(d.from,'projects.copy.cancel',source);
        if(released?.id!==id||released.cleaned!==true||!['READY','FAILED','CANCELED'].includes(released.state))return view(row);
        let state=d.state;
        if(!terminal.has(state)){
          state=stopped.state==='SUCCEEDED'?'SUCCEEDED':'CANCELED';
          if(state==='SUCCEEDED')checkReceipt(row,stopped,true);
        }
        return view(save(service,row,{state,cleanupComplete:true,...(stopped.targetRelease?{targetRelease:stopped.targetRelease}:{})}));
      }
      if(service.maintenanceFor?.(d.from)||service.maintenanceFor?.(d.machine))return view(row);
      if(!d.ticket){
        await service.ociProjectAdmission?.(d.from,d.sourceUserId,d.project);
        authorized(service,row.actor_id,d);
        if(read(service,id).data.cancelRequested)return view(read(service,id));
        let result;
        if(d.sourceSent)result=await service.bridge(d.from,'projects.copy.status',source);
        else{
          maintain(service,{userId:row.actor_id,role:'admin'},d);
          row=save(service,row,{sourceSent:true,state:'PREPARING'});
          result=await service.bridge(d.from,'projects.copy.prepare',{...source,project:d.project,release:d.release,targetMachine:d.machine});
        }
        checkReceipt(row,result);
        if(['FAILED','CANCELED'].includes(result.state))return view(save(service,row,{state:result.state,error:'源发布导出未完成。'}));
        if(result.state!=='READY')return view(save(service,row,{state:result.state==='UNKNOWN'?'UNKNOWN':'PREPARING'}));
        authorized(service,row.actor_id,d);
        if(read(service,id).data.cancelRequested)return view(read(service,id));
        maintain(service,{userId:row.actor_id,role:'admin'},d);
        if(!result.source)result=await service.bridge(d.from,'projects.copy.prepare',{...source,project:d.project,release:d.release,targetMachine:d.machine});
        checkReceipt(row,result);
        const ticket=result.source;
        if(ticket?.id!==id||ticket.project!==d.project||ticket.release!==d.release||ticket.protocol!=='portable-project-v1'||ticket.state!=='READY'||
          !/^[A-Za-z0-9_-]{43}$/.test(ticket.token||''))throw Error('Source ticket unconfirmed');
        row=save(service,row,{ticket,state:'PREPARING'});d=row.data;
      }
      authorized(service,row.actor_id,d);
      if(read(service,id).data.cancelRequested)return view(read(service,id));
      let result;
      if(d.targetSent)result=await service.bridge(d.machine,'projects.copy.status',target);
      else{
        await service.ociProjectAdmission?.(d.machine,d.targetUserId,d.targetProject,{creatingOCI:true});
        authorized(service,row.actor_id,d);
        if(read(service,id).data.cancelRequested)return view(read(service,id));
        maintain(service,{userId:row.actor_id,role:'admin'},d);
        row=save(service,row,{targetSent:true,state:'DISPATCHING'});
        result=await service.bridge(d.machine,'projects.copy.admin-start',{...target,hostAdmin:true,sourceUserId:d.sourceUserId,sourceProject:d.project,
          project:d.targetProject,release:d.release,sourceMachine:d.from,source:d.ticket});
      }
      checkReceipt(row,result,true);
      authorized(service,row.actor_id,d);
      if(read(service,id).data.cancelRequested)return view(read(service,id));
      return view(save(service,row,{state:result.state==='READY'?'UNKNOWN':result.state,bytes:result.bytes??null,totalBytes:result.totalBytes??null,
        ...(result.state==='SUCCEEDED'?{targetRelease:result.targetRelease}:{}),error:result.state==='FAILED'?'目标复制失败，请核对原操作。':null}));
    }catch{
      row=read(service,id);
      return view(save(service,row,{state:terminal.has(row.data.state)?row.data.state:row.data.cancelRequested?'CANCELING':'UNKNOWN',
        error:'原节点回执未确认；只查询原编号，不重新派发。'}));
    }
  })().finally(()=>pending.delete(id));pending.set(id,task);return task;
}
export function installAdminProjectCopy(service){
  service.db.exec('CREATE TABLE IF NOT EXISTS admin_project_copies (id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,client_key TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(actor_id,client_key))');
  service.reconcileAdminProjectCopies=async()=>{
    const rows=service.db.prepare("SELECT id FROM admin_project_copies WHERE COALESCE(json_extract(data,'$.cleanupComplete'),0)=0 LIMIT 8").all();
    await Promise.all(rows.map(row=>advance(service,row.id).catch(()=>{})));
  };
  service.adminProjectCopyTimer=setInterval(()=>service.reconcileAdminProjectCopies().catch(()=>{}),15000);service.adminProjectCopyTimer.unref();
}
export async function adminProjectCopyCall(service,principal,operation,args,revalidate=()=>{}){
  authorized(service,principal.userId);
  if(!args||typeof args!=='object'||Array.isArray(args))fail('复制参数无效。');
  const action=operation.slice('projects.admin-copy.'.length);
  if(['status','cancel'].includes(action)){
    if(Object.keys(args).join(',')!=='id'||!UUID.test(args.id||''))fail('需要原复制 UUID。');
    let row=read(service,args.id);
    if(row.actor_id!==principal.userId)fail('复制不属于当前管理员。',404);
    if(action==='cancel'&&!terminal.has(row.data.state))row=save(service,row,{cancelRequested:true,state:'CANCELING'});
    if(action==='cancel')return advance(service,row.id);
    // Read-only recovery: even an old or unknown record cannot dispatch work.
    if(row.data.targetSent&&!terminal.has(row.data.state)&&!row.data.cancelRequested){
      try{
        const result=await service.bridge(row.data.machine,'projects.copy.status',{id:row.id,userId:row.data.targetUserId});
        checkReceipt(row,result,true);revalidate();authorized(service,principal.userId);
        row=save(service,row,{state:result.state==='READY'?'UNKNOWN':result.state,
          bytes:result.bytes??null,totalBytes:result.totalBytes??null,
          error:['UNKNOWN','READY'].includes(result.state)?'原节点回执未确认；只查询原编号。':result.state==='FAILED'?'目标复制失败，请核对原操作。':null,
          ...(result.state==='SUCCEEDED'?{targetRelease:result.targetRelease}:{})});
      }catch{revalidate();authorized(service,principal.userId);row=read(service,row.id);
        if(!terminal.has(row.data.state)&&!row.data.cancelRequested)save(service,row,{state:'UNKNOWN',error:'原节点回执未确认；只查询原编号。'});}
    }
    return view(read(service,row.id));
  }
  const allowed=action==='plan'?fields:action==='begin'?[...fields,'key','planHash','authorization']:[];
  if(!allowed.length||Object.keys(args).some(k=>!allowed.includes(k))||allowed.some(k=>args[k]===undefined))fail('复制参数不完整或包含未允许字段。');
  const data=identity(args);authorized(service,principal.userId,data);
  if(action==='plan')return plan(service,principal,data,revalidate);
  if(!UUID.test(args.key||'')||!/^[a-f0-9]{64}$/.test(args.planHash||'')||typeof args.authorization!=='string'||
    args.authorization.trim().length<5||args.authorization.length>1000)fail('需要原 UUID、核对计划及源账号授权说明。');
  const requestDigest=digest({...data,planHash:args.planHash,authorization:args.authorization});
  const previous=service.db.prepare('SELECT id,digest FROM admin_project_copies WHERE actor_id=? AND client_key=?').get(principal.userId,args.key);
  if(previous){if(previous.digest!==requestDigest)fail('该键已绑定其他复制。',409);return view(read(service,previous.id));}
  maintain(service,principal,data);
  const checked=await plan(service,principal,data,revalidate);
  if(checked.planHash!==args.planHash)fail('计划已变化，请重新只读核对。',409);
  revalidate();authorized(service,principal.userId,data);maintain(service,principal,data);
  const raced=service.db.prepare('SELECT id,digest FROM admin_project_copies WHERE actor_id=? AND client_key=?').get(principal.userId,args.key);
  if(raced){if(raced.digest!==requestDigest)fail('该键已绑定其他复制。',409);return view(read(service,raced.id));}
  if(service.db.prepare("SELECT count(*) AS n FROM admin_project_copies WHERE COALESCE(json_extract(data,'$.cleanupComplete'),0)=0").get().n>=8)fail('尚有未完成复制，请先核对原编号。',429);
  const id=randomUUID();
  service.db.exec('BEGIN IMMEDIATE');
  try{
    service.db.prepare('INSERT INTO admin_project_copies VALUES(?,?,?,?,?)').run(id,principal.userId,args.key,requestDigest,
      JSON.stringify({...data,state:'PREPARING',planHash:args.planHash,authorization:args.authorization,createdAt:new Date().toISOString(),cleanupComplete:false}));
    service.audit(principal.username,operation,data.machine,JSON.stringify({id,...data,authorization:args.authorization}));
    service.db.exec('COMMIT');
  }catch(error){service.db.exec('ROLLBACK');throw error;}
  return advance(service,id);
}
