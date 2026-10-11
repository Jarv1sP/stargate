import {authorizationPolicy,MACHINES,validUsername} from './dist/model.js';
import {createHash} from 'node:crypto';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH=/^[a-f0-9]{64}$/;
const STATES=new Set(['READY','REGISTERED','STAGING','PREPARING','FAILED','UNKNOWN']);
const OWNER_ID=/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

export const LAST_COPY_MESSAGE='这可能是这个版本的最后一份完整数据。为避免永久丢失，暂不能按机器删除；节点更新后可用「彻底删除」（7 天内可恢复）。';
// The legacy detached worker has RuntimeMaxSec=86400. Keep another hour for
// launch/stop cleanup; a contract test parses its actual systemd-run definition.
export const DATASET_REMOVAL_GRACE_MS=25*60*60*1000;
// An in-process refusal cannot be forged by a serialized node/bridge error.
export const DATASET_FENCE_REFUSAL=Symbol('portal.dataset-deletion-fence-refusal');
const removalLanes=new WeakMap();
const lastCopy=()=>Object.assign(Error(LAST_COPY_MESSAGE),{status:409,code:'LAST_COPY_UNPROVEN'});
const complete=value=>value?.state==='READY'||value?.state===undefined&&value?.complete===true;
const pendingRemoval=()=>Object.assign(Error('这台服务器上的删除结果待确认'),{status:409,code:'DATASET_REMOVAL_PENDING'});

