import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {project,call,submit,waitJob,terminalStates} from '../lib/exec.mjs';
import {adminSession} from '../lib/accounts.mjs';
import {stackExec} from '../lib/stack.mjs';
import {waitFor} from '../lib/context.mjs';
import {sections} from '../lib/sections.mjs';
import {trained} from './G08-outputs.mjs';
// 节点在真实开启项目配额的回环 ext4/XFS 上运行：打标、root 采样、用量接口、容器层、迁移工具。
const ROOTCHECK=`import fcntl,json,os,struct,sys
from pathlib import Path
cfg=json.load(open('/etc/gpuq-console/node-install.json'));p=cfg['profiles']['7IM']
def x(path):
    try:fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    except OSError:return None
    try:raw=bytearray(28);fcntl.ioctl(fd,0x801C581F,raw);flags,_,_,value,_=struct.unpack('IIIII8x',raw);return [value,bool(flags&0x200)]
    finally:os.close(fd)
paths=json.loads(sys.argv[1])
print(json.dumps({'config':{k:p[k] for k in ('root','workspacesRoot','datasetsRoot')},'release':cfg['releaseRoot'],
  'ids':json.load(open(p['root']+'/quota/ids.json'))['ids'],'disks':open('/run/gray-node-quota').read().split(),
  'attrs':{k:x(v.format(**p)) for k,v in paths.items()},
  'oci':{k:(json.load(open(v.format(**p))) if os.path.exists(v.format(**p)) else None) for k,v in json.loads(sys.argv[2]).items()}}))`;
// 以服务账户在另一个已打标的引擎里拉镜像、建容器、commit、删除：确认打标不影响镜像暂存与删除时的 rename。
const ENGINE=`import importlib.util,json,os,sys
from pathlib import Path
node=Path(sys.argv[1])/'current'/'node'
def load(name):
    s=importlib.util.spec_from_file_location(name.replace('-','_'),node/(name+'.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
config=json.loads(load('runtime-profile').read_private(node.parent/'profiles'/'7IM'/'node-config.json'))
engine=load('personal-oci').PersonalOCI(config,'gray-quota-probe')
state=engine.folder/'probe-state';state.mkdir(mode=0o700,exist_ok=True);engine.state_folder=state
if sys.argv[2]=='create':print(json.dumps(engine.workspace_container('probe')))
else:
    head=engine.load('probe')
    engine.run('commit','--pause=false',head['container'],'localhost/gray-quota:commit',timeout=900)
    engine.run('rmi','localhost/gray-quota:commit',timeout=900)
    engine.run('rm','--force',head['container'],timeout=900)
    engine.run('rmi','--force',head['image'],timeout=900)
    (state/'oci.json').unlink()
    print(json.dumps({'containers':engine.run('ps','--all','--format','{{.Names}}').split()}))`;
