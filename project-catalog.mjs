import {UUID,selectFields} from './portal-request-validation.mjs';
// Owner-scoped presentation only. No filesystem, release or run identities change.
import {MACHINES} from './dist/model.js';
const PROJECT=/^[a-z][a-z0-9_-]{0,47}$/;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
function name(value){if(typeof value!=='string'||/[\p{Cc}\p{Cf}]/u.test(value))fail('名称不能包含控制或不可见字符。');const text=value.normalize('NFC').trim();if([...text].length<1||[...text].length>80)fail('显示名称需为 1–80 个字符。');return text;}
function instance(value){if(!value||typeof value!=='object'||Array.isArray(value)||!MACHINES.some(m=>m.id===value.machine)||typeof value.project!=='string'||!PROJECT.test(value.project))fail('项目实例须指定服务器和内部项目 ID。');return {machine:value.machine,project:value.project};}
export function installProjectCatalog(service){
  service.db.exec(`CREATE TABLE IF NOT EXISTS project_labels_v2(owner_id TEXT NOT NULL,machine TEXT NOT NULL,project TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,machine,project));
    CREATE TABLE IF NOT EXISTS project_shared_v2(owner_id TEXT NOT NULL,machine TEXT NOT NULL,project TEXT NOT NULL,shared INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,machine,project));
    CREATE TABLE IF NOT EXISTS project_groups_v2(owner_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,primary_machine TEXT,primary_project TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,id));
    CREATE TABLE IF NOT EXISTS project_group_members_v2(owner_id TEXT NOT NULL,machine TEXT NOT NULL,project TEXT NOT NULL,group_id TEXT NOT NULL,PRIMARY KEY(owner_id,machine,project));`);
  service.projectPresentation=(owner,machine,row)=>{
    const label=service.db.prepare('SELECT name,revision FROM project_labels_v2 WHERE owner_id=? AND machine=? AND project=?').get(owner,machine,row.project);
    const shared=service.db.prepare('SELECT shared FROM project_shared_v2 WHERE owner_id=? AND machine=? AND project=?').get(owner,machine,row.project);
    const group=service.db.prepare('SELECT g.id,g.name,g.revision,g.primary_machine,g.primary_project FROM project_group_members_v2 m JOIN project_groups_v2 g ON g.owner_id=m.owner_id AND g.id=m.group_id WHERE m.owner_id=? AND m.machine=? AND m.project=?').get(owner,machine,row.project);
    return {...row,shared:shared?.shared===1,displayName:label?.name||row.project,displayNameRevision:label?.revision||0,
      logicalProjectId:group?.id??null,logicalProjectName:group?.name??null,
      ...(group?{logicalProjectRevision:group.revision,primaryInstance:group.primary_machine?{machine:group.primary_machine,project:group.primary_project}:null}:{})};
  };
}
export function setProjectShared(service,owner,machine,project,shared){
  service.db.prepare('INSERT INTO project_shared_v2(owner_id,machine,project,shared,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,machine,project) DO UPDATE SET shared=excluded.shared,updated_at=excluded.updated_at').run(owner,machine,project,shared===true?1:0,new Date().toISOString());
}
export async function projectCatalogCall(service,principal,user,operation,args,authorize){
  if(!['projects.label.get','projects.label.set','projects.shared.set','projects.group.get','projects.group.set','projects.catalog'].includes(operation))return undefined;
  const check=()=>{if(service.closing)fail('服务正在关闭，请稍后查询。',503);};
  if(operation==='projects.shared.set'){
    args=selectFields(args,['machine','ownerId','project','shared']);const ref=instance(args);authorize(ref.machine);check();
    setProjectShared(service,user.id,ref.machine,ref.project,args.shared);
    service.audit(principal.username,operation,ref.machine,JSON.stringify({project:ref.project,ownerId:user.id,shared:args.shared===true}));
    return service.projectPresentation(user.id,ref.machine,{...ref,ownerId:user.id,ownerName:user.name??null});
  }
  if(operation==='projects.catalog'){
    args=selectFields(args,['includeArchived','ownerId']);if(args.includeArchived!==undefined&&typeof args.includeArchived!=='boolean')fail('includeArchived 须为布尔值。');
    const rows=[],errors=[];
    for(const machine of MACHINES.map(m=>m.id)){
      check();try{
        const result=await service.bridge(machine,'projects.list',{userId:principal.userId,...(args.ownerId?{ownerId:user.id}:{})});check();
        if(!Array.isArray(result?.projects))throw Error('项目清单无效');
        for(const row of result.projects){instance({machine,project:row?.project});if(!args.includeArchived&&row.lifecycle?.state==='ARCHIVED')continue;const owner=service.store.users.find(value=>value.id===(row.ownerId??row.userId??user.id));rows.push({machine,...service.projectPresentation(owner?.id??user.id,machine,row),ownerId:owner?.id??row.ownerId??user.id,ownerName:owner?.name??null});}
      }catch(error){check();errors.push({machine,error:'此节点项目列表暂未读到，请稍后重试。'});}
    }
    const groups=new Map();
    for(const row of rows){const id=row.logicalProjectId||row.ownerId+':'+row.machine+':'+row.project;if(!groups.has(id))groups.set(id,{id,logical:!!row.logicalProjectId,name:row.logicalProjectName||row.displayName,instances:[],primaryInstance:row.primaryInstance||null});groups.get(id).instances.push(row);}
    return {groups:[...groups.values()],partial:errors.length>0,errors,historyMapping:'immutable-instance-references'};
  }
  if(operation.startsWith('projects.label.')){
    const setting=operation.endsWith('.set');args=selectFields(args,['machine','ownerId','project',...(setting?['displayName']:[])]);
    const ref=instance({machine:args.machine,project:args.project});const text=setting?name(args.displayName):null;authorize(ref.machine);check();
    const view=()=>{const row=service.db.prepare('SELECT name,revision,updated_at FROM project_labels_v2 WHERE owner_id=? AND machine=? AND project=?').get(user.id,ref.machine,ref.project);return {...ref,displayName:row?.name||ref.project,revision:row?.revision||0,updatedAt:row?.updated_at||null};};
    if(!setting)return view();check();service.db.exec('BEGIN IMMEDIATE');
    try{
      service.db.prepare('INSERT INTO project_labels_v2(owner_id,machine,project,name,revision,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,machine,project) DO UPDATE SET name=excluded.name,revision=excluded.revision,updated_at=excluded.updated_at').run(user.id,ref.machine,ref.project,text,view().revision+1,new Date().toISOString());
      service.db.exec('COMMIT');
    }catch(error){service.db.exec('ROLLBACK');throw error;}
    service.audit(principal.username,operation,ref.machine,ref.project);return view();
  }
  const setting=operation.endsWith('.set');args=selectFields(args,['ownerId','id',...(setting?['displayName','members','primary']:[])]);
  if(typeof args.id!=='string'||!UUID.test(args.id))fail('逻辑项目须使用固定 UUID。');
  const view=()=>{const row=service.db.prepare('SELECT * FROM project_groups_v2 WHERE owner_id=? AND id=?').get(user.id,args.id);if(!row)return {id:args.id,revision:0,members:[],displayName:null,primary:null};
    const members=service.db.prepare('SELECT machine,project FROM project_group_members_v2 WHERE owner_id=? AND group_id=? ORDER BY machine,project').all(user.id,args.id).map(instance);for(const ref of members)authorize(ref.machine);
    return {id:args.id,revision:row.revision,displayName:row.name,members,primary:row.primary_machine?{machine:row.primary_machine,project:row.primary_project}:null};};
  const previous=view();if(!setting)return previous;
  const text=name(args.displayName);
  if(!Array.isArray(args.members))fail('项目实例须为列表；空成员用于解除归组。');
  const members=args.members.map(instance),keys=members.map(r=>r.machine+':'+r.project);if(new Set(keys).size!==keys.length)fail('项目实例不能重复。');
  const primary=args.primary==null?null:instance(args.primary);if(primary&&!keys.includes(primary.machine+':'+primary.project))fail('主实例必须在本组成员中。');
  for(const ref of members)authorize(ref.machine);check();
  service.db.exec('BEGIN IMMEDIATE');
  try{
    service.db.prepare('INSERT INTO project_groups_v2(owner_id,id,name,revision,primary_machine,primary_project,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,id) DO UPDATE SET name=excluded.name,revision=excluded.revision,primary_machine=excluded.primary_machine,primary_project=excluded.primary_project,updated_at=excluded.updated_at').run(user.id,args.id,text,view().revision+1,primary?.machine??null,primary?.project??null,new Date().toISOString());
    service.db.prepare('DELETE FROM project_group_members_v2 WHERE owner_id=? AND group_id=?').run(user.id,args.id);
    const insert=service.db.prepare('INSERT INTO project_group_members_v2(owner_id,machine,project,group_id) VALUES(?,?,?,?) ON CONFLICT(owner_id,machine,project) DO UPDATE SET group_id=excluded.group_id');for(const ref of members)insert.run(user.id,ref.machine,ref.project,args.id);
    service.db.exec('COMMIT');
  }catch(error){service.db.exec('ROLLBACK');throw error;}
  service.audit(principal.username,operation,null,args.id);return view();
}