function removalPending(service,machine,dataset,version){
  if(!service.db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dataset_removal_exclusions'").get())return null;
  return service.db.prepare('SELECT operation_id,registration_identity FROM dataset_removal_exclusions WHERE machine=? AND dataset=? AND version=? LIMIT 1').get(machine,dataset,version);
}

// The old node accepts cleanup before its worker removes READY. A durable
// exclusion is therefore written BEFORE dispatch, and survives a Portal swap.
// Neither a failed HTTP response nor a missing operation ID proves no deletion.
export function createDatasetRemovalGuard(service,principal,{readTimeoutMs=32000,now=Date.now,allowEmptyPersonalRegistration=false}={}){
  const user=service.store.get(principal.userId),policy=authorizationPolicy(user);
  const checkPolicy=()=>{
    const current=service.store.get(principal.userId);
    if(service.closing||principal.role!=='admin'||!current?.enabled||current.role!=='admin'||authorizationPolicy(current)!==policy)
      fail('账号授权已改变，请刷新后重试。',403);
  };
  checkPolicy();
  if(!service.db||!service.bridge)throw lastCopy();
  service.db.exec(`CREATE TABLE IF NOT EXISTS dataset_removal_exclusions (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
    machine TEXT NOT NULL, dataset TEXT NOT NULL, version TEXT NOT NULL,
    scope_version TEXT, operation_id TEXT, user_id TEXT NOT NULL, started_at TEXT NOT NULL,
    registration_identity TEXT
  )`);
  if(!service.db.prepare('PRAGMA table_info(dataset_removal_exclusions)').all().some(column=>column.name==='registration_identity'))
    service.db.exec('ALTER TABLE dataset_removal_exclusions ADD COLUMN registration_identity TEXT');
  async function read(machine,operation,args){
    let timer;
    try{
      return await Promise.race([service.bridge(machine,operation,args),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(lastCopy()),readTimeoutMs);timer.unref?.();
      })]);
    }catch{throw lastCopy();}finally{clearTimeout(timer);checkPolicy();}
  }
  async function listings(){
    const rows=await Promise.all(MACHINES.map(async machine=>{
      const readStartedAt=now();
      const result=await read(machine.id,'datasets.list',{userId:user.id,hostAdmin:true});
      if(!Array.isArray(result?.datasets)||result.datasets.some(item=>!ID.test(item?.dataset)||!Array.isArray(item.versions)||
        item.versions.some(value=>!HASH.test(value?.version))||item.ownerIds!==undefined&&(!Array.isArray(item.ownerIds)||item.ownerIds.some(owner=>typeof owner!=='string'||!OWNER_ID.test(owner)))))throw lastCopy();
      return {machine:machine.id,datasets:result.datasets,readStartedAt};
    }));
    checkPolicy();return rows;
  }
  function names(machine,item,version){
    const values=new Set([item.dataset]);
    for(const owner of item.ownerIds||[]){
      if(typeof owner!=='string'||!OWNER_ID.test(owner))continue;
      const alias=service.datasetAliases?.(owner,machine)?.get(item.dataset+'@'+version);
      const archived=service.archiveAliases?.(owner,machine)?.get(item.dataset+'@'+version);
      for(const name of [alias,archived])if(typeof name==='string'&&ID.test(name))values.add(name);
    }
    return values;
  }
  const exclusionRows=()=>service.db.prepare('SELECT * FROM dataset_removal_exclusions').all();
  const registrationIdentity=(item,value)=>JSON.stringify({dataset:item.dataset,version:value.version,
    ...(item.ownerIds!==undefined?{ownerIds:[...item.ownerIds].sort()}:{}),
    ...(value.bytes!==undefined?{bytes:value.bytes}:{}),...(value.files!==undefined?{files:value.files}:{})});
  const hasCopy=(rows,pending)=>rows.find(row=>row.machine===pending.machine)?.datasets.some(item=>item.dataset===pending.dataset&&item.versions?.some(value=>value.version===pending.version&&complete(value)));
  const absent=(rows,pending)=>{
    const listing=rows.find(row=>row.machine===pending.machine);
    return !!listing&&!listing.datasets.some(item=>item.dataset===pending.dataset&&item.versions.some(value=>value.version===pending.version));
  };
  function graceConfirmed(rows,pending){
    const listing=rows.find(row=>row.machine===pending.machine),item=listing?.datasets.find(item=>item.dataset===pending.dataset);
    const value=item?.versions.find(value=>value.version===pending.version),startedAt=Date.parse(pending.started_at);
    return !pending.operation_id&&typeof pending.registration_identity==='string'&&Number.isFinite(startedAt)&&
      now()>=startedAt+DATASET_REMOVAL_GRACE_MS&&listing?.readStartedAt>=startedAt+DATASET_REMOVAL_GRACE_MS&&
      value?.state==='READY'&&registrationIdentity(item,value)===pending.registration_identity;
  }
  async function reconcile(rows,pending){
    const remove=service.db.prepare('DELETE FROM dataset_removal_exclusions WHERE id=?');
    // Confirmed absence is independent of an unreadable old receipt. Missing-ID
    // READY is safe only after the worker's hard limit AND an unchanged listing.
    const remaining=[];
    for(const row of pending){if(absent(rows,row)||graceConfirmed(rows,row))remove.run(row.id);else remaining.push(row);}
    const receipts=new Map();
    for(const row of remaining){
      if(!HASH.test(row.operation_id||''))continue;
      const key=JSON.stringify([row.machine,row.operation_id]);
      if(!receipts.has(key))receipts.set(key,await read(row.machine,'datasets.status',{operationId:row.operation_id,userId:row.user_id,hostAdmin:true}));
      const receipt=receipts.get(key);
      if(receipt?.operationId!==row.operation_id||receipt.dataset!==row.dataset||(receipt.version??null)!==row.scope_version)throw lastCopy();
    }
    // Read AFTER the original receipt. A pre-receipt READY can be the copy
    // that the just-finished worker removed, and must never release an exclusion.
    if(receipts.size)rows=await listings();
    for(const row of remaining){
      const receipt=receipts.get(JSON.stringify([row.machine,row.operation_id]));
      if(absent(rows,row)||(receipt?.state==='UNREGISTERED'&&typeof receipt.unregistered==='boolean')||(receipt?.state==='FAILED'&&hasCopy(rows,row)))remove.run(row.id);
    }
    checkPolicy();return rows;
  }
  async function refreshExclusions(){
    const pending=exclusionRows();if(!pending.length)return;
    await reconcile(await listings(),pending);
  }
  async function snapshot(machine,dataset,version){
    checkPolicy();
    if(!MACHINES.some(row=>row.id===machine)||!ID.test(dataset)||version!=null&&!HASH.test(version))throw lastCopy();
    let rows=await listings();
    let target=rows.find(row=>row.machine===machine)?.datasets.find(item=>item.dataset===dataset);
    const versions=version==null?[...new Set([...(target?.versions||[]).map(value=>value.version),...exclusionRows().filter(row=>row.machine===machine&&row.dataset===dataset).map(row=>row.version)])]:[version];
    const pending=exclusionRows().filter(row=>versions.includes(row.version));
    rows=await reconcile(rows,pending);
    target=rows.find(row=>row.machine===machine)?.datasets.find(item=>item.dataset===dataset);
    if(version==null)versions.splice(0,versions.length,...new Set((target?.versions||[]).map(value=>value.version)));
    checkPolicy();
    const excluded=exclusionRows(),proof=[];
    if(excluded.some(row=>row.machine===machine&&row.dataset===dataset&&versions.includes(row.version)))throw pendingRemoval();
    // Only paired v1 nodes can accept this metadata-only case. An empty list
    // never proves absence of payload: the node must bind and recheck the
    // personal registry, upload intents and every dependency before moving it.
    if(!versions.length&&version==null&&allowEmptyPersonalRegistration===true&&target?.versions.length===0&&target.ownerIds?.length===1){
      const prefix='u-'+createHash('sha256').update(target.ownerIds[0]).digest('hex').slice(0,16)+'-';
      if(dataset.startsWith(prefix)&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(dataset.slice(prefix.length))){
        if(excluded.some(row=>row.machine===machine&&row.dataset===dataset))throw pendingRemoval();
        return [];
      }
    }
    if(!versions.length||!target||versions.some(id=>!target.versions.some(value=>value.version===id)))throw lastCopy();
    for(const id of versions){
      const targetNames=names(machine,target,id),copies=[];
      for(const row of rows){
        if(row.machine===machine)continue;
        for(const item of row.datasets){
          if(!ID.test(item?.dataset)||!Array.isArray(item.versions)||![...names(row.machine,item,id)].some(name=>targetNames.has(name)))continue;
          const value=item.versions.find(value=>value.version===id);
          if(!complete(value)||excluded.some(pending=>pending.machine===row.machine&&pending.dataset===item.dataset&&pending.version===id))continue;
          copies.push({machine:row.machine,dataset:item.dataset,version:id});
        }
      }
      // An ARCHIVED journal alone is historical. Its distinct authority must
      // also report this fixed version complete in the current node read.
      if(!copies.length)throw lastCopy();
      proof.push({version:id,copies,registrationIdentity:registrationIdentity(target,target.versions.find(value=>value.version===id))});
    }
    return proof;
  }
  async function withProtectedRemoval(machine,dataset,version,dispatch){
    // A single removal lane also covers whole-dataset requests and differently
    // named archive aliases, without acquiring version locks in opposite orders.
    const prior=removalLanes.get(service)||Promise.resolve();
    const run=prior.then(async()=>{
      const proof=await snapshot(machine,dataset,version),requestId=crypto.randomUUID(),startedAt=new Date(now()).toISOString();
      checkPolicy();
      const insert=service.db.prepare('INSERT INTO dataset_removal_exclusions(id,request_id,machine,dataset,version,scope_version,operation_id,user_id,started_at,registration_identity) VALUES(?,?,?,?,?,?,NULL,?,?,?)');
      service.db.exec('BEGIN IMMEDIATE');
      try{
        for(const row of proof)insert.run(crypto.randomUUID(),requestId,machine,dataset,row.version,version??null,user.id,startedAt,row.registrationIdentity);
        service.db.exec('COMMIT');
      }catch(error){service.db.exec('ROLLBACK');throw error;}
      checkPolicy();
      let result;
      try{
        // Read-only version scope of this exact proof. Existing callbacks may
        // ignore it; v1 nodes use it to reject newly added, unproved versions.
        result=await dispatch(proof.map(row=>({version:row.version})));
      }catch(error){
        // Only our explicit Portal fence refusal proves zero node dispatch.
        // Transport/worker/account failures keep the original M2 exclusions.
        if(error.code==='DATASET_DELETION_FENCED'&&error[DATASET_FENCE_REFUSAL]===true)
          service.db.prepare('DELETE FROM dataset_removal_exclusions WHERE request_id=? AND operation_id IS NULL').run(requestId);
        throw error;
      }
      if(HASH.test(result?.operationId||'')&&(result.dataset===undefined||result.dataset===dataset)&&(result.version===undefined||(result.version??null)===(version??null)))
        service.db.prepare('UPDATE dataset_removal_exclusions SET operation_id=? WHERE request_id=?').run(result.operationId,requestId);
      checkPolicy();return result;
    });
    const tail=run.catch(()=>{});removalLanes.set(service,tail);
    try{return await run;}finally{if(removalLanes.get(service)===tail)removalLanes.delete(service);}
  }
  return {assertAnotherCompleteCopy:snapshot,withProtectedRemoval,refreshExclusions};
}

