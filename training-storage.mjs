import {createHash} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {datasetCatalogCall} from './dataset-catalog.mjs';
import {resolveTrainingDataset} from './training-datasets.mjs';

export const TRAINING_STORAGE_PROTOCOL='training-storage-plan-v1';
const SOURCE_PROTOCOL='dataset-training-source-v1',HASH=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const fail=(message,code='TRAINING_STORAGE_UNKNOWN',status=503,storage)=>{throw Object.assign(Error(message),{status,code,
  ...(['TRAINING_STORAGE_UNKNOWN','TRAINING_STORAGE_INSUFFICIENT'].includes(code)?{trainingStorage:storage||{protocol:1,reasonCode:code,requiredBytes:null,availableBytes:null,volumes:[]}}:{})});};
const known=id=>MACHINES.some(machine=>machine.id===id);
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
export const trainingStorageDigest=args=>createHash('sha256').update(JSON.stringify(sorted(args))).digest('hex');
const required=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');

// HTTP display projection, not an admission token. Never serialize the private
// plan, device IDs, owner, authority, paths, or untrusted node error properties.
export function trainingStorageErrorBody(error){
  const value=error?.trainingStorage;
  if(!required(value,['protocol','reasonCode','requiredBytes','availableBytes','volumes'])||value.protocol!==1||
     !['TRAINING_STORAGE_UNKNOWN','TRAINING_STORAGE_INSUFFICIENT'].includes(value.reasonCode)||
     !Array.isArray(value.volumes)||value.volumes.length>2||
     ![value.requiredBytes,value.availableBytes].every(v=>v===null||count(v)))return {};
  for(const row of value.volumes){
    if(!required(row,['roles','requiredBytes','availableBytes','requiredInodes','availableInodes'])||
       !Array.isArray(row.roles)||!row.roles.length||row.roles.length>2||new Set(row.roles).size!==row.roles.length||
       row.roles.some(role=>!['project','cache'].includes(role))||
       !['requiredBytes','availableBytes','requiredInodes','availableInodes'].every(key=>count(row[key])))return {};
  }
  if(value.reasonCode==='TRAINING_STORAGE_UNKNOWN'&&(value.volumes.length||value.requiredBytes!==null||value.availableBytes!==null))return {};
  return {storage:structuredClone(value)};
}

export function projectStorageFootprint(probe,project,from){
  if(probe?.protocol!=='portable-project-v1'||probe.enabled!==true||probe.environmentMode!=='oci'||probe.releaseReady!==true||
     probe.project!==project.project||probe.release!==project.release||!known(from)||!/^sha256:[a-f0-9]{64}$/.test(probe.image)||
     !['amd64','arm64'].includes(probe.architecture)||!['codeBytes','codeEntries','imageUnpackedBytes'].every(key=>count(probe[key]))||probe.imageUnpackedBytes===0)
    fail('固定项目版本或镜像容量尚未确认；未启动准备。');
  if(probe.imageEntries!==undefined&&probe.imageEntries!==null&&!count(probe.imageEntries))fail('固定镜像文件数尚未确认；未启动准备。');
  return {sourceMachine:from,image:probe.image,architecture:probe.architecture,codeBytes:probe.codeBytes,codeEntries:probe.codeEntries,imageUnpackedBytes:probe.imageUnpackedBytes,imageEntries:probe.imageEntries??null};
}

function datasetFootprint(value,ref,mode,{ready=false,machine}={}){
  if(value?.protocol!==SOURCE_PROTOCOL||value.dataset!==ref.dataset||value.version!==ref.version||value.datasetReadMode!==mode||value.machine!==machine||
     !['bytes','files','directories','manifestBytes','footprintBytes','remainingBytes'].every(key=>count(value[key]))||value.manifestBytes===0||value.manifestBytes>64*1024**2||
     value.footprintBytes!==value.bytes+4096*(value.files+value.directories)+8192||
     ready&&value.state!=='READY'||!ready&&value.state!=='READY'&&value.canPrepare!==true)
    fail('固定数据版本的容量或读取能力尚未确认；未启动准备。');
  return {bytes:value.bytes,files:value.files,directories:value.directories,manifestBytes:value.manifestBytes};
}

