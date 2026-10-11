import {authorizationPolicy} from './dist/model.js';
import {projectCatalogCall} from './project-catalog.mjs';
// Project identities are always derived from the authenticated account. A
// client chooses a node and an opaque project/release, never a host filesystem.
export const PROJECT=/^[a-z][a-z0-9_-]{0,47}$/;
export const RELEASE=/^[a-f0-9]{64}$/;
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export function projectReference(args,{optional=true,release=false}={}){
  if(args.project===undefined){if(!optional||args.release!==undefined)fail('请先选择项目。');return {};}
  if(typeof args.project!=='string'||!PROJECT.test(args.project))fail('项目名称须以小写字母开头，仅用字母、数字、下划线或连字符，最长 48 位。');
  if(release&&(typeof args.release!=='string'||!RELEASE.test(args.release)))fail('训练必须使用已发布的完整项目版本。先发布代码和环境。');
  return {project:args.project,...(release?{release:args.release}:{})};
}
export async function projectCall(service,principal,user,operation,args,authorizedMachine){
  const presentation=await projectCatalogCall(service,principal,user,operation,args,authorizedMachine);
  if(presentation!==undefined)return presentation;
  const lifecycle=['projects.archive','projects.unarchive','projects.retire.plan','projects.retire','projects.retire.status'].includes(operation);
  if(!lifecycle&&!['projects.list','projects.quota','projects.create','projects.status','projects.publish','projects.local-import.begin','projects.local-import.status','projects.local-import.cancel'].includes(operation))return undefined;
  authorizedMachine(args.machine);
  const ownerOnly=['projects.list','projects.quota'].includes(operation);
  const allowed=ownerOnly?['machine']:['machine','project'];
  if(operation==='projects.create')allowed.push('environmentMode');
  if(operation==='projects.publish')allowed.push('key');
  if(['projects.archive','projects.unarchive','projects.retire'].includes(operation))allowed.push('revision');
  if(['projects.retire','projects.retire.status'].includes(operation))allowed.push('key');
  if(operation==='projects.retire')allowed.push('manifestSha256');
  if(operation.startsWith('projects.local-import.'))allowed.push('key');
  if(operation==='projects.local-import.begin')allowed.push('sourcePath','destinationPath');
  if(Object.keys(args).some(k=>!allowed.includes(k)))fail('项目参数无效。');
  if(args.key!==undefined&&(typeof args.key!=='string'||!UUID.test(args.key)))fail('发布标识必须是完整 UUID。');
  if(['projects.archive','projects.unarchive','projects.retire'].includes(operation)&&(!Number.isSafeInteger(args.revision)||args.revision<0||args.revision>=Number.MAX_SAFE_INTEGER))fail('请使用当前项目生命周期 revision。');
  if(['projects.retire','projects.retire.status'].includes(operation)&&!UUID.test(args.key||''))fail('退役须使用固定完整 UUID。');
  if(operation==='projects.retire'&&!RELEASE.test(args.manifestSha256||''))fail('退役须使用准确的清单摘要。');
  if(operation==='projects.create'&&args.environmentMode!==undefined&&args.environmentMode!=='oci')fail('新项目统一使用个人容器；不能新建共享或隔离 venv 环境。');
  if(operation==='projects.local-import.begin')for(const key of ['sourcePath','destinationPath']){
    const value=args[key];
    if(typeof value!=='string'||value.length>1024||value.includes('\\')||/[\p{Cc}\p{Cf}]/u.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'||p.length>255))fail('同机导入只接受个人数据区和项目草稿内的相对目录。');
  }
  if(operation.startsWith('projects.local-import.')&&args.key===undefined)fail('同机导入必须使用固定 UUID 操作标识。');
  const reference=ownerOnly?{}:projectReference(args,{optional:false});
  if(operation==='projects.create')await service.ociProjectAdmission?.(args.machine,user.id,args.project,{creatingOCI:true});
  if(operation==='projects.publish')await service.ociProjectAdmission?.(args.machine,user.id,args.project);
  const priorJobs=service.store.jobs.filter(job=>job.userId===user.id&&job.machine===args.machine&&job.project===args.project);
  if(operation==='projects.retire'&&priorJobs.length)fail('项目有任务历史，不能退役；请归档以保留结果。',409);
  if(operation==='projects.archive'&&priorJobs.some(job=>!['SUCCEEDED','FAILED','CANCELED'].includes(job.state)&&!job.nodeJobId))fail('已有任务尚未确认派发到节点；先核对其原状态，再归档项目。',409);
  const policy=authorizationPolicy(user);
  const result=await service.bridge(args.machine,operation,{...reference,...(operation==='projects.create'?{environmentMode:'oci'}:{}),...(args.key!==undefined?{key:args.key}:{}),...(args.revision!==undefined?{revision:args.revision}:{}),...(args.manifestSha256!==undefined?{manifestSha256:args.manifestSha256}:{}),...(operation==='projects.local-import.begin'?{sourcePath:args.sourcePath,destinationPath:args.destinationPath}:{}),userId:user.id});
  if(authorizationPolicy(service.store.get(user.id))!==policy)fail('账号权限已改变，请重新查询原操作状态。',403);
  if(operation==='projects.create'&&(result?.project!==args.project||result.environmentMode!=='oci'))fail('服务器未确认个人容器项目；请查询原项目，不会回退或新建替代环境。',503);
  if(operation==='projects.quota')return quotaStatus(result,user.id);
  if(['projects.create','projects.publish','projects.local-import.begin','projects.local-import.cancel','projects.archive','projects.unarchive','projects.retire'].includes(operation))service.audit(principal.username,operation,args.machine,args.project);
  if(operation==='projects.list')return {...result,environmentModes:Array.isArray(result.environmentModes)&&result.environmentModes.includes('oci')?['oci']:[],projects:(result.projects||[]).map(row=>service.projectPresentation(user.id,args.machine,row))};
  return ['projects.status','projects.create'].includes(operation)?service.projectPresentation(user.id,args.machine,result):result;
}
export function quotaStatus(value,owner){
  const unknown=()=>fail('磁盘硬配额用量未确认，请联系管理员；不会当作零用量。',503);
  if(!value||typeof value!=='object'||Array.isArray(value)||value.owner!==owner||typeof value.enabled!=='boolean')unknown();
  if(!value.enabled){
    const keys=Object.keys(value).sort().join(',');
    if(!['enabled,enforcement,owner,volumes','enabled,enforcement,owner,reason,volumes'].includes(keys)||value.enforcement!==null||value.volumes!==null||(keys.includes('reason')&&value.reason!=='OWNER_NOT_ACTIVATED'))unknown();
    return value;
  }
  if(Object.keys(value).sort().join(',')!=='enabled,enforcement,owner,projectId,volumes'||value.enforcement!=='kernel-project-quota'||!Number.isSafeInteger(value.projectId)||value.projectId<10000||value.projectId>=2**31||!Array.isArray(value.volumes)||!value.volumes.length||value.volumes.length>8)unknown();
  const seen=new Set();
  for(const row of value.volumes){
    if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='bytes,inodes,remainingBytes,remainingInodes,usedBytes,usedInodes,volume'||typeof row.volume!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(row.volume)||seen.has(row.volume))unknown();
    for(const key of ['bytes','inodes','usedBytes','usedInodes','remainingBytes','remainingInodes'])if(!Number.isSafeInteger(row[key])||row[key]<0)unknown();
    if(!row.bytes||!row.inodes||row.remainingBytes!==Math.max(0,row.bytes-row.usedBytes)||row.remainingInodes!==Math.max(0,row.inodes-row.usedInodes))unknown();
    seen.add(row.volume);
  }
  return value;
}
export function validateProjectFile(args){
  const reference=projectReference(args);
  if(!reference.project){
    if(['area','runId','uploadId','totalSize','sha256','final'].some(k=>args[k]!==undefined))fail('这些文件参数仅用于项目工作区。');
    return {};
  }
  if(args.area!==undefined&&!['code','output'].includes(args.area))fail('只能访问项目代码或本人的任务输出。');
  const area=args.area||'code';
  if(area==='output'&&(typeof args.runId!=='string'||!UUID.test(args.runId)))fail('下载输出时必须指定任务 ID。');
  if(area==='code'&&args.runId!==undefined)fail('代码工作区不能指定任务 ID。');
  return {...reference,area,...(area==='output'?{runId:args.runId}:{})};
}
