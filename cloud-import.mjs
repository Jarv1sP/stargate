import {UUID,selectFields} from './portal-request-validation.mjs';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {AliyunShare,shareReference} from './aliyun-share.mjs';
import {MACHINES} from './dist/model.js';
import {assertMachineAccess} from './machine-access.mjs';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export function importPath(path){if(typeof path!=='string'||!path||Buffer.byteLength(path)>1024||/[\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||Buffer.byteLength(p)>255))fail('保存位置请填写所选数据集或工作区内的相对文件名。');return path;}
function directURL(value){let u;try{u=new URL(value);}catch{fail('请输入完整 HTTPS 下载链接。');}if(typeof value!=='string'||value.length>16384||u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443')fail('仅接受不含账号密码的 HTTPS 下载链接。');return u.href;}
function downloadDescriptor(value){
  const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
  const header=value=>typeof value==='string'&&value.length>=1&&value.length<=512&&/^[\x20-\x7e]+$/.test(value);
  if(typeof value==='string'){try{return {url:directURL(value)};}catch{fail('云盘没有返回安全的 HTTPS 下载地址。',502);}}
  if(!plain(value)||value.additionalHeaders!==undefined&&!plain(value.additionalHeaders))fail('云盘下载描述符无效。',502);
  let url;try{url=directURL(value.url);}catch{fail('云盘没有返回安全的 HTTPS 下载地址。',502);}
  const downloadHeaders={};
  if(value.userAgent!==undefined){if(!header(value.userAgent))fail('云盘下载 User-Agent 无效。',502);downloadHeaders['User-Agent']=value.userAgent;}
  for(const [name,content] of Object.entries(value.additionalHeaders||{})){
    if(!['Referer','Origin'].includes(name))continue;
    if(!header(content)||!/^https:\/\/www\.(?:alipan|aliyundrive)\.com\/?$/.test(content))fail('云盘下载请求头无效。',502);
    downloadHeaders[name]=content;
  }
  return {url,...(Object.keys(downloadHeaders).length?{downloadHeaders}:{})};
}
export function installCloudImports(service,{provider,request}={}){
  service.db.exec(`CREATE TABLE IF NOT EXISTS cloud_credentials(id TEXT PRIMARY KEY,cipher TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cloud_downloads(user_id TEXT NOT NULL,machine TEXT NOT NULL,id TEXT NOT NULL,cipher TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,machine,id));`);
  service.cloudSeal=(id,value)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',service.inviteKey,iv);c.setAAD(Buffer.from('gpuq-cloud:'+id));const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');};
  service.cloudOpen=(id,value)=>{const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',service.inviteKey,b.subarray(0,12));c.setAAD(Buffer.from('gpuq-cloud:'+id));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString('utf8'));};
  const load=()=>{const row=service.db.prepare("SELECT cipher FROM cloud_credentials WHERE id='aliyun'").get();return row?service.cloudOpen('aliyun',row.cipher):null;};
  const save=value=>service.db.prepare("INSERT INTO cloud_credentials VALUES('aliyun',?) ON CONFLICT(id) DO UPDATE SET cipher=excluded.cipher").run(service.cloudSeal('aliyun',value));
  service.cloudProvider=provider||new AliyunShare({load,save,request});
  service.cloudQR=new Map();service.cloudInspections=new Map();
}
function sweep(service){const now=Date.now();for(const map of [service.cloudQR,service.cloudInspections])for(const [key,v] of map)if(v.expiresAt<now)map.delete(key);}
function authorized(service,actor,machine){assertMachineAccess(service.store.get(actor.userId),machine,MACHINES);if(!service.bridge)fail('节点执行桥未连接。',503);}
export async function cloudImportCall(service,actor,operation,args,assertCurrent=()=>{}){
  service.assertMaintenanceAllowed?.(operation,args,actor);
  if(operation.startsWith('cloud.files.')){
    const action=operation.slice('cloud.files.'.length),allowed={info:[],list:[],status:['operationId'],cancel:['operationId'],upload:['key','path','name','size'],download:['key','fileId','path','size']};
    if(!Object.hasOwn(allowed,action))fail('未知云文件操作。');
    args=selectFields(args,['machine','area','dataset','project','ownerId',...allowed[action]]);authorized(service,actor,args.machine);assertCurrent();
    for(const key of ['key','operationId'])if(allowed[action].includes(key)&&!UUID.test(args[key]||''))fail('云文件操作需要有效的完整编号。');
    if(allowed[action].includes('path'))importPath(args.path);
    const {machine,...payload}=args;
    const result=await service.bridge(machine,'datasets.cloud.'+action,{...payload,userId:actor.userId,actor:{userId:actor.userId,isAdmin:actor.role==='admin'}});
    assertCurrent();
    if(['upload','download','cancel'].includes(action))service.audit(actor.username,operation,machine,args.key||args.operationId);
    return result;
  }
  const provider=service.cloudProvider,backend='aliyun';sweep(service);
  const current=()=>assertCurrent();
  if(operation==='cloud.info'){
    args=selectFields(args,[]);return {version:1,aliyunConnected:provider.connected(),providers:['https','aliyun'],nodeDirect:true,backend,managedExternally:false,disabled:false,status:provider.connected()?'connected':'disconnected'};
  }
  if(operation.startsWith('cloud.auth.')){
    if(actor.role!=='admin')fail('云盘连接仅管理员可管理。',403);
    if(operation==='cloud.auth.begin'){
      args=selectFields(args,[]);const login=await provider.begin(),id=randomUUID();assertCurrent();
      for(const [key,v] of service.cloudQR)if(v.userId===actor.userId)service.cloudQR.delete(key);
      service.cloudQR.set(id,{...login,userId:actor.userId,nextPoll:0});service.audit(actor.username,operation,'aliyun','started');return {id,image:login.image,expiresAt:login.expiresAt};
    }
    if(operation==='cloud.auth.poll'){
      args=selectFields(args,['id']);const login=service.cloudQR.get(args.id);if(!login)fail('二维码已过期，请重新获取。',404);
      if(Date.now()<login.nextPoll)fail('请稍后检查扫码状态。',429);login.nextPoll=Date.now()+2500;
      const result=await provider.poll(login.secret);assertCurrent();if(['CONFIRMED','EXPIRED','CANCELED'].includes(result.state))service.cloudQR.delete(args.id);
      if(result.state==='CONFIRMED')service.audit(actor.username,operation,'aliyun','connected');return result;
    }
    if(operation==='cloud.auth.disconnect'){
      args=selectFields(args,[]);
      service.db.prepare("DELETE FROM cloud_credentials WHERE id='aliyun'").run();
      provider.clear();service.cloudQR.clear();service.cloudInspections.clear();service.audit(actor.username,operation,backend,'disconnected');return {disconnected:true,backend,persistent:true};
    }
    fail('未知云盘授权操作。');
  }
  if(operation==='cloud.inspect'){
    args=selectFields(args,['machine','url','password']);authorized(service,actor,args.machine);
    current();if(!provider.connected())fail('管理员尚未连接阿里云盘。',409);const source=shareReference(args.url,args.password),files=await provider.list(source),id=randomUUID();current();
    service.cloudInspections.set(id,{userId:actor.userId,machine:args.machine,source,files,backend,expiresAt:Date.now()+3600000});
    return {inspectionId:id,files:files.map(({id,name,size})=>({id,name,size})),note:'仅列出分享根目录的文件；目录请先压缩后分享。'};
  }
  if(!operation.startsWith('cloud.import.'))fail('未知云盘操作。');
  authorized(service,actor,args.machine);const action=operation.slice(13);
  if(['list','status','cancel','discard'].includes(action)){
    args=selectFields(args,action==='list'?['machine']:['machine','operationId']);if(action!=='list'&&!UUID.test(args.operationId||''))fail('导入编号无效。');
    if(['cancel','discard'].includes(action))service.audit(actor.username,operation,args.machine,args.operationId);
    const result=await service.bridge(args.machine,'datasets.import.'+action,{userId:actor.userId,actor:{userId:actor.userId,isAdmin:actor.role==='admin'},...(action==='list'?{}:{operationId:args.operationId})});
    assertCurrent();
    if(action==='discard'){
      if(result?.discarded!==true)return {...result,state:result?.state||'UNKNOWN',message:'清理结果未知，请按原编号查询。'};
      service.db.prepare('DELETE FROM cloud_downloads WHERE machine=? AND id=?').run(args.machine,args.operationId);
    }
    return result;
  }
  if(!['start','resume'].includes(action))fail('未知导入操作。');
  args=selectFields(args,action==='resume'?['machine','operationId','url']:['machine','area','dataset','project','ownerId','key','url','path','expectedBytes','inspectionId','fileId']);
  const key=action==='resume'?args.operationId:args.key;if(!UUID.test(key||''))fail('导入需要有效 UUID 标识。');
  let row=service.db.prepare('SELECT * FROM cloud_downloads WHERE machine=? AND id=?').get(args.machine,key),source;
  const identity=JSON.stringify([row?.user_id??actor.userId,args.machine,key]);
  if(action==='resume'){
    if(!row)fail('导入记录不存在。',404);source=service.cloudOpen(identity,row.cipher);
    if(args.url!==undefined){if(source.kind!=='https')fail('阿里云盘直链由后台刷新，不接受替换地址。');source.url=directURL(args.url);}
  }else if(row){
    source=service.cloudOpen(identity,row.cipher);
  }else{
    const path=importPath(args.path);
    if(args.inspectionId){
      const inspection=service.cloudInspections.get(args.inspectionId);if(!inspection||inspection.expiresAt<=Date.now())fail('分享列表已过期，请重新读取。',409);
      const file=inspection.files.find(f=>f.id===args.fileId);if(!file)fail('请从当前分享列表选择文件。');source={kind:'aliyun',path,target:selectFields(args,['area','dataset','project','ownerId']),reference:inspection.source,file};
    }else{
      if(args.fileId!==undefined)fail('文件编号需要分享列表。');
      if(args.expectedBytes!==undefined&&(!Number.isSafeInteger(args.expectedBytes)||args.expectedBytes<0))fail('文件大小无效。');
      source={kind:'https',path,target:selectFields(args,['area','dataset','project','ownerId']),url:directURL(args.url),...(args.expectedBytes!==undefined?{expectedBytes:args.expectedBytes}:{})};
    }
    if(!row)service.db.prepare('INSERT INTO cloud_downloads VALUES(?,?,?,?,?)').run(actor.userId,args.machine,key,service.cloudSeal(identity,source),Date.now());
  }
  let url=source.url,downloadHeaders;
  if(source.kind==='aliyun'){
    current();
    if(!provider.connected())fail('云盘连接已停用，请管理员检查。',409);
    const resolved=await provider.resolve(source.reference,source.file);
    current();({url,downloadHeaders}=downloadDescriptor(resolved));
  }
  assertCurrent();
  const node={userId:actor.userId,actor:{userId:actor.userId,isAdmin:actor.role==='admin'},...source.target,key,path:source.path,url,sourceKind:source.kind,...(downloadHeaders?{downloadHeaders}:{}),...(source.kind==='aliyun'?{expectedBytes:source.file.size}:{...(source.expectedBytes!==undefined?{expectedBytes:source.expectedBytes}:{})})};
  service.audit(actor.username,operation,args.machine,key);
  const result=await service.bridge(args.machine,'datasets.import.'+action,{...node,...(action==='resume'?{operationId:key}:{})});
  assertCurrent();
  if(action==='resume'&&source.kind==='https')service.db.prepare('UPDATE cloud_downloads SET cipher=? WHERE user_id=? AND machine=? AND id=?').run(service.cloudSeal(identity,source),row.user_id,args.machine,key);
  return result;
}
