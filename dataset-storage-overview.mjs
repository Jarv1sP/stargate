import {authorizationPolicy,MACHINES} from './dist/model.js';
import {datasetCatalogCall} from './dataset-catalog.mjs';

export const STORAGE_OVERVIEW_TIMEOUT_MS=4000;
export const STORAGE_OVERVIEW_TTL_MS=60000;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const byte=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
// Preserve real collection times; successful capacity snapshots expire after
// sixty seconds and never acquire a new timestamp on a cache hit.
const observations=new WeakMap();
const capacities=new WeakMap();
function lastCollected(service,key,value){
  let times=observations.get(service);if(!times){times=new Map();observations.set(service,times);}
  if(value!==null&&(!times.has(key)||Date.parse(value)>Date.parse(times.get(key))))times.set(key,value);
  return times.get(key)??null;
}
const sum=values=>{
  let result=0;
  for(const value of values){if(value===null||!Number.isSafeInteger(result+value))return null;result+=value;}
  return result;
};
const consistent=(locations,key)=>{
  const values=locations.map(location=>byte(location[key]));
  return values.length&&values.every(value=>value!==null&&value===values[0])?values[0]:null;
};

function volumeView(machine,value){
  const unknown={id:null,state:'UNKNOWN',checkedAt:null,collectedAt:null,totalBytes:null,usedBytes:null,availableBytes:null,reserveBytes:null,usableBytes:null,readOnly:null,guarded:false};
  if(!value||typeof value!=='object'||Array.isArray(value))return unknown;
  const totalBytes=byte(value.filesystemBytes),usedBytes=byte(value.usedBytes),availableBytes=byte(value.availableBytes),reserveBytes=byte(value.reserveBytes),usableBytes=byte(value.usableBytes);
  if([totalBytes,usedBytes,availableBytes,reserveBytes,usableBytes].some(value=>value===null)||usedBytes>totalBytes||availableBytes>totalBytes||usedBytes+availableBytes>totalBytes||usableBytes!==Math.max(0,availableBytes-reserveBytes))return unknown;
  return {id:typeof value.volumeDeviceId==='string'&&/^[a-f0-9]{64}$/.test(value.volumeDeviceId)?machine+':'+value.volumeDeviceId:null,
    state:'READY',checkedAt:timestamp(value.checkedAt),collectedAt:timestamp(value.collectedAt)??timestamp(value.checkedAt),totalBytes,usedBytes,availableBytes,reserveBytes,usableBytes,
    readOnly:typeof value.readOnly==='boolean'?value.readOnly:null,guarded:value.guarded===true};
}

function capacityView(service,machine,value){
  const versioned=value?.storageOverview?.protocol==='dataset-storage-node-v1',facts=versioned?value.storageOverview:null;
  const volume=volumeView(machine,versioned?facts.cache?.volume:value);
  volume.collectedAt=lastCollected(service,machine+':cache',volume.collectedAt);
  const budgetBytes=byte(versioned?facts.cache?.budgetBytes:value?.datasetBudgetBytes);
  const projectCollectedAt=lastCollected(service,machine+':projects',timestamp(facts?.cache?.projectCollectedAt));
  const projectUsageComplete=facts?.cache?.projectUsageComplete===true&&byte(facts.cache.projectBytes)!==null&&timestamp(facts.cache.projectCollectedAt)!==null;
  const projectBytes=projectUsageComplete?facts.cache.projectBytes:null;
  let warehouse=null;
  if(versioned&&facts.warehouse!==null){
    const candidate=volumeView(machine,facts.warehouse?.volume);
    candidate.collectedAt=lastCollected(service,machine+':warehouse',candidate.collectedAt);
    warehouse={machine,state:facts.warehouse?.state==='READY'&&candidate.state==='READY'?'READY':'UNAVAILABLE',volume:candidate};
  }
  return {machine,state:volume.state==='READY'?'READY':'UNKNOWN',volume,budgetBytes,projectBytes,projectUsageComplete,projectCollectedAt,warehouse,warehouseKnown:versioned,
    fileListCapability:value?.datasetFileList===1&&volume.state==='READY'};
}

function unknownCapacity(service,machine){
  return {machine,state:'UNKNOWN',reason:'timeout',volume:{...volumeView(machine,null),collectedAt:lastCollected(service,machine+':cache',null)},budgetBytes:null,
    projectBytes:null,projectUsageComplete:false,projectCollectedAt:lastCollected(service,machine+':projects',null),warehouse:null,warehouseKnown:false};
}

