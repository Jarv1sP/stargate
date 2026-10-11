import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {MACHINES,authorizationPolicy} from './dist/model.js';
import {archiveUploadCapability,archiveUploadSpecification} from './dist/dataset-upload.js';

// Independent from storageArchivePolicy: adding upload admission must never
// change the policy hash or reinterpret an existing archive/transfer journal.
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const USER=/^(builtin-admin|demo-user-[0-9]{1,18})$/;
const SPEC=['name','manifestBytes','manifestSha256','totalBytes','entries'];
const known=machine=>MACHINES.some(value=>value.id===machine);
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const specification=args=>({...Object.fromEntries(SPEC.map(key=>[key,args[key]])),...(args.archive?{archive:args.archive}:{})});
const validSpecification=value=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===SPEC.length+Number(!!value.archive)&&(!value.archive||archiveUploadSpecification(value.archive,value.totalBytes,value.entries))&&SPEC.every(key=>Object.hasOwn(value,key))&&
  typeof value.name==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value.name)&&
  Number.isSafeInteger(value.manifestBytes)&&value.manifestBytes>=1&&value.manifestBytes<=64*1024*1024&&
  typeof value.manifestSha256==='string'&&HASH.test(value.manifestSha256)&&
  Number.isSafeInteger(value.totalBytes)&&value.totalBytes>=0&&
  Number.isSafeInteger(value.entries)&&value.entries>=0&&value.entries<=500000;
const ADMISSION='dataset-upload-admission-v1';
const UPLOAD_STATES=new Set(['RECEIVING_MANIFEST','SEALING','UPLOADING','PUBLISHING','READY','FAILED','DISCARDING','DISCARDED']);
const authorityId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
// Match storage-archive's pre-existing policy hash exactly; never change the
// global archive policy to enable a second upload authority.
const archiveKey=value=>hash([{enabled:true,machine:value.machine,authority:value.authority}]);
const uploadFootprint=spec=>spec.totalBytes+spec.manifestBytes*4+spec.entries*8192+65536;

export function datasetIngressPolicy(input){
  if(input==null)return {enabled:false};
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.enabled!=='boolean'||
    Object.keys(input).some(key=>!['enabled','machine','authority','allowDuringMaintenance','warehouses'].includes(key))||
    input.allowDuringMaintenance!==undefined&&typeof input.allowDuringMaintenance!=='boolean')fail('Invalid trusted dataset ingress policy');
  if(!input.enabled)return {enabled:false};
  if(!known(input.machine)||typeof input.authority!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.authority))
    fail('Unknown dataset warehouse or authority');
  let warehouses;
  if(input.warehouses!==undefined){
    if(!Array.isArray(input.warehouses)||input.warehouses.length<1||input.warehouses.length>4||
      input.warehouses.some(value=>!value||Object.keys(value).sort().join(',')!=='authority,machine'||!known(value.machine)||!authorityId(value.authority))||
      new Set(input.warehouses.map(value=>value.machine)).size!==input.warehouses.length||
      new Set(input.warehouses.map(value=>value.authority)).size!==input.warehouses.length||
      !input.warehouses.some(value=>value.machine===input.machine&&value.authority===input.authority))
      fail('Invalid fixed dataset warehouse pool');
    warehouses=input.warehouses.map(value=>Object.freeze({machine:value.machine,authority:value.authority}));
  }
  return {enabled:true,machine:input.machine,authority:input.authority,
    ...(warehouses?{warehouses:Object.freeze(warehouses)}:{}),
    ...(input.allowDuringMaintenance!==undefined?{allowDuringMaintenance:input.allowDuringMaintenance}:{})};
}

// Public display metadata only; neither node health nor an upload permission.
// Keep authority IDs and private ingress configuration on the server.
export function datasetUploadAdmissionView(policy,archive){
  const available=policy?.enabled===true;
  return {protocol:1,available,targetMachine:available&&known(policy.machine)?policy.machine:null,...(available&&archiveUploadCapability(archive)?{archive:archiveUploadCapability(archive)}:{})};
}

