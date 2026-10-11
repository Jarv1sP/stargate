import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {authorizationPolicy,MACHINES} from './dist/model.js';

// Durable control-plane orchestration only. Data bytes use the existing node
// transfer service. Private authority grants are never saved in portal rows.
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const USER=/^(builtin-admin|demo-user-[0-9]+)$/;
const key=(...parts)=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const fail=(message,status)=>{throw Object.assign(Error(message),status===undefined?{}:{status});};
const isRef=value=>value&&ID.test(value.dataset)&&HASH.test(value.version);
const safePhase=new Set(['QUEUED','COPYING','PROVISIONING','CERTIFYING','ARCHIVED','BLOCKED','FAILED']);

export function storageArchivePolicy(input){
  if(input==null)return {enabled:false};
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['enabled','machine','authority'].includes(k))||typeof input.enabled!=='boolean')fail('Invalid trusted archive policy');
  if(!input.enabled)return {enabled:false};
  if(!MACHINES.some(m=>m.id===input.machine)||!ID.test(input.authority))fail('Unknown trusted archive machine or authority');
  return {enabled:true,machine:input.machine,authority:input.authority};
}

export async function loadStorageArchivePolicy(path){
  if(!path)return {enabled:false};
  const raw=await readFile(path,'utf8');
  if(Buffer.byteLength(raw)>4096)fail('Archive configuration is too large');
  return storageArchivePolicy(JSON.parse(raw));
}