// Only usernames from valid node ACLs are projected from the trusted account
// store. Directory discovery is public to members; owner IDs stay internal.
function ownerIds(item){
  const ids=item?.ownerIds;
  return Array.isArray(ids)&&ids.length>0&&ids.length<=64&&ids.every(id=>typeof id==='string'&&OWNER_ID.test(id))?[...new Set(ids)].sort():null;
}
function ownerView(item,users){
  const owners=ownerIds(item);
  if(!owners)return {key:null,label:'所属用户：未知（授权信息未完整返回）'};
  const names=owners.map(id=>users?.find(user=>user.id===id)?.username);
  const known=names.filter(validUsername),unknown=names.length-known.length;
  const label=owners.length===1?`所属用户：${unknown?'未知（账号已删除或未登记）':known[0]}`:
    `共享授权用户：${[...known,...(unknown?[`未知用户 ${unknown} 位（账号已删除或未登记）`]:[])].join('、')}`;
  return {key:JSON.stringify(owners),label};
}

// Only the node's durable, fixed-version warehouse binding may select a
// physical training cache. This is never a client-supplied path or an alias
// inferred from a naming prefix. Missing/invalid bindings cannot run on HDD.
export function warehouseCacheReference(status,ref){
  if(status?.storageReference===undefined&&!(typeof status?.warehouseReady==='boolean'&&status?.state==='READY'))return null;
  const value=status?.storageReference;
  if(typeof ref?.dataset!=='string'||!ID.test(ref.dataset)||typeof ref?.version!=='string'||!HASH.test(ref.version)||status?.dataset!==ref.dataset||status?.version!==ref.version||status?.state!=='READY'||status?.warehouseReady!==true||
    !value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||
    !Object.hasOwn(value,'dataset')||!Object.hasOwn(value,'version')||typeof value.dataset!=='string'||!ID.test(value.dataset)||value.version!==ref.version||!HASH.test(value.version))
    throw Object.assign(Error('仓库训练缓存的固定版本绑定尚未确认。'),{status:502,code:'WAREHOUSE_REFERENCE_INVALID'});
  return {dataset:value.dataset,version:value.version,mountAs:ref.dataset};
}

