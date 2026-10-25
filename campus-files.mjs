import {SHA256,selectFields} from './portal-request-validation.mjs';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {validateProjectFile,UUID} from './projects.mjs';

export const FILE_PROTOCOL='campus-file';
const hash=value=>createHash('sha256').update(value).digest('hex');
const denied=(message,status=403)=>{throw Object.assign(Error(message),{status,code:'CAMPUS_FILE_REQUIRED'});};
function rememberTicket(service,ticket,entry){
  const now=Date.now()/1000;
  service.db.prepare('DELETE FROM file_authorizations WHERE expires_at<=?').run(now);
  for(const [key,old] of service.fileTickets)if(old.expiresAt<=now)service.fileTickets.delete(key);
  if(service.fileTickets.size>=4096)denied('文件授权繁忙，请稍后核对原操作。',429);
  const key=hash(ticket);
  service.db.prepare('INSERT INTO file_authorizations(ticket_hash,expires_at,data) VALUES(?,?,?) ON CONFLICT(ticket_hash) DO UPDATE SET expires_at=excluded.expires_at,data=excluded.data').run(key,entry.expiresAt,JSON.stringify(entry));
  service.fileTickets.set(key,entry);
}
// Keep only the hash of the node capability, never its bearer ticket. SQLite is
// owned by Portal's single writer and survives a drained rollout/restart. Every
// use still checks the current login and maintenance state.
export function installFileCampus(service){
  service.db.exec('CREATE TABLE IF NOT EXISTS file_authorizations (ticket_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS file_authorizations_expiry ON file_authorizations(expires_at);');
  service.db.prepare('DELETE FROM file_authorizations WHERE expires_at<=?').run(Date.now()/1000);
  service.fileTickets=new Map(service.db.prepare('SELECT ticket_hash, expires_at, data FROM file_authorizations').all().map(row=>{
    const entry=JSON.parse(row.data);
    return [row.ticket_hash,{...entry,expiresAt:row.expires_at}];
  }));
  service.checkFileTicket=data=>{
    if(!data||typeof data.ticket!=='string'||data.ticket.length>4096)denied('文件授权无效。');
    const entry=service.fileTickets.get(hash(data.ticket));
    if(!entry||entry.expiresAt<=Date.now()/1000||service.closing)denied('校园文件授权已失效，请核对原操作。');
    const principal=service.loginSessions.principalFromHash(entry.sessionHash);
    if(entry.args.area==='output')service.assertMachineStatusVisible(principal,entry.args.machine);
    if(service.maintenanceFor(entry.args.machine))denied('服务器正在维护，请稍后继续原操作。',503);
    return {allowed:true,protocol:FILE_PROTOCOL};
  };
}

