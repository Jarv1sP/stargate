import {authorizationPolicy} from './dist/model.js';
// Portal boundary for pinned snapshot reads and code-only imports. Both source
// and target node calls use the authenticated account, never supplied identity.
const hash=/^[a-f0-9]{64}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const project=/^[a-z][a-z0-9_-]{0,47}$/;
const dataset=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const fields={begin:['manifestBytes','manifestSha256','totalBytes','entries','source'],manifest:['offset','data'],seal:[],status:['path'],chunk:['path','offset','data'],finish:[],cancel:['snapshotId','source','manifestSha256','revision']};
export async function snapshotSyncCall(service,principal,user,operation,args,authorizedMachine,{physical=false}={}){
  const match=/^(projects|datasets)\.(snapshot|sync)\.([a-z]+)$/.exec(operation);if(!match)return undefined;
  const [,kind,mode,action]=match;authorizedMachine(args.machine);
  const reference=kind==='projects'?['project',...(mode==='snapshot'?['release']:['key'])]:['dataset','version'];
  const extra=mode==='snapshot'?({info:[],manifest:['offset'],get:['path','offset']}[action]):fields[action];
  if(!extra||mode==='sync'&&kind!=='projects'||Object.keys(args).some(k=>!['machine',...reference,...extra].includes(k)))fail('同步参数无效。');
  if(kind==='projects'&&(typeof args.project!=='string'||!project.test(args.project)))fail('同步项目名无效。');
  if(kind==='datasets'&&(!dataset.test(args.dataset||'')||!hash.test(args.version||'')))fail('必须选择完整的数据集名称与固定版本。');
  if(mode==='snapshot'&&kind==='projects'&&!hash.test(args.release||''))fail('代码同步必须指定完整的已发布版本。');
  if(mode==='sync'&&!uuid.test(args.key||''))fail('代码同步需要 UUID 重试键。');
  if(args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0))fail('同步偏移无效。');
  if(args.data!==undefined&&(typeof args.data!=='string'||args.data.length>1398104||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)))fail('同步分块无效。');
  if(args.path!==undefined&&(typeof args.path!=='string'||!args.path||args.path.startsWith('/')||args.path.length>4096||/[\\\x00-\x1f\x7f]/.test(args.path)||args.path.split('/').some(p=>['','.','..'].includes(p))))fail('同步只能使用快照内相对路径。');
  if(action==='cancel'){
    const source=args.source;
    if(!uuid.test(args.snapshotId||'')||!hash.test(args.revision||'')||!hash.test(args.manifestSha256||'')||!source||typeof source!=='object'||Array.isArray(source))fail('取消同步需要原 UUID、快照身份和最新状态校验。');
    const keys=Object.keys(source);
    if(source.kind==='git'?(keys.length!==2||keys.some(k=>!['kind','commit'].includes(k))||typeof source.commit!=='string'||!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(source.commit)):
      source.kind==='release'?(keys.length!==4||keys.some(k=>!['kind','machine','project','release'].includes(k))||typeof source.machine!=='string'||!source.machine||source.machine.length>128||!project.test(source.project||'')||!hash.test(source.release||'')):true)fail('取消同步必须保留固定原始来源。');
    // Cancellation only fences this account's target draft. It neither reads
    // nor changes the original source, which may now be offline/revoked.
  }
  const policy=mode==='sync'&&action==='begin'?authorizationPolicy(user):null;
  if(action==='begin'){
    if(!hash.test(args.manifestSha256||'')||!Number.isSafeInteger(args.manifestBytes)||args.manifestBytes<1||args.manifestBytes>48*1024**2||!Number.isSafeInteger(args.totalBytes)||args.totalBytes<0||!Number.isSafeInteger(args.entries)||args.entries<0)fail('代码快照大小或校验信息无效。');
    const source=args.source;
    if(!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).some(k=>!['kind','commit','machine','project','release'].includes(k))||!['git','release'].includes(source.kind))fail('同步来源无效。');
    if(source.kind==='git'&&(Object.keys(source).length!==2||typeof source.commit!=='string'||!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(source.commit)))fail('Git 来源必须固定完整 commit。');
    // Code-only imports create a personal OCI draft on the target. Use the
    // same server-derived membership admission as ordinary project creation;
    // the client cannot request a legacy venv or supply an owner/cohort.
    await service.ociProjectAdmission?.(args.machine,user.id,args.project,{creatingOCI:true});
    if(source.kind==='release'){
      if(Object.keys(source).length!==4||!project.test(source.project||'')||!hash.test(source.release||''))fail('来源必须固定项目版本。');
      authorizedMachine(source.machine);
      const ready=await service.bridge(source.machine,'projects.snapshot.info',{project:source.project,release:source.release,userId:user.id});
      if(ready.state!=='READY'||['manifestBytes','manifestSha256','totalBytes','entries'].some(k=>ready[k]!==args[k]))fail('源节点的固定快照与同步清单不符。',409);
    }
  }
  const {machine,...request}=args;
  if(policy!==null&&service.store&&authorizationPolicy(service.store.get(user.id))!==policy)fail('账号权限已改变，请查询原同步状态。',403);
  if(!physical&&mode==='snapshot'&&kind==='datasets'&&service.datasetPhysicalReference){
    const mapped=service.datasetPhysicalReference(user.id,machine,{dataset:request.dataset,version:request.version});
    if(!mapped||typeof mapped.dataset!=='string'||!dataset.test(mapped.dataset)||mapped.version!==request.version)fail('数据集逻辑引用尚未确认。',409);
    request.dataset=mapped.dataset;
  }
  const result=await service.bridge(machine,operation,{...request,userId:user.id,...(mode==='snapshot'&&kind==='datasets'?{hostAdmin:principal.role==='admin'}:{})});
  if(policy!==null&&service.store&&authorizationPolicy(service.store.get(user.id))!==policy)fail('账号权限已改变，请查询原同步状态。',403);
  if(mode==='sync'&&['begin','finish','cancel'].includes(action))service.audit(principal.username,operation,machine,args.project);
  return result;
}