export function installStorageArchive(service,input,{clock=Date.now,startTimer=true}={}){
  const policy=storageArchivePolicy(input);
  service.storageArchivePolicy=Object.freeze(policy);
  service.db.exec('CREATE TABLE IF NOT EXISTS storage_archives (id TEXT PRIMARY KEY, owner TEXT NOT NULL, machine TEXT NOT NULL, data TEXT NOT NULL)');
  service.db.exec('CREATE TABLE IF NOT EXISTS storage_archive_lane (singleton INTEGER PRIMARY KEY CHECK(singleton=1), archive_id TEXT NOT NULL)');
  const policyKey=key(policy);
  let reconciling=false;
  const retiring=new Map();
  const load=id=>{const row=service.db.prepare('SELECT data FROM storage_archives WHERE id=?').get(id);return row?JSON.parse(row.data):null;};
  const rows=()=>service.db.prepare('SELECT data FROM storage_archives ORDER BY rowid').all().map(row=>JSON.parse(row.data));
  const save=row=>{
    if(service.closing)fail('Archive service is closing');
    // Copy only our defined journal fields. A grant/token/source ticket cannot
    // accidentally enter durable state through a spread of a remote response.
    const allowed=['id','kind','owner','machine','dataset','version','eventId','sourceMachine','sourceDataset','logicalDataset','phase','copyKey','transferId','grantId','certifyId','createdAt','updatedAt','nextCheckAt','failures','error','receiptSha256','eventAcknowledged','policyKey','retryRequested','transferState','failureStage','enrollment','retirement','retirementIntent','ingressBinding'];
    if(Object.keys(row).some(k=>!allowed.includes(k))||!safePhase.has(row.phase))fail('Invalid archive journal');
    row.updatedAt=clock();
    service.db.prepare('INSERT INTO storage_archives(id,owner,machine,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(row.id,row.owner,row.machine,JSON.stringify(row));
  };
  const laneOwner=()=>service.db.prepare('SELECT archive_id FROM storage_archive_lane WHERE singleton=1').get()?.archive_id;
  const holdLane=row=>{
    // Serialize admission against control-only cancellation across SQLite
    // connections too. A stale worker paused after its earlier fence cannot
    // acquire a lane or resurrect the journal after a cancellation commit.
    service.db.exec('BEGIN IMMEDIATE');
    try{
      fence(row);
      service.db.prepare('INSERT OR IGNORE INTO storage_archive_lane(singleton,archive_id) VALUES(1,?)').run(row.id);
      const held=laneOwner()===row.id;service.db.exec('COMMIT');return held;
    }catch(error){service.db.exec('ROLLBACK');throw error;}
  };
  const releaseLane=row=>service.db.prepare('DELETE FROM storage_archive_lane WHERE singleton=1 AND archive_id=?').run(row.id);
  const boundIngress=row=>Boolean(row?.ingressBinding&&row.policyKey===row.ingressBinding.policyKey&&
    row.sourceMachine===row.ingressBinding.machine&&service.datasetIngressArchiveBindingValid?.(
      row.owner,row.ingressBinding,{dataset:row.sourceDataset,version:row.version}));
  const currentPolicy=row=>row?.ingressBinding!==undefined?boundIngress(row):row.policyKey===policyKey&&row.sourceMachine===policy.machine;
  const sourcePolicy=row=>row.ingressBinding?{enabled:true,machine:row.sourceMachine,authority:row.ingressBinding.authority}:policy;
  const sourceContext=row=>row.ingressBinding?{sourcePolicy:sourcePolicy(row)}:{};
  // A machine cutover changes dispatch, not a certified record's authority.
  // Only canonical journals under this same trusted authority are readable;
  // changing authority or disabling the policy never imports old records.
  const trustedHistory=row=>policy.enabled&&row&&HASH.test(row.id||'')&&USER.test(row.owner||'')&&isRef(row)&&
    ['ingest','enrollment','replica'].includes(row.kind)&&MACHINES.some(m=>m.id===row.machine)&&
    MACHINES.some(m=>m.id===row.sourceMachine)&&
    (row.ingressBinding!==undefined?boundIngress(row):row.policyKey===key({enabled:true,machine:row.sourceMachine,authority:policy.authority}));
  const archiveIdentity=row=>row&&key(row.id,row.kind,row.owner,row.machine,row.dataset,row.version,row.eventId,
    row.sourceMachine,row.sourceDataset,row.logicalDataset,row.policyKey,row.copyKey,row.transferId,row.grantId,row.certifyId,row.receiptSha256,
    row.phase,row.eventAcknowledged,...(row.ingressBinding?[row.ingressBinding]:[]));
  const isCopyIntent=row=>['ingest','enrollment'].includes(row?.kind);
  const isRetired=row=>['retired','authority-retired'].includes(row?.failureStage);
  const availableArchive=row=>trustedHistory(row)&&ID.test(row.sourceDataset||'')&&row.phase==='ARCHIVED'&&!row.retirementIntent&&!isRetired(row)
    &&!service.datasetDeletionBlocked?.(row.sourceMachine,{dataset:row.sourceDataset,version:row.version});
  const availableCurrentArchive=row=>currentPolicy(row)&&availableArchive(row);
  const enrollmentProof=(value,machine,owner,ref)=>{
    if(!value||Object.keys(value).sort().join(',')!=='dataset,machine,manifestBytes,manifestSha256,protocol,registration,role,state,userId,version'||
      value.protocol!==1||value.machine!==machine||value.userId!==owner||value.dataset!==ref.dataset||value.version!==ref.version||
      value.state!=='READY'||value.role!=='protected'||value.manifestSha256!==ref.version||
      !HASH.test(value.registration||'')||!Number.isSafeInteger(value.manifestBytes)||value.manifestBytes<1||value.manifestBytes>64*1024**2)
      fail('Existing original or replica is not confirmed; no enrollment was created.');
    return value;
  };
  const grantIdentity=row=>{
    if(!ID.test(row.sourceDataset||''))fail('Archive source identity is not confirmed');
    const value=key(row.owner,row.sourceMachine,row.sourceDataset,row.version,row.machine);
    // This is an idempotency identity, never the secret authority token.
    return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`;
  };
  const enabledUser=(owner,machine,ref)=>{
    const user=service.store.get(owner);
    if(!user?.enabled||(!user.limits?.[machine]&&!service.datasetIngressSourceAllowed?.(owner,machine,ref)))fail('Archive owner or ingest-machine permission changed');
    return user;
  };
  const fence=(row,snapshot)=>{
    service.assertDatasetNotDeleting?.(row.machine,{dataset:row.dataset,version:row.version});
    service.assertDatasetNotDeleting?.(row.sourceMachine,{dataset:row.sourceDataset,version:row.version});
    const current=load(row.id);
    if(retiring.has(row.id)||current?.retirementIntent||isRetired(current))fail('Archive retirement fences this old intent');
    if(service.closing||!policy.enabled)fail('Archive service is unavailable');
    service.assertMaintenanceAllowed?.('storage.archive.advance',{machine:row.machine,from:row.sourceMachine});
    if(!currentPolicy(row))fail('Archive policy changed; existing intent requires administrator review');
    const user=enabledUser(row.owner,row.machine,{dataset:row.dataset,version:row.version});
    if(snapshot!==undefined&&authorizationPolicy(user)!==snapshot)fail('Archive owner policy changed during operation');
    return authorizationPolicy(user);
  };
  const call=async(row,snapshot,machine,operation,args)=>{
    fence(row,snapshot);
    try{return await service.bridge(machine,operation,args);}
    finally{fence(row,snapshot);}
  };
  const publicRow=row=>row?{
    dataset:row.logicalDataset||row.dataset,version:row.version,phase:row.phase,
    archiveMachine:row.sourceMachine,localMachine:row.machine,
    originalRetained:availableArchive(row),
    ...(row.retirementIntent?{retirement:{state:row.retirementIntent.state||'FENCING'}}:{}),
    ...(row.error?{error:row.error}:{}),
  }:null;

  service.archiveState=(owner,machine,ref)=>publicRow(rows().findLast(row=>row.owner===owner&&row.machine===machine&&(row.dataset===ref.dataset||row.logicalDataset===ref.dataset)&&row.version===ref.version));
  service.archiveSourceAllowed=(owner,machine,ref)=>isRef(ref)&&rows().some(row=>availableArchive(row)&&row.owner===owner&&row.sourceMachine===machine&&row.sourceDataset===ref.dataset&&row.version===ref.version);
  service.archiveOriginalForCopy=(owner,machine,ref)=>{
    if(!isRef(ref))return null;
    const origins=new Map(rows().filter(row=>availableArchive(row)&&row.owner===owner&&row.version===ref.version&&
      (row.machine===machine&&row.dataset===ref.dataset||row.sourceMachine===machine&&row.sourceDataset===ref.dataset))
      .map(row=>{const value={machine:row.sourceMachine,dataset:row.sourceDataset,version:row.version};return [key(value),value];}));
    if(origins.size>1)fail('固定数据副本对应多个仓库来源，请管理员核对；未选择其他来源。');
    return origins.values().next().value||null;
  };
  service.archiveMachineVisible=(owner,machine)=>rows().some(row=>availableArchive(row)&&row.owner===owner&&row.sourceMachine===machine);
  service.archiveAliases=(owner,machine=policy.machine)=>new Map(rows().filter(row=>availableArchive(row)&&row.owner===owner&&row.sourceMachine===machine).map(row=>[row.sourceDataset+'@'+row.version,row.logicalDataset||row.dataset]));
  service.archiveIntentAllowed=(owner,args)=>{
    if(!policy.enabled||args.kind!=='copy'||args.from===args.machine||!UUID.test(args.key||'')||!isRef(args))return false;
    const row=rows().find(row=>row.owner===owner&&row.machine===args.from&&row.dataset===args.dataset&&row.version===args.version&&row.copyKey===args.key);
    return isCopyIntent(row)&&args.machine===row.sourceMachine&&!row.retirementIntent&&row.failureStage!=='retired'&&!retiring.has(row.id)&&currentPolicy(row)&&row.owner===owner&&row.copyKey===args.key&&args.name==='archive-'+key(owner,args.from,args.dataset).slice(0,24);
  };

  function enqueueEvent(machine,event){
    if(!policy.enabled||!MACHINES.some(m=>m.id===machine)||!event||event.state!=='READY'||!UUID.test(event.id)||!USER.test(event.userId)||!isRef(event))fail('Invalid immutable archive event');
    // A re-registration of the same content is a new immutable event. Keep
    // the older receipt for recovery; never silently reuse its target identity.
    const id=key(event.userId,machine,event.dataset,event.version,event.id),old=load(id);
    if(old){
      if(old.kind!=='ingest')fail('Archive intent identity conflict');
      return old;
    }
    const ingressBinding=service.datasetIngressArchiveEventBinding?.(machine,event);
    enabledUser(event.userId,machine,{dataset:event.dataset,version:event.version});
    if(rows().length>=10000)fail('Archive history limit reached');
    const source=ingressBinding?{machine:ingressBinding.machine,authority:ingressBinding.authority}:policy;
    const archived=rows().findLast(row=>availableCurrentArchive(row)&&row.owner===event.userId&&row.machine===machine&&row.dataset===event.dataset&&row.version===event.version);
    const sourceDataset=machine===source.machine?event.dataset:archived?.sourceDataset||null;
    const now=clock(),row={id,kind:'ingest',owner:event.userId,machine,dataset:event.dataset,version:event.version,eventId:event.id,
      logicalDataset:event.dataset,sourceMachine:source.machine,sourceDataset,
      phase:sourceDataset?'PROVISIONING':'QUEUED',copyKey:randomUUID(),transferId:null,grantId:null,certifyId:randomUUID(),
      createdAt:now,updatedAt:now,nextCheckAt:now,failures:0,eventAcknowledged:false,
      policyKey:ingressBinding?.policyKey||policyKey,...(ingressBinding?{ingressBinding}: {})};
    if(sourceDataset)row.grantId=grantIdentity(row);
    save(row);return row;
  }

  service.enqueueArchiveReplica=(owner,machine,logicalRef,physicalRef,fixedSource)=>{
    if(!policy.enabled)return null;
    if(!isRef(logicalRef)||!isRef(physicalRef)||logicalRef.version!==physicalRef.version)fail('Invalid fixed archive replica');
    enabledUser(owner,machine);
    if(fixedSource!==undefined&&(!fixedSource||Object.keys(fixedSource).sort().join(',')!=='dataset,machine'||
      !MACHINES.some(m=>m.id===fixedSource.machine)||!ID.test(fixedSource.dataset)))fail('Invalid fixed replica source');
    const source=rows().findLast(row=>availableCurrentArchive(row)&&row.owner===owner&&(row.logicalDataset||row.dataset)===logicalRef.dataset&&row.version===logicalRef.version&&
      (!fixedSource||row.sourceMachine===fixedSource.machine&&row.sourceDataset===fixedSource.dataset||
        row.machine===fixedSource.machine&&row.dataset===fixedSource.dataset));
    if(!source)return null;
    const id=key(owner,machine,physicalRef.dataset,physicalRef.version),old=load(id);
    if(old)return publicRow(old);
    if(rows().length>=10000)fail('Archive history limit reached');
    const now=clock(),row={id,kind:'replica',owner,machine,...physicalRef,logicalDataset:logicalRef.dataset,
      sourceMachine:source.sourceMachine,sourceDataset:source.sourceDataset,phase:'PROVISIONING',
      copyKey:randomUUID(),transferId:null,grantId:null,certifyId:randomUUID(),createdAt:now,updatedAt:now,nextCheckAt:now,failures:0,eventAcknowledged:true,
      policyKey:source.policyKey,...(source.ingressBinding?{ingressBinding:structuredClone(source.ingressBinding)}:{})};
    row.grantId=grantIdentity(row);
    save(row);return publicRow(row);
  };

  const enrolling=new Map();
  service.cancelStorageArchiveIntent=(principal,args)=>{
    if(!args||Object.keys(args).sort().join(',')!=='archiveId,revision'||
      !HASH.test(args.archiveId||'')||!HASH.test(args.revision||''))
      fail('Intent cancellation requires the original archive ID and full journal revision.',400);
    const actor=service.store.get(principal.userId);
    if(!actor?.enabled||actor.role!=='admin'||principal.role!=='admin'||actor.username!==principal.username)
      fail('Intent cancellation requires a current administrator.',403);
    const actorSnapshot=authorizationPolicy(actor);
    if(service.closing)fail('Archive service is closing.',503);
    service.assertMaintenanceAllowed?.('datasets.archive.cancel-intent',{},principal);
    // No await/RPC occurs here. BEGIN IMMEDIATE serializes the full-row CAS,
    // durable lane/transfer admission checks and audited tombstone. advance()
    // owns that same lane before its first await; transfer admission is saved
    // before remote I/O. An old in-memory worker must still pass fence() and
    // archiveIntentAllowed(), both of which read the permanent tombstone.
    service.db.exec('BEGIN IMMEDIATE');
    try{
      const stored=service.db.prepare('SELECT id,owner,machine,data FROM storage_archives WHERE id=?').get(args.archiveId);
      if(!stored)fail('Archive intent is unavailable.',404);
      const row=JSON.parse(stored.data),mode='undispatched-intent-cancel-v1';
      const response=()=>({archiveId:row.id,state:'CANCELED',controlOnly:true,dataDeleted:false});
      if(!row||row.id!==stored.id||row.owner!==stored.owner||row.machine!==stored.machine||
        row.id!==key(row.owner,row.machine,row.dataset,row.version,row.eventId))
        fail('Archive journal identity is not confirmed.',409);
      if(row.phase==='FAILED'&&row.failureStage==='retired'&&row.retirement?.mode===mode&&row.retirement.revision===args.revision&&
        row.retirement.controlOnly===true&&row.retirement.dataDeleted===false&&HASH.test(row.retirement.proofSha256||'')){
        service.db.exec('COMMIT');return response();
      }
      if(createHash('sha256').update(stored.data).digest('hex')!==args.revision)
        fail('Archive journal changed; inspect its original ID again.',409);
      if(!row||row.id!==stored.id||row.owner!==stored.owner||row.machine!==stored.machine||
        row.id!==key(row.owner,row.machine,row.dataset,row.version,row.eventId)||row.kind!=='ingest'||
        !USER.test(row.owner||'')||!isRef(row)||!UUID.test(row.eventId||'')||
        !MACHINES.some(m=>m.id===row.machine)||!MACHINES.some(m=>m.id===row.sourceMachine)||row.machine===row.sourceMachine||
        row.logicalDataset!==row.dataset||row.phase!=='BLOCKED'||row.eventAcknowledged!==false||
        row.sourceDataset!==null||row.transferId!==null||row.grantId!==null||
        !UUID.test(row.copyKey||'')||!UUID.test(row.certifyId||'')||row.copyKey===row.certifyId||!HASH.test(row.policyKey||'')||
        !Number.isSafeInteger(row.createdAt)||!Number.isSafeInteger(row.updatedAt)||!Number.isSafeInteger(row.failures)||row.failures<0||
        row.retryRequested!==undefined&&row.retryRequested!==false||
        ['failureStage','transferState','receiptSha256','enrollment','retirement','retirementIntent'].some(field=>Object.hasOwn(row,field))||
        retiring.has(row.id)||laneOwner()===row.id)
        fail('Only a confirmed, undispatched BLOCKED ingest intent can be canceled.',409);
      const hasTable=name=>!!service.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      if(!hasTable('transfers'))fail('Durable transfer admission is not confirmed.',409);
      const transfers=service.db.prepare('SELECT owner_id,client_key,state,data FROM transfers').all();
      const copies=hasTable('dataset_copies')?service.db.prepare('SELECT data FROM dataset_copies').all():[];
      if(transfers.length+copies.length>10000)fail('Transfer dependency history requires review.',409);
      const related=(machine,ref)=>ref?.version===row.version&&ref.dataset===row.dataset&&[row.machine,row.sourceMachine].includes(machine);
      for(const item of transfers){
        const data=JSON.parse(item.data);
        if(!data||typeof data!=='object'||Array.isArray(data)||!['copy','upload','download'].includes(data.kind)||
          !MACHINES.some(m=>m.id===data.machine)||data.kind==='copy'&&!MACHINES.some(m=>m.id===data.from)||
          data.kind!=='upload'&&(!isRef(data.reference)||data.reference.kind!=='datasets'))
          fail('Unknown transfer dependency prevents intent cancellation.',409);
        if(item.owner_id===row.owner&&item.client_key===row.copyKey)
          fail('This intent already has durable transfer admission; cancellation is not safe.',409);
        if(related(data.from||data.machine,data.reference)||related(data.machine,data.result)){
          if(!['SUCCEEDED','CANCELED','FAILED'].includes(item.state)||
            data.kind==='copy'&&data.sourceRelease?.state!=='RELEASED'||
            data.kind==='download'&&data.downloadProtection?.state!=='RELEASED'||
            data.sourceRelease&&data.sourceRelease.state!=='RELEASED'||data.downloadProtection&&data.downloadProtection.state!=='RELEASED')
            fail('Active or unknown transfer protection prevents intent cancellation.',409);
        }
      }
      for(const item of copies){
        const copy=JSON.parse(item.data);
        if(!copy||!isRef(copy)||!ID.test(copy.sourceDataset||'')||
          !MACHINES.some(m=>m.id===copy.source)||!MACHINES.some(m=>m.id===copy.target))
          fail('Unknown replica dependency prevents intent cancellation.',409);
        if(related(copy.source,{dataset:copy.sourceDataset,version:copy.version})||related(copy.target,copy))
          fail('A replica depends on this reference; reconcile it before canceling the intent.',409);
      }
      for(const other of rows())if(other.id!==row.id&&other.version===row.version&&!isRetired(other)&&
        [other.dataset,other.logicalDataset,other.sourceDataset].includes(row.dataset))
        fail('Another archive depends on this reference; reconcile it before canceling the intent.',409);
      const proof={mode,archiveId:row.id,revision:args.revision,actor:principal.userId,
        owner:row.owner,machine:row.machine,dataset:row.dataset,version:row.version,eventId:row.eventId,
        controlOnly:true,dataDeleted:false,copyNeverAdmitted:true};
      row.phase='FAILED';row.failureStage='retired';row.retryRequested=false;
      row.retirement={mode,revision:args.revision,actor:principal.userId,proofSha256:key(proof),controlOnly:true,dataDeleted:false};
      row.error='未开始的归档请求已取消；数据未删除，仍须通过正常数据集删除流程处理。';
      save(row);
      service.audit(principal.username,'datasets.archive.cancel-intent',row.id,JSON.stringify(proof));
      if(authorizationPolicy(service.store.get(principal.userId))!==actorSnapshot)
        fail('Intent cancellation authorization changed.',403);
      service.db.exec('COMMIT');return response();
    }catch(error){service.db.exec('ROLLBACK');throw error;}
  };
  service.retireStorageAuthority=(principal,args)=>{
    if(!args||Object.keys(args).filter(key=>key!=='retryKey').sort().join(',')!=='dataset,key,machine,ownerId,recoveryId,replacement,version'||
      !USER.test(args.ownerId||'')||!UUID.test(args.key||'')||!isRef(args)||
      ('retryKey' in args&&!UUID.test(args.retryKey||''))||
      !/^unregister-[a-f0-9]{32}$/.test(args.recoveryId||'')||!MACHINES.some(m=>m.id===args.machine)||
      !args.replacement||Object.keys(args.replacement).sort().join(',')!=='dataset,machine,version'||
      !isRef(args.replacement)||!MACHINES.some(m=>m.id===args.replacement.machine))
      fail('Authority retirement requires the exact removed reference, owner, receipt, replacement and UUID key.',400);
    const actor=service.store.get(principal.userId);
    if(!actor?.enabled||actor.role!=='admin')fail('Authority retirement requires a current administrator.',403);
    const old=rows().findLast(row=>trustedHistory(row)&&row.owner===args.ownerId&&row.machine===args.machine&&
      row.dataset===args.dataset&&row.version===args.version);
    const replacement=rows().findLast(row=>availableArchive(row)&&row.owner===args.ownerId&&row.machine===args.replacement.machine&&
      row.dataset===args.replacement.dataset&&row.version===args.replacement.version);
    if(!old||!replacement||old.id===replacement.id||old.version===replacement.version||
      !UUID.test(old.grantId||'')||!UUID.test(old.certifyId||'')||!HASH.test(old.receiptSha256||'')||
      !UUID.test(replacement.grantId||'')||!HASH.test(replacement.receiptSha256||'')||!old.eventAcknowledged||!replacement.eventAcknowledged)
      fail('Exact archived authority and independently certified replacement are required.',409);
    // The node protocol proves both grants on one immutable authority store.
    // A cross-machine replacement cannot safely retire the old source yet.
    if(old.sourceMachine!==replacement.sourceMachine||old.policyKey!==replacement.policyKey)
      fail('Cross-authority replacement retirement is unsupported; source protection is retained.',409);
    const binding=key('authority-retire-v1',args.ownerId,old.id,replacement.id,args.recoveryId,args.key),snapshot=authorizationPolicy(actor);
    const oldIdentity=archiveIdentity(old),replacementIdentity=archiveIdentity(replacement);
    if(old.retirement?.mode==='authority-retire-v1'){
      if(old.retirement.binding!==binding||old.failureStage!=='authority-retired')fail('Authority retirement identity cannot change.',409);
      return Promise.resolve(publicRow(old));
    }
    if(old.phase!=='ARCHIVED'||old.retirementIntent&&old.retirementIntent.binding!==binding)
      fail('Authority retirement identity or state changed.',409);
    const check=()=>{
      if(service.closing||!policy.enabled||key(service.storageArchivePolicy)!==policyKey)fail('Authority retirement is unavailable.');
      if(authorizationPolicy(service.store.get(principal.userId))!==snapshot)fail('Authority retirement authorization changed.',403);
      enabledUser(args.ownerId,args.machine);enabledUser(args.ownerId,args.replacement.machine);
      service.assertMaintenanceAllowed?.('storage.archive.advance',{machine:old.machine,from:old.sourceMachine});
      service.assertMaintenanceAllowed?.('storage.archive.advance',{machine:replacement.machine,from:replacement.sourceMachine});
      const current=load(old.id),fresh=load(replacement.id);
      if(!trustedHistory(current)||archiveIdentity(current)!==oldIdentity||
        current.retirementIntent&&current.retirementIntent.binding!==binding||
        !availableArchive(fresh)||archiveIdentity(fresh)!==replacementIdentity)
        fail('Retirement or replacement identity changed.');
      if(rows().some(row=>row.id!==old.id&&!isRetired(row)&&row.sourceMachine===old.sourceMachine&&row.sourceDataset===old.sourceDataset&&row.version===old.version))
        fail('Another archive depends on the old authority; explicit reconciliation is required.',409);
      if(laneOwner()===old.id)fail('An archive worker still holds the old lane.',409);
      for(const transfer of service.db.prepare('SELECT state,data FROM transfers').all()){
        const data=JSON.parse(transfer.data),ref=data.reference;
        const related=ref&&ref.version===old.version&&(
          (data.from||data.machine)===old.sourceMachine&&ref.dataset===old.sourceDataset||
          (data.from||data.machine)===old.machine&&ref.dataset===old.dataset);
        if(related&&(!['SUCCEEDED','CANCELED','FAILED'].includes(transfer.state)||
          data.kind==='copy'&&data.sourceRelease?.state!=='RELEASED'||
          data.kind==='download'&&data.downloadProtection?.state!=='RELEASED'))
          fail('Active or unknown transfer protection prevents authority retirement.',409);
      }
    };
    check();
    const pending=retiring.get(old.id);
    if(pending){if(pending.binding!==binding||pending.retryKey!==args.retryKey)fail('Authority retirement identity or active retry cannot change.');return pending.task;}
    const task=Promise.resolve().then(async()=>{
      check();old.retirementIntent={mode:'authority-retire-v1',binding,key:args.key,replacementId:replacement.id,recoveryId:args.recoveryId,state:'FENCING'};save(old);
      const proof=await service.bridge(old.machine,'storage.archive.retire',{
        mode:'authority-target-v1',opId:args.key,userId:old.owner,target:{dataset:old.dataset,version:old.version},
        grantId:old.grantId,certifyId:old.certifyId,recoveryId:args.recoveryId,receiptSha256:old.receiptSha256,...sourceContext(old)});
      check();
      if(!proof||proof.protocol!==1||proof.state!=='REVOKED'||proof.opId!==args.key||proof.userId!==old.owner||proof.grantId!==old.grantId||
        proof.sourceMachine!==old.sourceMachine||proof.targetMachine!==old.machine||proof.source?.dataset!==old.sourceDataset||proof.source?.version!==old.version||
        proof.target?.dataset!==old.dataset||proof.target?.version!==old.version||!HASH.test(proof.proofSha256||''))
        fail('Target retirement fence is not confirmed; source protection is retained.');
      old.retirementIntent.state='REVOKING';save(old);
      const result=await service.bridge(old.sourceMachine,'storage.archive.retire',{
        mode:'authority-source-v1',opId:args.key,userId:old.owner,grantId:old.grantId,replacementGrantId:replacement.grantId,targetProof:proof,
        ...(args.retryKey?{retryKey:args.retryKey}:{})});
      check();
      if(!result||result.protocol!==1||result.opId!==args.key||result.userId!==old.owner||result.grantId!==old.grantId||
        result.source?.dataset!==old.sourceDataset||result.source?.version!==old.version||
        !HASH.test(result.unregister?.operationId||''))fail('Normal authority removal is not confirmed.');
      if(result.state==='RETIRED'&&result.unregister.state==='UNREGISTERED'&&result.unregister.unregistered===true){
        old.retirement={mode:'authority-retire-v1',binding,actor:principal.userId,replacementId:replacement.id,
          targetProofSha256:proof.proofSha256,operationId:result.unregister.operationId,recoveryId:result.unregister.recoveryId};
        old.phase='FAILED';old.failureStage='authority-retired';old.retryRequested=false;delete old.retirementIntent;
        old.error='旧原件已由已验证的新版本替代并正常注销；旧恢复授权已永久退役。';save(old);
      }else{
        old.retirementIntent.state=result.unregister.state||'UNKNOWN';save(old);
      }
      service.audit(principal.username,'datasets.archive.retire-authority',old.machine,old.owner+':'+old.dataset+'@'+old.version);
      return publicRow(old);
    }).finally(()=>{if(retiring.get(old.id)?.task===task)retiring.delete(old.id);});
    retiring.set(old.id,{binding,retryKey:args.retryKey,task});return task;
  };
  service.retireStorageArchive=(principal,args)=>{
    if(!args||Object.keys(args).sort().join(',')!=='dataset,eventId,machine,ownerId,recoveryId,version'||
      !USER.test(args.ownerId||'')||!UUID.test(args.eventId||'')||!isRef(args)||
      !/^unregister-[a-f0-9]{32}$/.test(args.recoveryId||'')||!MACHINES.some(m=>m.id===args.machine))
      fail('Retirement requires the exact event, owner, reference and normal unregister receipt.',400);
    const actor=service.store.get(principal.userId);
    if(!actor?.enabled||actor.role!=='admin')fail('Archive retirement requires a current administrator.',403);
    const snapshot=authorizationPolicy(actor),ownerSnapshot=authorizationPolicy(enabledUser(args.ownerId,args.machine));
    const id=key(args.ownerId,args.machine,args.dataset,args.version,args.eventId),row=load(id);
    if(!row||!trustedHistory(row)||row.kind!=='ingest'||row.owner!==args.ownerId||row.machine!==args.machine||
      row.dataset!==args.dataset||row.version!==args.version||row.eventId!==args.eventId||row.eventAcknowledged)
      fail('Only a never-dispatched same-HDD ingest can be retired.');
    const identity=archiveIdentity(row);
    const check=()=>{
      if(service.closing||!policy.enabled||!service.bridge||key(service.storageArchivePolicy)!==policyKey)fail('Archive retirement is unavailable.');
      service.assertMaintenanceAllowed?.('storage.archive.advance',{machine:row.machine,from:row.sourceMachine});
      if(authorizationPolicy(service.store.get(principal.userId))!==snapshot||authorizationPolicy(enabledUser(args.ownerId,args.machine))!==ownerSnapshot)
        fail('Archive retirement authorization changed.',403);
      if(archiveIdentity(load(id))!==identity)fail('Archive retirement identity changed.');
    };
    check();
    const binding=key(args.ownerId,args.machine,args.dataset,args.version,args.eventId,args.recoveryId),prior=row.retirement;
    if(prior){if(prior.binding!==binding||row.phase!=='FAILED'||row.failureStage!=='retired')fail('Retirement receipt cannot be changed.');return Promise.resolve(publicRow(row));}
    const queuedSafe=value=>value?.kind==='ingest'&&value.phase==='QUEUED'&&value.sourceDataset===null&&value.transferId===null&&value.grantId===null&&
      value.retryRequested!==true&&!value.failureStage&&UUID.test(value.copyKey||'')&&laneOwner()!==value.id&&
      typeof service.transferSnapshotByKey==='function'&&!service.transferSnapshotByKey(value.owner,value.copyKey);
    const queued=queuedSafe(row);
    if(!queued&&(row.sourceMachine!==row.machine||row.sourceDataset!==row.dataset||row.transferId!==null||
      row.grantId!==grantIdentity(row)||!UUID.test(row.certifyId||'')||!['PROVISIONING','BLOCKED','FAILED'].includes(row.phase)))
      fail('Only a never-dispatched same-HDD or untouched QUEUED ingest can be retired.');
    if(row.retirementIntent&&(!queued||row.retirementIntent.binding!==binding))fail('Pending retirement binding cannot be changed.');
    const checkQueued=()=>{
      const current=load(id);
      if(!queuedSafe(current)||['owner','machine','dataset','version','eventId','sourceMachine','copyKey','certifyId'].some(k=>current[k]!==row[k])||
        current.retirementIntent&&current.retirementIntent.binding!==binding)
        fail('Queued archive admission changed; retirement remains fenced for review.');
      return current;
    };
    const pending=retiring.get(id);
    if(pending){if(pending.binding!==binding)fail('Retirement receipt cannot be changed.');return pending.task;}
    const task=Promise.resolve().then(async()=>{
      check();
      if(queued){
        checkQueued();
        // A lost RPC reply or portal restart cannot dispatch this old intent.
        // This is a pending operator intent, never an inferred terminal proof.
        row.retirementIntent={binding,recoveryId:args.recoveryId,mode:'queued-ingest-v1'};
        row.error='正在核实正常注销回执；该旧意图不会启动归档。';save(row);
      }
      const proof=await service.bridge(row.machine,'storage.archive.retire',{
        id:row.eventId,userId:row.owner,dataset:row.dataset,version:row.version,
        recoveryId:args.recoveryId,...(queued?{mode:'queued-ingest-v1'}:{grantId:row.grantId,certifyId:row.certifyId})});
      check();
      if(queued&&checkQueued().retirementIntent?.binding!==binding)fail('Durable retirement fence changed.');
      const scope=queued?'sourceRetired':'neverDispatched';
      if(!proof||Object.keys(proof).sort().join(',')!==['dataset','id',scope,'proofSha256','protocol','recoveryId','state','userId','version'].sort().join(',')||
        proof.protocol!==1||proof.id!==row.eventId||proof.userId!==row.owner||proof.dataset!==row.dataset||proof.version!==row.version||
        proof.recoveryId!==args.recoveryId||proof.state!=='RETIRED'||proof[scope]!==true||!HASH.test(proof.proofSha256||''))
        fail('Exact normal retirement is not confirmed; archive lane is retained.');
      // Save the terminal proof before compare-and-delete; restart recovery is
      // permitted only for this known never-dispatched terminal state.
      row.phase='FAILED';row.failureStage='retired';row.retryRequested=false;row.failures=0;
      row.retirement={binding,recoveryId:args.recoveryId,proofSha256:proof.proofSha256,actor:principal.userId};
      delete row.retirementIntent;
      row.error='原登记已由管理员正常注销，旧归档意图已退役；不会自动重建或重试。';
      save(row);releaseLane(row);
      service.audit(principal.username,'datasets.archive.retire',row.machine,row.owner+':'+row.dataset+'@'+row.version);
      return publicRow(row);
    }).finally(()=>{if(retiring.get(id)?.task===task)retiring.delete(id);});
    retiring.set(id,{binding,task});return task;
  };
  service.enrollStorageArchive=(principal,args)=>{
    if(!args||!['dataset,key,machine,ownerId,version','copyIfMissing,dataset,key,machine,ownerId,version'].includes(Object.keys(args).sort().join(','))||
      Object.hasOwn(args,'copyIfMissing')&&typeof args.copyIfMissing!=='boolean'||
      !USER.test(args.ownerId||'')||!UUID.test(args.key||'')||!isRef(args)||
      !MACHINES.some(m=>m.id===args.machine)||args.machine===policy.machine)
      fail('Enrollment requires an exact owner, hot machine, version and UUID key.',400);
    const {ownerId:owner,machine,dataset,version,key:requestKey}=args;
    const admitted=service.store.get(principal.userId);
    if(!admitted?.enabled||admitted.role!=='admin')fail('Archive enrollment requires a current administrator.',403);
    const actorPolicy=authorizationPolicy(admitted),ownerPolicy=authorizationPolicy(enabledUser(owner,machine));
    const check=()=>{
      if(service.closing||!policy.enabled||!service.bridge||key(service.storageArchivePolicy)!==policyKey)fail('Archive enrollment is unavailable.');
      service.assertMaintenanceAllowed?.('storage.archive.advance',{machine,from:policy.machine});
      if(authorizationPolicy(service.store.get(principal.userId))!==actorPolicy||
         authorizationPolicy(enabledUser(owner,machine))!==ownerPolicy)fail('Archive enrollment authorization changed.',403);
    };
    check();
    const copyIfMissing=args.copyIfMissing===true;
    const id=key('explicit-enrollment',principal.userId,requestKey),binding=copyIfMissing?key(owner,machine,dataset,version,policyKey,'copy-if-missing-v1'):key(owner,machine,dataset,version,policyKey);
    const prior=load(id);
    if(prior){
      if(prior.enrollment?.binding!==binding)fail('Enrollment key cannot change its owner or fixed reference.');
      return Promise.resolve(publicRow(prior));
    }
    const pending=enrolling.get(id);
    if(pending){if(pending.binding!==binding)fail('Enrollment key is already bound to another reference.');return pending.task;}
    const task=(async()=>{
      // No scan, forged outbox or inferred absence. A new HDD copy requires
      // explicit admin intent and an exact trusted ABSENT probe.
      if(rows().some(row=>currentPolicy(row)&&row.owner===owner&&row.machine===machine&&row.dataset===dataset&&row.version===version))
        fail('An archive intent already exists; inspect or retry that intent.');
      const reference={userId:owner,dataset,version},proofs=[];
      for(const target of [machine,policy.machine]){
        const value=await service.bridge(target,'storage.archive.enrollment-check',{
          ...reference,...(copyIfMissing&&target===policy.machine?{allowMissing:true}:{})});check();
        const absent=copyIfMissing&&target===policy.machine&&value?.state==='ABSENT'&&
          Object.keys(value).sort().join(',')==='dataset,machine,protocol,state,userId,version'&&value.protocol===1&&
          value.machine===target&&value.userId===owner&&value.dataset===dataset&&value.version===version;
        proofs.push(absent?value:enrollmentProof(value,target,owner,reference));
      }
      const needsCopy=proofs[1].state==='ABSENT';
      if(!needsCopy&&proofs[0].manifestBytes!==proofs[1].manifestBytes)fail('Complete immutable manifests do not match.');
      check();
      if(rows().some(row=>currentPolicy(row)&&row.owner===owner&&row.machine===machine&&row.dataset===dataset&&row.version===version))
        fail('An archive intent was created concurrently; inspect that intent.');
      if(rows().length>=10000)fail('Archive history limit reached');
      const now=clock(),row={id,kind:needsCopy?'enrollment':'replica',owner,machine,dataset,version,logicalDataset:dataset,
        sourceMachine:policy.machine,sourceDataset:needsCopy?null:dataset,phase:needsCopy?'QUEUED':'PROVISIONING',copyKey:randomUUID(),transferId:null,
        grantId:null,certifyId:randomUUID(),createdAt:now,updatedAt:now,nextCheckAt:now,failures:0,eventAcknowledged:true,policyKey,
        enrollment:{binding,actor:principal.userId,key:requestKey,targetRegistration:proofs[0].registration,
          sourceRegistration:needsCopy?null:proofs[1].registration,manifestBytes:proofs[0].manifestBytes}};
      if(!needsCopy)row.grantId=grantIdentity(row);save(row);
      service.audit(principal.username,'datasets.archive.enroll',machine,owner+':'+dataset+'@'+version);
      return publicRow(row);
    })().finally(()=>{if(enrolling.get(id)?.task===task)enrolling.delete(id);});
    enrolling.set(id,{binding,task});return task;
  };

  // Explicit authenticated intent, never an automatic retry or a new transfer.
  // The background lane alone consumes this flag after rechecking permission.
  service.retryStorageArchive=(owner,machine,ref)=>{
    if(!policy.enabled||!isRef(ref))fail('Invalid archive retry reference');
    enabledUser(owner,machine,ref);
    const row=rows().findLast(value=>value.owner===owner&&value.machine===machine&&(value.dataset===ref.dataset||value.logicalDataset===ref.dataset)&&value.version===ref.version);
    if(!row)fail('Archive intent is unavailable');
    if(isRetired(row))fail('已注销的旧归档意图不能重试；重新登记必须使用新的发布事件。');
    fence(row);
    if(row.transferState==='CANCELED')fail('归档传输已永久取消；原件仍受保护，请联系管理员处理。');
    if(!['FAILED','BLOCKED'].includes(row.phase))return publicRow(row);
    row.retryRequested=true;row.nextCheckAt=clock();row.failures=0;
    row.phase=isCopyIntent(row)&&!row.sourceDataset?'COPYING':'PROVISIONING';
    delete row.error;save(row);return publicRow(row);
  };

  async function acknowledge(row,snapshot){
    if(row.eventAcknowledged||row.kind!=='ingest')return;
    const result=await call(row,snapshot,row.machine,'storage.archive.ack',{id:row.eventId,userId:row.owner,dataset:row.dataset,version:row.version});
    if(result?.acknowledged!==true||result.id!==row.eventId)fail('Archive event acknowledgement mismatch');
    row.eventAcknowledged=true;save(row);
  }

  async function advance(row){
    if(service.maintenanceFor?.(row.machine)||service.maintenanceFor?.(row.sourceMachine))return;
    if(row.nextCheckAt>clock())return;
    if(row.phase==='FAILED'||row.phase==='BLOCKED'||row.nextCheckAt>clock())return;
    const snapshot=fence(row);
    if(!holdLane(row))return;
    if(row.phase==='ARCHIVED'){await acknowledge(row,snapshot);releaseLane(row);return;}
    if(row.phase==='QUEUED'||row.phase==='COPYING'){
      if(typeof service.archiveTransferCall!=='function')fail('Archive copy adapter is unavailable');
      if(row.kind==='enrollment'){
        const proof=enrollmentProof(await call(row,snapshot,row.machine,'storage.archive.enrollment-check',{
          userId:row.owner,dataset:row.dataset,version:row.version}),row.machine,row.owner,row);
        if(proof.registration!==row.enrollment.targetRegistration||proof.manifestBytes!==row.enrollment.manifestBytes)
          fail('Explicit archive enrollment registration changed before copy');
      }
      // The copy key is durable before the first request; ambiguous replies
      // always resolve the same transfer, never a second destination/name.
      row.phase='COPYING';save(row);
      const result=await service.archiveTransferCall({userId:row.owner,username:service.store.get(row.owner).username,role:'member'},
        {key:row.copyKey,kind:'copy',from:row.machine,machine:row.sourceMachine,dataset:row.dataset,version:row.version,name:'archive-'+key(row.owner,row.machine,row.dataset).slice(0,24)},
        {resume:row.retryRequested===true});
      fence(row,snapshot);
      if(!UUID.test(result?.id))fail('Archive transfer identity mismatch');
      if(row.transferId&&row.transferId!==result.id)fail('Archive transfer changed identity');
      row.transferId=result.id;
      row.transferState=result.state;
      if(result.state==='FAILED'||result.state==='PAUSED'||result.state==='CANCELED'){
        row.phase='FAILED';row.failureStage='copy';row.retryRequested=false;
        row.error=result.state==='CANCELED'?'归档传输已永久取消；原件仍受保护，请联系管理员处理。':'长期归档未完成，本机原件仍受保护。请检查传输后重试。';save(row);releaseLane(row);return;
      }
      row.retryRequested=false;
      if(result.state!=='SUCCEEDED'){save(row);return;}
      if(!isRef(result.result)||result.result.version!==row.version)fail('Archive copy returned a different version');
      row.sourceDataset=result.result.dataset;row.grantId=grantIdentity(row);row.phase='PROVISIONING';save(row);
    }
    if(row.kind==='enrollment'&&!row.enrollment.sourceRegistration){
      const source={dataset:row.sourceDataset,version:row.version};
      const proof=enrollmentProof(await call(row,snapshot,row.sourceMachine,'storage.archive.enrollment-check',{
        userId:row.owner,...source}),row.sourceMachine,row.owner,source);
      if(proof.manifestBytes!==row.enrollment.manifestBytes)fail('Copied archive manifest does not match enrollment');
      row.enrollment.sourceRegistration=proof.registration;save(row);
    }
    if(row.machine===row.sourceMachine){
      const result=await call(row,snapshot,row.sourceMachine,'storage.archive.original',{userId:row.owner,dataset:row.dataset,version:row.version});
      if(result?.protected!==true||result.dataset!==row.dataset||result.version!==row.version)fail('Archive original is not protected');
      row.phase='ARCHIVED';delete row.error;save(row);await acknowledge(row,snapshot);releaseLane(row);return;
    }
    const request={opId:row.grantId,userId:row.owner,source:{dataset:row.sourceDataset,version:row.version},targetMachine:row.machine,
      ...(row.enrollment?{expectedRegistration:row.enrollment.sourceRegistration}:{}),...(row.retryRequested?{retry:true}:{})};
    const provision=await call(row,snapshot,row.sourceMachine,'storage.archive.provision',request);
    if(provision?.opId!==row.grantId)fail('Archive provision identity mismatch');
    if(provision.state==='FAILED'){row.phase='FAILED';row.failureStage='provision';row.retryRequested=false;row.error='长期原件校验未完成，本机副本不会被清理。';save(row);releaseLane(row);return;}
    if(provision.state!=='READY'){row.phase='PROVISIONING';save(row);return;}
    if(!provision.grant||provision.grant.id!==row.grantId||provision.grant.sourceMachine!==row.sourceMachine||provision.grant.targetMachine!==row.machine||provision.grant.dataset!==row.sourceDataset||provision.grant.version!==row.version||JSON.stringify(provision.grant.receipt?.owners)!==JSON.stringify([row.owner]))fail('Archive grant does not match the fixed owner/reference');
    row.phase='CERTIFYING';save(row);
    const certified=await call(row,snapshot,row.machine,'storage.archive.certify',{opId:row.certifyId,userId:row.owner,target:{dataset:row.dataset,version:row.version},grant:provision.grant,
      ...(row.enrollment?{expectedRegistration:row.enrollment.targetRegistration}:{}),...(row.retryRequested?{retry:true}:{}),...sourceContext(row)});
    if(certified?.opId===row.certifyId&&certified.state==='FAILED'){row.phase='FAILED';row.failureStage='certify';row.retryRequested=false;row.error='缓存认证未完成；本机副本仍受保护，请检查后重试。';save(row);releaseLane(row);return;}
    if(certified?.opId!==row.certifyId||certified.state!=='READY'||certified.dataset!==row.dataset||certified.version!==row.version||certified.role!=='cache'||!HASH.test(certified.receiptSha256||''))fail('Archive cache certification not confirmed');
    row.receiptSha256=certified.receiptSha256;row.phase='ARCHIVED';row.failures=0;row.retryRequested=false;delete row.error;save(row);
    await acknowledge(row,snapshot);
    releaseLane(row);
  }

  service.reconcileStorageArchive=async()=>{
    if(reconciling||service.closing||!policy.enabled||!service.bridge)return;
    reconciling=true;
    try{
      // Only post-enable publish intents are enumerated. No scan of old users,
      // datasets, disks or cloud accounts creates an archive job.
      for(const machine of MACHINES){
        if(service.closing)return;
        if(service.maintenanceFor?.(machine.id))continue;
        try{
          const value=await service.bridge(machine.id,'storage.archive.events',{limit:8});
          if(!Array.isArray(value?.events)||value.events.length>8)fail('Invalid archive outbox response');
          for(const event of value.events){try{enqueueEvent(machine.id,event);}catch{}}
        }catch{}
      }
      // A single HDD copy/seal lane bounds source pressure. Existing node
      // workers persist and continue through a portal restart.
      // A known stopped failure may have crashed between saving its receipt
      // and releasing the lane. Unknown replies and revocation retain it.
      let held=laneOwner(),heldRow=held&&load(held);
      const knownStoppedFailure=heldRow?.phase==='FAILED'&&(['copy','provision','certify'].includes(heldRow.failureStage)||
        heldRow.failureStage==='retired'&&HASH.test(heldRow.retirement?.proofSha256||''));
      if(heldRow&&(heldRow.phase==='ARCHIVED'&&heldRow.eventAcknowledged||knownStoppedFailure)){releaseLane(heldRow);held=null;}
      // An unknown old-policy lane stays held for explicit reconciliation. Do
      // not dispatch or rewrite that journal merely because defaults changed.
      const pending=held?(heldRow&&currentPolicy(heldRow)?[heldRow]:[]):rows().filter(row=>currentPolicy(row)&&!row.retirementIntent&&row.nextCheckAt<=clock()&&(row.phase==='ARCHIVED'&&!row.eventAcknowledged||!['ARCHIVED','FAILED','BLOCKED'].includes(row.phase))).sort((a,b)=>a.updatedAt-b.updatedAt);
      for(const row of pending.slice(0,1)){
        try{await advance(row);}
        catch(error){
          if(service.closing)return;
          if(retiring.has(row.id)||load(row.id)?.retirementIntent||isRetired(load(row.id)))continue;
          if(error.code==='MAINTENANCE_ACTIVE')continue; // Retain the fixed intent/lane without automatic retry or cleanup.
          row.failures=(row.failures||0)+1;
          row.nextCheckAt=clock()+Math.min(300000,15000*2**Math.min(row.failures,5));
          row.error='归档状态暂未确认；保留本机数据，稍后自动核对。';
          try{enabledUser(row.owner,row.machine,{dataset:row.dataset,version:row.version});}catch{row.phase='BLOCKED';row.error='账号或机器授权已改变；原件保持受保护，等待管理员核对。';}
          save(row);
        }
      }
    }finally{reconciling=false;}
  };
  if(policy.enabled&&startTimer){service.storageArchiveTimer=setInterval(()=>service.reconcileStorageArchive().catch(()=>{}),15000);service.storageArchiveTimer.unref();}
  return {enqueueEvent,load,rows,advance,policy};
}
