// Durable immutable OCI copies; payload goes node-to-node, never through VPS.
import {randomUUID,createHash} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {projectReference,UUID} from './projects.mjs';
const terminal=new Set(['SUCCEEDED','FAILED','CANCELED']);
const phaseLabels={SOURCE_PREPARATION:'源端准备',TARGET_ADMISSION:'目标准入',TARGET_DISPATCH:'目标派发',CANCELLATION:'取消',CLEANUP:'清理'};
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lanes=new WeakMap();
const preparations=new WeakMap();
const view=row=>{const {sourceTicket,...data}=row.data;return {id:row.id,state:row.state,...data};};
function read(service,id){const row=service.db.prepare('SELECT * FROM project_copies WHERE id=?').get(id);if(!row)fail('项目复制不存在。',404);return {...row,data:JSON.parse(row.data)};}
function save(service,row,state,change={}){
  const current=read(service,row.id),data={...row.data,...change,cancelRequested:current.data.cancelRequested||change.cancelRequested||false};
  if(data.cancelRequested&&!terminal.has(state))state='CANCELING';
  if(service.closing)fail('服务正在关闭。',503);
  service.db.prepare('UPDATE project_copies SET state=?,data=?,updated_at=? WHERE id=?').run(state,JSON.stringify(data),Date.now(),row.id);
  return read(service,row.id);
}
function authorized(service,owner,data){
  const user=service.store.get(owner);
  if(!user.enabled)fail('账号已暂停。',403);
  for(const machine of [data.from,data.machine])if(!MACHINES.some(m=>m.id===machine)||!user.limits[machine])fail('项目来源或目标服务器未授权。',403);
  return user;
}
async function lane(service,id,run){
  let state=lanes.get(service);if(!state){state=new Map();lanes.set(service,state);}
  if(state.has(id))return state.get(id);
  if(state.size>=8)fail('项目复制请求繁忙，请稍后刷新。',429);
  const operation=Promise.resolve().then(run).finally(()=>state.delete(id));state.set(id,operation);return operation;
}
function assertCopyResult(row,result){
  if(result?.id!==row.id||result.project!==row.data.project||result.release!==row.data.release||
     !['READY','RUNNING','UNKNOWN','SUCCEEDED','FAILED','CANCELED'].includes(result.state))throw Error('项目复制回执不匹配。');
}
async function advance(service,id){return lane(service,id,async()=>{
  let row=read(service,id);const control={id,userId:row.owner_id};
  if(terminal.has(row.state)&&row.data.cleanupComplete)return view(row);
  if(!terminal.has(row.state)&&!row.data.cancelRequested){
    try{authorized(service,row.owner_id,row.data);}
    catch{row=save(service,row,'CANCELING',{cancelRequested:true,cancellationReason:'AUTHORIZATION_REVOKED'});}
  }
  const data=row.data;
  let phase=data.sourceTicket?'TARGET_ADMISSION':'SOURCE_PREPARATION';
  if(data.cancelRequested)phase='CANCELLATION';
  else if(terminal.has(row.state))phase='CLEANUP';
  const maintained=()=>service.maintenanceFor?.(data.from)||service.maintenanceFor?.(data.machine);
  try{
    if((data.cancelRequested||terminal.has(row.state))&&!row.data.sourceRevoked){
      // Revoke the bearer capability before contacting a possibly unreachable
      // target. This operation retains transport packages and never kills a
      // worker; final cleanup still requires both sides definitely stopped.
      try{
        const fenced=await service.bridge(data.from,'projects.copy.revoke',control);
        if(fenced?.id===id&&fenced.sourceRevoked===true&&fenced.fenced===true)
          row=save(service,row,row.state,{sourceRevoked:true});
      }catch{} // Still try to stop the target if the source itself is offline.
    }
    if(data.cancelRequested){
      const stopped=await service.bridge(data.machine,'projects.copy.cancel',control);
      if(stopped?.id!==id||!['CANCELED','SUCCEEDED'].includes(stopped.state)||!row.data.sourceRevoked)return view(save(service,row,'CANCELING'));
      const source=await service.bridge(data.from,'projects.copy.cancel',control);
      if(source?.id!==id||!['READY','CANCELED','FAILED'].includes(source.state))return view(save(service,row,'CANCELING'));
      return view(save(service,row,stopped.state==='SUCCEEDED'?'SUCCEEDED':'CANCELED',{
        sourceRevoked:true,cleanupComplete:stopped.cleaned===true&&source.cleaned===true,error:null}));
    }
    if(terminal.has(row.state)){
      const target=await service.bridge(data.machine,'projects.copy.cancel',control);
      if(target?.id!==id||!['SUCCEEDED','CANCELED','FAILED'].includes(target.state)||!row.data.sourceRevoked)return view(row);
      const source=await service.bridge(data.from,'projects.copy.cancel',control);
      if(source?.id===id&&['READY','CANCELED','FAILED'].includes(source.state))row=save(service,row,row.state,{
        sourceRevoked:true,cleanupComplete:source.cleaned===true&&target.cleaned===true});
      return view(row);
    }
    if(maintained())return view(row);
    if(!data.sourceTicket){
      await service.ociProjectAdmission?.(data.from,row.owner_id,data.project);
      authorized(service,row.owner_id,data);
      if(maintained()||read(service,id).data.cancelRequested)return view(read(service,id));
      const result=await service.bridge(data.from,'projects.copy.prepare',{...control,project:data.project,release:data.release,targetMachine:data.machine});
      assertCopyResult(row,result);
      if(result.state==='FAILED'||result.state==='CANCELED')return view(save(service,row,result.state,{error:result.error||'项目导出未完成。'}));
      if(result.state!=='READY')return view(save(service,row,'PREPARING',{sourceState:result.state,error:result.state==='UNKNOWN'?'导出回执未确认；不会重复启动。':null}));
      const ticket=result.source;
      if(ticket?.id!==id||ticket.protocol!=='portable-project-v1'||ticket.state!=='READY'||ticket.project!==data.project||ticket.release!==data.release||
         typeof ticket.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ticket.token))throw Error('项目源授权回执不匹配。');
      row=save(service,row,'DISPATCHING',{sourceTicket:ticket,sourceState:'READY',error:null,errorCode:null,errorPhase:null});
    }
    authorized(service,row.owner_id,row.data);
    if(maintained()||read(service,id).data.cancelRequested)return view(row);
    phase='TARGET_ADMISSION';
    await service.ociProjectAdmission?.(data.machine,row.owner_id,data.project,{creatingOCI:true});
    authorized(service,row.owner_id,row.data);
    if(maintained()||read(service,id).data.cancelRequested)return view(read(service,id));
    phase='TARGET_DISPATCH';
    const result=await service.bridge(data.machine,'projects.copy.start',{...control,project:data.project,release:data.release,
      sourceMachine:data.from,source:row.data.sourceTicket});
    assertCopyResult(row,result);
    row=save(service,row,result.state==='READY'?'SUCCEEDED':result.state,
      {sourceState:'READY',bytes:result.bytes,totalBytes:result.totalBytes,error:result.error||null,errorCode:null,errorPhase:null});
    return view(row);
  }catch(error){
    if(!terminal.has(row.state)){
      try{authorized(service,row.owner_id,row.data);}
      catch{return view(save(service,row,'CANCELING',{cancelRequested:true,cancellationReason:'AUTHORIZATION_REVOKED',
        errorCode:'PROJECT_COPY_'+phase+'_UNCONFIRMED',errorPhase:phase}));}
    }
    return view(save(service,row,terminal.has(row.state)?row.state:'UNKNOWN',{
      error:terminal.has(row.state)?row.data.error||null:`${phaseLabels[phase]}结果未确认；请查询原复制任务，不会改派或重复创建。`,
      errorCode:terminal.has(row.state)?row.data.errorCode||null:'PROJECT_COPY_'+phase+'_UNCONFIRMED',
      errorPhase:terminal.has(row.state)?row.data.errorPhase||null:phase}));
  }
});}

