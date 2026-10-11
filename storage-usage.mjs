import {createHash} from 'node:crypto';
import {authorizationPolicy,MACHINES} from './dist/model.js';

export const STORAGE_USAGE_TTL_MS=300000;
export const STORAGE_USAGE_TIMEOUT_MS=4000;
const observations=new WeakMap();
const MAX_GROUPS=4096,OWNER=/^(?:[a-f0-9]{64}|[a-f0-9]{32})$/,PROJECT=/^[a-z0-9][a-z0-9_-]{0,47}$/;
const fail=(message,status)=>{throw Object.assign(Error(message),{status});};
const bytes=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const time=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
  &&Number.isFinite(Date.parse(value))?value:null;
const unavailable=(machine,reason)=>({machine,available:false,reason,collectedAt:null,complete:false,projectBytes:null,projects:[]});

function nodeView(machine,value){
  const cache=value?.storageOverview?.protocol==='dataset-storage-node-v1'?value.storageOverview.cache:null;
  const usage=cache?.projectUsage;
  if(usage?.protocol!==1)return unavailable(machine,'这台服务器暂不支持空间统计');
  if(typeof usage.complete!=='boolean'||!Array.isArray(usage.owners)||!Array.isArray(usage.projects)
    ||usage.owners.length>MAX_GROUPS||usage.projects.length>MAX_GROUPS)
    return unavailable(machine,'空间统计未确认');
  const owners=new Map(),projects=new Set();
  for(const row of usage.owners){
    if(!row||typeof row.owner!=='string'||!OWNER.test(row.owner)||owners.has(row.owner)||typeof row.complete!=='boolean'
      ||row.projectBytes!==null&&bytes(row.projectBytes)===null||row.complete!==(row.projectBytes!==null))
      return unavailable(machine,'空间统计未确认');
    owners.set(row.owner,{complete:row.complete,projectBytes:row.projectBytes});
  }
  const rows=new Map(),totals=new Map();
  for(const row of usage.projects){
    if(!row||typeof row.owner!=='string'||row.owner.length!==64||!owners.has(row.owner)
      ||typeof row.project!=='string'||!PROJECT.test(row.project)||projects.has(row.owner+':'+row.project)
      ||row.bytes!==null&&bytes(row.bytes)===null)return unavailable(machine,'空间统计未确认');
    projects.add(row.owner+':'+row.project);
    if(!rows.has(row.owner))rows.set(row.owner,[]);
    rows.get(row.owner).push({project:row.project,name:row.project,bytes:row.bytes});
    if(row.bytes!==null){
      const total=(totals.get(row.owner)||0)+row.bytes;
      if(!Number.isSafeInteger(total)||owners.get(row.owner).complete&&total>owners.get(row.owner).projectBytes)
        return unavailable(machine,'空间统计未确认');
      totals.set(row.owner,total);
    }
  }
  return {machine,available:true,collectedAt:time(cache.projectCollectedAt),complete:usage.complete,owners,projects:rows};
}

function readNode(service,machine){
  if(!service.bridge)return Promise.resolve(unavailable(machine,'节点状态不可用'));
  let nodes=observations.get(service);if(!nodes){nodes=new Map();observations.set(service,nodes);}
  let record=nodes.get(machine);
  if(record?.expires>Date.now())return Promise.resolve(record.value);
  // Keep the lane until the underlying read actually ends, including after a
  // timeout; repeated refreshes cannot spawn unbounded hung SSH processes.
  if(record?.pending)return record.pending;
  record={value:null,expires:0,pending:null};nodes.set(machine,record);
  let timer;
  const work=Promise.resolve().then(()=>service.bridge(machine,'datasets.capacity',{userId:'builtin-admin',hostAdmin:true}));
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(unavailable(machine,'节点状态未确认')),STORAGE_USAGE_TIMEOUT_MS);});
  record.pending=Promise.race([
    work.then(value=>nodeView(machine,value)).catch(()=>unavailable(machine,'节点状态不可用')),deadline
  ]).then(value=>{
    record.value=value;
    // An incomplete refresh can retain an older last-success timestamp. Cache
    // that unknown result by this read's TTL, without making the old sample fresh.
    record.expires=Math.min(Date.now()+STORAGE_USAGE_TTL_MS,value.available&&value.complete&&value.collectedAt!==null
      ?Date.parse(value.collectedAt)+STORAGE_USAGE_TTL_MS:Infinity);
    return value;
  }).finally(()=>{clearTimeout(timer);});
  Promise.allSettled([work,record.pending]).then(()=>{record.pending=null;});
  return record.pending;
}

function ownerView(node,user,identities,prefixes){
  if(!node.available)return {...node,projects:[]};
  const owner=identities.get(user.id),prefix=owner.slice(0,32);
  const prefixUnique=prefixes.get(prefix)===1;
  const full=node.owners.get(owner),legacy=prefixUnique?node.owners.get(prefix):null;
  // Two physical owner records must not be summed without an inode proof.
  const known=node.complete&&node.collectedAt!==null&&!(full&&legacy)
    &&(full?.complete??legacy?.complete??true);
  const projects=(node.projects.get(owner)||[]).map(row=>({...row}));
  const complete=known&&projects.every(row=>row.bytes!==null);
  return {machine:node.machine,available:true,collectedAt:node.collectedAt,complete,
    projectBytes:complete?(full?.projectBytes??legacy?.projectBytes??0):null,projects};
}

/** Literal, read-only node capacity projection. No DB table, write, project
 * mutation, quota admission, user-provided identity or secondary tree walk. */
export async function storageUsageCall(service,principal,operation,args){
  if(!['storage.usage.mine','storage.usage.users'].includes(operation))fail('未知空间查询。',400);
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)fail('空间查询不接受额外参数。',400);
  let user;try{user=service.store.get(principal?.userId);}catch{}
  if(user?.enabled!==true||user.id!==principal?.userId||(user.role||'member')!==principal?.role)fail('账号不存在或已停用。',403);
  if(operation==='storage.usage.users'&&principal.role!=='admin')fail('此操作需要管理员权限。',403);
  const policy=authorizationPolicy(user),check=()=>{
    let current;try{current=service.store.get(principal.userId);}catch{}
    if(service.closing||current?.enabled!==true||authorizationPolicy(current)!==policy)fail('账号授权已改变，请刷新后重试。',403);
  };
  check();
  const nodes=await Promise.all(MACHINES.map(({id})=>readNode(service,id)));
  check();
  const users=service.store.users.filter(row=>typeof row.id==='string');
  const identities=new Map(),prefixes=new Map();
  for(const row of users){
    const owner=createHash('sha256').update(row.id).digest('hex'),prefix=owner.slice(0,32);
    identities.set(row.id,owner);prefixes.set(prefix,(prefixes.get(prefix)||0)+1);
  }
  const checkedAt=new Date().toISOString();
  if(operation==='storage.usage.mine')return {protocol:1,checkedAt,machines:nodes.map(node=>ownerView(node,user,identities,prefixes))};
  return {protocol:1,checkedAt,users:users.map(row=>({userId:row.id,label:row.name||row.username||row.id,
    machines:nodes.map(node=>ownerView(node,row,identities,prefixes))}))};
}