function warehouseProjection(result){
  if(!Array.isArray(result?.datasets))return result;
  const originals=new Map();
  for(const item of result.datasets){
    if(typeof item?.dataset!=='string'||!ID.test(item.dataset)||!Array.isArray(item.versions))continue;
    const ids=ownerIds(item);if(!ids)continue;
    for(const value of item.versions)if(HASH.test(value?.version)&&typeof value.warehouseReady==='boolean'){
      const key=item.dataset+'@'+value.version,entries=originals.get(key)||[];
      entries.push({item,value,owners:JSON.stringify(ids)});originals.set(key,entries);
    }
  }
  return {...result,datasets:result.datasets.map(item=>{
    if(!Array.isArray(item?.versions))return item;
    const ids=ownerIds(item);
    const versions=item.versions.filter(value=>{
      if(typeof value?.logicalDataset!=='string'||!ID.test(value.logicalDataset)||!HASH.test(value.version)||!ids)return true;
      const entries=originals.get(value.logicalDataset+'@'+value.version);
      if(entries?.length!==1||entries[0].owners!==JSON.stringify(ids)||item.dataset===value.logicalDataset)return true;
      const original=entries[0].value;
      if(original.state==='READY'){
        try{return warehouseCacheReference({...original,dataset:value.logicalDataset},{dataset:value.logicalDataset,version:value.version})?.dataset!==item.dataset;}
        catch{return true;}
      }
      // A registered original and its non-READY cache may share a durable
      // binding, but a contradictory READY physical copy stays visible.
      return value.state==='READY';
    });
    return item.versions.length&&!versions.length?null:{...item,versions};
  }).filter(item=>item!==null)};
}