export function installProjectReplication(service){
  service.db.exec(`CREATE TABLE IF NOT EXISTS project_copies (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,client_key TEXT NOT NULL,digest TEXT NOT NULL,
    state TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    UNIQUE(owner_id,client_key));`);
  service.projectCopyProbe=async(owner,machine,reference)=>{
    authorized(service,owner,{from:reference.from||machine,machine});
    const result=await service.bridge(machine,'projects.copy.probe',{userId:owner,...reference});
    if(result?.protocol!=='portable-project-v1'||result.enabled!==true||result.environmentMode!=='oci'||result.project!==reference.project||
       !['amd64','arm64'].includes(result.architecture)||!Array.isArray(result.sources)||typeof result.releaseReady!=='boolean'||
       reference.release&&(result.release!==reference.release||!result.releaseReady))fail('项目便携能力未确认。',503);
    return result;
  };
  const prepareProject=async(owner,machine,reference)=>{
    const {from,project,release}=reference;authorized(service,owner,{from,machine});
    try{
      const result=await service.bridge(machine,'projects.verify',{userId:owner,project,release});
      if(result?.state==='READY'&&result.project===project&&result.release===release)return {...result,machine};
    }catch{}
    if(from===machine)fail('所选源节点的固定项目版本不可用。',409);
    let found;
    for(const row of service.db.prepare('SELECT * FROM project_copies WHERE owner_id=? ORDER BY created_at DESC LIMIT 1000').all(owner)){
      const data=JSON.parse(row.data);
      if(data.from===from&&data.machine===machine&&data.project===project&&data.release===release){found=row;break;}
    }
    const principal={userId:owner,role:service.store.get(owner).role||'member',username:service.store.get(owner).username};
    const result=found?await advance(service,found.id):await projectReplicationCall(service,principal,'projects.replicate',{from,machine,project,release,key:randomUUID()});
    return {project,release,machine,state:result.state==='SUCCEEDED'?'READY':terminal.has(result.state)?'FAILED':'PREPARING',operationId:result.id,
      error:terminal.has(result.state)&&result.state!=='SUCCEEDED'?`${result.error||'项目复制未完成。'} 排查后运行 gpuctl project copy-retry ${result.id}；状态未知时不要新建复制。`:result.error};
  };
  service.prepareProject=(owner,machine,reference)=>{
    let pending=preparations.get(service);if(!pending){pending=new Map();preparations.set(service,pending);}
    const key=JSON.stringify([owner,machine,reference.from,reference.project,reference.release]);
    if(pending.has(key))return pending.get(key);
    if(pending.size>=8)return Promise.reject(Object.assign(Error('项目准备繁忙，请稍后刷新。'),{status:429}));
    const operation=Promise.resolve().then(()=>prepareProject(owner,machine,reference)).finally(()=>pending.delete(key));
    pending.set(key,operation);return operation;
  };
  service.reconcileProjectCopies=async()=>{
    const rows=service.db.prepare("SELECT id FROM project_copies WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELED') OR COALESCE(json_extract(data,'$.cleanupComplete'),0)=0 ORDER BY updated_at LIMIT 8").all();
    await Promise.all(rows.map(r=>advance(service,r.id).catch(()=>{})));
  };
  service.projectCopyTimer=setInterval(()=>service.reconcileProjectCopies().catch(()=>{}),15000);service.projectCopyTimer.unref();
}

