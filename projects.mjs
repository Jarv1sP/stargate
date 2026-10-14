import {UUID,selectFields} from './portal-request-validation.mjs';
import {projectCatalogCall} from './project-catalog.mjs';
export {UUID};
export const PROJECT=/^[a-z][a-z0-9_-]{0,47}$/;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export function projectReference(args,{optional=true}={}){
  if(args.project===undefined){if(!optional)fail('请先选择项目。');return {};}
  if(typeof args.project!=='string'||!PROJECT.test(args.project))fail('项目目录名称无效。');
  return {project:args.project};
}
export async function projectCall(service,principal,user,operation,args,authorize){
  const ownerId=args.ownerId??user.id;
  const owner=service.store.users.find(row=>row.id===ownerId)||{id:ownerId};
  const presentation=await projectCatalogCall(service,principal,owner,operation,args,authorize);
  if(presentation!==undefined)return presentation;
  const names=new Set(['projects.list','projects.quota','projects.create','projects.status','projects.archive','projects.unarchive',
    'projects.retire','projects.retire.status','projects.retire.list','projects.retire.restore','projects.retire.purge','projects.retire.empty']);
  if(!names.has(operation))return undefined;
  authorize(args.machine);
  args=selectFields(args,['machine','ownerId','project','key','kind',...(operation==='projects.create'?['repo']:operation==='projects.status'?['diagnoseNetwork']:[])]);
  const collection=['projects.list','projects.quota','projects.retire.list','projects.retire.empty'].includes(operation);
  const trash=operation.startsWith('projects.retire.');
  if(!collection&&!trash)projectReference(args,{optional:false});
  if(args.key!==undefined&&!UUID.test(args.key))fail('请使用原 UUID 编号。');
  if(['projects.retire','projects.retire.restore','projects.retire.purge'].includes(operation)&&!UUID.test(args.key||''))fail('请使用原回收站编号。');
  if(['projects.retire.purge','projects.retire.empty'].includes(operation)&&principal.role!=='admin')fail('立即清空仅管理员可用。',403);
  if(args.repo!==undefined&&(typeof args.repo!=='string'||Buffer.byteLength(args.repo)>4096||/[\x00-\x1f\x7f]/.test(args.repo)))fail('仓库地址格式或长度无效。');
  if(args.repo){try{const url=new URL(args.repo);if(url.password||['http:','https:'].includes(url.protocol)&&url.username)fail('仓库地址不要带密码或令牌，请在容器终端里配置 Git 凭据。');}catch(error){if(error.status)throw error;}}
  const {machine,...request}=args;
  const result=await service.bridge(machine,operation,{...request,...(!collection||operation==='projects.quota'||args.ownerId!==undefined?{ownerId}:{}),userId:principal.userId,actor:{userId:principal.userId,isAdmin:principal.role==='admin'}});
  if(!['projects.list','projects.quota','projects.status','projects.retire.list','projects.retire.status'].includes(operation))
    service.audit(principal.username,operation,machine,JSON.stringify({project:args.project,key:args.key,kind:args.kind,ownerId}));
  if(operation==='projects.list')return {...result,projects:result.projects?.map(row=>{
    const id=row.ownerId??ownerId,account=service.store.users.find(user=>user.id===id);
    return {...service.projectPresentation(id,machine,row),ownerId:id,ownerName:account?.name??'已删除账号'};
  })};
  if(['projects.create','projects.status'].includes(operation))return service.projectPresentation(ownerId,machine,result);
  return result;
}
export function validateProjectFile(args){
  if(args.area==='dataset')return {area:'dataset',dataset:args.dataset};
  const reference=projectReference(args,{optional:false}),area=args.area||'code';
  if(!['code','output'].includes(area))fail('请选择工作区、数据集或任务输出。');
  if(area==='output'&&!UUID.test(args.runId||''))fail('请指定任务 UUID。');
  return {...reference,area,...(area==='output'?{runId:args.runId}:{})};
}