export function validateFileLanEndpoints(input){
  const value=typeof input==='string'?JSON.parse(input):input;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>16)denied('Invalid trusted file LAN endpoints',503);
  for(const [machine,endpoint] of Object.entries(value)){
    let u;try{u=new URL(endpoint);}catch{denied('Invalid trusted file LAN origin',503);}
    const [a,b]=u.hostname.split('.').map(Number);
    if(!MACHINES.some(m=>m.id===machine)||u.protocol!=='https:'||u.origin!==endpoint||u.username||u.password||u.search||u.hash||u.pathname!=='/'||isIP(u.hostname)!==4||!(a===10||a===172&&b>=16&&b<=31||a===192&&b===168))denied('Invalid trusted file LAN origin',503);
  }
  return Object.freeze({...value});
}
export async function fileTicket(service,token,args){
  const principal=service.principal(token),user=service.store.get(principal.userId);
  const allowed=['machine','ownerId','dataset','project','area','runId','path','action','maxChunkBytes','uploadId','totalSize','overwrite'];
  if(!args||typeof args!=='object'||Array.isArray(args))denied('校园文件参数无效。',400);
  args=selectFields(args,allowed);
  if(args.maxChunkBytes!==undefined&&(!Number.isSafeInteger(args.maxChunkBytes)||args.maxChunkBytes<1||args.maxChunkBytes>16*1048576))denied('校园文件分块边界无效。',400);
  if(!user.enabled)denied('请重新登录。');
  if(!MACHINES.some(machine=>machine.id===args.machine))denied('请选择列表中的服务器。',400);
  if(args.area==='output')service.assertMachineStatusVisible(principal,args.machine);
  const context=validateProjectFile(args);
  if(!['put','get'].includes(args.action)||typeof args.path!=='string'||Buffer.byteLength(args.path)>4096
    ||args.path.split('/').some(part=>!part||part==='.'||part==='..'||Buffer.byteLength(part)>255)||/[\\\x00-\x1f\x7f]/.test(args.path))denied('请使用数据集或工作区内的相对文件路径。',400);
  if(args.action==='put'&&(!UUID.test(args.uploadId||'')||!Number.isSafeInteger(args.totalSize)||args.totalSize<0))denied('上传请使用原 UUID 和文件大小。',400);
  if(service.maintenanceFor(args.machine))denied('维护状态禁止校园文件字节传输。',503);
  if(!service.bridge)denied('节点执行桥尚未配置。',503);
  const parameters=args;
  const request={...parameters,...context,ownerId:args.ownerId??user.id};
  const before={...principal};
  let result;
  try{result=await service.bridge(args.machine,'files.direct.prepare',{...request,userId:user.id});}
  catch(error){
    const reason=/\[Errno 11\]|Resource temporarily unavailable|\bbusy\b|active reader or lifecycle operation/i.test(error.message??'')?'METADATA_LOCK_BUSY':
      error.status===403?'AUTHORIZATION_REJECTED':
      /ENOENT|No such file|FileNotFoundError/i.test(error.message??'')?'SOURCE_NOT_FOUND':
      ['NODE_RESPONSE_TIMEOUT','NODE_TRANSPORT_BUSY','NODE_CONNECTION_FAILED','JOB_RECORD_PURGED'].includes(error.code)?error.code:'NODE_REQUEST_REJECTED';
    console.warn(JSON.stringify({event:'file-ticket-rejected',reasonCode:reason}));
    service.principal(token);
    if(service.maintenanceFor(args.machine))denied('服务器正在维护，请稍后继续原操作。',503);
    throw error;
  }
  const current=service.principal(token);
  if(args.area==='output')service.assertMachineStatusVisible(current,args.machine);
  if(service.maintenanceFor(args.machine))denied('服务器正在维护，请稍后继续原操作。',503);
  if(result?.available!==true)return {result:{...result,state:'UNKNOWN',message:'节点暂未返回文件入口，请按原编号重试。'},principal:current};
  if(!Number.isSafeInteger(result.chunkBytes)||result.chunkBytes<1||result.chunkBytes>(args.maxChunkBytes??1048576)
        ||!UUID.test(result.grantId||'')
    ||typeof result.ticket!=='string'||result.ticket.length>4096||!Number.isFinite(result.expiresAt)
    ||result.expiresAt<=Date.now()/1000)denied('文件入口暂不可用，请稍后用原编号重试。',503);
  let endpoint;try{endpoint=new URL(result.endpoint);}catch{denied('节点校园入口无效。',503);}
  if(endpoint.protocol!=='https:'||endpoint.origin!==result.endpoint||endpoint.pathname!=='/'||endpoint.username||endpoint.password
    ||endpoint.search||endpoint.hash||! SHA256.test(result.certificateSha256||''))denied('节点校园入口身份无效。',503);
  const entry={principal:before,sessionHash:hash(token),args:request,expiresAt:result.expiresAt};
  rememberTicket(service,result.ticket,entry);
  const lan=service.fileLanEndpoints?.[args.machine];
  return {result:{...result,routes:[{id:'primary',kind:'campus-direct',endpoint:result.endpoint},
    ...(lan&&lan!==result.endpoint?[{id:'node-lan',kind:'campus-direct',endpoint:lan}]:[])]},principal:current};
}