// Do not forward arbitrary node metadata, owner IDs, paths or user records.
export function datasetListView(result,users,{includeEmpty=false,labelView,logicalName}={}){
  if(!Array.isArray(result?.datasets))fail('数据集目录暂时无法确认。',502);
  return {datasets:warehouseProjection(result).datasets.filter(item=>ID.test(item?.dataset)&&Array.isArray(item.versions)).map(item=>({
    dataset:item.dataset,ownerLabel:ownerView(item,users).label,
    ...(labelView?labelView(logicalName?.(item)||item.dataset):{}),
    versions:item.versions.filter(value=>HASH.test(value?.version)).map(value=>{
      const clean={version:value.version,state:STATES.has(value.state)?value.state:'UNKNOWN',canPrepare:value.canPrepare===true};
      try{warehouseCacheReference({...value,dataset:item.dataset},{dataset:item.dataset,version:value.version});}
      catch{clean.state='UNKNOWN';clean.canPrepare=false;}
      for(const field of ['bytes','files'])if(Number.isSafeInteger(value[field])&&value[field]>=0)clean[field]=value[field];
      if(HASH.test(value.operationId))clean.operationId=value.operationId;
      if(value.recoveryConfigured===true)clean.recoveryConfigured=true;
      if(typeof value.warehouseReady==='boolean')clean.warehouseReady=clean.state!=='UNKNOWN'&&value.warehouseReady;
      if(typeof value.warehouseCanPrepare==='boolean')clean.warehouseCanPrepare=value.warehouseCanPrepare===true&&clean.canPrepare;
      if(value.deletionPermissions)clean.deletionPermissions={memberAllowed:value.deletionPermissions.memberAllowed===true,reason:value.deletionPermissions.memberAllowed===true?null:'这份数据只能由管理员删除'};
      if(typeof value.error==='string')clean.error=value.error.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300);
      return clean;
    })
  })).filter(item=>includeEmpty||item.versions.length>0)};
}

function combinedOwnerLabel(locations,owners){
  const views=locations.map(location=>owners.get(location)),keys=new Set(views.map(view=>view.key).filter(key=>key!==null));
  if(keys.size>1)return '各机授权不同（见副本位置）';
  if(views.some(view=>view.key===null))return '所属用户：未知（部分节点授权信息未完整返回）';
  return views[0]?.label||'所属用户：未知';
}

// Discovery is metadata-only. The elevated principal is confined to list;
// capabilities, source selection and all mutations keep the member's own ACL.
// Admission needs only an owner-bound version grant, not a complete capacity
// scan or a READY cache. This existing personal list RPC never elevates admins.
export async function assertDatasetReadAccess(service,principal,machine,refs){
  const user=service.store.get(principal.userId),policy=authorizationPolicy(user);
  if(!user.enabled||user.username!==principal.username||(user.role||'member')!==principal.role||!user.limits?.[machine])
    fail('当前账号没有这台服务器的读取授权。',403);
  const result=await service.bridge(machine,'datasets.list',{userId:user.id,hostAdmin:false});
  if(authorizationPolicy(service.store.get(user.id))!==policy)fail('账号授权已改变。',403);
  if(!Array.isArray(result?.datasets))fail('数据集读取授权暂未确认。',503);
  const datasets=warehouseProjection(result).datasets;
  for(const ref of refs){
    const item=datasets.find(row=>row.dataset===ref.dataset&&row.versions?.some(value=>value.version===ref.version));
    if(!item||item.ownerIds!=null&&!ownerIds(item)?.includes(user.id))fail('当前账号没有数据集读取授权。',403);
  }
}

