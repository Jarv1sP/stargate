import {randomUUID} from 'node:crypto';
import {normalizeWorkshopPackage} from './dist/workshop-package.js';
import {WORKSHOP_EXAMPLES} from './dist/workshop-examples.js';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
function fields(args,allowed){
  if(!args||typeof args!=='object'||Array.isArray(args))fail('创意工坊参数无效。');
}
function uuid(value){
  if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))fail('请提供有效 UUID；重试发布须沿用原 key。');
  return value.toLowerCase();
}
function version(value){if(!Number.isSafeInteger(value)||value<1)fail('请指定作品的整数版本。');return value;}
function actor(service,principal){
  const user=service.store.users.find(user=>user.id===principal.userId);
  if(!user?.enabled)fail('账号已暂停或不存在。',403);
}
const VERSION_SELECT=`SELECT i.id,i.author_id,i.kind,i.removed_at,v.version,v.package,v.created_at
  FROM workshop_items i JOIN workshop_versions v ON v.item_id=i.id`;
function record(service,id,number){
  const row=service.db.prepare(VERSION_SELECT+' WHERE i.id=?'+(number===undefined?' ORDER BY v.version DESC LIMIT 1':' AND v.version=?'))
    .get(...(number===undefined?[uuid(id)]:[uuid(id),version(number)]));
  if(!row)fail('作品或版本不存在。',404);
  if(row.removed_at!==null)fail('作品已下架，所有使用者均已停用。',410);
  return row;
}
function view(service,principal,row){
  const pkg=JSON.parse(row.package),author=service.store.users.find(user=>user.id===row.author_id);
  return {item:{id:row.id,version:row.version,kind:row.kind,...(pkg.presentation==='interface'?{presentation:'interface'}:{}),name:pkg.name,description:pkg.description,
    author:{id:row.author_id,name:row.author_id==='system'?'STARGATE':author?.name||'已删除账号',username:author?.username||null},createdAt:row.created_at,
    canEdit:true,canRemove:true},package:pkg};
}
function mine(service,principal){
  const rows=service.db.prepare(VERSION_SELECT+` JOIN workshop_installs s ON s.item_id=i.id AND s.version=v.version
    WHERE s.user_id=? AND i.removed_at IS NULL ORDER BY i.kind DESC,s.installed_at,i.id`).all(principal.userId);
  return {installed:rows.map(row=>view(service,principal,row))};
}
export function installWorkshop(service){
  service.db.exec(`
    CREATE TABLE IF NOT EXISTS workshop_items (
      id TEXT PRIMARY KEY, author_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('theme','plugin')), removed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS workshop_versions (
      item_id TEXT NOT NULL, version INTEGER NOT NULL, author_id TEXT NOT NULL,
      client_key TEXT NOT NULL, request_json TEXT NOT NULL, package TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(item_id,version), UNIQUE(author_id,client_key)
    );
    CREATE TABLE IF NOT EXISTS workshop_installs (
      user_id TEXT NOT NULL, item_id TEXT NOT NULL, version INTEGER NOT NULL, installed_at TEXT NOT NULL,
      PRIMARY KEY(user_id,item_id)
    );
  `);
  for(const [name,id] of [['light','ec2da0a5-485a-44ee-aeb6-7b2f6f2ad015'],['aispace','6f3e6e95-1ed8-40db-8e4c-18596c74380e']]){
    const pkg=normalizeWorkshopPackage(WORKSHOP_EXAMPLES.find(example=>example.id===name).package);
    service.db.prepare('INSERT OR IGNORE INTO workshop_items(id,author_id,kind) VALUES(?,?,?)').run(id,'system','theme');
    service.db.prepare('INSERT OR IGNORE INTO workshop_versions(item_id,version,author_id,client_key,request_json,package,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id,1,'system',id,'{}',JSON.stringify(pkg),'2026-10-20T00:00:00.000Z');
  }
}
function dispatch(service,principal,operation,args){
  const db=service.db;
  if(operation==='workshop.list'){
    fields(args,[]);
    const rows=db.prepare(VERSION_SELECT+` WHERE i.removed_at IS NULL AND v.version=(SELECT max(version) FROM workshop_versions WHERE item_id=i.id)
      ORDER BY v.created_at DESC,i.id`).all();
    return {items:rows.map(row=>view(service,principal,row).item)};
  }
  if(operation==='workshop.get'){
    fields(args,['id','version']);
    return view(service,principal,record(service,args.id,args.version));
  }
  if(operation==='workshop.mine'){fields(args,[]);return mine(service,principal);}
  if(operation==='workshop.publish'){
    fields(args,['key','id','package']);
    const key=uuid(args.key),id=args.id===undefined?null:uuid(args.id),pkg=normalizeWorkshopPackage(args.package);
    const request=JSON.stringify({id,package:pkg});
    const previous=db.prepare('SELECT * FROM workshop_versions WHERE author_id=? AND client_key=?').get(principal.userId,key);
    if(previous){
      if(previous.request_json!==request)fail('同一 key 不能发布不同内容；请查询原作品。',409);
      return {...view(service,principal,record(service,previous.item_id,previous.version)),duplicate:true};
    }
    let number=1;
    if(id){
      const current=record(service,id);
      if(current.kind!==pkg.kind)fail('新版本不能改变作品类型。');
      number=current.version+1;
    }
    const itemId=id||randomUUID(),now=new Date().toISOString();
    if(!id)db.prepare('INSERT INTO workshop_items(id,author_id,kind) VALUES(?,?,?)').run(itemId,principal.userId,pkg.kind);
    db.prepare('INSERT INTO workshop_versions(item_id,version,author_id,client_key,request_json,package,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(itemId,number,principal.userId,key,request,JSON.stringify(pkg),now);
    service.audit(principal.username,operation,itemId,'ok');
    return {...view(service,principal,record(service,itemId,number)),duplicate:false};
  }
  if(operation==='workshop.install'){
    fields(args,['id','version','permissions']);
    const row=record(service,args.id,version(args.version));
    if(JSON.parse(row.package).presentation==='interface'){
      for(const entry of mine(service,principal).installed)if(entry.package.presentation==='interface')
        db.prepare('DELETE FROM workshop_installs WHERE user_id=? AND item_id=?').run(principal.userId,entry.item.id);
    }
    if(row.kind==='theme')db.prepare("DELETE FROM workshop_installs WHERE user_id=? AND item_id IN (SELECT id FROM workshop_items WHERE kind='theme')").run(principal.userId);
    db.prepare(`INSERT INTO workshop_installs(user_id,item_id,version,installed_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id,item_id) DO UPDATE SET version=excluded.version,installed_at=excluded.installed_at`)
      .run(principal.userId,row.id,row.version,new Date().toISOString());
    service.audit(principal.username,operation,row.id,'ok');
    return mine(service,principal);
  }
  if(operation==='workshop.uninstall'){
    fields(args,['id']);const id=uuid(args.id);
    db.prepare('DELETE FROM workshop_installs WHERE user_id=? AND item_id=?').run(principal.userId,id);
    service.audit(principal.username,operation,id,'ok');return mine(service,principal);
  }
  if(operation==='workshop.reset'){
    fields(args,[]);db.prepare('DELETE FROM workshop_installs WHERE user_id=?').run(principal.userId);
    service.audit(principal.username,operation,principal.userId,'ok');return {installed:[]};
  }
  if(operation==='workshop.remove'){
    fields(args,['id']);const id=uuid(args.id),row=db.prepare('SELECT * FROM workshop_items WHERE id=?').get(id);
    if(!row)fail('作品不存在。',404);
    db.prepare('UPDATE workshop_items SET removed_at=COALESCE(removed_at,?) WHERE id=?').run(new Date().toISOString(),id);
    service.audit(principal.username,operation,id,'ok');return {removed:true,id};
  }
  fail('未知创意工坊操作。');
}

// Every API call shares PortalService's authenticated mutation queue; these
// three small tables never touch training jobs, quotas, projects or node RPCs.
export function workshopCall(service,principal,operation,args={}){
  actor(service,principal);service.db.exec('BEGIN IMMEDIATE');
  try{const result=dispatch(service,principal,operation,args);service.db.exec('COMMIT');return result;}
  catch(error){service.db.exec('ROLLBACK');throw error;}
}

export function installedWorkshopPlugin(service,principal,args){
  actor(service,principal);fields(args,['id','version']);
  const row=record(service,args.id,version(args.version));
  if(row.kind!=='plugin'||!service.db.prepare('SELECT 1 FROM workshop_installs WHERE user_id=? AND item_id=? AND version=?').get(principal.userId,row.id,row.version))
    fail('此插件版本未安装或已停用。',403);
  return JSON.parse(row.package);
}