export async function projectReplicationCall(service,principal,operation,args,revalidate=()=>{}){
  if(!args||typeof args!=='object'||Array.isArray(args))fail('项目复制参数无效。');
  if(!service.store.get(principal.userId).enabled)fail('账号已暂停。',403);
  if(operation==='projects.replicate'){
    if(Object.keys(args).some(k=>!['from','machine','project','release','key'].includes(k))||!UUID.test(args.key||''))fail('项目复制需要完整操作 UUID。');
    const reference=projectReference(args,{optional:false,release:true});
    if(args.from===args.machine)fail('源服务器与目标服务器应不同。');
    const data={from:args.from,machine:args.machine,...reference};authorized(service,principal.userId,data);
    service.assertMaintenanceAllowed?.('projects.create',{machine:args.machine},principal);
    service.assertMaintenanceAllowed?.('projects.publish',{machine:args.from},principal);
    const digest=hash(data),previous=service.db.prepare('SELECT id,digest FROM project_copies WHERE owner_id=? AND client_key=?').get(principal.userId,args.key);
    if(previous){if(previous.digest!==digest)fail('此操作键已用于另一个项目复制。',409);return advance(service,previous.id);}
    const active=service.db.prepare("SELECT COUNT(*) AS n FROM project_copies WHERE owner_id=? AND state NOT IN ('SUCCEEDED','FAILED','CANCELED')").get(principal.userId).n;
    if(active>=8)fail('最多保留 8 个进行中的项目复制。',429);
    // Admission is read-only and checks both OCI hosts plus the authenticated
    // source image; it never exports data or starts a development container.
    const source=await service.projectCopyProbe(principal.userId,args.from,reference);
    const target=await service.projectCopyProbe(principal.userId,args.machine,{project:reference.project,from:args.from});
    if(source.architecture!==target.architecture)fail('源与目标 CPU 架构不兼容。',409);
    // Recheck after I/O; concurrent retries still share the same durable row.
    authorized(service,principal.userId,data);
    revalidate();
    service.assertMaintenanceAllowed?.('projects.create',{machine:args.machine},principal);
    service.assertMaintenanceAllowed?.('projects.publish',{machine:args.from},principal);
    const raced=service.db.prepare('SELECT id,digest FROM project_copies WHERE owner_id=? AND client_key=?').get(principal.userId,args.key);
    if(raced){if(raced.digest!==digest)fail('此操作键已用于另一个项目复制。',409);return advance(service,raced.id);}
    if(service.db.prepare("SELECT COUNT(*) AS n FROM project_copies WHERE owner_id=? AND state NOT IN ('SUCCEEDED','FAILED','CANCELED')").get(principal.userId).n>=8)fail('最多保留 8 个进行中的项目复制。',429);
    const id=randomUUID(),now=Date.now();
    service.db.prepare('INSERT INTO project_copies VALUES(?,?,?,?,?,?,?,?)').run(id,principal.userId,args.key,digest,'PREPARING',JSON.stringify({...data,cancelRequested:false}),now,now);
    service.audit(principal.username,operation,args.machine,reference.project);
    return advance(service,id);
  }
  const retry=operation==='projects.replication.retry';
  if(!['projects.replication.status','projects.replication.cancel','projects.replication.retry'].includes(operation)||
    Object.keys(args).sort().join(',')!==(retry?'id,key':'id')||!UUID.test(args.id||'')||retry&&!UUID.test(args.key||''))fail('项目复制操作无效。');
  let row=read(service,args.id);if(row.owner_id!==principal.userId)fail('项目复制不存在或属于其他账号。',404);
  if(retry){
    authorized(service,principal.userId,row.data);
    if(!['FAILED','CANCELED'].includes(row.state))fail('仅明确失败或取消的复制可重试；运行中或 UNKNOWN 请先查询原操作。',409);
    if(args.key===row.client_key)fail('显式重试需要新的重试键；其响应不明时必须复用该键。',409);
    await advance(service,row.id);
    const retried=await lane(service,row.id,async()=>{
      row=read(service,args.id);authorized(service,principal.userId,row.data);revalidate();
      if(row.data.retryKey&&row.data.retryKey!==args.key)fail(`原复制已申请一次重试；请复用 --key ${row.data.retryKey} 查询原重试，不要换键。`,409);
      if(!['FAILED','CANCELED'].includes(row.state)||!row.data.cleanupComplete||!row.data.sourceRevoked)
        fail('旧复制尚未确认停止并清理；请稍后查询，未创建新操作。',409);
      const control={id:row.id,userId:row.owner_id};
      for(const machine of [row.data.machine,row.data.from]){
        // Idempotent cancel also proves a never-dispatched target's permanent
        // tombstone; release alone has no spec to read after export failure.
        const proof=await service.bridge(machine,'projects.copy.cancel',control);
        authorized(service,principal.userId,row.data);revalidate();
        if(proof?.id!==row.id||proof.cleaned!==true||!['READY','SUCCEEDED','FAILED','CANCELED'].includes(proof.state))
          fail('旧复制的停止与清理回执未确认，未创建新操作。',409);
      }
      if(!row.data.retryKey)row=save(service,row,row.state,{retryKey:args.key});
      // A durable client key is bound to this old operation BEFORE any new
      // remote I/O. A lost response cannot turn into another copy on restart.
      const result=await projectReplicationCall(service,principal,'projects.replicate',{
        from:row.data.from,machine:row.data.machine,project:row.data.project,release:row.data.release,key:args.key,
      },revalidate);
      save(service,row,row.state,{retryId:result.id});
      return {...result,retryOf:row.id};
    });
    // Different keys may have waited on the same per-operation lane. They
    // must not silently acquire the first caller's durable retry identity.
    if(read(service,args.id).data.retryKey!==args.key)fail(`原复制已申请一次重试；请复用 --key ${read(service,args.id).data.retryKey} 查询原重试，不要换键。`,409);
    return retried;
  }
  // Losing a machine grant must not strand an owned operation. Reading its
  // history or fencing its existing workers never creates new compute access.
  if(operation.endsWith('.cancel')&&!terminal.has(row.state))row=save(service,row,'CANCELING',{cancelRequested:true});
  return advance(service,row.id);
}
