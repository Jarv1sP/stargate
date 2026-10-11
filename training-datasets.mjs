import {authorizationPolicy,MACHINES} from './dist/model.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {setTimeout as delay} from 'node:timers/promises';

const retryScope=new AsyncLocalStorage();
const RETRYABLE_READS=new Set(['datasets.training.status','storage.training.plan']);
const RETRYABLE_ERRORS=new Set(['TRAINING_ADMISSION_BUSY','NODE_TRANSPORT_BUSY','NODE_CONNECT_FAILED',
  'NODE_RESPONSE_TIMEOUT','EXECUTOR_UNAVAILABLE','EXECUTOR_TIMEOUT','EXECUTOR_UNCONFIRMED','TRAINING_ROUTE_UNCONFIRMED']);
// Share the extra waiting across a submission; keep the existing 27s node and
// 40s client deadlines. Only reads can be repeated, never a submission/write.
export const withTrainingReadRetries=callback=>retryScope.getStore()?callback():retryScope.run({remainingMs:12000},callback);
export async function retryTrainingRead(operation,read,{check=()=>{},now=Date.now,sleep=delay}={}){
  if(!RETRYABLE_READS.has(operation))throw Error('Invalid training read retry operation');
  const budget=retryScope.getStore()||{remainingMs:12000};
  for(let attempt=0;;attempt++){
    check();const started=now();
    try{const value=await read();check();return value;}
    catch(error){
      check();
      if(error?.status===401||error?.status===403||!RETRYABLE_ERRORS.has(error?.code))throw error;
      budget.remainingMs=Math.max(0,budget.remainingMs-Math.max(0,now()-started));
      const wait=250*2**attempt;
      if(attempt>=2||budget.remainingMs<=wait)throw error;
      budget.remainingMs-=wait;await sleep(wait);
    }
  }
}

const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH=/^[a-f0-9]{64}$/;
const fail=(message,status=503,code='DATASET_TRAINING_SOURCE_UNAVAILABLE')=>{
  throw Object.assign(Error(message),{status,code});
};

/** A member-bound observation, never training admission or a reservation.
 * Only an exact local, protected fixed-version receipt can enable the switch.
 * Login/session revalidation remains the caller's bounded dataset-read lane.
 */
export async function trainingDatasetCapabilities(service,principal,args){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).sort().join(',')!=='dataset,machine,version'||
    typeof args.machine!=='string'||typeof args.dataset!=='string'||!ID.test(args.dataset)||
    typeof args.version!=='string'||!HASH.test(args.version))
    fail('仓库训练能力查询必须指定机器、数据集和固定版本。',400,'DATASET_TRAINING_CAPABILITIES_INVALID');
  const {machine,dataset,version}=args,actor={userId:principal?.userId,username:principal?.username,role:principal?.role};
  let user;try{user=service.store.get(actor.userId);}catch{}
  const host=MACHINES.find(row=>row.id===machine);
  if(!host||user?.enabled!==true||user.id!==actor.userId||user.username!==actor.username||
    (user.role||'member')!==actor.role||!(user.limits?.[machine]>0))
    fail('账号或所选服务器未授权。',403,'DATASET_TRAINING_FORBIDDEN');
  const policy=authorizationPolicy(user),check=()=>{
    let current;try{current=service.store.get(actor.userId);}catch{}
    if(current?.enabled!==true||current.id!==actor.userId||current.username!==actor.username||
      (current.role||'member')!==actor.role||!(current.limits?.[machine]>0)||authorizationPolicy(current)!==policy)
      fail('账号授权已改变，请重新登录或刷新后重试。',403,'DATASET_TRAINING_AUTH_CHANGED');
    if(service.closing)fail('服务正在关闭，仓库能力尚未确认。');
  };
  const maintained=()=>!!service.maintenanceFor?.(machine);
  const result=(reason=null)=>{
    check();
    if(maintained())reason='maintenance';
    return {protocol:1,machine,dataset,version,warehouse:{available:reason===null,reason}};
  };
  check();
  if(maintained())return result('maintenance');
  if(service.refreshGPUQ){
    try{await service.refreshGPUQ();}catch{check();return result('unverified');}
    check();if(maintained())return result('maintenance');
  }
  if(service.gpuq?.stale===false&&service.gpuq.hosts?.find(row=>row.id===machine)?.reachable===false)
    return result('offline');
  if(typeof service.bridge!=='function')return result('protocol-unavailable');
  let status;
  try{status=await retryTrainingRead('datasets.training.status',()=>service.bridge(machine,'datasets.training.status',{
    userId:actor.userId,hostAdmin:false,dataset,version,datasetReadMode:'warehouse',
  }),{check});}
  catch(error){check();return result(error?.status===403?'forbidden':'unverified');}
  check();if(maintained())return result('maintenance');
  // A response from another version/node/mode is unverified even if it says
  // READY. Missing protocol is not a fabricated claim that the node is offline.
  if(!status||typeof status!=='object'||Array.isArray(status)||status.machine!==machine||
    status.dataset!==dataset||status.version!==version||status.datasetReadMode!=='warehouse')return result('unverified');
  if(typeof status.protocol==='string'&&status.protocol!=='dataset-training-source-v1')return result('protocol-unavailable');
  if(status.protocol!=='dataset-training-source-v1')return result('unverified');
  // Host inventory/GPU class says nothing about storage. Only this exact
  // member-bound node receipt can confirm that local warehouse mode is absent.
  if(status.datasetWarehouseRead===0)return result(status.authority===null&&status.warehouseReady===false&&
    status.reference===undefined&&(status.state===undefined||status.state==='NOT_READY')?'machine-not-warehouse':'unverified');
  if(status.datasetWarehouseRead!==1||typeof status.authority!=='string'||!ID.test(status.authority)||
    typeof status.warehouseReady!=='boolean'||!['READY','NOT_READY'].includes(status.state))return result('unverified');
  if(status.state==='NOT_READY')return result(status.warehouseReady===false&&status.reference===undefined?'not-ready':'unverified');
  const reference=status.reference;
  if(status.warehouseReady!==true||!reference||typeof reference!=='object'||Array.isArray(reference)||
    Object.keys(reference).sort().join(',')!=='dataset,version'||typeof reference.dataset!=='string'||!ID.test(reference.dataset)||
    reference.version!==version)return result('unverified');
  return result();
}

