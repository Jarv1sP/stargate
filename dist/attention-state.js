// Local read markers are UI preferences only; never write task or approval state.
export const ATTENTION_WINDOW=24*60*60*1000;
const timestamp=value=>{
  const time=typeof value==='number'?value*(value<1e11?1000:1):typeof value==='string'&&value.trim()?Date.parse(value):NaN;
  return Number.isFinite(time)&&time>0&&Number.isFinite(new Date(time).getTime())?time:null;
};
export function failureTime(record){
  for(const value of [record.latestAttempt?.finishedAt,record.finishedAt,record.updatedAt]){
    const time=timestamp(value);if(time!==null)return time;
  }
  return null;
}
export const recentFailure=(record,now=Date.now())=>{
  const time=failureTime(record);return time!==null&&time<=now&&time>=now-ATTENTION_WINDOW;
};
export const failureReadKey=(kind,record)=>{
  const time=failureTime(record);return typeof record.id==='string'&&time!==null?JSON.stringify([kind,record.id,time]):null;
};
export const attentionCount=count=>count>99?'99+':String(count);
export const attentionStorageKey=userId=>'stargate:attention-read:v1:'+encodeURIComponent(userId);
function validKey(key,now){
  if(typeof key!=='string')return false;
  try{const row=JSON.parse(key);return Array.isArray(row)&&row.length===3&&['job','data'].includes(row[0])&&typeof row[1]==='string'&&Number.isFinite(row[2])&&row[2]>0&&row[2]<=now&&row[2]>=now-ATTENTION_WINDOW;}catch{return false;}
}
export function createAttentionReads({storage=()=>globalThis.localStorage,now=()=>Date.now()}={}){
  const unavailable=new Set();
  function read(userId){
    if(!userId||unavailable.has(userId))return null;
    try{const saved=storage().getItem(attentionStorageKey(userId)),keys=saved?JSON.parse(saved):[];if(!Array.isArray(keys))throw Error('Invalid read markers');return new Set(keys.filter(key=>validKey(key,now())));}
    catch{unavailable.add(userId);return null;}
  }
  function acknowledge(userId,keys){
    const seen=read(userId);if(seen===null)return false;
    for(const key of keys)if(validKey(key,now()))seen.add(key);
    try{storage().setItem(attentionStorageKey(userId),JSON.stringify([...seen]));return true;}
    catch{unavailable.add(userId);return false;}
  }
  return {read,acknowledge};
}

// Partial reads update known records; only a complete directory proves absence.
export function mergeAttentionActivities(previous,incoming,userId,complete=false){
  const rows=new Map((complete?[]:previous).filter(row=>typeof row.id==='string').map(row=>[row.id,row]));
  for(const row of incoming){
    if(!row||typeof row.id!=='string'||!row.id)continue;
    rows.set(row.id,{id:row.id,userId:row.ownerId||row.userId||row.owner?.id,kind:row.kind,state:row.state,machine:row.machine,name:row.name||row.reference?.dataset||'数据传输',finishedAt:row.finishedAt,updatedAt:row.updatedAt,error:row.error||row.result?.error});
  }
  return [...rows.values()];
}
