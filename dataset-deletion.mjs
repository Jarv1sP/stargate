import {createHash,randomUUID} from 'node:crypto';
import {authorizationPolicy,MACHINES} from './dist/model.js';
import {DATASET_FENCE_REFUSAL} from './dataset-catalog.mjs';

// Independent, durable version-deletion journal. It never mutates external
// archive-retirement journals, invents their proofs, or replays unknown writes.
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROTOCOL='dataset-delete-node-v1',RETIREMENT='dataset-version-retirement-v1';
const states=new Set(['PLANNED','REMOVING_CACHES','RETIRING_ORIGINAL','DELETED','BLOCKED','FAILED','UNKNOWN','RUNNING','WAITING_CONTINUE','CANCELING','CANCELED']);
// Python journals sort object keys; JSON property order is not proof identity.
// Array order and every field remain significant.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const encoded=value=>JSON.stringify(canonical(value));
const sha=value=>createHash('sha256').update(encoded(value)).digest('hex');
const fail=(message,status=409,code)=>{throw Object.assign(Error(message),{status,...(code?{code}:{})});};
const fields=(value,allowed)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('删除参数无效。',400);
};
const reference=(dataset,version)=>{if(typeof dataset!=='string'||!ID.test(dataset)||typeof version!=='string'||!HASH.test(version))fail('需要数据集 ID 和完整版本。',400);};
const uuid=value=>{if(typeof value!=='string'||!UUID.test(value))fail('需要完整 UUID 编号。',400);return value;};
const machine=value=>{if(!MACHINES.some(m=>m.id===value))fail('删除清单包含未知服务器。');return value;};
const MAPPED_REFUSAL=Symbol('mapped dataset refusal');
const safeRefusal=error=>error[MAPPED_REFUSAL]?error.message:refusal(error.message);
function refusal(message){
  if(/retention|保留期|expired/i.test(message))return '保留期已过，不能开始恢复。';
  if(/clock|时钟|时间|synchron/i.test(message))return '节点时间待确认，请联系管理员核对。';
  if(/overwrite|占名|conflict/i.test(message))return '已有同名数据，恢复不会覆盖。';
  if(/verification|校验|checksum/i.test(message))return '保留的数据校验未通过，恢复已停止。';
  if(/lease|租约|训练|正在使用/i.test(message))return '仍有训练或传输正在使用这份数据。';
  if(/pin|固定保留/i.test(message))return '这份数据仍有固定保留。';
  if(/maintenance|维护/i.test(message))return '服务器正在维护，请等待管理员恢复。';
  if(/依赖|归档|archive|alias|物理名称|传输/i.test(message))return '归档或副本依赖未确认，请联系管理员核对。';
  if(/管理员|provenance|owner|权限|账号|logged out/i.test(message))return '账号或来源权限未确认，请联系管理员。';
  return '节点步骤未确认，请联系管理员核对原编号。';
}
const same=(a,b)=>encoded(a)===encoded(b);
const planFields=['protocol','operationId','machine','dataset','version','state','snapshotSha256','owners','memberAllowed','complete','absent','authority','authorityReferences','authorityAliases'];
const receiptFields=['protocol','operationId','machine','dataset','version','state','isolated','complete','snapshotSha256','generation','fenceState','retainUntil','proofSha256','authorityReferences','authorityAliases'];

function account(service,principal){
  const value=service.store.get(principal.userId);
  if(!value?.enabled||value.username!==principal.username||(value.role||'member')!==principal.role)fail('账号权限已改变，请重新登录。',403);
  if(!MACHINES.some(m=>value.limits[m.id]>0))fail('账号尚未获得服务器授权。',403);
  return value;
}
function parsePlan(value,step,principal){
  if(!value||Object.keys(value).sort().join(',')!==planFields.toSorted().join(',')||value.protocol!==PROTOCOL
    ||value.operationId!==step.operationId||value.machine!==step.machine||value.dataset!==step.dataset||value.version!==step.version
    ||value.state!=='PLANNED'||!HASH.test(value.snapshotSha256)||typeof value.memberAllowed!=='boolean'||typeof value.complete!=='boolean'
    ||typeof value.absent!=='boolean'||!Array.isArray(value.owners)||!value.owners.length||!Array.isArray(value.authorityReferences)||!Array.isArray(value.authorityAliases))fail('节点删除计划未确认。',502);
  if(principal.role!=='admin'&&(!value.memberAllowed||!same(value.owners,[principal.userId])))fail('这份数据只能由管理员删除。',403);
  return structuredClone(value);
}
function parseReceipt(value,step,state='ISOLATED'){
  if(!value||Object.keys(value).sort().join(',')!==receiptFields.toSorted().join(',')||value.protocol!==RETIREMENT
    ||value.operationId!==step.operationId||value.machine!==step.machine||value.dataset!==step.dataset||value.version!==step.version
    ||value.snapshotSha256!==step.plan.snapshotSha256||value.complete!==step.plan.complete||value.state!==state
    ||value.isolated!==(state==='ISOLATED')||!HASH.test(value.generation)||!HASH.test(value.proofSha256)
    ||value.fenceState!==(state==='RESTORED'?(step.plan.absent?'RELEASED':'RESTORED'):state)
    ||step.fence&&value.generation!==step.fence.generation
    ||step.result&&(value.generation!==step.result.generation||value.retainUntil!==step.result.retainUntil)
    ||!Number.isFinite(value.retainUntil)||value.retainUntil<step.fenceAt/1000+7*86400-300
    ||!same(value.authorityReferences,step.plan.authorityReferences)||!same(value.authorityAliases,step.plan.authorityAliases))fail('完整隔离回执或节点时间待确认。',502);
  return structuredClone(value);
}
function parseNewRegistration(value,step){
  const keys=['protocol','machine','dataset','version','operationId','generation','snapshotSha256','registrationSha256','state'];
  if(!value||Object.keys(value).sort().join(',')!==keys.toSorted().join(',')
    ||value.protocol!=='dataset-new-registration-proof-v1'||value.state!=='REGISTERED'
    ||value.machine!==step.machine||value.dataset!==step.dataset||value.version!==step.version
    ||value.operationId!==step.operationId||value.snapshotSha256!==step.plan.snapshotSha256
    ||value.generation!==(step.fence?.generation||step.result?.generation)||!HASH.test(value.registrationSha256))
    fail('显式新登记的来源证明待确认。',502);
  return structuredClone(value);
}
function externalRetirementAction(archive){
  if(archive.retirement?.mode==='undispatched-intent-cancel-v1')return '归档请求已取消（数据未删除）';
  if(archive.failureStage==='authority-retired')return '外部替代退役';
  // The external lifecycle retains the fixed admission metadata. This is
  // only a log label, never authorization, an absence proof or data isolation.
  let mode='待确认';
  if(archive.kind==='ingest'&&HASH.test(archive.retirement?.proofSha256||'')){
    if(archive.sourceMachine===archive.machine&&archive.sourceDataset===archive.dataset
      &&archive.transferId===null&&UUID.test(archive.grantId||'')&&UUID.test(archive.certifyId||''))mode='same-HDD';
    else if(archive.sourceDataset===null&&archive.transferId===null&&archive.grantId===null
      &&UUID.test(archive.copyKey||''))mode='queued-ingest-v1';
  }
  return `归档意图退役（外部原语，模式 ${mode}）`;
}
function publicTask(row){
  return {operationId:row.id,key:row.key,dataset:row.dataset,version:row.version,state:row.state,
    ...(row.state==='WAITING_CONTINUE'?{canContinue:!row.cancelRequested&&!row.waitingWorker}:{}),
    createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString(),
    ...(row.error?{error:row.error}:{}),copyNotice:'其他名称下的副本不受影响',...(row.retainUntil?{retainUntil:new Date(row.retainUntil*1000).toISOString()}:{}),
    steps:row.steps.map(step=>({machine:step.machine,dataset:step.dataset,operationId:step.operationId,
      phase:step.phase,complete:step.plan?.complete===true,state:step.state,
      ...(step.result?{retainUntil:new Date(step.result.retainUntil*1000).toISOString()}:{}),
      ...(step.error?{error:step.error}:{}),...(step.restoreState?{restoreState:step.restoreState}:{})})),
    events:row.events.map(({time,action,machine:host,state})=>({time,action,...(host?{machine:host}:{}),state}))};
}