// These are fresh admission snapshots, not disk reservations. Node writers
// retain their independent live, pinned-volume checks; no predicted deletion
// or display-only project-usage aggregate contributes to available capacity.
export function validateTrainingStoragePlan(value,machine,args,{now=Date.now()}={}){
  const unknown=()=>fail('目标项目／缓存卷的剩余容量尚未确认；未提交训练。');
  if(value?.protocol!==TRAINING_STORAGE_PROTOCOL||value.machine!==machine||value.owner!==args.userId||value.requestSHA256!==trainingStorageDigest(args)||
     value.noReclaim!==true||typeof value.fits!=='boolean'||!Array.isArray(value.volumes)||!value.volumes.length||value.volumes.length>2||
     typeof value.checkedAt!=='string'||!Number.isFinite(Date.parse(value.checkedAt))||Date.parse(value.checkedAt)<now-30000||Date.parse(value.checkedAt)>now+5000)unknown();
  const ids=new Set();let fits=true;
  for(const volume of value.volumes){
    if(!HASH.test(volume?.volumeDeviceId||'')||ids.has(volume.volumeDeviceId)||volume.guarded!==true||volume.readOnly!==false||
       !Array.isArray(volume.roles)||!volume.roles.length||new Set(volume.roles).size!==volume.roles.length||volume.roles.some(role=>!['project','cache'].includes(role))||
       !['availableBytes','reserveBytes','activeReservedBytes','requiredBytes','usableBytes','availableInodes','reserveInodes','activeReservedInodes','requiredInodes','usableInodes'].every(key=>count(volume[key]))||
       volume.usableBytes!==Math.max(0,volume.availableBytes-volume.reserveBytes-volume.activeReservedBytes)||
       volume.usableInodes!==Math.max(0,volume.availableInodes-volume.reserveInodes-volume.activeReservedInodes)||
       !count(volume.reserveBytes+volume.activeReservedBytes+volume.requiredBytes)||!count(volume.reserveInodes+volume.activeReservedInodes+volume.requiredInodes))unknown();
    ids.add(volume.volumeDeviceId);
    fits=volume.availableBytes>=volume.reserveBytes+volume.activeReservedBytes+volume.requiredBytes&&
      volume.availableInodes>=volume.reserveInodes+volume.activeReservedInodes+volume.requiredInodes&&fits;
  }
  if(value.volumes.filter(v=>v.roles.includes('project')).length!==1||value.volumes.filter(v=>v.roles.includes('cache')).length!==(args.datasetReadMode==='cache'&&args.datasets.length?1:0))unknown();
  const budget=value.cacheBudget;
  if(!required(budget,['enabled','budgetBytes','usedOrReservedBytes','requiredBytes'])||typeof budget.enabled!=='boolean'||
     !count(budget.usedOrReservedBytes)||!count(budget.requiredBytes)||(budget.enabled?!count(budget.budgetBytes)||budget.budgetBytes===0:budget.budgetBytes!==null))unknown();
  if(!count(budget.usedOrReservedBytes+budget.requiredBytes))unknown();
  if(budget.enabled)fits=budget.usedOrReservedBytes+budget.requiredBytes<=budget.budgetBytes&&fits;
  const quota=value.quota;
  if(!required(quota,['enabled','volumes'])||typeof quota.enabled!=='boolean'||(quota.enabled?!Array.isArray(quota.volumes)||quota.volumes.length!==ids.size:quota.volumes!==null))unknown();
  if(quota.enabled){
    const seen=new Set();
    for(const row of quota.volumes){
      const volume=value.volumes.find(v=>v.volumeDeviceId===row?.volumeDeviceId);
      if(!volume||seen.has(row.volumeDeviceId)||!['remainingBytes','remainingInodes','requiredBytes','requiredInodes'].every(key=>count(row[key]))||
         row.requiredBytes!==volume.requiredBytes||row.requiredInodes!==volume.requiredInodes)unknown();
      seen.add(row.volumeDeviceId);fits=row.remainingBytes>=row.requiredBytes&&row.remainingInodes>=row.requiredInodes&&fits;
    }
  }
  if(value.fits!==fits)unknown();
  if(!fits){
    const roles=volume=>volume.roles.map(role=>role==='project'?'项目':'缓存').join('／'),blocked=[];
    for(const volume of value.volumes){
      if(volume.availableBytes<volume.reserveBytes+volume.activeReservedBytes+volume.requiredBytes)
        blocked.push(`${roles(volume)}卷：所需 ${volume.requiredBytes} 字节，可用 ${volume.usableBytes} 字节（已扣除保留空间和在途占用）`);
      if(volume.availableInodes<volume.reserveInodes+volume.activeReservedInodes+volume.requiredInodes)
        blocked.push(`${roles(volume)}卷文件数：所需 ${volume.requiredInodes}，可用 ${volume.usableInodes}`);
    }
    if(budget.enabled&&budget.usedOrReservedBytes+budget.requiredBytes>budget.budgetBytes)
      blocked.push(`缓存预算：所需 ${budget.requiredBytes} 字节，可用 ${Math.max(0,budget.budgetBytes-budget.usedOrReservedBytes)} 字节`);
    for(const row of quota.volumes||[]){
      const label=roles(value.volumes.find(volume=>volume.volumeDeviceId===row.volumeDeviceId));
      if(row.remainingBytes<row.requiredBytes)blocked.push(`${label}个人额度：所需 ${row.requiredBytes} 字节，可用 ${row.remainingBytes} 字节`);
      if(row.remainingInodes<row.requiredInodes)blocked.push(`${label}个人文件数额度：所需 ${row.requiredInodes}，可用 ${row.remainingInodes}`);
    }
    const volumes=value.volumes.map(volume=>({roles:[...volume.roles],requiredBytes:volume.requiredBytes,availableBytes:volume.usableBytes,
      requiredInodes:volume.requiredInodes,availableInodes:volume.usableInodes}));
    const byteBlocked=volumes.filter(volume=>volume.requiredBytes>volume.availableBytes),singleByteFailure=byteBlocked.length===1&&blocked.length===1?byteBlocked[0]:null;
    fail(`指定目标的个人项目／数据缓存卷容量不足；${blocked.join('；')}。请自行清理或选择其他服务器。不会自动删除数据、换机或使用系统盘。`,'TRAINING_STORAGE_INSUFFICIENT',409,
      {protocol:1,reasonCode:'TRAINING_STORAGE_INSUFFICIENT',requiredBytes:singleByteFailure?.requiredBytes??null,
        availableBytes:singleByteFailure?.availableBytes??null,volumes});
  }
  return structuredClone(value);
}