const asService=['runuser','-u','gpuops','--','env','XDG_RUNTIME_DIR=/run/user/1001','HOME=/home/gpuops','python3','-I','-B','-c'];
export default {features:[],id:'G16',title:'项目编号记账：真实配额盘上的打标、采样、容器层与迁移（STOR-001）',level:'fast',async run(ctx){
  const {name,member}=await project(ctx),item=await trained(ctx),owner=member.userId,admin=await adminSession(ctx);
  const node=async(...args)=>JSON.parse((await stackExec(ctx.stack,'gray-node-1',...args)).stdout);
  const inspect=(paths,oci={})=>node('python3','-I','-B','-c',ROOTCHECK,JSON.stringify(paths),JSON.stringify(oci));
  const ids=facts=>key=>facts.ids[key];
  const usage=async predicate=>waitFor(()=>call(ctx,member,'projects.list',{machine:ctx.machine,includeUsage:true}),predicate,{timeoutMs:180000,intervalMs:5000,what:'root 采样写出预期的用量'});
  const job=async(argv,what)=>{const sent=await submit(ctx,member,name,argv);const ended=await waitJob(ctx,member,sent.id,terminalStates,{timeoutMs:300000});ctx.check(what,ended.state==='SUCCEEDED',ended);return ended;};
  let facts;
  await sections(ctx,[['数据盘开启项目配额',async()=>{
    facts=await inspect({});
    ctx.check('/data1 是开启 project,quota 的 ext4',facts.disks.join(' ').includes('/data1 ext4'),facts.disks);
    ctx.check('/data2 开启项目配额（XFS，内核不支持时为 ext4）',/\/data2 (xfs|ext4)/.test(facts.disks.join(' ')),facts.disks);
    if(!facts.disks.join(' ').includes('/data2 xfs'))ctx.note('宿主内核未提供 XFS，/data2 用 ext4');
  }],['运行时打标与容器型目录',async()=>{
    const project=`{workspacesRoot}/${owner}/${name}`;
    facts=await inspect({project,code:project+'/code',output:'{root}/outputs/'+item.jobId,engine:`{workspacesRoot}/.oci/${owner}`,
      workspaces:'{workspacesRoot}',owner:`{workspacesRoot}/${owner}`,oci:'{workspacesRoot}/.oci',outputs:'{root}/outputs',root:'{root}',datasets:'{datasetsRoot}'},{dev:project+'/oci.json'});
    const id=ids(facts),a=facts.attrs,layer=facts.oci.dev?.layer;
    ctx.check('项目目录打项目·文件号并继承',JSON.stringify(a.project)===JSON.stringify([id(`p:${owner}/${name}:files`),true]),a.project);
    ctx.check('项目代码目录同号',JSON.stringify(a.code)===JSON.stringify(a.project),a.code);
    ctx.check('任务输出打项目·输出号',JSON.stringify(a.output)===JSON.stringify([id(`p:${owner}/${name}:outputs`),true]),a.output);
    ctx.check('个人引擎目录打镜像号',JSON.stringify(a.engine)===JSON.stringify([id('i:'+owner),true]),a.engine);
    for(const key of ['workspaces','owner','oci','outputs','root','datasets'])ctx.check(key+' 是容器型目录、不继承',a[key]&&a[key][1]===false,a[key]);
    ctx.check('开发容器记录了层目录',typeof layer==='string'&&layer.includes('/graph/overlay/'),facts.oci.dev);
    const layers=await inspect({layer,diff:layer+'/diff',work:layer+'/work'});
    ctx.check('层目录本身保留镜像号且不继承',JSON.stringify(layers.attrs.layer)===JSON.stringify([id('i:'+owner),false]),layers.attrs.layer);
    for(const part of ['diff','work'])ctx.check(part+' 为项目·环境号并继承',JSON.stringify(layers.attrs[part])===JSON.stringify([id(`p:${owner}/${name}:env`),true]),layers.attrs[part]);
  }],['容器内修改镜像原有文件（copy-up）',async()=>{
    await job(['sh','-c','echo "# gray quota copy-up" >> /etc/profile && tail -n 1 /etc/profile | grep -q "gray quota copy-up"'],'改写镜像自带的 /etc/profile 成功');
  }],['root 采样与用量接口',async()=>{
    const result=await usage(v=>v.disks?.some(d=>d.accounting==='quota'&&d.items.some(i=>i.kind==='project'&&i.ownerId===owner&&i.project===name&&i.files>0&&i.outputs>0&&i.environment>0)));
    const disk=result.disks.find(d=>d.roles.includes('workspace')),row=result.projects.find(p=>p.project===name&&(p.ownerId||p.userId)===owner);
    ctx.check('用量接口带样本时间',typeof result.checkedAt==='string',result.checkedAt);
    const sum=disk.items.reduce((total,i)=>total+(i.bytes??0)+(i.files??0)+(i.outputs??0)+(i.environment??0),0);
    ctx.check('工作区盘各项相加等于已用',disk.accounting==='quota'&&sum===disk.usedBytes,{sum,used:disk.usedBytes});
    ctx.check('工作区盘列出本人镜像',disk.items.some(i=>i.kind==='images'&&i.ownerId===owner),disk.items);
    ctx.check('项目行三项都来自记账且已知',row&&row.size>0&&row.complete===true&&row.outputs.size>0&&row.environment.size>0,row);
  }],['打标后拉镜像、建容器、commit 与删除',async()=>{
    const created=await node(...asService,ENGINE,facts.release,'create');
    const probe=await inspect({layer:created.layer,diff:created.layer+'/diff'});
    ctx.check('新引擎的容器层同样打号',probe.attrs.layer?.[1]===false&&probe.attrs.diff?.[1]===true&&probe.attrs.diff[0]===probe.ids['p:gray-quota-probe/probe:env'],probe.attrs);
    const cleaned=await node(...asService,ENGINE,facts.release,'cleanup');
    ctx.check('commit、rmi 与 podman rm 均成功且容器已删除',!cleaned.containers.includes(created.container),cleaned);
  }],['管理员立即清空带容器的项目',async()=>{
    const doomed=ctx.name('purge'),base={machine:ctx.machine,project:doomed},key=ctx.key();
    await call(ctx,member,'projects.create',base);
    const sent=await submit(ctx,member,doomed,['true']);const ended=await waitJob(ctx,member,sent.id,terminalStates,{timeoutMs:300000});
    ctx.check('新项目容器已建好',ended.state==='SUCCEEDED',ended);
    const before=await inspect({},{dev:`{workspacesRoot}/${owner}/${doomed}/oci.json`});const layer=before.oci.dev?.layer;
    ctx.check('删除进入回收站',(await call(ctx,member,'projects.retire',{...base,key})).state==='TRASHED');
    const purged=await call(ctx,admin,'projects.retire.purge',{machine:ctx.machine,key});
    ctx.check('管理员立即清空成功',purged.state==='PURGED',purged);
    const after=await inspect({layer});
    ctx.check('podman rm 已删除该容器层',after.attrs.layer===null,{layer,attrs:after.attrs});
  }],['迁移工具 dry-run 与正式执行',async()=>{
    const source=await readFile(resolve(dirname(ctx.stack.file),'src/deploy/node/quota-migrate.py'),'utf8');
    const migrate=async(...args)=>(await stackExec(ctx.stack,'gray-node-1','python3','-I','-B','-c',source,'--config','/etc/gpuq-console/node-install.json',...args)).stdout;
    const plan=await migrate('--dry-run');ctx.note(plan.split('\n').slice(0,40).join('\n'));
    ctx.check('dry-run 打印计划且未改动',plan.includes('仅打印计划')&&plan.includes('4 项目文件'),plan.slice(0,2000));
    const done=await migrate();ctx.note(done.split('\n').slice(-40).join('\n'));
    const line=done.split('\n').find(l=>l.startsWith('完成后 /data1：'));const match=line?.match(/已用 ([\d,]+) 字节，未登记（编号 0）([\d,]+) 字节/);
    const [used,untracked]=match?match.slice(1).map(v=>Number(v.replaceAll(',',''))):[0,Infinity];
    ctx.check('迁移后 /data1 未登记接近 0',untracked<=Math.max(64*1024**2,used*0.02),{line,used,untracked});
    const after=await usage(v=>v.disks?.some(d=>d.roles.includes('workspace')&&d.items.some(i=>i.kind==='platform')));
    ctx.check('迁移后工作区盘列出平台运行数据',after.disks.find(d=>d.roles.includes('workspace')).items.some(i=>i.kind==='platform'));
    await job(['sh','-c','echo "# after migration" >> /etc/profile'],'迁移后任务照常运行并能改写镜像文件');
  }]]);
}};