export async function datasetCatalogCall(service,principal,operation,args,{refreshRemovalExclusions=true}={}){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='machine'))fail('数据集目录参数无效。');
  let user;
  try{user=service.store.get(principal?.userId);}catch{fail('账号不存在或已停用。',403);}
  if(user?.enabled!==true||user.id!==principal?.userId)fail('账号不存在或已停用。',403);
  const machine=args.machine??null;
  if(machine!==null&&!MACHINES.some(m=>m.id===machine))fail('这台机器未授权。',403);
  const hasMachine=id=>user.limits?.[id]>0;
  const policy=authorizationPolicy(user),checkPolicy=()=>{
    let current;try{current=service.store.get(principal.userId);}catch{}
    if(service.closing||current?.enabled!==true||authorizationPolicy(current)!==policy)fail('账号授权已改变，请刷新后重试。',403);
  };
  if(!service.bridge)fail('节点执行桥尚未配置。',503);
  const owner={userId:user.id,hostAdmin:false};
  if(operation==='datasets.capacity'){
    if(machine===null||!hasMachine(machine))fail('这台机器未授权。',403);
    const value=await service.bridge(machine,'datasets.capacity',owner);
    checkPolicy();
    const result={machine,available:true};
    for(const key of ['filesystemBytes','availableBytes','reserveBytes','usableBytes']){
      if(!Number.isSafeInteger(value?.[key])||value[key]<0)fail('数据盘容量暂时无法确认。',502);
      result[key]=value[key];
    }
    for(const key of ['totalInodes','availableInodes']){
      if(value.inodeUsageKnown===true&&(!Number.isSafeInteger(value[key])||value[key]<0))fail('数据盘 inode 容量暂时无法确认。',502);
      result[key]=value.inodeUsageKnown===true?value[key]:null;
    }
    const time=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
    result.checkedAt=time(value.checkedAt);
    result.collectedAt=time(value.collectedAt)??result.checkedAt;
    if(value.storageOverview?.protocol==='dataset-storage-node-v1'){
      const byte=value=>Number.isSafeInteger(value)&&value>=0?value:null;
      const volume=value=>{
        if(!value||typeof value!=='object'||Array.isArray(value))return null;
        const bytes=Object.fromEntries(['filesystemBytes','usedBytes','availableBytes','reserveBytes','usableBytes'].map(key=>[key,byte(value[key])]));
        if(Object.values(bytes).some(value=>value===null)||bytes.usedBytes+bytes.availableBytes>bytes.filesystemBytes||
          bytes.usableBytes!==Math.max(0,bytes.availableBytes-bytes.reserveBytes))return null;
        return {...bytes,volumeDeviceId:typeof value.volumeDeviceId==='string'&&HASH.test(value.volumeDeviceId)?value.volumeDeviceId:null,
          checkedAt:time(value.checkedAt),collectedAt:time(value.collectedAt)??time(value.checkedAt),
          readOnly:typeof value.readOnly==='boolean'?value.readOnly:null,guarded:value.guarded===true};
      };
      const facts=value.storageOverview,cache=facts.cache,warehouse=facts.warehouse;
      const cacheVolume=volume(cache?.volume),warehouseVolume=warehouse?.state==='READY'?volume(warehouse.volume):null;
      const projectCollectedAt=time(cache?.projectCollectedAt),projectBytes=byte(cache?.projectBytes);
      const projectUsageComplete=cache?.projectUsageComplete===true&&projectBytes!==null&&projectCollectedAt!==null;
      // Explicit display projection: never copy private owner/project splits,
      // paths, grants or upload credentials from the raw node observation.
      result.storageOverview={protocol:facts.protocol,cache:{volume:cacheVolume,budgetBytes:byte(cache?.budgetBytes),
        projectBytes:projectUsageComplete?projectBytes:null,projectUsageComplete,projectCollectedAt},
        warehouse:warehouse===null?null:{state:warehouseVolume?'READY':'UNAVAILABLE',volume:warehouseVolume}};
      if(cacheVolume&&value.datasetFileList===1)result.datasetFileList=1;
    }
    return {...result,inodeUsageKnown:value.inodeUsageKnown===true,guarded:value.guarded===true,
      ...(value.datasetDelete===1&&service.datasetDeleteCapabilities?await service.datasetDeleteCapabilities(principal):{datasetDelete:0})};
  }
  if(operation!=='datasets.catalog')fail('未知目录操作。');
  // An explicit administrator refresh may retire a proven terminal or absent
  // exclusion. It never dispatches cleanup or invents an operation identity.
  if(refreshRemovalExclusions&&principal.role==='admin'&&service.db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dataset_removal_exclusions'").get()){
    try{await createDatasetRemovalGuard(service,principal).refreshExclusions();}
    catch(error){if(error.code!=='LAST_COPY_UNPROVEN')throw error;}
  }
  const listings=await Promise.all(MACHINES.map(async m=>{
    try{
      // This fixed service identity is confined to this literal list call.
      // It does not provision a legacy workspace for every zero-quota viewer,
      // and must never be forwarded to a content or mutation operation.
      const result=await service.bridge(m.id,'datasets.list',{userId:'builtin-admin',hostAdmin:true});
      if(!Array.isArray(result?.datasets))throw Error('invalid catalog');
      // Old nodes omit ownerIds (and large ACLs return null). An exact second
      // read as the member can prove use; missing/failed/invalid proofs cannot.
      // New deletion permissions are also actor-bound. Never copy the service
      // identity's permission hint into this member's catalog projection.
      const legacy=new Set(),memberDeletes=new Set();
      const needsProof=result.datasets.some(item=>(item?.ownerIds==null||result.datasetDelete===1&&ownerIds(item)?.includes(user.id))&&typeof item?.dataset==='string'&&ID.test(item.dataset)&&Array.isArray(item.versions)&&item.versions.some(value=>
        typeof value?.version==='string'&&HASH.test(value.version)&&(hasMachine(m.id)||service.archiveSourceAllowed?.(user.id,m.id,{dataset:item.dataset,version:value.version})===true||service.datasetIngressSourceAllowed?.(user.id,m.id,{dataset:item.dataset,version:value.version})===true)));
      if(needsProof){
        try{
          const personal=await service.bridge(m.id,'datasets.list',owner);
          for(const item of personal?.datasets||[]){
            if(typeof item?.dataset!=='string'||!ID.test(item.dataset)||!Array.isArray(item.versions))continue;
            const ids=ownerIds(item);
            if(item.ownerIds!=null&&(!ids||!ids.includes(user.id)))continue;
            for(const value of item.versions)if(typeof value?.version==='string'&&HASH.test(value.version)){
              const ref=item.dataset+'@'+value.version;legacy.add(ref);
              if(personal.datasetDelete===1&&value.deletionPermissions?.memberAllowed===true)memberDeletes.add(ref);
            }
          }
        }catch{}
      }
      return {machine:m.id,state:'ok',datasets:warehouseProjection(result).datasets,legacy,memberDeletes,datasetDelete:result.datasetDelete===1};
    }catch{return {machine:m.id,state:'unavailable',datasets:[]};}
  }));
  let capabilities;
  if(machine!==null&&hasMachine(machine))try{capabilities=await service.transferCall?.({...principal,role:'member'},'transfers.capabilities',{machine});}catch{}
  checkPolicy();
  const replicaSources=capabilities?.enabled===true&&Array.isArray(capabilities.sources)?capabilities.sources.filter(id=>MACHINES.some(m=>m.id===id)):[];
  const datasets=new Map();
  const owners=new WeakMap();
  const sourceNames=new WeakMap();
  const aliases=new Map();
  const aliasesFor=id=>{if(!aliases.has(id))aliases.set(id,service.datasetAliases?.(user.id,id));return aliases.get(id);};
  for(const listing of listings)for(const item of listing.datasets){
    if(typeof item?.dataset!=='string'||!ID.test(item.dataset)||!Array.isArray(item.versions))continue;
    for(const value of item.versions){
      if(typeof value?.version!=='string'||!HASH.test(value.version))continue;
      const ids=ownerIds(item),ref={dataset:item.dataset,version:value.version};
      const own=ids?ids.includes(user.id):item.ownerIds==null&&listing.legacy?.has(item.dataset+'@'+value.version)===true;
      const canUse=own&&(hasMachine(listing.machine)||service.archiveSourceAllowed?.(user.id,listing.machine,ref)===true||service.datasetIngressSourceAllowed?.(user.id,listing.machine,ref)===true);
      // Never apply this viewer's historical aliases to somebody else's new
      // registration. Unknown ownership needs the same precise member proof.
      const alias=own?(aliasesFor(listing.machine)?.get(item.dataset+'@'+value.version)||service.archiveAliases?.(user.id,listing.machine)?.get(item.dataset+'@'+value.version)):null;
      const name=typeof alias==='string'&&ID.test(alias)?alias:item.dataset;
      let dataset=datasets.get(name);
      if(!dataset){dataset={dataset:name,versions:new Map()};datasets.set(name,dataset);}
      let version=dataset.versions.get(value.version);
      if(!version){version={version:value.version,locations:[]};dataset.versions.set(value.version,version);}
      const ownership=ownerView(item,service.store.users);
      const pending=principal.role==='admin'?removalPending(service,listing.machine,item.dataset,value.version):null;
      // A current warehouse fact is about this node's fixed HDD source, not
      // a historical archive journal which may point at a retired authority.
      const storage=canUse&&typeof value.warehouseReady!=='boolean'?service.archiveState?.(user.id,listing.machine,ref):null;
      const memberAllowed=canUse&&listing.memberDeletes?.has(item.dataset+'@'+value.version)===true;
      let cache,invalidBinding=false;
      try{cache=warehouseCacheReference({...value,dataset:item.dataset},ref);}catch{invalidBinding=true;}
      const location={machine:listing.machine,dataset:cache?.dataset||item.dataset,ownerLabel:ownership.label,state:invalidBinding?'UNKNOWN':STATES.has(value.state)?value.state:'UNKNOWN',canUse,canPrepare:!invalidBinding&&canUse&&hasMachine(listing.machine)&&value.canPrepare===true,
        ...(Number.isSafeInteger(value.bytes)&&value.bytes>=0?{contentBytes:value.bytes}:{}),
        ...(Number.isSafeInteger(value.files)&&value.files>=0?{fileCount:value.files}:{}),
        ...(typeof value.warehouseReady==='boolean'?{warehouseReady:!invalidBinding&&value.warehouseReady}:{}),
        ...(typeof value.warehouseReady==='boolean'?{originalDataset:item.dataset}:{}),
        ...(pending?{removalPending:true,...(!pending.operation_id&&pending.registration_identity?{removalGraceEligible:true}:{})}:{}),
        deletionPermissions:{memberAllowed,reason:memberAllowed?null:'这份数据只能由管理员删除'},
        ...(storage?{storage}:{}),
        ...(canUse&&listing.machine===machine&&typeof value.error==='string'?{error:value.error.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300)}:{})};
      owners.set(location,ownership);sourceNames.set(location,item.dataset);version.locations.push(location);
      if(Number.isSafeInteger(value.bytes)&&value.bytes>=0)version.bytes=value.bytes;
      if(Number.isSafeInteger(value.files)&&value.files>=0)version.files=value.files;
    }
  }
  // Deletion still requires a machine grant; directory browsing does not.
  const deletionCapabilities=MACHINES.some(m=>hasMachine(m.id))&&listings.every(l=>l.datasetDelete)&&service.datasetDeleteCapabilities?await service.datasetDeleteCapabilities(principal):{datasetDelete:0};
  checkPolicy();
  const localAvailable=listings.find(m=>m.machine===machine)?.state==='ok',targetAllowed=machine!==null&&hasMachine(machine);
  return {machine,...deletionCapabilities,partial:listings.some(m=>m.state!=='ok'),machines:listings.map(({machine,state})=>({machine,state})),
    datasets:[...datasets.values()].sort((a,b)=>a.dataset.localeCompare(b.dataset)).map(item=>({dataset:item.dataset,
      ...(service.datasetLabelView?.(user.id,item.dataset)||{}),versions:[...item.versions.values()].sort((a,b)=>a.version.localeCompare(b.version)).map(version=>{
      const canUse=version.locations.some(l=>l.canUse),usableLocal=version.locations.filter(l=>l.machine===machine&&l.canUse);
      const local=usableLocal.find(l=>l.state==='READY')||usableLocal[0];
      const visibleLocal=version.locations.find(l=>l.machine===machine);
      const source=targetAllowed&&localAvailable&&local?.state!=='READY'&&!local?.canPrepare&&version.locations.find(l=>l.canUse&&(l.state==='READY'||l.warehouseReady===true)&&replicaSources.includes(l.machine));
      const transfer=targetAllowed&&canUse?service.datasetReplicaState?.(user.id,machine,{dataset:item.dataset,version:version.version}):null;
      // A private local READY is useful directory metadata, not proof that a
      // remote authorized version is already prepared for this member here.
      const state=local?.state==='READY'?'READY':transfer?.state||local?.state||(!canUse?visibleLocal?.state:null)||(localAvailable?'NOT_LOCAL':'UNKNOWN');
      return {...version,ownerLabel:combinedOwnerLabel(version.locations,owners),state,canUse,canPrepare:targetAllowed&&(local?.canPrepare===true||!!source),...(source?{sourceMachine:source.machine,sourceDataset:sourceNames.get(source)}:{}),...(canUse&&local?.state!=='READY'&&(transfer?.error||local?.error)?{error:transfer?.error||local?.error}:{})};
    })}))};
}
