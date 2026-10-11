import {authorizationPolicy} from './dist/model.js';
// Personal display metadata only. Nodes remain the source of truth for data,
// versions, ACLs and paths. A shared reader cannot rename another user's view.
import {datasetCatalogCall} from './dataset-catalog.mjs';
import {defaultDatasetDisplayName} from './dist/dataset-display-name.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OWNER=/^(?:builtin-admin|demo-user-[0-9]+)$/;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};

function displayName(value){
  if(typeof value!=='string'||/[\p{Cc}\p{Cf}]/u.test(value))fail('显示名称不能包含换行、控制字符或不可见格式字符。');
  const name=value.normalize('NFC').trim(),length=[...name].length;
  if(length<1||length>80)fail('显示名称需为 1–80 个字符。');
  return name;
}

export function installDatasetLabels(service){
  service.db.exec(`CREATE TABLE IF NOT EXISTS dataset_labels (
    owner_id TEXT NOT NULL,logical_id TEXT NOT NULL,name TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,
    PRIMARY KEY(owner_id,logical_id));`);
  service.datasetLabelView=(owner,dataset)=>{
    const row=service.db.prepare('SELECT name,revision FROM dataset_labels WHERE owner_id=? AND logical_id=?').get(owner,dataset);
    return {name:row?.name||defaultDatasetDisplayName(dataset),displayNameRevision:row?.revision||0,labelScope:'personal'};
  };
}

export async function datasetLabelCall(service,principal,operation,args,revalidate=()=>{}){
  if(!['datasets.label.get','datasets.label.set'].includes(operation))fail('未知数据集名称操作。');
  const setting=operation==='datasets.label.set',allowed=['machine','dataset','ownerId',...(setting?['displayName','revision']:[])];
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!allowed.includes(k))||typeof args.dataset!=='string'||!ID.test(args.dataset))fail('数据集名称参数无效。');
  const owner=args.ownerId??principal.userId;
  if(!OWNER.test(owner)||owner!==principal.userId&&principal.role!=='admin')fail('不能修改其他账号的个人显示名称。',403);
  if(setting&&(!Number.isSafeInteger(args.revision)||args.revision<0||args.revision>=Number.MAX_SAFE_INTEGER))fail('需提供当前显示名称版本 revision；首次为 0。');
  const name=setting?displayName(args.displayName):null;
  const admitted=service.store.get(principal.userId),viewer=service.store.get(owner);
  if(!admitted.enabled||!viewer.enabled)fail('账号已停用。',403);
  if(owner!==principal.userId&&admitted.role!=='admin')fail('此操作需要管理员权限。',403);
  const actorPolicy=authorizationPolicy(admitted),viewerPolicy=authorizationPolicy(viewer);
  const check=()=>{
    revalidate();
    if(service.closing||authorizationPolicy(service.store.get(principal.userId))!==actorPolicy||authorizationPolicy(service.store.get(owner))!==viewerPolicy)
      fail('账号授权已改变，请重新查询数据集。',403);
  };
  check();
  // Admin delegation uses the target account's usable versions. Elevated
  // catalog metadata reads must not grant access to personal label mutations.
  // Logical aliases come from catalog receipts, not name-prefix guessing.
  const catalog=await datasetCatalogCall(service,{userId:owner,username:viewer.username,role:viewer.role||'member'},'datasets.catalog',{machine:args.machine});
  check();
  let matches=catalog.datasets.filter(item=>item.dataset===args.dataset);
  const physicalAlias=!matches.length;
  if(physicalAlias)matches=catalog.datasets.filter(item=>item.versions.some(version=>version.locations.some(location=>location.machine===args.machine&&location.dataset===args.dataset)));
  if(!matches.length&&catalog.partial)fail('部分节点目录尚未确认，请稍后重试；未修改显示名称。',503);
  if(matches.length!==1)fail(matches.length?'该本地名称映射到多个逻辑数据集，请使用目录中的逻辑 ID。':'数据集不存在或该账号无访问权限。',matches.length?409:404);
  if(!matches[0].versions.some(version=>version.canUse===true&&(!physicalAlias||version.locations.some(location=>location.canUse===true&&location.machine===args.machine&&location.dataset===args.dataset))))
    fail('当前账号没有数据集读取授权，不能修改或读取其个人显示名称。',403);
  const logical=matches[0].dataset;
  const result=()=>{
    const row=service.db.prepare('SELECT name,revision,updated_at FROM dataset_labels WHERE owner_id=? AND logical_id=?').get(owner,logical);
    return {dataset:logical,ownerId:owner,scope:'personal',name:row?.name||defaultDatasetDisplayName(logical),
      displayName:row?.name??null,revision:row?.revision||0,updatedAt:row?.updated_at??null};
  };
  if(!setting)return result();
  return service.enqueue(()=>{
    check();
    service.db.exec('BEGIN IMMEDIATE');
    try{
      const previous=service.db.prepare('SELECT revision FROM dataset_labels WHERE owner_id=? AND logical_id=?').get(owner,logical);
      if((previous?.revision||0)!==args.revision)fail('显示名称已被其他客户端更新，请重新读取后再修改。',409);
      if(!previous&&service.db.prepare('SELECT count(*) AS n FROM dataset_labels WHERE owner_id=?').get(owner).n>=10000)fail('个人显示名称数量已达上限。',429);
      service.db.prepare(`INSERT INTO dataset_labels(owner_id,logical_id,name,revision,updated_at,updated_by) VALUES(?,?,?,?,?,?)
        ON CONFLICT(owner_id,logical_id) DO UPDATE SET name=excluded.name,revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
        .run(owner,logical,name,args.revision+1,new Date().toISOString(),principal.userId);
      service.audit(principal.username,operation,args.machine,owner+':'+logical);
      service.db.exec('COMMIT');return result();
    }catch(error){service.db.exec('ROLLBACK');throw error;}
  });
}
