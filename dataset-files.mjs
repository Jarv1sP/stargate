import {createHash} from 'node:crypto';
import {authorizationPolicy,MACHINES} from './dist/model.js';
import {datasetCatalogCall} from './dataset-catalog.mjs';

const PROTOCOL='dataset-files-list-v1',ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,HASH=/^[a-f0-9]{64}$/;
const fail=(message,status=400,code)=>{throw Object.assign(Error(message),{status,...(code?{code}:{})});};
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const safePath=value=>typeof value==='string'&&Buffer.byteLength(value)<=4096&&!/[\\\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value)&&(!value||value.split('/').every(part=>part&&part!=='.'&&part!=='..'));

/** Metadata visibility never substitutes for the actor's content ACL. */
export async function datasetFilesCall(service,principal,args){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['dataset','version','path','cursor'].includes(key))||typeof args.dataset!=='string'||!ID.test(args.dataset)||typeof args.version!=='string'||!HASH.test(args.version)||!safePath(args.path===undefined?'':args.path)||args.cursor!==undefined&&(typeof args.cursor!=='string'||!args.cursor||args.cursor.length>16384))fail('固定版本目录参数无效。');
  let user;try{user=service.store.get(principal?.userId);}catch{}
  if(user?.enabled!==true||user.id!==principal?.userId)fail('账号不存在或已停用。',403);
  const policy=authorizationPolicy(user),check=()=>{
    let current;try{current=service.store.get(principal.userId);}catch{}
    if(service.closing||current?.enabled!==true||authorizationPolicy(current)!==policy)fail('账号授权已改变，请刷新后重试。',403);
  };
  const path=args.path??'',binding=createHash('sha256').update(JSON.stringify([user.id,args.dataset,args.version,path])).digest('hex');
  let cursor=null;
  if(args.cursor!==undefined){
    try{cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'));}catch{fail('目录分页编号无效。');}
    if(!cursor||Array.isArray(cursor)||Object.keys(cursor).sort().join(',')!=='binding,machine,nodeCursor,source'||cursor.binding!==binding||!MACHINES.some(row=>row.id===cursor.machine)||typeof cursor.source!=='string'||!ID.test(cursor.source)||typeof cursor.nodeCursor!=='string'||!cursor.nodeCursor||cursor.nodeCursor.length>8192||encode(cursor)!==args.cursor)fail('目录分页来源已改变，请重新读取原目录。');
  }
  const catalog=await datasetCatalogCall(service,principal,'datasets.catalog',{},{refreshRemovalExclusions:false});check();
  const version=catalog.datasets.find(row=>row.dataset===args.dataset)?.versions.find(row=>row.version===args.version);
  if(!version?.canUse)fail('没有这份数据的读取授权。',403);
  const locations=version.locations.filter(row=>row.canUse===true&&(row.warehouseReady===true||row.state==='READY')).map(row=>({
    machine:row.machine,source:row.warehouseReady===true?row.originalDataset:row.dataset,warehouse:row.warehouseReady===true
  })).filter(row=>ID.test(row.source||'')).sort((a,b)=>Number(b.warehouse)-Number(a.warehouse)||a.machine.localeCompare(b.machine)||a.source.localeCompare(b.source));
  const location=cursor?locations.find(row=>row.machine===cursor.machine&&row.source===cursor.source):locations[0];
  if(!location)fail('固定版本的可读位置尚未确认。',503,'DATASET_FILES_SOURCE_UNCONFIRMED');
  const unavailable=()=>({protocol:PROTOCOL,available:false,dataset:args.dataset,version:args.version,path,reason:'DATASET_FILES_NODE_UNAVAILABLE'});
  let capacity;
  try{capacity=await service.bridge(location.machine,'datasets.capacity',{userId:user.id,hostAdmin:false});}catch{check();return unavailable();}
  check();if(capacity?.datasetFileList!==1)return unavailable();
  let value;
  try{value=await service.bridge(location.machine,'datasets.files.list',{userId:user.id,hostAdmin:false,dataset:location.source,version:args.version,path,...(cursor?{cursor:cursor.nodeCursor}:{})});}
  catch{check();fail('这份目录的读取结果尚未确认，请查询原版本。',503,'DATASET_FILES_UNCONFIRMED');}
  check();
  if(value?.protocol!==PROTOCOL||value.available!==true||value.machine!==location.machine||value.dataset!==location.source||value.version!==args.version||value.path!==path||!Array.isArray(value.entries)||value.entries.length>200||value.nextCursor!==null&&(typeof value.nextCursor!=='string'||!value.nextCursor||value.nextCursor.length>8192))fail('节点目录响应尚未确认。',502);
  const names=new Set(),prefix=path?path+'/':'',entries=value.entries.map(row=>{
    if(!row||typeof row.name!=='string'||!row.name||row.name.includes('/')||!safePath(row.name)||row.path!==prefix+row.name||!safePath(row.path)||names.has(row.name)||!['file','directory'].includes(row.type)||row.type==='directory'&&row.bytes!==null||row.type==='file'&&(!Number.isSafeInteger(row.bytes)||row.bytes<0))fail('节点目录条目无效。',502);
    names.add(row.name);return {name:row.name,path:row.path,type:row.type,bytes:row.bytes};
  });
  if(value.nextCursor!==null&&!entries.length)fail('节点目录分页响应无效。',502);
  const result={protocol:PROTOCOL,available:true,dataset:args.dataset,version:args.version,path,entries,
    nextCursor:value.nextCursor===null?null:encode({binding,machine:location.machine,source:location.source,nodeCursor:value.nextCursor})};
  if(Buffer.byteLength(JSON.stringify(result))>65536)fail('节点目录响应超出界限。',502);
  return result;
}
