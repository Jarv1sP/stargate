import {authorizationPolicy} from './dist/model.js';
import {createHash,randomUUID} from 'node:crypto';
import {datasetCatalogCall,warehouseCacheReference} from './dataset-catalog.mjs';
import {prepareTrainingDataset} from './training-preparation.mjs';

// Logical names over the durable transfer service: no second copy worker,
// retry controller or byte path through the portal.
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,HASH=/^[a-f0-9]{64}$/;
const stopped=new Set(['FAILED','PAUSED','CANCELED']);
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const key=(owner,target,ref)=>createHash('sha256').update(JSON.stringify([owner,target,ref.dataset,ref.version])).digest('hex');

export function installDatasetReplication(service){
  service.db.exec('CREATE TABLE IF NOT EXISTS dataset_copies (id TEXT PRIMARY KEY, owner TEXT NOT NULL, target TEXT NOT NULL, data TEXT NOT NULL)');
  const pending=new Map();
  const load=(owner,target,ref)=>{const value=service.db.prepare('SELECT data FROM dataset_copies WHERE id=?').get(key(owner,target,ref));return value&&JSON.parse(value.data);};
  const save=row=>{if(service.closing)fail('服务正在关闭，请稍后重试。',503);service.db.prepare('INSERT INTO dataset_copies(id,owner,target,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(row.id,row.owner,row.target,JSON.stringify(row));};
  const authority=(owner,target)=>{const user=service.store.get(owner);if(!user.enabled||!user.limits[target])fail('这台机器未授权。',403);return user;};
  const principal=user=>({userId:user.id,username:user.username,role:'member'});
  const check=(owner,target,policy)=>{const user=authority(owner,target);if(service.closing||authorizationPolicy(user)!==policy)fail('账号授权已改变，请刷新后重试。',403);return user;};
  const receipt=row=>{
    if(!row)return null;
    if(row.transferId)return service.transferSnapshot?.(row.owner,row.transferId);
    // The canonical transfer is committed before its create reply. Recover by
    // the durable key before consulting a source which may since be offline.
    const value=service.transferSnapshotByKey?.(row.owner,row.key);
    if(value?.id){row.transferId=value.id;save(row);}
    return value||null;
  };
  function actual(row){
    const result=receipt(row);
    if(result?.state!=='SUCCEEDED'||typeof result.result?.dataset!=='string'||!ID.test(result.result.dataset)||result.result.version!==row.version)return null;
    return {dataset:result.result.dataset,version:row.version,mountAs:row.dataset};
  }
  function view(row){
    const value=receipt(row),failed=stopped.has(value?.state);
    // A historical SUCCEEDED cannot prove that the local cache still exists.
    return {dataset:row.dataset,version:row.version,state:failed?'FAILED':'PREPARING',phase:value?.state||'DISPATCHING',sourceMachine:row.source,
      ...(value?.id?{transferId:value.id}:{}),...(failed?{error:'跨机传输已暂停或失败；请查看传输记录后重试。'}:{})};
  }
  service.datasetReplicaState=(owner,target,ref)=>{const row=load(owner,target,ref);return row?view(row):null;};
  service.datasetAliases=(owner,target)=>{
    const aliases=new Map();
    for(const {data} of service.db.prepare('SELECT data FROM dataset_copies WHERE owner=? AND target=?').all(owner,target)){
      const row=JSON.parse(data),ref=actual(row);if(ref)aliases.set(ref.dataset+'@'+ref.version,row.dataset);
    }
    return aliases;
  };
  service.datasetPhysicalReference=(owner,target,ref)=>{
    const row=load(owner,target,ref),mapped=row&&actual(row);
    return mapped?{dataset:mapped.dataset,version:mapped.version}:{...ref};
  };
  service.resolveDataset=async(owner,target,ref)=>{
    const policy=authorizationPolicy(authority(owner,target));let status,error;
    try{status=await service.bridge(target,'datasets.status',{userId:owner,hostAdmin:false,...ref});}catch(value){error=value;}
    check(owner,target,policy);
    if(status?.dataset===ref.dataset&&status?.version===ref.version&&status.state==='READY')return {status,reference:warehouseCacheReference(status,ref)||{...ref}};
    // Validate an unexpected private binding before consulting historical
    // transfers; a malformed warehouse receipt must not select another source.
    if(status?.storageReference!==undefined)warehouseCacheReference(status,ref);
    const row=load(owner,target,ref),mapped=actual(row);
    if(mapped){
      const {mountAs,...request}=mapped;
      try{
        const result=await service.bridge(target,'datasets.status',{userId:owner,hostAdmin:false,...request});
        check(owner,target,policy);
        if(result?.dataset!==request.dataset||result.version!==request.version)fail('本机数据版本回执不符。',502);
        if(result.state==='READY'){
          // Certification is asynchronous; until it succeeds this complete
          // replica remains protected and usable, never an evictable guess.
          try{service.enqueueArchiveReplica?.(owner,target,ref,request,{machine:row.source,dataset:row.sourceDataset});}catch{}
          return {status:{...result,dataset:ref.dataset},reference:mapped};
        }
        return {status:{...result,dataset:ref.dataset},reference:null};
      }catch(value){check(owner,target,policy);if(value.status===403)throw value;return {status:{...ref,state:'UNKNOWN'},reference:null};}
    }
    if(row)return {status:view(row),reference:null};
    if(error)throw error;
    if(status?.dataset!==ref.dataset||status.version!==ref.version)fail('本机数据版本回执不符。',502);
    return {status,reference:null};
  };
  async function prepare(owner,target,ref,{retry=true,trainingJobId}={}){
    if(!ID.test(ref.dataset)||!HASH.test(ref.version))fail('数据集版本无效。',400);
    service.assertDatasetNotDeleting?.(target,ref);
    const user=authority(owner,target),policy=authorizationPolicy(user),who=principal(user);
    const localPrepare=physical=>trainingJobId?prepareTrainingDataset(service,trainingJobId,ref,physical):service.bridge(target,'datasets.prepare',{userId:owner,hostAdmin:false,...physical});
    let resolved;
    try{resolved=await service.resolveDataset(owner,target,ref);}catch(error){if(error.status===403||error.code==='WAREHOUSE_REFERENCE_INVALID')throw error;}
    check(owner,target,policy);
    if(resolved?.status.state==='READY')return resolved.status;
    if(resolved?.status.warehouseReady===true){
      if(resolved.status.warehouseCanPrepare!==true&&resolved.status.state!=='PREPARING')fail('仓库原件尚不能准备为本机训练缓存。');
      const result=await localPrepare(ref);
      check(owner,target,policy);
      if(result?.dataset!==ref.dataset||result.version!==ref.version)fail('仓库缓存准备回执不符。',502);
      if(result.state==='READY'){
        if(!warehouseCacheReference(result,ref))fail('仓库缓存的物理绑定缺失。',502);
      }else if(result.storageReference!==undefined)warehouseCacheReference(result,ref);
      return result;
    }
    if(resolved?.status.recoveryConfigured===true){
      // A disposable copy can only be restored from its private, fixed
      // authority receipt. Do not reselect another source or create a second
      // logical replica merely because the historical transfer succeeded.
      const physical=service.datasetPhysicalReference(owner,target,ref);
      const result=await localPrepare(physical);
      check(owner,target,policy);
      if(result?.dataset!==physical.dataset||result.version!==physical.version)fail('缓存恢复回执不符。',502);
      return {...result,dataset:ref.dataset};
    }
    let row=load(owner,target,ref),value=receipt(row);
    if(trainingJobId&&row&&value?.state!=='SUCCEEDED'&&row.trainingJobId!==trainingJobId)
      fail('已有准备任务必须保留原运行时；不会把旧传输升级为新训练准入。');
    if(row&&value&&stopped.has(value.state)&&!retry)return view(row);
    if(row&&value&&!stopped.has(value.state)&&value.state!=='SUCCEEDED'){
      await service.transferCall(who,'transfers.status',{id:value.id});check(owner,target,policy);
      return (await service.resolveDataset(owner,target,ref)).status;
    }
    if(row&&value&&['FAILED','PAUSED'].includes(value.state)&&retry){
      await service.transferCall(who,'transfers.resume',{id:value.id});check(owner,target,policy);return view(row);
    }
    // Capability discovery validates the real account role. The personal
    // content projection and subsequent transfer still use owner-only access;
    // pretending an administrator is a member breaks that identity check.
    const catalog=await datasetCatalogCall(service,{...who,role:user.role||'member'},'datasets.catalog',{machine:target});
    check(owner,target,policy);
    const selected=catalog.datasets.find(item=>item.dataset===ref.dataset)?.versions.find(item=>item.version===ref.version);
    // Catalog visibility is metadata only, including another owner's READY
    // copies. Only an explicitly usable version may enter the prepare path.
    if(!selected||selected.canUse!==true)fail('没有当前账号可用的数据版本；请先导入或取得读取授权。',403);
    if(selected.state==='READY')return {...ref,state:'READY'};
    if(!selected.sourceMachine){
      if(!selected.canPrepare&&selected.state!=='PREPARING')fail('目标机器没有可用的数据来源。');
      if(row)fail('跨机传输未就绪；请检查原传输记录。');
      return localPrepare(ref);
    }
    if(!service.transferCall)fail('服务器间传输尚未启用。',503);
    const fresh=!row||value?.state==='CANCELED'||value?.state==='SUCCEEDED';
    const selectedRef={dataset:selected.sourceDataset||ref.dataset,version:ref.version};
    // A new prepare prefers the certified original, not a second cache hop.
    // This is a control-plane journal lookup, never a peer-supplied root or a
    // new copy protocol. Existing UUIDs keep their original physical source.
    const original=fresh?service.archiveOriginalForCopy?.(owner,selected.sourceMachine,selectedRef):null;
    const sourceMachine=fresh?(original?.machine||selected.sourceMachine):row.source;
    const sourceRef={dataset:fresh?(original?.dataset||selectedRef.dataset):row.sourceDataset,version:ref.version};
    if(!authority(owner,target).limits[sourceMachine]&&!service.archiveSourceAllowed?.(owner,sourceMachine,sourceRef)&&!service.datasetIngressSourceAllowed?.(owner,sourceMachine,sourceRef))fail('源机器未授权。',403);
    if(fresh&&original?.machine===target){
      // Normally the earlier warehouseReady branch handles this. Do not
      // manufacture a same-node transfer when an old logical alias differs.
      if(sourceRef.dataset!==ref.dataset)fail('已确认原件在目标仓库，请按仓库中的固定数据版本准备；未建立缓存中转。');
      return localPrepare(sourceRef);
    }
    // Lost create replies reuse the durable UUID. Only an explicit retry of a
    // confirmed canceled/evicted copy receives a new transfer identity.
    if(fresh){
      row={id:key(owner,target,ref),owner,target,...ref,source:sourceMachine,sourceDataset:sourceRef.dataset,key:randomUUID(),transferId:null,...(trainingJobId?{trainingJobId}:{})};save(row);
    }
    const args={key:row.key,kind:'copy',machine:target,from:row.source,dataset:row.sourceDataset,version:row.version,name:'replica-'+row.id.slice(0,24)};
    if(trainingJobId&&!service.trainingTransferCall)fail('新训练准备协议尚未启用；不会回退旧 worker。',503);
    const result=trainingJobId?await service.trainingTransferCall(who,args,{jobId:trainingJobId,logicalReference:ref}):await service.transferCall(who,'transfers.create',args);
    // Preserve a receipt even after revocation so recovery cannot lose a job.
    row.transferId=result.id;save(row);check(owner,target,policy);
    return (await service.resolveDataset(owner,target,ref)).status;
  }
  service.prepareDataset=(owner,target,ref,options)=>{
    const id=key(owner,target,ref)+':'+(options?.trainingJobId||'legacy');if(pending.has(id))return pending.get(id);
    const task=prepare(owner,target,ref,options).finally(()=>{if(pending.get(id)===task)pending.delete(id);});pending.set(id,task);return task;
  };
}
