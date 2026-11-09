// Administrator-owned desired caps. Nodes apply the complete list; outages keep
// the saved setting and the next five-minute refresh retries the same values.
export function installProjectStorageLimits(service){
  service.db.exec(`CREATE TABLE IF NOT EXISTS project_storage_limits_v2(owner_id TEXT NOT NULL,machine TEXT NOT NULL,project TEXT NOT NULL,bytes INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,machine,project));`);
  service.projectStorageLimit=(owner,machine,project)=>service.db.prepare('SELECT bytes FROM project_storage_limits_v2 WHERE owner_id=? AND machine=? AND project=?').get(owner,machine,project)?.bytes??null;
  service.syncStorageLimits=async machine=>{
    const limits=service.db.prepare('SELECT owner_id AS ownerId,project,bytes FROM project_storage_limits_v2 WHERE machine=? ORDER BY owner_id,project').all(machine);
    return service.bridge(machine,'projects.storage.limits.sync',{limits,actor:{isAdmin:true}});
  };
}
export async function projectStorageLimitCall(service,principal,owner,operation,args,authorize){
  if(operation!=='projects.storage.limit.set')return undefined;
  if(principal.role!=='admin')throw Object.assign(Error('项目文件上限只有管理员能修改。'),{status:403});
  authorize(args.machine);
  if(!/^[a-z][a-z0-9_-]{0,47}$/.test(args.project||'')||typeof owner.id!=='string'||!Number.isSafeInteger(args.bytes)||args.bytes<=0)
    throw Object.assign(Error('请选择项目，并填写大于 0 的整数字节上限。'),{status:400});
  service.db.exec('BEGIN IMMEDIATE');
  try{
    service.db.prepare('INSERT INTO project_storage_limits_v2(owner_id,machine,project,bytes,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,machine,project) DO UPDATE SET bytes=excluded.bytes,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(owner.id,args.machine,args.project,args.bytes,principal.username,new Date().toISOString());
    service.audit(principal.username,operation,args.machine,JSON.stringify({ownerId:owner.id,project:args.project,bytes:args.bytes}));
    service.db.exec('COMMIT');
  }catch(error){service.db.exec('ROLLBACK');throw error;}
  let synced=true;try{await service.syncStorageLimits(args.machine);}catch{synced=false;}
  service.scheduleStorageRefresh(args.machine,0);
  return {ownerId:owner.id,machine:args.machine,project:args.project,desiredLimitBytes:args.bytes,synced};
}