export async function loadDatasetIngressPolicy(path){
  if(!path)return {enabled:false};
  const raw=await readFile(path,'utf8');
  if(Buffer.byteLength(raw)>4096)fail('Dataset ingress configuration is too large');
  return datasetIngressPolicy(JSON.parse(raw));
}

export function installDatasetIngress(service,input){
  const policy=datasetIngressPolicy(input);
  if(policy.enabled&&(!service.storageArchivePolicy?.enabled||service.storageArchivePolicy.machine!==policy.machine||
    service.storageArchivePolicy.authority!==policy.authority))fail('Dataset ingress requires the existing fixed HDD authority');
  service.datasetIngressPolicy=Object.freeze(policy);
  service.datasetArchiveCapability=null;
  service.db.exec('CREATE TABLE IF NOT EXISTS dataset_upload_placements (owner TEXT NOT NULL, upload_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,upload_id))');
  service.db.exec("CREATE INDEX IF NOT EXISTS dataset_upload_ready_source ON dataset_upload_placements(owner,json_extract(data,'$.storageMachine'),json_extract(data,'$.ready.dataset'),json_extract(data,'$.ready.version'))");
  service.db.exec('CREATE TABLE IF NOT EXISTS dataset_upload_admissions (owner TEXT NOT NULL, intent_key TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE, PRIMARY KEY(owner,intent_key))');
  const load=(owner,id)=>{
    const value=service.db.prepare('SELECT data FROM dataset_upload_placements WHERE owner=? AND upload_id=?').get(owner,id);
    if(!value)return null;
    const row=JSON.parse(value.data);
    if(row.protocol!==1||row.owner!==owner||row.uploadId!==id||!known(row.requestedMachine)||
      !['LOCATING','ISSUED','BOUND'].includes(row.phase)||!known(row.candidateMachine)||
      row.phase==='BOUND'&&!known(row.storageMachine)||
      row.specification&&hash(row.specification)!==row.specificationSha256)fail('Dataset upload placement journal is corrupt');
    if(row.admissionProtocol!==undefined||row.phase==='ISSUED'){
      const mapping=service.db.prepare('SELECT upload_id FROM dataset_upload_admissions WHERE owner=? AND intent_key=?').get(owner,row.admissionKey);
      if(row.admissionProtocol!==1||!UUID.test(row.admissionKey||'')||mapping?.upload_id!==id||
        row.phase==='LOCATING'||row.warehouse!==true||row.storageMachine!==row.candidateMachine||
        typeof row.authority!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.authority)||
        !validSpecification(row.specification)||hash(specification(row.specification))!==row.specificationSha256)
        fail('Dataset fresh admission journal is corrupt');
    }
    if(row.warehousePolicyKey!==undefined&&(row.admissionProtocol!==1||
      row.warehousePolicyKey!==archiveKey({machine:row.storageMachine,authority:row.authority})))
      fail('Dataset warehouse source binding is corrupt');
    return row;
  };
  const save=row=>service.db.prepare('INSERT INTO dataset_upload_placements(owner,upload_id,data) VALUES(?,?,?) ON CONFLICT(owner,upload_id) DO UPDATE SET data=excluded.data')
    .run(row.owner,row.uploadId,JSON.stringify(row));
  const lanes=new Map();let pending=0;
  const fence=(principal,row,operation='datasets.upload.begin')=>{
    const user=service.store.get(principal.userId);
    if(service.closing||!user?.enabled||user.username!==principal.username||(user.role||'member')!==principal.role||!user.limits?.[row.requestedMachine])
      fail('账号或所选训练服务器的授权已改变。',403);
    const maintenanceArgs={key:operation==='datasets.upload.admission.create'?row.admissionKey:row.uploadId,uploadId:row.uploadId};
    service.assertMaintenanceAllowed?.(operation,{...maintenanceArgs,machine:row.requestedMachine},principal);
    if(row.storageMachine&&operation!=='datasets.upload.admission.create')
      service.assertMaintenanceAllowed?.(operation,{...maintenanceArgs,machine:row.storageMachine},principal);
    return authorizationPolicy(user);
  };
  const call=async(principal,row,machine,operation,args,publicOperation=operation)=>{
    const snapshot=fence(principal,row,publicOperation);
    const result=await service.bridge(machine,operation,args);
    if(fence(principal,row,publicOperation)!==snapshot)fail('上传期间账号授权已改变。',403);
    return result;
  };
  const locate=async(principal,row,machine,publicOperation)=>{
    const result=await call(principal,row,machine,'storage.upload.locate',{userId:row.owner,uploadId:row.uploadId},publicOperation);
    if(!result||result.protocol!=='dataset-upload-location-v1'||result.machine!==machine||result.userId!==row.owner||
      result.uploadId!==row.uploadId||typeof result.present!=='boolean'||
      result.present&&!validSpecification(result.specification))fail('旧上传位置未能确认；未创建其他副本。',502);
    return result;
  };
  const placement=row=>({placementProtocol:1,requestedMachine:row.requestedMachine,storageMachine:row.storageMachine,
    storageTier:row.warehouse?'hdd':'existing',legacyPlacement:!row.warehouse});
  const remember=(row,result)=>{
    if(result?.state==='READY'){
      const expected='u-'+createHash('sha256').update(row.owner).digest('hex').slice(0,16)+'-'+row.specification.name;
      if(result.uploadId!==row.uploadId||result.dataset!==expected||!HASH.test(result.version||'')||
        result.totalBytes!==row.specification.totalBytes||result.entries!==row.specification.entries)
        fail('仓库发布回执与上传身份不匹配。',502);
      row.ready={dataset:result.dataset,version:result.version};save(row);
    }else if(['DISCARDING','DISCARDED','FAILED'].includes(result?.state)&&row.ready){
      delete row.ready;save(row);
    }
    return {...result,...placement(row)};
  };
  const sourceRows=(owner,machine,ref)=>ref?
    service.db.prepare("SELECT data FROM dataset_upload_placements WHERE owner=? AND json_extract(data,'$.storageMachine')=? AND json_extract(data,'$.ready.dataset')=? AND json_extract(data,'$.ready.version')=?").all(owner,machine,ref.dataset,ref.version):
    service.db.prepare("SELECT data FROM dataset_upload_placements WHERE owner=? AND json_extract(data,'$.storageMachine')=? AND json_extract(data,'$.ready.dataset') IS NOT NULL").all(owner,machine);
  const sourceAllowed=(owner,machine,ref)=>{
    if(!USER.test(owner)||!known(machine)||!ref||!HASH.test(ref.version||''))return false;
    const user=service.store.get(owner);
    if(!user?.enabled)return false;
    return sourceRows(owner,machine,ref).some(value=>{
      const row=JSON.parse(value.data);
      return row.phase==='BOUND'&&row.warehouse===true&&row.storageMachine===machine&&user.limits?.[row.requestedMachine]&&
        row.ready?.dataset===ref.dataset&&row.ready.version===ref.version&&
        !service.datasetDeletionBlocked?.(machine,ref);
    });
  };
  service.datasetIngressSourceAllowed=sourceAllowed;
  // Visibility is only capability metadata. The actual copy request must
  // still prove the precise READY tuple through sourceAllowed above.
  service.datasetIngressMachineVisible=(owner,machine)=>USER.test(owner)&&known(machine)&&sourceRows(owner,machine).some(value=>{
    const row=JSON.parse(value.data);return row.ready&&sourceAllowed(owner,machine,row.ready);
  });

  const warehouseConfigured=(machine,authority)=>policy.enabled&&(policy.warehouses||[policy]).some(value=>
    value.machine===machine&&value.authority===authority);
  const bindingOf=row=>({protocol:1,uploadId:row.uploadId,admissionKey:row.admissionKey,
    machine:row.storageMachine,authority:row.authority,policyKey:row.warehousePolicyKey});
  // Only exact post-admission outbox identities can create pool archives.
  // An unrelated/old event retains legacy routing; an invalid matching intent
  // is an error, not permission to fall back to the global default warehouse.
  service.datasetIngressArchiveEventBinding=(machine,event)=>{
    const row=load(event.userId,event.id);
    if(!row||row.warehousePolicyKey===undefined)return null;
    const dataset='u-'+createHash('sha256').update(row.owner).digest('hex').slice(0,16)+'-'+row.specification.name;
    if(row.phase!=='BOUND'||row.storageMachine!==machine||event.dataset!==dataset||!HASH.test(event.version||'')||
      event.state!=='READY'||
      row.ready&&(row.ready.dataset!==event.dataset||row.ready.version!==event.version))
      fail('Archive event does not match its fixed warehouse admission');
    // The authenticated node outbox is a READY publication receipt. This also
    // closes the lost final HTTP ACK case without probing/copying other nodes.
    if(!row.ready){row.ready={dataset:event.dataset,version:event.version};save(row);}
    return bindingOf(row);
  };
  service.datasetIngressArchiveBindingValid=(owner,binding,ref)=>{
    if(!binding||Object.keys(binding).sort().join(',')!=='admissionKey,authority,machine,policyKey,protocol,uploadId'||
      binding.protocol!==1||!UUID.test(binding.uploadId||'')||!UUID.test(binding.admissionKey||''))return false;
    const row=load(owner,binding.uploadId);
    return Boolean(row?.warehousePolicyKey&&row.phase==='BOUND'&&
      hash(bindingOf(row))===hash(binding)&&
      row.ready?.dataset===ref.dataset&&row.ready?.version===ref.version);
  };

  const currentPolicy=row=>{
    const archive=service.storageArchivePolicy;
    const matches=row.warehousePolicyKey!==undefined?
      warehouseConfigured(row.candidateMachine,row.authority)&&row.warehousePolicyKey===archiveKey({machine:row.candidateMachine,authority:row.authority}):
      policy.machine===row.candidateMachine&&policy.authority===row.authority&&
      archive?.machine===row.candidateMachine&&archive?.authority===row.authority;
    if(service.datasetIngressPolicy!==policy||!policy.enabled||archive?.enabled!==true||!matches)
      fail('入库策略已改变；此待确认上传未派发，请联系管理员核对。');
  };
  // A protected operator policy may open only new HDD intake while compute
  // and old-data cleanup remain in maintenance. This never unlocks projects,
  // terminal input, SSD uploads, transfers, cache preparation or legacy keys.
  service.warehouseMaintenanceUploadAllowed=(operation,args,principal)=>{
    if(!policy.enabled||policy.allowDuringMaintenance!==true||!principal||!args||
      service.storageArchivePolicy?.enabled!==true||service.storageArchivePolicy.machine!==policy.machine||
      service.storageArchivePolicy.authority!==policy.authority)return false;
    const actor=service.store.get(principal.userId);
    if(!actor?.enabled||(actor.role||'member')!==principal.role)return false;
    if(operation==='datasets.upload.admission.create')
      return known(args.machine)&&Boolean(actor.limits?.[args.machine])&&UUID.test(args.key||'');
    if(!['storage.upload.admit','datasets.upload.begin','datasets.upload.manifest','datasets.upload.seal',
      'datasets.upload.chunk','datasets.upload.commit','datasets.upload.discard','datasets.upload.direct-ticket'].includes(operation))return false;
    const id=operation==='datasets.upload.begin'?args.key:args.uploadId;
    if(!UUID.test(id||''))return false;
    const row=load(principal.userId,id);
    if(row?.admissionProtocol!==1||row.warehouse!==true||!warehouseConfigured(row.storageMachine,row.authority)||
      !actor.limits?.[row.requestedMachine]||
      ![row.requestedMachine,row.storageMachine].includes(args.machine))return false;
    if(operation==='storage.upload.admit'&&(args.intentKey!==row.admissionKey||args.protocol!==ADMISSION||
      args.requestedMachine!==row.requestedMachine||args.storageMachine!==row.storageMachine||
      args.authority!==row.authority||hash(args.specification)!==row.specificationSha256||
      args.specificationSha256!==row.specificationSha256))return false;
    return true;
  };
  const admissionView=row=>({protocol:ADMISSION,key:row.admissionKey,uploadId:row.uploadId,
    requestedMachine:row.requestedMachine,storageMachine:row.storageMachine,storageTier:'hdd',
    specification:structuredClone(row.specification),state:row.phase});
  const selectWarehouse=async(principal,request,spec)=>{
    if(!policy.warehouses)return policy; // Exact legacy single-warehouse wire contract.
    const requiredBytes=uploadFootprint(spec),requiredInodes=spec.entries+16;
    if(!Number.isSafeInteger(requiredBytes))fail('上传清单的实际空间需求超出精确计数范围。',400);
    for(const candidate of policy.warehouses){
      // No user-selectable root, warning watermark, personal quota or fallback
      // data path. These bounded observations precede any durable placement.
      if(service.maintenanceFor?.(candidate.machine)&&policy.allowDuringMaintenance!==true)continue;
      let result;
      try{result=await call(principal,request,candidate.machine,'storage.upload.locate',{
        userId:request.owner,uploadId:request.uploadId,authority:candidate.authority,specification:spec},'datasets.upload.admission.create');}
      catch(error){if(error.status===403||error.code==='MAINTENANCE_ACTIVE'||service.closing)throw error;continue;}
      const capacity=result?.capacity;
      if(result?.protocol!=='dataset-upload-location-v1'||result.machine!==candidate.machine||
        result.userId!==request.owner||result.uploadId!==request.uploadId||result.present!==false||
        result.authority?.enabled!==true||result.authority.machine!==candidate.machine||result.authority.authority!==candidate.authority||
        capacity?.protocol!=='dataset-upload-capacity-v1'||capacity.machine!==candidate.machine||capacity.authority!==candidate.authority||
        capacity.specificationSha256!==hash(spec)||capacity.requiredBytes!==requiredBytes||capacity.requiredInodes!==requiredInodes||
        capacity.writable!==true||![capacity.availableBytes,capacity.availableInodes].every(value=>Number.isSafeInteger(value)&&value>=0))continue;
      if(capacity.availableBytes>=requiredBytes&&capacity.availableInodes>=requiredInodes)return candidate;
    }
    fail('没有已确认可写且容量足够的数据仓库；未创建上传或改走缓存。',503);
  };
  const admission=async(principal,action,args)=>{
    const owner=principal.userId,key=args.key,operation='datasets.upload.'+action;
    if(!USER.test(owner)||!UUID.test(key||''))fail('无效的上传准入意图。',400);
    const lane='admission/'+owner+'/'+key;
    const write=action==='admission.create';
    if(write&&(lanes.has(lane)||pending>=8))fail('上传控制繁忙，请稍后重试。',429);
    if(write){lanes.set(lane,true);pending++;}
    try{
      const mapping=service.db.prepare('SELECT upload_id FROM dataset_upload_admissions WHERE owner=? AND intent_key=?').get(owner,key);
      if(mapping){
        const row=load(owner,mapping.upload_id);
        if(!row||row.admissionKey!==key)fail('Dataset fresh admission mapping is corrupt');
        if(row.requestedMachine!==args.machine)fail('此上传已绑定原先选择的服务器；请使用原服务器继续。');
        if(action==='admission.create'&&hash(specification(args))!==row.specificationSha256)fail('此上传意图已绑定另一份清单。');
        fence(principal,row,operation);
        if(action==='admission.create'&&row.phase==='ISSUED')currentPolicy(row);
        return admissionView(row);
      }
      fence(principal,{requestedMachine:args.machine,admissionKey:key},operation);
      if(service.db.prepare("SELECT upload_id FROM dataset_upload_placements WHERE owner=? AND json_extract(data,'$.admissionKey')=?").get(owner,key))
        fail('Dataset fresh admission mapping is corrupt');
      if(action==='admission.status'){
        if(lanes.has(lane))fail('原上传准入仍在检查；请保留原意图稍后查询。',503);
        throw Object.assign(Error('这条上传意图尚未准入；再次发起同一上传可用原意图重试。'),
          {status:404,code:'DATASET_ADMISSION_ABSENT'});
      }
      if(!policy.enabled)fail('机械仓库新上传准入尚未启用。',503);
      const spec=specification(args);
      if(!validSpecification(spec))fail('上传准入清单无效。',400);
      if(archiveUploadCapability(service.datasetArchiveCapability)&&!spec.archive)throw Object.assign(Error('仓库只接受单个压缩包。'),{status:409,code:'ARCHIVE_FORMAT_UNSUPPORTED'});
      const identity={owner,uploadId:randomUUID(),requestedMachine:args.machine,admissionKey:key};
      const selected=policy.warehouses?await selectWarehouse(principal,identity,spec):policy;
      if(spec.archive){
        const route=await call(principal,identity,selected.machine,'datasets.upload.routes',{userId:owner,hostAdmin:false},operation);
        const capability=archiveUploadCapability(route?.archive);
        if(!capability||!capability.formats.includes(spec.archive.format))throw Object.assign(Error('服务器尚未开通此压缩包格式。'),{status:409,code:'ARCHIVE_FORMAT_UNSUPPORTED'});
        if(capability.maxBytes!==null&&spec.archive.bytes>capability.maxBytes)throw Object.assign(Error('压缩包过大。'),{status:413,code:'ARCHIVE_TOO_LARGE'});
        if(!route.routes?.some(value=>value.kind==='campus-direct'))throw Object.assign(Error('校内直连暂不可用。'),{status:503,code:'CAMPUS_ROUTE_UNAVAILABLE'});
      }

      const row={protocol:1,...identity,
        candidateMachine:selected.machine,storageMachine:selected.machine,authority:selected.authority,
        phase:'ISSUED',warehouse:true,createdAt:Date.now(),admissionProtocol:1,admissionKey:key,
        specification:spec,specificationSha256:hash(spec),
        ...(policy.warehouses?{warehousePolicyKey:archiveKey(selected)}:{})};
      currentPolicy(row);fence(principal,row,operation);
      // Both identities commit together, before any warehouse admission/write RPC. The
      // caller's intent key is never used as the node's fresh upload ID.
      service.db.exec('BEGIN IMMEDIATE');
      try{
        if(service.db.prepare('SELECT count(*) AS count FROM dataset_upload_placements').get().count>=10000)
          fail('上传位置历史已达上限，请联系管理员归档。');
        if(row.uploadId===key||service.db.prepare('SELECT upload_id FROM dataset_upload_placements WHERE upload_id=?').get(row.uploadId))
          fail('新上传身份发生冲突；未派发，请联系管理员核对。');
        service.db.prepare('INSERT INTO dataset_upload_placements(owner,upload_id,data) VALUES(?,?,?)').run(owner,row.uploadId,JSON.stringify(row));
        service.db.prepare('INSERT INTO dataset_upload_admissions(owner,intent_key,upload_id) VALUES(?,?,?)').run(owner,key,row.uploadId);
        service.db.exec('COMMIT');
      }catch(error){service.db.exec('ROLLBACK');throw error;}
      return admissionView(row);
    }finally{if(write){lanes.delete(lane);pending--;}}
  };

  service.datasetUploadIngress=async(principal,action,args)=>{
    if(action==='admission.create'||action==='admission.status')return admission(principal,action,args);
    const owner=principal.userId,id=action==='begin'?args.key:args.uploadId;
    // Preflight has no upload identity yet and therefore cannot resume or
    // rebind a session. Its advertised machine is explicit, not transparent.
    if(action==='routes'&&id===undefined){
      const target=policy.enabled?policy.machine:args.machine;
      const row={owner,requestedMachine:args.machine,storageMachine:target};
      const value=await call(principal,row,target,'datasets.upload.routes',{userId:owner,hostAdmin:false});
      service.datasetArchiveCapability=policy.enabled?archiveUploadCapability(value?.archive):null;
      return {...value,requestedMachine:args.machine,storageMachine:target,storageTier:policy.enabled?'hdd':'existing',
        ...(policy.enabled?{placementProtocol:1,legacyPlacement:false}:{})};
    }
    if(!USER.test(owner)||!UUID.test(id||''))fail('无效的上传身份。',400);
    const lane=owner+'/'+id;
    if(lanes.has(lane))fail('该上传已有操作正在执行，请稍后重试。',429);
    if(pending>=8)fail('上传控制繁忙，请稍后重试。',429);
    lanes.set(lane,true);pending++;
    try{
      let row=load(owner,id);
      if(!row&&!policy.enabled)return service.bridge(args.machine,'datasets.upload.'+action,
        {...Object.fromEntries(Object.entries(args).filter(([key])=>key!=='machine'&&(action!=='routes'||key!=='uploadId'))),userId:owner,hostAdmin:false});
      if(row&&row.requestedMachine!==args.machine)fail('此上传已绑定原先选择的服务器；请使用原服务器继续。');
      if(row?.specification?.archive&&['manifest','chunk'].includes(action))throw Object.assign(Error('压缩包只走校内直连。'),{status:403,code:'CAMPUS_ROUTE_UNAVAILABLE'});
      if(action==='begin'&&row?.specificationSha256&&row.specificationSha256!==hash(specification(args)))
        fail('此上传编号已绑定另一份清单。');
      if(!row){
        row={protocol:1,owner,uploadId:id,requestedMachine:args.machine,candidateMachine:policy.machine,
          authority:policy.authority,phase:'LOCATING',createdAt:Date.now(),
          ...(action==='begin'?{specification:specification(args),specificationSha256:hash(specification(args))}:{})};
        if(service.db.prepare('SELECT count(*) AS count FROM dataset_upload_placements').get().count>=10000)
          fail('上传位置历史已达上限，请联系管理员归档。');
        if(action==='begin')save(row); // Intent is durable before any admission.
      }
      fence(principal,row,'datasets.upload.'+action);
      if(row.specification?.archive&&action==='direct-ticket'){
        const routes=await call(principal,row,row.storageMachine,'datasets.upload.routes',{userId:owner,hostAdmin:false});
        const route=routes.routes?.find(route=>route.id===args.routeId&&route.kind==='campus-direct');
        if(!route)throw Object.assign(Error('压缩包只走校内直连。'),{status:403,code:'CAMPUS_ROUTE_UNAVAILABLE'});
      }

      if(row.admissionProtocol===1){
        if(action==='status'){
          const journalSnapshot=hash(row),policySnapshot=hash([service.datasetIngressPolicy,service.storageArchivePolicy]);
          if(row.phase==='ISSUED')currentPolicy(row);
          const located=await locate(principal,row,row.storageMachine,'datasets.upload.status');
          if(located.uploadAdmissionProtocol!==1||located.initializationProtocol!==1||
            located.nodePresent!==located.present)fail('仓库上传初始化状态未获权威确认；未改换编号或位置。',502);
          if(!located.present){
            // Missing may authorize an explicit same-ID begin. Unlike reads
            // of an existing upload, this needs the original intake policy
            // and immutable journal to remain current across the node read.
            currentPolicy(row);
            if(hash([service.datasetIngressPolicy,service.storageArchivePolicy])!==policySnapshot)
              fail('入库策略已改变；未授予重新初始化，请核对原上传。');
            const current=load(owner,id);
            if(!current||hash(current)!==journalSnapshot)
              fail('上传准入记录已改变；未授予重新初始化，请核对原上传。',502);
            if(row.ready||located.state!=='NOT_INITIALIZED'||located.authority?.enabled!==true||
              located.authority.machine!==row.storageMachine||located.authority.authority!==row.authority)
              fail('仓库未初始化证明与固定上传权威不匹配；未改换编号或位置。',502);
            // BOUND is only the durable dispatch attempt. This exact node
            // proof, not an HTTP/ENOENT error or Portal row, permits same-ID
            // recovery. No admission allocation or node write occurs here.
            return {...row.specification,uploadId:row.uploadId,userId:owner,state:'NOT_INITIALIZED',
              initializationProtocol:1,nodePresent:false,manifestOffset:0,
              admissionProtocol:1,admissionKey:row.admissionKey,...placement(row)};
          }
          if(row.phase!=='BOUND'||located.admissionProtocol!==1||located.admissionKey!==row.admissionKey||
            located.requestedMachine!==row.requestedMachine||located.storageMachine!==row.storageMachine||
            located.admissionAuthority!==row.authority||!validSpecification(located.specification)||
            hash(specification(located.specification))!==row.specificationSha256)
            fail('仓库已初始化回执与固定上传准入不匹配；未改换编号或位置。',502);
          const {machine,...request}=args;
          const result=await call(principal,row,row.storageMachine,'datasets.upload.status',
            {...request,userId:owner,hostAdmin:false});
          if(!result||result.uploadId!==row.uploadId||!UPLOAD_STATES.has(result.state)||
            ['name','manifestBytes','totalBytes','entries'].some(key=>result[key]!==row.specification[key]))
            fail('仓库上传状态与固定上传准入不匹配；未改换编号或位置。',502);
          return remember(row,{...result,initializationProtocol:1,nodePresent:true,userId:owner,
            admissionProtocol:1,admissionKey:row.admissionKey});
        }
        if(row.phase==='ISSUED'){
          if(action!=='begin')fail('此上传尚未向仓库准入；请按原意图核对并继续。');
          currentPolicy(row);
          // BOUND records the fixed dispatch attempt, not a successful node
          // admission. Unknown replies retain this route across restart.
          row.phase='BOUND';save(row);
        }
        if(action==='begin'){
          const result=await call(principal,row,row.storageMachine,'storage.upload.admit',{
            userId:owner,hostAdmin:false,protocol:ADMISSION,intentKey:row.admissionKey,
            uploadId:row.uploadId,requestedMachine:row.requestedMachine,storageMachine:row.storageMachine,
            authority:row.authority,specification:row.specification,specificationSha256:row.specificationSha256,
            ...(args.allowRelay!==undefined?{allowRelay:args.allowRelay}:{})},'datasets.upload.begin');
          if(!result||result.admissionProtocol!==1||result.admissionKey!==row.admissionKey||
            result.machine!==row.storageMachine||result.authority!==row.authority||result.uploadId!==row.uploadId||
            ['name','manifestBytes','totalBytes','entries'].some(key=>result[key]!==row.specification[key])||
            !UPLOAD_STATES.has(result.state)||!Number.isSafeInteger(result.manifestOffset)||
            result.manifestOffset<0||result.manifestOffset>row.specification.manifestBytes||
            result.chunkBytes!==1024*1024||result.uploadTransport?.protocol!=='dataset-upload-v1'||
            typeof result.uploadTransport.directAvailable!=='boolean')
            fail('机械仓库准入回执与固定上传意图不匹配；未改换编号或位置。',502);
          return remember(row,result);
        }
      }
      if(row.phase==='LOCATING'){
        // Exact owner/key observations only. Errors are never interpreted as
        // absence. Probe all configured nodes to prevent duplicate old keys.
        const found=await Promise.all(MACHINES.map(async machine=>({machine:machine.id,...await locate(principal,row,machine.id,'datasets.upload.'+action)})));
        const existing=found.filter(value=>value.present);
        if(existing.length>1)fail('同一上传编号存在于多台服务器；请联系管理员确认，未写入数据。');
        if(existing.length===1){
          const prior=existing[0];
          if(prior.machine!==row.requestedMachine)fail('旧上传存在于另一台服务器；请使用原来的服务器继续。');
          const priorSpec=specification(prior.specification);
          if(row.specificationSha256&&hash(priorSpec)!==row.specificationSha256)
            fail('旧上传的固定清单与本次上传不一致。');
          row.specification=priorSpec;row.specificationSha256=hash(priorSpec);
          row.storageMachine=prior.machine;row.warehouse=false;
        }else{
          if(action!=='begin')fail('上传不存在；恢复已有仓库上传需要原平台的位置记录。',404);
          // A caller-provided UUID is not evidence of an old session. Only
          // the server-issued admission path may create a fresh HDD upload.
          // Preserve this LOCATING journal: never silently rekey or relabel it.
          fail('原上传编号在所有节点均不存在；请升级 gpuctl 并使用数据仓库的新上传入口。',409);
        }
        row.phase='BOUND';save(row);
      }
      const {machine,uploadId,...request}=args;
      const payload={...request,...(action!=='begin'&&action!=='routes'?{uploadId}:{}),userId:owner,hostAdmin:false};
      const result=await call(principal,row,row.storageMachine,'datasets.upload.'+action,payload);
      return remember(row,result);
    }finally{lanes.delete(lane);pending--;}
  };
  return {policy,load};
}