export async function trainingStoragePlan(service,user,machine,request,{projectProbe,from,catalog,captureRequest=false}={}){
  if(!known(machine)||user?.enabled!==true||!user.limits?.[machine])fail('这台机器未授权。','TRAINING_STORAGE_FORBIDDEN',403);
  const policy=JSON.stringify(user),check=()=>{
    if(service.closing||JSON.stringify(service.store.get(user.id))!==policy)fail('账号授权已改变；未启动准备。','TRAINING_STORAGE_FORBIDDEN',403);
    if(service.maintenanceFor?.(machine))fail('目标服务器正在维护；未启动准备。');
  };
  // A node/transport exception may contain command lines, private paths, or
  // credentials. Normalize every new admission read here, after rechecking
  // the live grant; only our fixed public message and typed counters escape.
  const read=async(operation,message,{fallback=false}={})=>{
    let value;
    try{value=await operation();}
    catch(error){
      check();
      if(error?.status===403)fail('项目或数据来源未授权；未启动准备。','TRAINING_STORAGE_FORBIDDEN',403);
      if(error?.code==='TRAINING_ADMISSION_BUSY')fail('数据正在使用，请稍后用原提交键重试；未提交训练。','TRAINING_ADMISSION_BUSY',503);
      if(fallback)return undefined;
      fail(message);
    }
    check();return value;
  };
  check();
  const mode=request.datasetReadMode||'cache',project=request.project||{},logical=request.datasets||[];
  if(!['cache','warehouse'].includes(mode))fail('数据读取模式无效。','TRAINING_STORAGE_INVALID',400);
  let projectFootprint=null;
  if(project.project){
    from=from||machine;
    if(!projectProbe)projectProbe=await read(()=>service.projectCopyProbe(user.id,from,project),'固定项目版本或镜像容量尚未确认；未启动准备。');
    check();projectFootprint=projectStorageFootprint(projectProbe,project,from);
  }
  const datasets=[],datasetFootprints=[];
  for(const ref of logical){
    if(!ID.test(ref?.dataset||'')||!HASH.test(ref?.version||''))fail('数据集版本无效。','TRAINING_STORAGE_INVALID',400);
    let target=ref,source;
    if(mode==='warehouse'){
      const resolved=await read(()=>resolveTrainingDataset(service,user.id,machine,ref,mode),'本机仓库固定版本的读取能力尚未确认；未启动准备。');
      check();source=resolved.status;
      const footprint=datasetFootprint(source,ref,mode,{ready:true,machine});
      if(!resolved.reference)fail('本机仓库来源尚未 READY；未启动准备。');
      target={dataset:resolved.reference.dataset,version:resolved.reference.version};
      datasets.push(target);datasetFootprints.push({...target,...footprint});continue;
    }
    // Resolve trusted target aliases before probing, never infer a wc-/replica
    // name from its prefix or promote a remote original to local READY.
    let local;
    if(service.resolveDataset)local=await read(()=>service.resolveDataset(user.id,machine,ref),'固定数据版本尚未确认；未启动准备。',{fallback:true});
    check();
    if(local?.status.state==='READY'&&local.reference)target={dataset:local.reference.dataset,version:local.reference.version};
    source=await read(()=>service.bridge(machine,'datasets.training.status',{userId:user.id,hostAdmin:false,...target,datasetReadMode:'cache'}),'固定数据版本的容量尚未确认；未启动准备。',{fallback:true});
    check();
    let footprint;
    try{footprint=datasetFootprint(source,target,'cache',{ready:local?.status.state==='READY',machine});}catch(error){
      if(local?.status.state==='READY')throw error;
      if(!catalog)catalog=await read(()=>datasetCatalogCall(service,{userId:user.id,username:user.username,role:user.role},'datasets.catalog',{machine}),'数据目录的受信来源尚未确认；未启动准备。');
      check();
      const version=catalog.datasets?.find(d=>d.dataset===ref.dataset)?.versions?.find(v=>v.version===ref.version);
      if(version?.canUse!==true||version.canPrepare!==true||!known(version.sourceMachine)||!ID.test(version.sourceDataset||ref.dataset))throw error;
      const sourceRef={dataset:version.sourceDataset||ref.dataset,version:ref.version};
      const sourceMachine=version.sourceMachine;
      if(!user.limits[sourceMachine]&&!service.archiveSourceAllowed?.(user.id,sourceMachine,sourceRef)&&!service.datasetIngressSourceAllowed?.(user.id,sourceMachine,sourceRef))
        fail('数据来源未授权。','TRAINING_STORAGE_FORBIDDEN',403);
      source=await read(()=>service.bridge(sourceMachine,'datasets.training.status',{userId:user.id,hostAdmin:false,...sourceRef,datasetReadMode:'cache'}),'固定数据来源的容量或读取能力尚未确认；未启动准备。');
      check();footprint=datasetFootprint(source,sourceRef,'cache',{machine:sourceMachine});
    }
    datasets.push(target);datasetFootprints.push({...target,...footprint});
  }
  const args={userId:user.id,hostAdmin:false,...project,datasets,datasetReadMode:mode,projectFootprint,datasetFootprints};
  const value=await read(()=>service.bridge(machine,'storage.training.plan',args),'目标项目／缓存卷容量或新准入协议尚未确认；未启动准备。');
  check();const plan=validateTrainingStoragePlan(value,machine,args);
  return captureRequest?{plan,request:structuredClone(args)}:plan;
}
