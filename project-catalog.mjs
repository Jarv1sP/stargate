// Owner-scoped presentation only. No filesystem, release or run identities change.
import {authorizationPolicy,MACHINES} from './dist/model.js';
const PROJECT=/^[a-z][a-z0-9_-]{0,47}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const fields=(args,allowed)=>{if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!allowed.includes(k)))fail('项目整理参数无效。');};
function name(value){if(typeof value!=='string'||/[\p{Cc}\p{Cf}]/u.test(value))fail('名称不能包含控制或不可见字符。');const text=value.normalize('NFC').trim();if([...text].length<1||[...text].length>80)fail('显示名称需为 1–80 个字符。');return text;}
function revision(value){if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)fail('请提供当前 revision，首次为 0。');}
function instance(value){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='machine,project'||!MACHINES.some(m=>m.id===value.machine)||typeof value.project!=='string'||!PROJECT.test(value.project))fail('项目实例须指定服务器和内部项目 ID。');return {machine:value.machine,project:value.project};}
export function installProjectCatalog(service){
  service.db.exec(`CREATE TABLE IF NOT EXISTS project_labels(owner_id TEXT NOT NULL,machine TEXT NOT NULL,project TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,machine,project));
    CREATE TABLE IF NOT EXISTS project_groups(owner_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,primary_machine TEXT,primary_project TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,id));
    CREATE TABLE IF NOT EXISTS project_group_members(owner_id TEXT NOT NULL,machine TEXT NOT NULL,project TEXT NOT NULL,group_id TEXT NOT NULL,PRIMARY KEY(owner_id,machine,project));`);
  service.projectPresentation=(owner,machine,row)=>{
    const label=service.db.prepare('SELECT name,revision FROM project_labels WHERE owner_id=? AND machine=? AND project=?').get(owner,machine,row.project);
    const group=service.db.prepare('SELECT g.id,g.name,g.revision,g.primary_machine,g.primary_project FROM project_group_members m JOIN project_groups g ON g.owner_id=m.owner_id AND g.id=m.group_id WHERE m.owner_id=? AND m.machine=? AND m.project=?').get(owner,machine,row.project);
    return {...row,displayName:label?.name||row.project,displayNameRevision:label?.revision||0,
      logicalProjectId:group?.id??null,logicalProjectName:group?.name??null,
      ...(group?{logicalProjectRevision:group.revision,primaryInstance:group.primary_machine?{machine:group.primary_machine,project:group.primary_project}:null}:{})};
  };
}
export async function projectCatalogCall(service,principal,user,operation,args,authorize){
  if(!['projects.label.get','projects.label.set','projects.group.get','projects.group.set','projects.catalog'].includes(operation))return undefined;
  const policy=authorizationPolicy(user);
  const check=()=>{const current=service.store.get(user.id);if(service.closing||!current.enabled||authorizationPolicy(current)!==policy)fail('账号授权改变，请重新读取项目；未修改整理信息。',403);};
  const proof=async ref=>{authorize(ref.machine);check();const result=await service.bridge(ref.machine,'projects.status',{userId:user.id,project:ref.project});check();if(result?.project!==ref.project||!['DRAFT','READY','PUBLISHING','FAILED','UNKNOWN','SYNCING','IMPORTING','COMMITTING'].includes(result.state))fail('项目实例尚未确认，未修改整理信息。',503);return result;};
  if(operation==='projects.catalog'){
    fields(args,['includeArchived']);if(args.includeArchived!==undefined&&typeof args.includeArchived!=='boolean')fail('includeArchived 须为布尔值。');
    const rows=[],errors=[];
    for(const machine of MACHINES.filter(m=>user.limits[m.id]>0).map(m=>m.id)){
      check();try{
        const result=await service.bridge(machine,'projects.list',{userId:user.id});check();
        if(!Array.isArray(result?.projects)||result.projects.length>64)throw Error('项目清单无效');
        for(const row of result.projects){instance({machine,project:row?.project});if(!args.includeArchived&&row.lifecycle?.state==='ARCHIVED')continue;rows.push({machine,...service.projectPresentation(user.id,machine,row)});}
      }catch(error){check();errors.push({machine,error:'此节点项目清单未确认'});}
    }
    const groups=new Map();
    for(const row of rows){const id=row.logicalProjectId||row.machine+':'+row.project;if(!groups.has(id))groups.set(id,{id,logical:!!row.logicalProjectId,name:row.logicalProjectName||row.displayName,instances:[],primaryInstance:row.primaryInstance||null});groups.get(id).instances.push(row);}
    return {groups:[...groups.values()],partial:errors.length>0,errors,historyMapping:'immutable-instance-references'};
  }
  if(operation.startsWith('projects.label.')){
    const setting=operation.endsWith('.set');fields(args,['machine','project',...(setting?['displayName','revision']:[])]);
    const ref=instance({machine:args.machine,project:args.project});const text=setting?name(args.displayName):null;if(setting)revision(args.revision);await proof(ref);
    const view=()=>{const row=service.db.prepare('SELECT name,revision,updated_at FROM project_labels WHERE owner_id=? AND machine=? AND project=?').get(user.id,ref.machine,ref.project);return {...ref,displayName:row?.name||ref.project,revision:row?.revision||0,updatedAt:row?.updated_at||null};};
    if(!setting)return view();check();service.db.exec('BEGIN IMMEDIATE');
    try{if(view().revision!==args.revision)fail('名称已被其他客户端修改，请刷新。',409);
      if(args.revision===0&&service.db.prepare('SELECT count(*) AS n FROM project_labels WHERE owner_id=?').get(user.id).n>=10000)fail('项目名称记录过多。',429);
      service.db.prepare('INSERT INTO project_labels(owner_id,machine,project,name,revision,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,machine,project) DO UPDATE SET name=excluded.name,revision=excluded.revision,updated_at=excluded.updated_at').run(user.id,ref.machine,ref.project,text,args.revision+1,new Date().toISOString());
      service.db.exec('COMMIT');
    }catch(error){service.db.exec('ROLLBACK');throw error;}
    service.audit(principal.username,operation,ref.machine,ref.project);return view();
  }
  const setting=operation.endsWith('.set');fields(args,['id',...(setting?['displayName','revision','members','primary']:[])]);
  if(typeof args.id!=='string'||!UUID.test(args.id))fail('逻辑项目须使用固定 UUID。');
  const view=()=>{const row=service.db.prepare('SELECT * FROM project_groups WHERE owner_id=? AND id=?').get(user.id,args.id);if(!row)return {id:args.id,revision:0,members:[],displayName:null,primary:null};
    const members=service.db.prepare('SELECT machine,project FROM project_group_members WHERE owner_id=? AND group_id=? ORDER BY machine,project').all(user.id,args.id).map(instance);for(const ref of members)authorize(ref.machine);
    return {id:args.id,revision:row.revision,displayName:row.name,members,primary:row.primary_machine?{machine:row.primary_machine,project:row.primary_project}:null};};
  const previous=view();if(!setting)return previous;
  revision(args.revision);const text=name(args.displayName);
  if(!Array.isArray(args.members)||args.members.length>32)fail('一个逻辑项目最多包含 32 个实例；空成员用于解除归组。');
  const members=args.members.map(instance),keys=members.map(r=>r.machine+':'+r.project);if(new Set(keys).size!==keys.length)fail('项目实例不能重复。');
  const primary=args.primary==null?null:instance(args.primary);if(primary&&!keys.includes(primary.machine+':'+primary.project))fail('主实例必须在本组成员中。');
  for(const ref of members)await proof(ref);
  check();service.db.exec('BEGIN IMMEDIATE');
  try{if(view().revision!==args.revision)fail('逻辑项目已被其他客户端更新，请刷新。',409);
    if(args.revision===0&&service.db.prepare('SELECT count(*) AS n FROM project_groups WHERE owner_id=?').get(user.id).n>=1000)fail('逻辑项目记录过多。',429);
    for(const ref of members){const row=service.db.prepare('SELECT group_id FROM project_group_members WHERE owner_id=? AND machine=? AND project=?').get(user.id,ref.machine,ref.project);if(row&&row.group_id!==args.id)fail('实例已属于其他逻辑项目；先在原组移除，不能覆盖。',409);}
    service.db.prepare('INSERT INTO project_groups(owner_id,id,name,revision,primary_machine,primary_project,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,id) DO UPDATE SET name=excluded.name,revision=excluded.revision,primary_machine=excluded.primary_machine,primary_project=excluded.primary_project,updated_at=excluded.updated_at').run(user.id,args.id,text,args.revision+1,primary?.machine??null,primary?.project??null,new Date().toISOString());
    service.db.prepare('DELETE FROM project_group_members WHERE owner_id=? AND group_id=?').run(user.id,args.id);
    const insert=service.db.prepare('INSERT INTO project_group_members(owner_id,machine,project,group_id) VALUES(?,?,?,?)');for(const ref of members)insert.run(user.id,ref.machine,ref.project,args.id);
    service.db.exec('COMMIT');
  }catch(error){service.db.exec('ROLLBACK');throw error;}
  service.audit(principal.username,operation,null,args.id);return view();
}