// Warehouse reads are local, authenticated and explicitly requested. Never
// reinterpret a hot-cache READY or historical archive receipt as a HDD proof.
export async function resolveTrainingDataset(service,owner,machine,ref,readMode){
  if(readMode!=='warehouse'){
    if(service.resolveDataset)return service.resolveDataset(owner,machine,ref);
    const status=await service.bridge(machine,'datasets.status',{userId:owner,hostAdmin:false,...ref});
    return {status,reference:status?.state==='READY'?{...ref}:null};
  }
  const user=service.store.get(owner),policy=authorizationPolicy(user);
  const check=()=>{
    const current=service.store.get(owner);
    if(service.closing||!current.enabled||!current.limits?.[machine]||authorizationPolicy(current)!==policy)
      fail('账号或所选服务器授权已改变；未读取仓库。',403,'DATASET_TRAINING_AUTH_CHANGED');
    if(service.maintenanceFor?.(machine))fail('所选服务器正在维护；未读取仓库。',503,'MAINTENANCE_ACTIVE');
  };
  check();
  let status;
  try{status=await retryTrainingRead('datasets.training.status',()=>service.bridge(machine,'datasets.training.status',{
    userId:owner,hostAdmin:false,...ref,datasetReadMode:'warehouse',
  }),{check});}
  catch(error){
    check();
    if(error?.code==='TRAINING_ADMISSION_BUSY')fail('数据正在使用，请稍后用原提交键重试；未提交训练。',503,'TRAINING_ADMISSION_BUSY');
    if(error?.status===403)fail('仓库原件未授权；未改用缓存或其他机器。',403,'DATASET_TRAINING_FORBIDDEN');
    fail('仓库原件读取结果尚未确认；未改用缓存或其他机器。');
  }
  check();
  if(!status||status.protocol!=='dataset-training-source-v1'||status.datasetWarehouseRead!==1||
    status.machine!==machine||status.dataset!==ref.dataset||status.version!==ref.version||
    status.datasetReadMode!=='warehouse'||typeof status.authority!=='string'||!status.authority||
    typeof status.warehouseReady!=='boolean'||!['READY','NOT_READY'].includes(status.state))
    fail('服务器未确认这个版本的本机仓库直读能力；未改用缓存或其他机器。');
  if(status.state!=='READY'){
    if(status.warehouseReady||status.reference!==undefined)
      fail('仓库来源回执不一致；未提交训练。',502,'DATASET_TRAINING_SOURCE_INVALID');
    return {status,reference:null};
  }
  const physical=status.reference;
  if(!status.warehouseReady||!physical||typeof physical!=='object'||Array.isArray(physical)||
    Object.keys(physical).sort().join(',')!=='dataset,version'||!ID.test(physical.dataset)||
    !HASH.test(physical.version)||physical.version!==ref.version)
    fail('仓库原件的固定版本绑定未确认；未提交训练。',502,'DATASET_TRAINING_SOURCE_INVALID');
  return {status,reference:{...physical,...(physical.dataset!==ref.dataset?{mountAs:ref.dataset}:{})}};
}
