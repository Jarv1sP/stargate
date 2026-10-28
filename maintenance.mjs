import {selectFields} from './portal-request-validation.mjs';
import {MACHINES} from './dist/model.js';
import {canUseMachine} from './machine-access.mjs';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
// Operational admission is independent of the retired privilege-request flow.
// This row is not part of account snapshots, so an unrelated rollback cannot
// remove a maintenance decision. No deadline or automatic unlock exists.
const READ_OR_STOP=new Set([
 'state','jobs.logs','jobs.watch','jobs.diagnostics','jobs.completion','jobs.reconcile-resources','jobs.cancel','logs','watch','diagnostics','cancel','tasks.display.get',
 'files.list','files.get','files.stat','data.upload.status','data.upload.cancel','outputs.delete','projects.list','projects.quota','projects.status','projects.catalog',
 'datasets.list','projects.label.get','projects.group.get','projects.retire.status','projects.retire.list',
 'terminal.close','terminal.detach','terminal.status','transfers.list','transfers.status','transfers.capabilities','transfers.cancel','transfers.progress',
 'cloud.info','cloud.import.list','cloud.import.status','cloud.import.cancel','cloud.import.discard',
 'cloud.files.info','cloud.files.list','cloud.files.status','cloud.files.cancel'
]);
const maintenanceError=(machine,value)=>Object.assign(Error(`${machine?'服务器 '+machine:'全平台'}维护中：${value.reason}。新任务、终端输入和数据写入已暂停，请等待管理员明确恢复；仍可查看历史、日志或取消任务。`),{status:503,code:'MAINTENANCE_ACTIVE'});
function maintenanceState(service){
  const value=JSON.parse(service.db.prepare('SELECT data FROM operational_maintenance_v2 WHERE id=1').get().data);
  if(!Number.isSafeInteger(value.revision)||value.revision<0||!value.machines||typeof value.machines!=='object'||Array.isArray(value.machines))throw Error('维护状态损坏，需管理员核查；未自动解除。');
  value.machines=Object.fromEntries(Object.entries(value.machines).filter(([id])=>MACHINES.some(machine=>machine.id===id)));
  for(const entry of [value.global,...Object.values(value.machines)])if(entry!==null&&(!entry||typeof entry.reason!=='string'||!entry.reason.trim()||entry.reason.length>300||typeof entry.since!=='string'))throw Error('维护状态损坏，需管理员核查；未自动解除。');
  return value;
}
function operationalCall(service,principal,operation,args){
  if(operation==='maintenance.status'){
    args=selectFields(args,[]);return service.operationalMaintenance(principal);
  }
  if(principal.role!=='admin')fail('仅管理员可设置或解除维护状态。',403);
  args=selectFields(args,['scope','enabled','reason']);
  if(args.scope!=='all'&&!MACHINES.some(m=>m.id===args.scope)||typeof args.enabled!=='boolean')fail('维护范围、状态或版本无效。');
  const reason=args.reason;
  if(args.enabled&&(typeof reason!=='string'||!reason.trim())||reason!==undefined&&(typeof reason!=='string'||reason.length>300||/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(reason)))fail('维护原因须为 1–300 字的单行文本，不含控制字符。');
  service.db.exec('BEGIN IMMEDIATE');
  try{
    const value=maintenanceState(service);
    const entry=args.enabled?{reason:reason.trim(),since:new Date().toISOString()}:null;
    if(args.scope==='all')value.global=entry;
    else if(entry)value.machines[args.scope]=entry;
    else delete value.machines[args.scope];
    value.revision++;
    service.db.prepare('UPDATE operational_maintenance_v2 SET data=? WHERE id=1').run(JSON.stringify(value));
    service.audit(principal.username,operation,args.scope,JSON.stringify({enabled:args.enabled,reason:reason?.trim()||'',revision:value.revision}));
    service.db.exec('COMMIT');return service.operationalMaintenance(principal);
  }catch(error){service.db.exec('ROLLBACK');throw error;}
}
// Initialize only the persisted admission state before any startup retention.
// Account/bridge-dependent interfaces remain installed later, after restore.
export function installMaintenanceState(service){
  service.db.exec('CREATE TABLE IF NOT EXISTS operational_maintenance_v2 (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)');
  service.db.prepare('INSERT OR IGNORE INTO operational_maintenance_v2 VALUES(1,?)').run(JSON.stringify({version:1,revision:0,global:null,machines:{}}));
  maintenanceState(service); // Invalid persisted state is never treated as off.
  service.globalMaintenanceActive=()=>maintenanceState(service).global!==null;
  service.maintenanceFor=machine=>{const value=maintenanceState(service);return value.global||value.machines[machine]||null;};
}
export function installMaintenance(service){
  installMaintenanceState(service);
  service.operationalMaintenance=principal=>{
    const value=maintenanceState(service),user=principal?service.store.get(principal.userId):null;
    return {...value,machines:Object.fromEntries(Object.entries(value.machines).filter(([machine])=>canUseMachine(user,machine)))};
  };
  service.assertMaintenanceAllowed=(operation,args={},principal)=>{
    // The bridge calls this again with its trusted actor, immediately before
    // dispatch. Client-supplied role/hostAdmin alone never grants an exemption.
    if(READ_OR_STOP.has(operation)||operation==='terminal.exchange'&&(args.input===undefined||args.input===''))return;
    const machines=[args.machine,args.from,args.sourceMachine,args.targetMachine,args.source?.machine,args.job?.machine].filter(id=>typeof id==='string');
    if(args.jobId){const job=service.store.jobs.find(job=>job.id===args.jobId);if(job)machines.push(job.machine);}
    const value=maintenanceState(service);
    if(value.global)throw maintenanceError(null,value.global);
    for(const machine of machines)if(value.machines[machine]){
      throw maintenanceError(machine,value.machines[machine]);
    }
  };
  const bridge=service.bridge;
  if(bridge)service.bridge=(machine,operation,args,context)=>{
    const actor=service.store.users.find(user=>user.id===(args.userId||args.job?.userId));
    service.assertMaintenanceAllowed(operation,{...args,machine},actor?{userId:actor.id,role:actor.role||'member'}:null);
    return bridge(machine,operation,args,context);
  };

}
export async function maintenanceCall(service,principal,operation,args){
  if(!service.store.get(principal.userId).enabled)fail('请重新登录。',403);
  if(!['maintenance.status','maintenance.set'].includes(operation))fail('未知维护操作。');
  return operationalCall(service,principal,operation,args);
}