export function installDatasetDeletion(service,{clock=Date.now,pollMs=250,capabilityTimeoutMs=1500,capabilityTtlMs=1500}={}){
  service.db.exec(`CREATE TABLE IF NOT EXISTS dataset_deletions (
    id TEXT PRIMARY KEY,client_key TEXT NOT NULL UNIQUE,owner TEXT NOT NULL,dataset TEXT NOT NULL,version TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dataset_deletion_fences (
    machine TEXT NOT NULL,dataset TEXT NOT NULL,version TEXT NOT NULL,operation_id TEXT NOT NULL,PRIMARY KEY(machine,dataset,version));`);
  const running=new Map(),restoring=new Map(),canceling=new Map(),queries=new Map(),capCache=new Map();
  const restarted=new Set(service.db.prepare('SELECT id,data FROM dataset_deletions').all()
    .filter(r=>!['DELETED','CANCELED'].includes(JSON.parse(r.data).state)).map(r=>r.id));
  const load=id=>{const value=service.db.prepare('SELECT data FROM dataset_deletions WHERE id=?').get(id);return value&&JSON.parse(value.data);};
  const byKey=key=>{const value=service.db.prepare('SELECT data FROM dataset_deletions WHERE client_key=?').get(key);return value&&JSON.parse(value.data);};
  const save=row=>{
    if(service.closing)fail('服务正在关闭；请查询原删除任务。',503);
    if(!states.has(row.state))fail('删除任务状态损坏。');
    row.updatedAt=clock();service.db.prepare('UPDATE dataset_deletions SET data=? WHERE id=?').run(JSON.stringify(row),row.id);
  };
  const event=(row,action,host,state)=>{row.events.push({time:new Date(clock()).toISOString(),action,machine:host,state});save(row);service.audit(row.username,'datasets.delete.step',row.id,JSON.stringify({action,machine:host,state}));};
  const access=(principal,row)=>{
    account(service,principal);
    if(!row||principal.role!=='admin'&&row.owner!==principal.userId)fail('删除记录不存在或无权查看。',404);
    return row;
  };
  service.datasetDeletionBlocked=(host,ref)=>{
    if(!ref||!ID.test(ref.dataset))return false;
    if(ref.version===null||ref.version===undefined)return service.db.prepare('SELECT operation_id FROM dataset_deletion_fences WHERE machine=? AND dataset=?').all(host,ref.dataset)
      .some(fence=>{const row=load(fence.operation_id);return !row||!['DELETED','CANCELED'].includes(row.state);});
    if(!HASH.test(ref.version))return false;
    return !!service.db.prepare('SELECT operation_id FROM dataset_deletion_fences WHERE machine=? AND dataset=? AND version=?').get(host,ref.dataset,ref.version);
  };
  service.assertDatasetNotDeleting=(host,ref)=>{
    if(service.datasetDeletionBlocked(host,ref))throw Object.assign(Error('这个版本正在删除或已隔离，请查询原删除任务。'),
      {status:409,code:'DATASET_DELETION_FENCED',nodeNotDispatched:true,[DATASET_FENCE_REFUSAL]:true});
  };
  const previousBridge=service.bridge;
  service.confirmDatasetNotDeleting=async(host,ref,identity)=>{
    const blocked=service.datasetDeletionBlocked(host,ref);
    if(!blocked)return;
    if(previousBridge&&HASH.test(ref?.version)&&typeof identity?.userId==='string'&&typeof identity?.hostAdmin==='boolean'){
      const fence=service.db.prepare('SELECT operation_id FROM dataset_deletion_fences WHERE machine=? AND dataset=? AND version=?').get(host,ref.dataset,ref.version);
      const row=fence&&load(fence.operation_id),step=row?.steps.find(s=>s.machine===host&&s.dataset===ref.dataset);
      const actor=service.store.get(identity.userId),policy=actor&&authorizationPolicy(actor);
      if(step?.plan&&actor?.enabled&&(actor.role==='admin')===identity.hostAdmin&&actor.limits?.[host]>0){
        let proof;
        try{proof=await previousBridge(host,'storage.dataset-delete.registration',{dataset:ref.dataset,version:ref.version,userId:identity.userId,hostAdmin:identity.hostAdmin});}catch{/* No proof never opens a fence. */}
        try{proof=parseNewRegistration(proof,step);}catch{proof=null;}
        if(proof&&service.store.get(identity.userId)&&authorizationPolicy(service.store.get(identity.userId))===policy){
          if(service.closing)fail('服务正在关闭；结果未确认。',503);
          service.db.exec('BEGIN IMMEDIATE');
          try{
            const current=load(row.id),target=current.steps.find(s=>s.operationId===step.operationId);
            target.reopened=structuredClone(proof);save(current);event(current,'显式新登记代次',host,'REGISTERED');
            service.db.prepare('DELETE FROM dataset_deletion_fences WHERE machine=? AND dataset=? AND version=? AND operation_id=?').run(host,ref.dataset,ref.version,row.id);
            service.db.exec('COMMIT');
          }catch(error){service.db.exec('ROLLBACK');throw error;}
        }
      }
    }
    service.assertDatasetNotDeleting(host,ref);
  };
  if(previousBridge)service.bridge=(host,operation,args,context)=>{
    if(['datasets.prepare','datasets.unregister','datasets.register','datasets.sync.begin','datasets.snapshot.begin'].includes(operation)
      &&service.datasetDeletionBlocked(host,args))
      return service.confirmDatasetNotDeleting(host,args,args).then(()=>previousBridge(host,operation,args));
    // Keep the original synchronous maintenance refusal for every untouched
    // operation. A proof read is asynchronous only for a fenced namespace.
    return context===undefined?previousBridge(host,operation,args):previousBridge(host,operation,args,context);
  };
  const checkFactory=(principal,assertCurrent,policy,inventory,row,read=false,allowCancellation=false)=>()=>{
    if(service.closing)fail('服务正在关闭；结果未确认。',503);
    assertCurrent();const current=account(service,principal);
    if(!read&&!allowCancellation&&row&&load(row.id)?.cancelRequested)fail('管理员已请求取消删除。',409,'DATASET_DELETE_CANCELED');
    if(authorizationPolicy(current)!==policy||sha(MACHINES.map(m=>m.id))!==inventory)fail('账号或服务器清单已改变；删除已暂停。',403);
    if(!read)for(const host of row?.steps?.map(s=>s.machine)||MACHINES.map(m=>m.id))service.assertMaintenanceAllowed?.(allowCancellation?'datasets.delete.cancel':'datasets.delete',{machine:host},principal);
  };
  const rpc=async(principal,check,host,action,args={})=>{
    check();if(!service.bridge)fail('节点执行桥尚未配置。',503);
    try{return await service.bridge(machine(host),'storage.dataset-delete.'+action,{...args,userId:principal.userId,hostAdmin:principal.role==='admin'});}
    finally{check();}
  };
  async function capabilities(principal,check,{cached=false}={}){
    // Parallel short reads. Only the UI may reuse a short-lived success; a
    // write always probes every node afresh. Timeout is never negative data.
    const results=await Promise.allSettled(MACHINES.map(async host=>{
      const key=host.id+':'+principal.userId+':'+principal.role,previous=capCache.get(key);
      if(cached&&previous&&previous.until>clock()){check();return previous.value;}
      let timer;
      try{
        const value=await Promise.race([rpc(principal,check,host.id,'capabilities'),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('capability timeout')),capabilityTimeoutMs);})]);
        check();
        if(value?.protocol!==PROTOCOL||value.machine!==host.id||value.datasetDelete!==1)throw Error('unsupported capability');
        capCache.set(key,{until:clock()+capabilityTtlMs,value});return value;
      }catch(error){capCache.delete(key);throw error;}
      finally{clearTimeout(timer);}
    }));
    check();if(results.some(r=>r.status!=='fulfilled'))fail('服务器的删除能力未确认，请等待节点更新或恢复连接。',409,'DATASET_DELETE_UNSUPPORTED');
  }
  const hasTable=name=>!!service.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  function graph(row){
    const refs=new Map(MACHINES.map(m=>[m.id,new Set([row.dataset])])),records=[];
    const copies=hasTable('dataset_copies')?service.db.prepare('SELECT data FROM dataset_copies').all().map(r=>JSON.parse(r.data)):[];
    const archives=hasTable('storage_archives')?service.db.prepare('SELECT data FROM storage_archives').all().map(r=>JSON.parse(r.data)):[];
    if(copies.length+archives.length>10000)fail('数据依赖清单需要管理员核对。');
    let changed=true;
    while(changed){
      changed=false;
      for(const copy of copies){
        if(copy.version!==row.version)continue;
        const related=copy.dataset===row.dataset||refs.get(copy.source)?.has(copy.sourceDataset)||refs.get(copy.target)?.has(copy.dataset);
        if(!related)continue;
        machine(copy.source);machine(copy.target);reference(copy.dataset,row.version);reference(copy.sourceDataset,row.version);
        const transfer=service.transferSnapshot?.(copy.owner,copy.transferId);
        if(transfer?.state!=='SUCCEEDED'||transfer.result?.version!==row.version||!ID.test(transfer.result.dataset))fail('副本传输或物理名称尚未确认。');
        for(const [host,name] of [[copy.source,copy.sourceDataset],[copy.target,transfer.result.dataset]])if(!refs.get(host).has(name)){refs.get(host).add(name);changed=true;}
        if(!records.some(r=>r.kind==='copy'&&r.value.id===copy.id))records.push({kind:'copy',value:copy,receipt:transfer});
      }
      for(const archive of archives){
        if(archive.version!==row.version)continue;
        if((archive.logicalDataset||archive.dataset)!==row.dataset&&!refs.get(archive.machine)?.has(archive.dataset)&&!refs.get(archive.sourceMachine)?.has(archive.sourceDataset))continue;
        machine(archive.machine);machine(archive.sourceMachine);reference(archive.dataset,row.version);
        if(['retired','authority-retired'].includes(archive.failureStage)){
          if(!records.some(r=>r.kind==='external'&&r.value.id===archive.id))records.push({kind:'external',value:archive});
          continue; // Event only; never a proof that a physical version is gone.
        }
        if(archive.phase!=='ARCHIVED'||archive.retirementIntent||!ID.test(archive.sourceDataset))fail('归档或外部退役尚未确认，不能开始版本删除。');
        for(const [host,name] of [[archive.machine,archive.dataset],[archive.sourceMachine,archive.sourceDataset]])if(!refs.get(host).has(name)){refs.get(host).add(name);changed=true;}
        if(!records.some(r=>r.kind==='archive'&&r.value.id===archive.id))records.push({kind:'archive',value:archive});
      }
    }
    if(hasTable('transfers'))for(const record of service.db.prepare('SELECT state,data FROM transfers').all()){
      const transfer=JSON.parse(record.data),ref=transfer.reference;
      if(ref?.kind!=='datasets'||ref.version!==row.version||!refs.get(transfer.from||transfer.machine)?.has(ref.dataset))continue;
      if(!['SUCCEEDED','FAILED','CANCELED'].includes(record.state)||transfer.sourceRelease&&transfer.sourceRelease.state!=='RELEASED'
        ||transfer.downloadProtection&&transfer.downloadProtection.state!=='RELEASED')fail('传输还在使用这个版本或释放未确认。');
    }
    return {refs,records,digest:sha(records.toSorted((a,b)=>a.value.id.localeCompare(b.value.id)))};
  }
  function claim(row,host,dataset,insideTransaction=false){
    machine(host);reference(dataset,row.version);
    if(row.steps.some(s=>s.machine===host&&s.dataset===dataset))return row.steps.find(s=>s.machine===host&&s.dataset===dataset);
    // Persist the physical namespace and child UUID before any node plan/write.
    if(!insideTransaction)service.db.exec('BEGIN IMMEDIATE');
    try{
      const old=service.db.prepare('SELECT operation_id FROM dataset_deletion_fences WHERE machine=? AND dataset=? AND version=?').get(host,dataset,row.version);
      if(old&&old.operation_id!==row.id)fail('这个版本已有删除任务，请查询原编号。');
      const step={machine:host,dataset,version:row.version,operationId:randomUUID(),state:'PLANNED',phase:'plan',plan:null,result:null,dispatched:[],fenceAt:null};
      row.steps.push(step);save(row);if(!insideTransaction)service.db.exec('COMMIT');return step;
    }catch(error){if(!insideTransaction)service.db.exec('ROLLBACK');throw error;}
  }
  function claimAuthorized(row,principal){
    if(!row.steps.length||row.steps.some(s=>!s.plan||principal.role!=='admin'&&(!s.plan.memberAllowed||!same(s.plan.owners,[principal.userId]))))fail('数据来源权限尚未确认。',403);
    service.db.exec('BEGIN IMMEDIATE');
    try{
      for(const step of row.steps){
        const old=service.db.prepare('SELECT operation_id FROM dataset_deletion_fences WHERE machine=? AND dataset=? AND version=?').get(step.machine,step.dataset,row.version);
        if(old&&old.operation_id!==row.id)fail('这个版本已有删除任务，请查询原编号。');
        service.db.prepare('INSERT OR IGNORE INTO dataset_deletion_fences VALUES(?,?,?,?)').run(step.machine,step.dataset,row.version,row.id);
      }
      row.authorized=true;save(row);service.db.exec('COMMIT');
    }catch(error){service.db.exec('ROLLBACK');throw error;}
  }
  function releasePortalFences(row){
    service.db.exec('BEGIN IMMEDIATE');
    try{service.db.prepare('DELETE FROM dataset_deletion_fences WHERE operation_id=?').run(row.id);save(row);service.db.exec('COMMIT');}
    catch(error){service.db.exec('ROLLBACK');throw error;}
  }
  async function inspect(row,principal,check){
    const view=graph(row);row.inspectionComplete=false;row.graphDigest=view.digest;save(row);
    for(const record of view.records.filter(r=>r.kind==='external'))event(row,externalRetirementAction(record.value),record.value.machine,'RETIRED');
    const listings=new Map();
    for(const host of MACHINES){
      check();const listing=await service.bridge(host.id,'datasets.list',{userId:principal.userId,hostAdmin:principal.role==='admin'});check();
      if(!Array.isArray(listing?.datasets))fail('服务器数据清单未确认。',502);listings.set(host.id,listing.datasets);
    }
    const present=(host,name)=>listings.get(host).some(d=>d.dataset===name&&Array.isArray(d.versions)&&d.versions.some(v=>v.version===row.version));
    // Each present node independently authenticates actual immutable provenance.
    for(const [host,names] of view.refs)for(const name of names)if(present(host,name)){
      await service.confirmDatasetNotDeleting(host,{dataset:name,version:row.version},{userId:principal.userId,hostAdmin:principal.role==='admin'});
      const step=claim(row,host,name);
      step.plan=parsePlan(await rpc(principal,check,host,'plan',{operationId:step.operationId,dataset:name,version:row.version,...(principal.role==='admin'&&row.owner!==principal.userId?{adminContinue:true}:{})}),step,principal);save(row);
    }
    const originals=row.steps.filter(s=>s.plan?.authority);
    if(originals.length>1)fail('多个数据库原件需要管理员核对。');
    const source=originals[0]||row.steps.find(s=>s.plan?.complete);
    if(!source)fail('没有已确认的完整数据，不能安全删除。');
    row.source=source.operationId;save(row);
    const authorization={operationId:source.operationId,machine:source.machine,dataset:source.dataset,version:row.version,
      owners:source.plan.owners,memberAllowed:source.plan.memberAllowed,complete:true,snapshotSha256:source.plan.snapshotSha256};
    const authority=source.plan.authority;
    if(authority){
      if(authority.protocol!=='dataset-authority-dependencies-v1'||authority.sourceMachine!==source.machine||authority.dataset!==source.dataset||authority.version!==row.version||!Array.isArray(authority.grants))fail('数据库依赖计划未确认。',502);
      const references=authority.grants.map(grant=>({sourceMachine:source.machine,sourceDataset:source.dataset,version:row.version,
        targetMachine:machine(grant.targetMachine),grantId:uuid(grant.id),receiptSha256:grant.receiptSha256}));
      if(references.some(ref=>!HASH.test(ref.receiptSha256)))fail('数据库依赖回执未确认。',502);
      for(const host of MACHINES){
        const relevant=references.filter(r=>r.targetMachine===host.id);
        const locations=await rpc(principal,check,host.id,'locations',{version:row.version,references:relevant});
        if(locations?.protocol!==PROTOCOL||locations.machine!==host.id||!Array.isArray(locations.locations))fail('完整依赖位置未确认。',502);
        // One grant can name several physical aliases; conversely a location
        // reply can attest several refs for one name. Collect the entire fixed
        // set before issuing a plan, never a host-wide or partial ref list.
        const aliases=new Map();
        for(const location of locations.locations){
          if(!location||Object.keys(location).sort().join(',')!=='authorityReference,dataset,version'
            ||location.version!==row.version||!relevant.some(r=>same(r,location.authorityReference)))fail('数据库依赖物理名称不匹配。',502);
          reference(location.dataset,row.version);
          const refs=aliases.get(location.dataset)||[];
          if(!refs.some(ref=>same(ref,location.authorityReference)))refs.push(structuredClone(location.authorityReference));
          aliases.set(location.dataset,refs);
        }
        for(const [name,mapped] of aliases){
          // Preserve the fixed source grant order even if a location reply is
          // reordered, so an explicit original-child retry has identical args.
          const refs=relevant.filter(ref=>mapped.some(found=>same(found,ref)));
          view.refs.get(host.id).add(name);const step=claim(row,host.id,name);
          if(step.plan?.absent&&!same(step.plan.authorityReferences,refs))fail('原节点计划的固定依赖已改变。',502);
          if(!step.plan){
            // A present registration authenticates its own immutable local
            // snapshot. Only a certified absence/REMOVAL alias receives the
            // already selected complete source and this physical name's refs.
            const absence=present(host.id,name)?{}:{authorization,references:refs};
            step.plan=parsePlan(await rpc(principal,check,host.id,'plan',{operationId:step.operationId,dataset:name,version:row.version,...absence,
              ...(principal.role==='admin'&&row.owner!==principal.userId?{adminContinue:true}:{})}),step,principal);save(row);
          }
          if(!refs.every(ref=>step.plan.authorityReferences.some(r=>same(r,ref))))fail('数据库依赖未映射到固定物理版本，需管理员核对。');
        }
        for(const ref of relevant)if(!row.steps.some(s=>s.machine===host.id&&s.plan?.authorityReferences.some(r=>same(r,ref))))fail('数据库依赖未映射到固定物理版本，需管理员核对。');
      }
    }
    for(const [host,names] of view.refs)for(const name of names){
      const step=claim(row,host,name);
      if(!step.plan){step.plan=parsePlan(await rpc(principal,check,host,'plan',{operationId:step.operationId,dataset:name,version:row.version,authorization,references:[],...(principal.role==='admin'&&row.owner!==principal.userId?{adminContinue:true}:{})}),step,principal);save(row);}
    }
    if(graph(row).digest!==row.graphDigest)fail('数据依赖在准备期间改变，删除已暂停。');
    row.inspectionComplete=true;save(row);
  }
  function verifyStatus(value,step){
    if(value?.protocol!==PROTOCOL||value.operationId!==step.operationId||value.machine!==step.machine||value.dataset!==step.dataset
      ||value.version!==step.version||value.snapshotSha256!==step.plan.snapshotSha256||!value.phases||Array.isArray(value.phases)
      ||!Array.isArray(value.pendingPhases)||!Array.isArray(value.unconfirmedPhases)
      ||value.runningPhases!==undefined&&!Array.isArray(value.runningPhases))fail('原节点操作状态未确认。',502);
    return value;
  }
  function phaseResult(status,step,phase){
    const result=status.phases[phase];
    if(result?.ok===false)throw Object.assign(Error(refusal(result.error)),{status:409,code:'DATASET_DELETE_PHASE_FAILED',[MAPPED_REFUSAL]:true});
    if(!result)return null;
    if(result.ok!==true)fail('原节点步骤回执未确认。',502);
    const value=result.result;
    if(phase==='fence'){
      if(value?.protocol!=='dataset-version-fence-v1'||value.operationId!==step.operationId||value.machine!==step.machine
        ||value.dataset!==step.dataset||value.version!==step.version||value.snapshotSha256!==step.plan.snapshotSha256
        ||value.state!=='FENCED'||value.drained!==true||!HASH.test(value.generation)||status.state!=='FENCED')fail('持久栅栏和停止写入未确认。',502);
      return structuredClone(value);
    }
    if(phase==='cancel'){
      const keys=['protocol','operationId','machine','dataset','version','snapshotSha256','state','available'];
      if(!value||Object.keys(value).sort().join(',')!==keys.toSorted().join(',')
        ||value.protocol!=='dataset-version-cancel-v1'||value.operationId!==step.operationId||value.machine!==step.machine
        ||value.dataset!==step.dataset||value.version!==step.version||value.snapshotSha256!==step.plan.snapshotSha256
        ||value.state!=='CANCELED'||value.available!==true||status.state!=='CANCELED'||!same(status.result,value))fail('取消删除的恢复回执未确认。',502);
      return structuredClone(value);
    }
    if(phase==='release-absence'&&value?.protocol==='dataset-version-release-v1'){
      const keys=['protocol','operationId','machine','dataset','version','snapshotSha256','generation','state','sourceProofSha256'];
      if(Object.keys(value).sort().join(',')!==keys.toSorted().join(',')||value.operationId!==step.operationId
        ||value.machine!==step.machine||value.dataset!==step.dataset||value.version!==step.version
        ||value.snapshotSha256!==step.plan.snapshotSha256||value.generation!==step.fence?.generation
        ||value.state!=='RELEASED'||value.sourceProofSha256!==sha(step.phaseArguments?.[phase]?.sourceResult)
        ||status.state!=='RELEASED'||!same(status.result,value))fail('清理后名称的源恢复证明未确认。',502);
      return structuredClone(value);
    }
    const receipt=parseReceipt(value,step,['isolate','commit'].includes(phase)?'ISOLATED':'RESTORED');
    // A saved phase result is historical. The node must also confirm its
    // current durable outcome, so a restore/purge cannot replay old isolation.
    if(!same(status.result,receipt))fail('节点当前状态与原步骤回执不一致。',502);
    return receipt;
  }
  const workerActive=status=>status.runningPhases?.length>0||status.pendingPhases.some(phase=>!status.unconfirmedPhases.includes(phase));
  function waiting(row){
    row.state=row.cancelRequested?'CANCELING':'WAITING_CONTINUE';row.waitingWorker=true;
    row.error='节点仍在进行，请等待原工作进程结束。';save(row);return publicTask(row);
  }
  async function waitForWorkers(row,principal,check){
    const idle=()=>{if(running.has(row.id)||restoring.has(row.id)||canceling.has(row.id)||queries.has(row.id))fail('原任务还在运行或查询，请稍后核对。');};
    for(const step of row.steps.filter(s=>s.plan&&s.dispatched.length)){
      let status;
      try{status=verifyStatus(await rpc(principal,check,step.machine,'status',{operationId:step.operationId}),step);}
      catch(error){
        check();idle();Object.assign(row,access(principal,load(row.id)));
        row.state='UNKNOWN';row.error=safeRefusal(error);delete row.waitingWorker;save(row);return true;
      }
      // Reads yield. Another recovery/query must not have its newer journal
      // overwritten by this earlier snapshot, even when a worker is active.
      idle();
      if(workerActive(status)){Object.assign(row,access(principal,load(row.id)));waiting(row);return true;}
    }
    idle();
    Object.assign(row,access(principal,load(row.id)));
    delete row.waitingWorker;return false;
  }
  async function dispatch(row,step,principal,check,phase,args={},allowRetry=false){
    check();if(['fence','isolate'].includes(phase)&&graph(row).digest!==row.graphDigest)fail('数据依赖已改变，删除已暂停。');
    let retryKey;
    if(step.dispatched.includes(phase)&&allowRetry){
      if(principal.role!=='admin')fail('只有管理员可重试原节点阶段。',403);
      const status=verifyStatus(await rpc(principal,check,step.machine,'status',{operationId:step.operationId}),step);
      if(workerActive(status))fail('节点仍在进行，请等待原工作进程结束。',409,'DATASET_DELETE_WORKER_RUNNING');
      const old=status.phases[phase];
      if(!old||old.ok===false){
        if(phase==='restore'&&old?.ok===false&&/retention|expired|保留期/i.test(old.error)){
          // An expired old payload stays refused. Only a current explicit new
          // registration permits retrying its fixed source-check phase; the
          // node still requires complete READY bytes before returning RESTORED.
          let reopened;
          try{reopened=parseNewRegistration(await rpc(principal,check,step.machine,'registration',
            {dataset:step.dataset,version:step.version}),step);}catch{check();}
          if(!reopened)phaseResult(status,step,phase);
          step.reopened=reopened;save(row);
        }
        if(old&&(Object.keys(old).sort().join(',')!=='error,ok'||typeof old.error!=='string'))fail('旧阶段结果损坏；不会重投。',502);
        if(!Array.isArray(status.stoppedPhases)||!status.stoppedPhases.includes(phase)
          ||status.pendingPhases.length)fail('原节点工作进程尚未确认停止；不会重试。',409);
        retryKey=randomUUID();step.attempts??=[];
        step.attempts.push({phase,key:retryKey,requestedBy:principal.userId,time:clock()});
        step.state='DISPATCHING';step.phase=phase;save(row);event(row,'阶段重试（'+phase+'）',step.machine,'DISPATCHING');
      }
    }
    if(!step.dispatched.includes(phase)||retryKey){
      step.phase=phase;step.state='DISPATCHING';if(!retryKey)step.dispatched.push(phase);
      step.phaseArguments??={};
      if(!Object.hasOwn(step.phaseArguments,phase))step.phaseArguments[phase]=structuredClone(args);
      else if(!same(step.phaseArguments[phase],args))fail('原阶段的固定参数不能改变。');
      if(phase==='fence')step.fenceAt=clock();
      save(row);event(row,phase,step.machine,'DISPATCHING');
      const response=await rpc(principal,check,step.machine,phase,{operationId:step.operationId,...args,...(retryKey?{retryKey}:{}),
        ...(['fence','isolate'].includes(phase)&&principal.role==='admin'&&row.owner!==principal.userId?{adminContinue:true}:{})});
      if(response?.protocol!==PROTOCOL||response.operationId!==step.operationId||response.machine!==step.machine||response.action!==phase||response.state!=='DISPATCHED')fail('派发回执未确认，请查询原编号。',502);
    }
    // RUNNING has no wall-clock completion deadline. Lost/stopped/unknown
    // workers remain UNKNOWN; a confirmed phase advances only a new phase.
    while(true){
      check();const status=verifyStatus(await rpc(principal,check,step.machine,'status',{operationId:step.operationId}),step);
      const result=phaseResult(status,step,phase);
        if(result){step.state=phase==='fence'?'FENCED':['isolate','commit'].includes(phase)?'ISOLATED':phase==='cancel'?'CANCELED':result.state==='RELEASED'?'RELEASED':'RESTORED';
        if(phase==='isolate')step.result=result;else if(phase==='fence')step.fence=result;else if(phase==='commit')step.committed=result;else step.restored=result;
        save(row);event(row,phase,step.machine,step.state);return result;}
      if(!status.pendingPhases.includes(phase)||status.unconfirmedPhases.includes(phase))fail('原节点步骤结果未确认；不会自动重投。',504);
      await new Promise(resolve=>setTimeout(resolve,pollMs));
    }
  }
  async function execute(row,principal,check,{allowRetry=false,creator=principal}={}){
    try{
      // Source selection precedes authority-location and negative plans. A
      // saved source is not proof that inspection finished. Explicit continue
      // resumes the same fixed child IDs; already-authorized legacy tasks or
      // dispatched phases keep their original proofs, never a fresh deletion.
      check();if(!row.source||row.inspectionComplete!==true&&!row.authorized&&!row.steps.some(s=>s.dispatched.length))await inspect(row,creator,check);
      claimAuthorized(row,creator);
      const source=row.steps.find(s=>s.operationId===row.source);
      if(!source.fence&&!source.result)await dispatch(row,source,principal,check,'fence',{},allowRetry);
      for(const step of row.steps)if(step!==source&&!step.fence&&!step.result)await dispatch(row,step,principal,check,'fence',{},allowRetry);
      row.state='REMOVING_CACHES';save(row);
      for(const step of row.steps)if(step!==source)await dispatch(row,step,principal,check,'isolate',{targets:[]},allowRetry);
      row.state='RETIRING_ORIGINAL';save(row);
      await dispatch(row,source,principal,check,'isolate',source.phaseArguments?.isolate||{targets:row.steps.filter(s=>s!==source).map(s=>s.result)},allowRetry);
      // Recheck every durable outcome before claiming overall completion. A
      // local admin restore or an unavailable node is never cached success.
      for(const step of row.steps){
        const status=verifyStatus(await rpc(principal,check,step.machine,'status',{operationId:step.operationId}),step);
        step.result=phaseResult(status,step,'isolate');
      }
      check();if(row.steps.some(s=>!s.result))fail('还有服务器未确认完整隔离。',502);
      // Only a fully isolated original authorizes expiry of any child.
      // Partial/unknown parent tasks otherwise retain every full payload.
      for(const step of row.steps)await dispatch(row,step,principal,check,'commit',step.phaseArguments?.commit||{sourceResult:source.result},allowRetry);
      delete row.error;row.state='DELETED';row.retainUntil=Math.min(...row.steps.filter(s=>s.plan.complete).map(s=>s.result.retainUntil));save(row);event(row,'版本数据隔离完成',null,'DELETED');
    }catch(error){
      if(service.closing||error.code==='DATASET_DELETE_CANCELED')return; // cancel owns the durable journal
      const latest=load(row.id);if(latest?.cancelRequested)return;
      if(error.code==='DATASET_DELETE_WORKER_RUNNING'){waiting(row);return;}
      row.state=error.status===403||error.status===409||error.code==='MAINTENANCE_ACTIVE'?'BLOCKED':'UNKNOWN';
      row.error=row.state==='BLOCKED'?safeRefusal(error):'删除结果未确认；仅查询原编号，不会重新执行。';
      if(error.status===403&&!row.authorized)row.authorizationDenied=true;
      const step=row.steps.findLast(s=>s.state==='DISPATCHING');if(step)step.error=safeRefusal(error);
      if(!row.steps.some(s=>s.dispatched.length))releasePortalFences(row);
      save(row);event(row,'停止推进',null,row.state);
    }
  }
  async function observe(row,principal,check){
    // Read only on nodes. Confirm a late receipt without starting later steps,
    // including after a Portal restart, logout or a lost initial response.
    let confirmed=true,inProgress=false,uncertain=false,blocked=false;
    for(const step of row.steps){
      if(!step.plan){
        confirmed=false;
        try{
          const status=await rpc(principal,check,step.machine,'status',{operationId:step.operationId});
          const plan=Object.fromEntries(planFields.map(field=>[field,status?.[field]]));
          step.plan=parsePlan(plan,step,principal);save(row);
        }catch{check();}
        continue; // recover the plan receipt only, never start a new phase
      }
      if(!step.dispatched.length){confirmed=false;continue;}
      const phase=step.dispatched.at(-1);
      try{
        const status=verifyStatus(await rpc(principal,check,step.machine,'status',{operationId:step.operationId}),step);
        inProgress||=workerActive(status);
        if(workerActive(status)&&status.phases[phase]?.ok!==true){
          confirmed=false;inProgress=true;step.state='RUNNING';step.error='节点正在处理。';save(row);continue;
        }
        // A local administrator may have restored a confirmed copy through
        // the node CLI. Observe that proof without dispatching any new writes.
        if(['isolate','commit'].includes(phase)&&['RESTORED','PURGED'].includes(status.result?.state)){
          const result=parseReceipt(status.result,step,status.result.state);
          if(result.state==='RESTORED'){step.restored=result;step.restoreState='RESTORED';step.state='RESTORED';
            service.db.prepare('DELETE FROM dataset_deletion_fences WHERE machine=? AND dataset=? AND version=? AND operation_id=?').run(step.machine,step.dataset,row.version,row.id);
          }else{
            if(clock()<result.retainUntil*1000)fail('节点清理期限未确认。',502);
            step.result=result;step.state='PURGED';
          }
          delete step.error;save(row);continue;
        }
        const result=phaseResult(status,step,phase);
        if(result){if(['isolate','commit'].includes(phase)){step.result=result;if(phase==='commit')step.committed=result;}else if(phase==='cancel'){step.restored=result;step.state='CANCELED';}else if(phase==='restore'||phase==='release-absence'){step.restored=result;step.restoreState=result.state==='RELEASED'?'RELEASED':'RESTORED';}
          else step.fence=result;step.state=phase==='cancel'?'CANCELED':phase==='fence'?'FENCED':['isolate','commit'].includes(phase)?'ISOLATED':result.state==='RELEASED'?'RELEASED':'RESTORED';
          if(step.restored)service.db.prepare('DELETE FROM dataset_deletion_fences WHERE machine=? AND dataset=? AND version=? AND operation_id=?').run(step.machine,step.dataset,row.version,row.id);
          delete step.error;save(row);
        }else{confirmed=false;
          const pending=status.pendingPhases.includes(phase)&&!status.unconfirmedPhases.includes(phase);inProgress||=pending;uncertain||=!pending;
          step.state=pending?'RUNNING':'UNKNOWN';step.error=pending?'节点正在处理。':'原节点结果未确认；不会重投。';save(row);}
      }catch(error){check();confirmed=false;
        const definite=error.code==='DATASET_DELETE_PHASE_FAILED';blocked||=definite&&['fence','isolate','commit'].includes(phase);uncertain||=!definite;
        step.state=definite?['fence','isolate','commit'].includes(phase)?'BLOCKED':'FAILED':'UNKNOWN';
        if(['restore','release-absence'].includes(phase))step.restoreState=step.state;step.error=safeRefusal(error);save(row);}
    }
    if(row.cancelRequested){
      if(row.steps.every(s=>!s.dispatched.length||s.state==='CANCELED')){row.state='CANCELED';releasePortalFences(row);delete row.error;}
      else if(row.steps.some(s=>s.state==='FAILED')){row.state='FAILED';row.error=row.steps.find(s=>s.state==='FAILED').error;}
      save(row);
    }else if(blocked){row.state='BLOCKED';row.error=row.steps.find(s=>s.state==='BLOCKED').error;save(row);
    }else if(row.steps.some(s=>s.restoreState==='FAILED')){
      row.state='FAILED';row.error=row.steps.find(s=>s.restoreState==='FAILED').error;save(row);
    }else if(row.steps.some(s=>s.restored||s.restoreState)){
      row.state='BLOCKED';row.error='管理员已请求恢复；旧删除编号不可重新执行。';save(row);
    }else if(confirmed&&row.steps.length&&row.steps.every(s=>s.result&&s.committed&&['ISOLATED','PURGED'].includes(s.state))){
      delete row.error;row.state='DELETED';row.retainUntil=Math.min(...row.steps.filter(s=>s.plan.complete).map(s=>s.result.retainUntil));delete row.error;save(row);
    }else if(inProgress&&!uncertain||confirmed&&row.steps.length&&row.steps.every(s=>s.result&&s.state==='ISOLATED')){
      row.state=running.has(row.id)?'RUNNING':'WAITING_CONTINUE';delete row.error;save(row);
    }else if(!confirmed&&row.steps.some(s=>s.result)){
      row.state='UNKNOWN';row.error='节点当前结果未确认；仅查询原编号，不会重新执行。';save(row);
    }
    row.waitingWorker=inProgress;
    if(!row.cancelRequested&&(restarted.has(row.id)||row.state==='WAITING_CONTINUE')&&!['DELETED','CANCELED','BLOCKED','FAILED','UNKNOWN'].includes(row.state)){
      row.state='WAITING_CONTINUE';row.error=inProgress?'节点仍在进行，请等待原工作进程结束。':restarted.has(row.id)?'等待继续（门户已重启），请由管理员继续或取消删除。':'等待继续，请由管理员继续或取消删除。';save(row);
    }
    return publicTask(row);
  }
  service.datasetDeletionCall=async(principal,operation,args,assertCurrent=()=>{})=>{
    assertCurrent();
    const user=account(service,principal),policy=authorizationPolicy(user),inventory=sha(MACHINES.map(m=>m.id));
    if(operation==='datasets.delete'){
      fields(args,['dataset','version','key']);reference(args.dataset,args.version);uuid(args.key);
      let row=byKey(args.key);
      if(row){access(principal,row);if(row.owner!==principal.userId||row.dataset!==args.dataset||row.version!==args.version)fail('这个请求编号属于另一个删除任务。');return publicTask(row);}
      const precheck=checkFactory(principal,assertCurrent,policy,inventory,null);
      precheck();await capabilities(principal,precheck);precheck();
      if(byKey(args.key))return service.datasetDeletionCall(principal,operation,args,assertCurrent);
      row={id:randomUUID(),key:args.key,owner:principal.userId,username:principal.username,role:principal.role,dataset:args.dataset,version:args.version,
        state:'PLANNED',createdAt:clock(),updatedAt:clock(),steps:[],events:[],source:null,graphDigest:null};
      service.db.exec('BEGIN IMMEDIATE');
      try{service.db.prepare('INSERT INTO dataset_deletions VALUES(?,?,?,?,?,?)').run(row.id,row.key,row.owner,row.dataset,row.version,JSON.stringify(row));
        for(const host of MACHINES)claim(row,host.id,row.dataset,true);
        service.audit(principal.username,operation,row.id,row.dataset+'@'+row.version);service.db.exec('COMMIT');
      }catch(error){service.db.exec('ROLLBACK');throw error;}
      const check=checkFactory(principal,assertCurrent,policy,inventory,row);
      const task=Promise.resolve().then(()=>execute(row,principal,check)).finally(()=>running.delete(row.id));running.set(row.id,task);
      return publicTask(row);
    }
    if(operation==='datasets.delete.status'){
      fields(args,['key','operationId']);if(Object.keys(args).length!==1)fail('用 key 或 operationId 查询一个删除任务。',400);
      const row=access(principal,args.key?byKey(uuid(args.key)):load(uuid(args.operationId)));
      if(row.state==='CANCELED'){releasePortalFences(row);return publicTask(row);}
      const check=checkFactory(principal,assertCurrent,policy,inventory,row,true);check();
      if(running.has(row.id)||restoring.has(row.id)||canceling.has(row.id))return publicTask(row);
      if(queries.has(row.id))return queries.get(row.id).then(()=>{check();return publicTask(access(principal,load(row.id)));});
      const query=observe(row,principal,check).finally(()=>queries.delete(row.id));queries.set(row.id,query);return query;
    }
    if(operation==='datasets.delete.registration.discard'){
      fields(args,['operationId','machine','dataset','key']);uuid(args.operationId);machine(args.machine);uuid(args.key);
      if(principal.role!=='admin')fail('只有管理员可丢弃从未安装的登记意图。',403);
      let row=access(principal,load(args.operationId));
      if(args.dataset!==undefined)reference(args.dataset,row.version);
      const check=checkFactory(principal,assertCurrent,policy,inventory,row);check();
      await capabilities(principal,check);check();row=access(principal,load(args.operationId));
      if(running.has(row.id)||restoring.has(row.id)||canceling.has(row.id)||queries.has(row.id))fail('原任务还在运行或查询，请稍后核对。');
      const targets=row.steps.filter(s=>s.machine===args.machine&&s.dataset===(args.dataset??row.dataset));
      if(targets.length!==1||!targets[0].fence)fail('此服务器的固定删除代次未确认。');
      const step=targets[0],binding={key:args.key,machine:step.machine,dataset:step.dataset,requestedBy:principal.userId};
      row.registrationDiscards??=[];
      let intent=row.registrationDiscards.find(value=>value.key===args.key);
      if(intent&&Object.keys(binding).some(key=>intent[key]!==binding[key]))fail('这个丢弃请求编号属于另一个固定登记意图。');
      if(intent?.state==='DISCARDED')return structuredClone(intent.result);
      if(!intent){intent={...binding,state:'PREPARED'};row.registrationDiscards.push(intent);save(row);}
      // Both the fixed key and its audit are durable before the metadata-only
      // RPC. A lost reply is repeated only by an explicit same-key command.
      event(row,'丢弃未安装登记意图',step.machine,'PREPARED');
      const task=Promise.resolve().then(async()=>{
        try{
          const value=await rpc(principal,check,step.machine,'registration-discard',{operationId:step.operationId,requestKey:args.key});
          const keys=['protocol','operationId','requestKey','machine','dataset','version','generation','state'];
          if(!value||Object.keys(value).sort().join(',')!==keys.toSorted().join(',')
            ||value.protocol!=='dataset-registration-discard-v1'||value.operationId!==step.operationId||value.requestKey!==args.key
            ||value.machine!==step.machine||value.dataset!==step.dataset||value.version!==row.version
            ||value.generation!==step.fence.generation||value.state!=='DISCARDED')fail('丢弃登记意图的回执未确认。',502);
          intent.state='DISCARDED';intent.result={...structuredClone(value),operationId:row.id,key:args.key};
          save(row);event(row,'丢弃未安装登记意图',step.machine,'DISCARDED');return structuredClone(intent.result);
        }catch(error){
          check();intent.state=error.status===403||error.status===409?'FAILED':'UNKNOWN';intent.error=safeRefusal(error);save(row);
          event(row,'丢弃登记意图待核对',step.machine,intent.state);
          return {operationId:row.id,key:args.key,machine:step.machine,dataset:step.dataset,version:row.version,state:intent.state,error:intent.error};
        }
      }).finally(()=>restoring.delete(row.id));
      restoring.set(row.id,task);return task;
    }
    if(['datasets.delete.continue','datasets.delete.cancel'].includes(operation)){
      fields(args,['operationId']);uuid(args.operationId);
      if(principal.role!=='admin')fail('只有管理员可继续或取消删除。',403);
      let row=access(principal,load(args.operationId));
      if(row.state==='CANCELED'){releasePortalFences(row);return publicTask(row);}
      const isCancel=operation.endsWith('.cancel');
      if(!isCancel&&(row.cancelRequested||row.steps.some(s=>s.restored||s.restoreState||s.reopened)))fail('恢复、取消或重新登记过的任务不可继续删除。');
      if(operation==='datasets.delete.continue'&&row.state==='DELETED')return publicTask(row);
      if(restoring.has(row.id)||queries.has(row.id)||canceling.has(row.id)||!isCancel&&running.has(row.id))fail('原任务还在运行或查询。');
      const adminCheck=checkFactory(principal,assertCurrent,policy,inventory,row,false,isCancel);
      const creator={userId:row.owner,username:row.username,role:row.role};
      if(!isCancel&&(row.authorizationDenied||row.steps.some(s=>s.plan&&creator.role!=='admin'&&(!s.plan.memberAllowed||!same(s.plan.owners,[creator.userId])))))
        fail('原发起人无权删除这份数据；管理员需新建自己的删除任务。',403);
      const creatorCheck=isCancel?()=>{}:checkFactory(creator,()=>{},authorizationPolicy(account(service,creator)),inventory,row);
      const check=()=>{adminCheck();creatorCheck();};check();
      await capabilities(principal,check);check();row=access(principal,load(args.operationId));
      if(restoring.has(row.id)||queries.has(row.id)||canceling.has(row.id)||!isCancel&&running.has(row.id))fail('原任务还在运行或查询。');
      service.audit(principal.username,operation,row.id,isCancel?'CANCEL_REQUESTED':'CONTINUE_REQUESTED');
      if(!isCancel){
        if(await waitForWorkers(row,principal,check))return publicTask(row);
        // A resumed inspection can outlive its HTTP response. Persist the new
        // attempt before launching it: an earlier UNKNOWN is not its outcome,
        // and callers must keep the current session while this work is active.
        check();row.state='RUNNING';delete row.error;save(row);
        restarted.delete(row.id);
        const task=(async()=>{try{await observe(row,principal,check);check();
          if(row.state!=='DELETED')await execute(row,principal,check,{allowRetry:true,creator});
          }catch(error){if(!service.closing&&!load(row.id)?.cancelRequested){row.state='UNKNOWN';row.error=safeRefusal(error);save(row);}}})().finally(()=>running.delete(row.id));
        running.set(row.id,task);return publicTask(row);
      }
      row.cancelRequested={userId:principal.userId,time:clock()};row.state='CANCELING';save(row);
      const task=(async()=>{
        try{
          await running.get(row.id);row=access(principal,load(row.id));check();
          // Drain every original worker before restoring. No kill, guessed
          // absence or replay of an uncertain launch is accepted.
          for(const step of row.steps.filter(s=>s.plan&&s.dispatched.length))while(true){
            const status=verifyStatus(await rpc(principal,check,step.machine,'status',{operationId:step.operationId}),step);
            if(status.pendingPhases.length||workerActive(status)){await new Promise(resolve=>setTimeout(resolve,pollMs));continue;}
            // Executor independently requires STOPPED for every original
            // worker before cancellation; missing files alone are no proof.
            break;
          }
          const source=row.steps.find(s=>s.operationId===row.source),ordered=[...(source?[source]:[]),...row.steps.filter(s=>s!==source)];
          for(const step of ordered){
            if(!step.plan||!step.dispatched.length){step.state='CANCELED';continue;}
            await dispatch(row,step,principal,check,'cancel',{},true);
            service.db.prepare('DELETE FROM dataset_deletion_fences WHERE machine=? AND dataset=? AND version=? AND operation_id=?').run(step.machine,step.dataset,row.version,row.id);
          }
          row.state='CANCELED';delete row.error;releasePortalFences(row);event(row,'取消删除并恢复',null,'CANCELED');
        }catch(error){if(!service.closing){row.state=error.code==='DATASET_DELETE_PHASE_FAILED'?'FAILED':'UNKNOWN';row.error=safeRefusal(error);save(row);event(row,'取消待核对',null,row.state);}}
      })().finally(()=>canceling.delete(row.id));canceling.set(row.id,task);return publicTask(row);
    }
    if(operation==='datasets.delete.restore'){
      fields(args,['operationId','machine']);uuid(args.operationId);machine(args.machine);
      if(principal.role!=='admin')fail('只有管理员可在保留期内恢复。',403);
      let row=access(principal,load(args.operationId));
      if(running.has(row.id)||restoring.has(row.id)||canceling.has(row.id)||queries.has(row.id))fail('原任务还在运行或查询，请稍后核对。');
      const check=checkFactory(principal,assertCurrent,policy,inventory,row);check();
      // Restore may also release source-authorized negative namespaces. Every
      // node must still confirm v1 before any restore/release write is accepted.
      await capabilities(principal,check);check();
      // Capability reads yield: reload the journal and recheck in-flight work
      // so concurrent restore/status calls cannot reuse an earlier snapshot.
      row=access(principal,load(args.operationId));
      if(await waitForWorkers(row,principal,check))return {...publicTask(row),machine:args.machine};
      const step=row.steps.find(s=>s.machine===args.machine&&s.result?.complete);
      if(!step||row.steps.filter(s=>s.machine===args.machine&&s.result?.complete).length!==1)fail('此服务器的完整保留副本未确认或名称不唯一，请先核对删除任务。');
      if(running.has(row.id)||restoring.has(row.id)||canceling.has(row.id)||queries.has(row.id))fail('原任务还在运行或查询，请稍后核对。');
      // A restored source may still have incomplete peer recovery. Repeated
      // explicit restore continues that fixed tree, never returns early.
      if(step.restored&&step.operationId!==row.source)return {operationId:row.id,machine:step.machine,state:'RESTORED',version:row.version};
      step.restoreState='DISPATCHING';save(row);
      const task=(async()=>{
        try{
          if(!step.restored)await dispatch(row,step,principal,check,'restore',{},true);
          else{
            const status=verifyStatus(await rpc(principal,check,step.machine,'status',{operationId:step.operationId}),step);
            step.restored=parseReceipt(status.result,step,'RESTORED');
          }
          service.db.prepare('DELETE FROM dataset_deletion_fences WHERE machine=? AND dataset=? AND version=? AND operation_id=?').run(step.machine,step.dataset,row.version,row.id);
          if(step.operationId===row.source)for(const peer of row.steps.filter(s=>s!==step&&s.plan&&s.result&&!s.restored)){
            const status=verifyStatus(await rpc(principal,check,peer.machine,'status',{operationId:peer.operationId}),peer);
            const release=peer.plan.absent||status.result?.state==='PURGED'||status.state==='RELEASED'
              ||peer.dispatched.includes('release-absence')
              ||status.phases.restore?.ok===false&&/retention|expired|保留期/i.test(status.phases.restore.error)
              ||status.result?.retainUntil*1000<=clock()+300000;
            try{
              await dispatch(row,peer,principal,check,release?'release-absence':'restore',release?{sourceResult:step.restored}:{},true);
              peer.restoreState=peer.restored.state==='RELEASED'?'RELEASED':'RESTORED';
              peer.state=peer.restoreState;delete peer.error;
              service.db.prepare('DELETE FROM dataset_deletion_fences WHERE machine=? AND dataset=? AND version=? AND operation_id=?').run(peer.machine,peer.dataset,row.version,row.id);
            }catch(error){peer.restoreState=error.code==='DATASET_DELETE_PHASE_FAILED'?'FAILED':'UNKNOWN';peer.error=safeRefusal(error);save(row);throw error;}
          }
          delete row.restoreState;row.state='BLOCKED';row.error='管理员已恢复数据和全部名称；旧删除编号不可重新执行。';save(row);
          service.audit(principal.username,operation,row.id,JSON.stringify({machine:step.machine,state:'RESTORED'}));
        }catch(error){if(!service.closing){if(error.code==='DATASET_DELETE_WORKER_RUNNING'){delete step.restoreState;waiting(row);return;}
          row.restoreState=error.code==='DATASET_DELETE_PHASE_FAILED'?'FAILED':'UNKNOWN';row.error=safeRefusal(error);
          if(!step.restored){step.restoreState=row.restoreState;step.error=row.error;}save(row);}}
      })().finally(()=>restoring.delete(row.id));restoring.set(row.id,task);await task;check();
      return {operationId:row.id,machine:step.machine,state:row.restoreState|| (step.restored?'RESTORED':step.restoreState||'UNKNOWN'),...(row.restoreState?{error:row.error}:step.error?{error:step.error}:{}),dataset:step.dataset,version:row.version,...(principal.role==='admin'&&row.owner!==principal.userId?{adminContinue:true}:{})};
    }
    fail('未知数据删除操作。',400);
  };
  // Awaitable for shutdown/tests; never scans/restarts historical tasks.
  service.waitDatasetDeletions=()=>Promise.allSettled([...running.values(),...restoring.values(),...canceling.values()]);
  service.datasetDeleteCapabilities=async principal=>{
    const value=account(service,principal),policy=authorizationPolicy(value),inventory=sha(MACHINES.map(m=>m.id));
    try{await capabilities(principal,checkFactory(principal,()=>{},policy,inventory,null,true),{cached:true});return {datasetDelete:1};}
    catch{return {datasetDelete:0};}
  };
}