function readCapacity(service,machine){
  let nodes=capacities.get(service);if(!nodes){nodes=new Map();capacities.set(service,nodes);}
  let record=nodes.get(machine);
  if(record?.expires>Date.now())return Promise.resolve(record.value);
  if(record?.pending)return record.pending;
  record={value:null,expires:0,pending:null};nodes.set(machine,record);
  let timer;
  // This literal service read is metadata-only; cached facts never grant ACLs.
  const work=Promise.resolve().then(()=>service.bridge(machine,'datasets.capacity',{userId:'builtin-admin',hostAdmin:true}))
    .then(value=>capacityView(service,machine,value)).then(value=>{
      if(value.state==='READY'){record.value=value;record.expires=Date.now()+STORAGE_OVERVIEW_TTL_MS;}
      return value;
    });
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(unknownCapacity(service,machine)),STORAGE_OVERVIEW_TIMEOUT_MS);});
  record.pending=Promise.race([work,deadline]).catch(()=>unknownCapacity(service,machine)).finally(()=>clearTimeout(timer));
  // A timed-out SSH read keeps its lane until it ends; refresh cannot pile up
  // copies of the same hung request. A late successful reply may seed the cache.
  Promise.allSettled([work,record.pending]).then(()=>{record.pending=null;});
  return record.pending;
}

function catalogWithinDeadline(service){
  const view=Object.create(service),deadline=Date.now()+STORAGE_OVERVIEW_TIMEOUT_MS;
  view.bridge=async(machine,operation,args)=>{
    const remaining=deadline-Date.now();
    if(remaining<=0)throw Error('timeout');
    let timer;
    try{return await Promise.race([Promise.resolve().then(()=>service.bridge(machine,operation,args)),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error('timeout')),remaining);
    })]);}finally{clearTimeout(timer);}
  };
  return view;
}

function warning(machine,code){return {machine,code};}
function warehouseWarnings(machine,volume){
  if(volume.state!=='READY')return [warning(machine,'WAREHOUSE_CAPACITY_UNKNOWN')];
  const result=[];
  // Display-only watermarks, never per-user quotas or admission decisions.
  if(volume.totalBytes>0&&volume.usedBytes/volume.totalBytes>=0.9)result.push(warning(machine,'WAREHOUSE_USAGE_HIGH'));
  if(volume.availableBytes<=volume.reserveBytes)result.push(warning(machine,'WAREHOUSE_FREE_SPACE_LOW'));
  if(volume.readOnly===true)result.push(warning(machine,'WAREHOUSE_READ_ONLY'));
  return result;
}

/** Authenticated metadata projection; not a download/preview or mutation grant.
 * Existing node catalogs remain authoritative. No second registry, allocation,
 * lease mutation or user workspace is created. Project usage comes only from
 * the node's bounded cached observation, never a Portal tree walk.
 */
