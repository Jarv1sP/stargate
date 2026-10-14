// One public metadata contract for registration/profile, job submission and
// resource displays. These fields describe a task; they are never executable.
const encoder=new TextEncoder();
const controls=/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
export function displayName(value){
  if(typeof value!=='string'||!value.isWellFormed())throw Error('姓名／显示名格式无效。');
  const name=value.trim();
  if(!name||[...name].length>32||encoder.encode(name).length>128||controls.test(name))throw Error('姓名／显示名须为 1–32 字，不能包含控制字符。');
  return name;
}
export function taskDescription(value){
  if(value===undefined)return '';
  if(typeof value!=='string'||!value.isWellFormed())throw Error('任务描述格式无效。');
  // Preserve CRLF compatibility, but validate before trimming so edge controls
  // cannot disappear. C1 includes CSI/OSC; checking only ASCII misses those.
  const normalized=value.replace(/\r\n?/g,'\n');
  const description=normalized.trim();
  if([...description].length>2000||encoder.encode(description).length>6000||controls.test(normalized.replace(/[\n\t]/g,'')))throw Error('任务描述最多 2000 字／6 KiB，不能包含控制字符。');
  return description;
}
// Native presentation is never execution identity. Only the original platform
// node supplies labels; take known display fields without changing job ownership.
export function nativeTaskDisplay(value,username){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const actor=value.submitter;
  if(!actor||typeof actor!=='object'||Array.isArray(actor))return null;
  if(typeof value.name!=='string'||!value.name.isWellFormed()||!value.name.trim()||[...value.name].length>64||encoder.encode(value.name).length>256||controls.test(value.name))return null;
  try{return {name:value.name,description:taskDescription(value.description),submitter:{name:displayName(actor.name),username:typeof actor.username==='string'?actor.username:username}};}catch{return null;}
}
export function taskIdentity(job,users=[]){
  const account=users.find(u=>u.id===job.userId),username=typeof job.username==='string'?job.username:account?.username||'未知用户';
  let name,description;
  try{name=displayName(job.submitterName??account?.name??username);}catch{name=username;}
  try{description=taskDescription(job.description);}catch{description='';}
  return nativeTaskDisplay(job.nativeTaskDisplay,username)||{name:job.name||'train',description,submitter:{name,username}};
}