export async function datasetStorageOverviewCall(service,principal,args){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)fail('存储总览不接受额外参数。');
  let user;try{user=service.store.get(principal?.userId);}catch{}
  if(user?.enabled!==true||user.id!==principal?.userId)fail('账号不存在或已停用。',403);
  if(!service.bridge)fail('节点执行桥尚未配置。',503);
  const policy=authorizationPolicy(user),checkPolicy=()=>{
    let current;try{current=service.store.get(principal.userId);}catch{}
    if(service.closing||current?.enabled!==true||authorizationPolicy(current)!==policy)fail('账号授权已改变，请刷新后重试。',403);
  };
  // Independent fixed metadata reads share one elapsed window. Waiting for
  // every catalog before starting capacities doubles an offline node's bridge
  // deadline and makes a healthy warehouse disappear behind client timeouts.
  // Neither branch grants access; both revalidate the actor before projection.
  const [catalog,nodes]=await Promise.all([
    datasetCatalogCall(catalogWithinDeadline(service),principal,'datasets.catalog',{},{refreshRemovalExclusions:false}),
    Promise.all(MACHINES.map(({id})=>readCapacity(service,id)))
  ]);
  checkPolicy();
  const usage=new Map(nodes.map(node=>{
    const readable=catalog.machines.find(row=>row.machine===node.machine)?.state==='ok';
    return [node.machine,{sizes:[],versions:new Set(),readable,complete:readable}];
  }));
  const originals=new Map(nodes.filter(node=>node.warehouse).map(node=>[node.machine,{sizes:[],datasets:new Set(),versions:new Set(),complete:catalog.machines.find(row=>row.machine===node.machine)?.state==='ok'}]));
  const datasets=catalog.datasets.map(item=>({dataset:item.dataset,...(typeof item.displayName==='string'?{displayName:item.displayName}:{}),versions:item.versions.map(version=>{
    const contentBytes=consistent(version.locations,'contentBytes'),fileCount=consistent(version.locations,'fileCount');
    const originalLocations=[],cacheLocations=[];
    for(const location of version.locations){
      const key=item.dataset+'@'+version.version,size=byte(location.contentBytes),cached=usage.get(location.machine);
      if(typeof location.warehouseReady==='boolean'){
        originalLocations.push({machine:location.machine,dataset:location.originalDataset,state:location.warehouseReady?'READY':'NOT_READY',warehouseReady:location.warehouseReady,canUse:location.canUse&&location.warehouseReady});
        const original=originals.get(location.machine);
        if(original&&location.state==='UNKNOWN')original.complete=false;
        if(original&&location.warehouseReady&&!original.versions.has(key)){
          original.sizes.push(size);original.datasets.add(item.dataset);original.versions.add(key);
        }
      }
      const state=location.warehouseReady===false?'UNKNOWN':location.state==='REGISTERED'&&location.warehouseReady===true?'NOT_LOCAL':location.state;
      if(cached&&state==='UNKNOWN')cached.complete=false;
      cacheLocations.push({machine:location.machine,dataset:location.dataset,state,canUse:location.canUse&&state==='READY',canPrepare:location.canPrepare===true});
      const cacheKey=location.dataset+'@'+version.version;
      if(cached&&state==='READY'&&!cached.versions.has(cacheKey)){cached.sizes.push(size);cached.versions.add(cacheKey);}
    }
    return {version:version.version,ownerLabel:version.ownerLabel,contentBytes,fileCount,canUse:version.canUse===true,originals:originalLocations,caches:cacheLocations};
  })}));
  const warehouses=nodes.filter(node=>node.warehouse).map(node=>{
    const counts=originals.get(node.machine),complete=counts.complete&&counts.sizes.every(value=>value!==null),warnings=warehouseWarnings(node.machine,node.warehouse.volume);
    if(node.volume.id!==null&&node.volume.id===node.warehouse.volume.id)warnings.push(warning(node.machine,'CACHE_WAREHOUSE_SHARED_VOLUME'));
    return {...node.warehouse,originalContentBytes:complete?sum(counts.sizes):null,datasetCount:counts.complete?counts.datasets.size:null,versionCount:counts.complete?counts.versions.size:null,usageComplete:complete,warnings};
  });
  const caches=nodes.map(node=>{
    const counts=usage.get(node.machine),complete=counts.complete&&counts.sizes.every(value=>value!==null);
    const known=counts.sizes.filter(value=>value!==null);
    const readyContentBytes=counts.readable&&(counts.sizes.length===0||known.length>0)?sum(known):null;
    return {machine:node.machine,state:node.state,...(node.reason?{reason:node.reason}:{}),volume:node.volume,readyContentBytes,
      readyVersionCount:counts.complete?counts.versions.size:null,budgetBytes:node.budgetBytes,reserveBytes:node.volume.reserveBytes,usageComplete:complete,
      projectBytes:node.projectBytes,projectUsageComplete:node.projectUsageComplete,projectCollectedAt:node.projectCollectedAt};
  });
  // Count logical original versions once even if the same immutable tuple has
  // several warehouse copies. Physical volume bytes are never summed from
  // dataset content, cache budgets, bind roots or workspace quota reports.
  const uniqueOriginals=new Map(),originalDatasets=new Set();
  for(const item of datasets)for(const version of item.versions)if(version.originals.some(row=>row.state==='READY')){
    uniqueOriginals.set(item.dataset+'@'+version.version,version.contentBytes);originalDatasets.add(item.dataset);
  }
  const warehouseKnown=nodes.every(node=>node.warehouseKnown),warehouseComplete=warehouseKnown&&warehouses.every(row=>row.state==='READY'&&row.usageComplete);
  const physicalVolumes=[],seen=new Set();
  for(const node of nodes)for(const volume of [node.volume,node.warehouse?.volume].filter(Boolean)){
    if(volume.id===null||seen.has(volume.id))continue;
    seen.add(volume.id);physicalVolumes.push({machine:node.machine,...volume});
  }
  const capableNodes=new Set(nodes.filter(node=>node.fileListCapability).map(node=>node.machine));
  const filePreviewAvailable=catalog.datasets.some(item=>item.versions.some(version=>version.locations.some(location=>
    location.canUse===true&&capableNodes.has(location.machine)&&(location.warehouseReady===true||location.state==='READY'))));
  return {protocol:'dataset-storage-overview-v1',checkedAt:new Date().toISOString(),partial:catalog.partial||nodes.some(node=>node.state!=='READY'||!node.warehouseKnown||node.warehouse&&node.warehouse.state!=='READY'),
    filePreviewAvailable,fileContentPreviewAvailable:false,physicalVolumes,
    warehouse:{state:warehouses.length?(warehouseComplete?'READY':'UNKNOWN'):(warehouseKnown?'NOT_CONFIGURED':'UNKNOWN'),volumes:warehouses,
      originalContentBytes:warehouseComplete?sum([...uniqueOriginals.values()]):null,datasetCount:warehouseComplete?originalDatasets.size:null,versionCount:warehouseComplete?uniqueOriginals.size:null,
      warnings:[...warehouses.flatMap(row=>row.warnings),...nodes.filter(node=>!node.warehouseKnown).map(node=>warning(node.machine,'WAREHOUSE_FACTS_UNAVAILABLE'))]},caches,datasets};
}
