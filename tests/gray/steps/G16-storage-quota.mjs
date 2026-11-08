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
  const job=async(argv,what,where=name)=>{const sent=await submit(ctx,member,where,argv);const ended=await waitJob(ctx,member,sent.id,terminalStates,{timeoutMs:300000});ctx.check(what,ended.state==='SUCCEEDED',ended);return ended;};
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
    ctx.check('迁移前文件已知、输出与环境保持未知',row&&row.size>0&&row.complete===true&&row.outputs.size===null&&row.environment.size===null,row);
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
    // 专用项目保留旧特殊 inode；首轮验证共享项目的活层跳过，再停止 podman 完成实际迁移。
    const legacy=ctx.name('legacy');
    await call(ctx,member,'projects.create',{machine:ctx.machine,project:legacy});
    await job(['true'],'专用项目容器已建好',legacy);
    // 模拟启用 quota 前已有的层：旧特殊 inode 无法用 FSSETXATTR 改号。
    await stackExec(ctx.stack,'gray-node-1','python3','-I','-B','-c',`import importlib.util,json,sys
from pathlib import Path
cfg=json.load(open('/etc/gpuq-console/node-install.json'));p=cfg['profiles']['7IM']
head=json.load(open(Path(p['workspacesRoot'])/sys.argv[1]/sys.argv[2]/'oci.json'))
s=importlib.util.spec_from_file_location('quota','/usr/local/libexec/stargate/quota-ids.py');q=importlib.util.module_from_spec(s);s.loader.exec_module(q)
q.tag_tree(head['layer'],0,inherit=False)`,owner,legacy);
    await job(['sh','-c','test -d /usr/share/doc && rm -rf /usr/share/doc && ln -s /etc/profile /tmp/gray-quota-legacy-link && mkfifo /tmp/gray-quota-legacy-fifo'],'迁移前删除镜像目录并创建旧符号链接和 FIFO',legacy);
    const source=await readFile(resolve(dirname(ctx.stack.file),'src/deploy/node/quota-migrate.py'),'utf8');
    const migrate=async(...args)=>(await stackExec(ctx.stack,'gray-node-1','python3','-I','-B','-c',source,'--config','/etc/gpuq-console/node-install.json',...args)).stdout;
    const plan=await migrate('--dry-run');ctx.note(plan.split('\n').slice(0,40).join('\n'));
    ctx.check('dry-run 打印计划且未改动',plan.includes('仅打印计划')&&plan.includes('4 项目文件'),plan.slice(0,2000));
    const legacyHead=await inspect({},{dev:`{workspacesRoot}/${owner}/${legacy}/oci.json`}),legacyLayer=legacyHead.oci.dev.layer;
    const first=await migrate('--only','platform');ctx.note(first.split('\n').slice(-40).join('\n'));
    const mounted=text=>[...text.matchAll(/活 overlay 层跳过 (\d+)/g)].reduce((sum,match)=>sum+Number(match[1]),0);
    const skipped=first.split('\n').filter(line=>line.includes('注意：容器层仍有活 overlay'));
    ctx.check('首轮 platform 仅跳过共享项目仍挂载的层',mounted(first)===1&&skipped.length===1&&skipped[0].endsWith(facts.oci.dev.layer),{skipped,mounted:mounted(first)});
    const unknown=await usage(v=>{const p=v.projects.find(p=>p.project===name&&(p.ownerId||p.userId)===owner);return p?.outputs?.size===null&&p?.environment?.size===null;});
    ctx.check('跳过活层时输出与环境仍未知',unknown.projects.some(p=>p.project===name&&p.outputs.size===null&&p.environment.size===null));
    // 隔离灰度节点：直接结束服务账户的 pause；已有容器可能带着故障步骤留下的失效 conmon 状态。
    await stackExec(ctx.stack,'gray-node-1',...asService,`import contextlib,os,signal,time
from pathlib import Path
pidfile=Path(os.environ['XDG_RUNTIME_DIR'])/'libpod/tmp/pause.pid';pid=int(pidfile.read_text())
with contextlib.suppress(ProcessLookupError):os.kill(pid,signal.SIGKILL)
pidfile.unlink(missing_ok=True);deadline=time.monotonic()+15
while (Path('/proc')/str(pid)/'ns/mnt').exists():
    if time.monotonic()>deadline:raise TimeoutError('rootless pause did not exit')
    time.sleep(.05)`);
    const done=await migrate('--only','platform');ctx.note(done.split('\n').slice(-40).join('\n'));
    ctx.check('停止 podman 后 platform 不再跳过活层',mounted(done)===0,done.slice(-5000));
    const completed=await node('python3','-I','-B','-c',`import json,os,sys;print(json.dumps(os.path.isfile(sys.argv[1]+'/quota/migrated.json')))`,facts.config.root);
    ctx.check('platform 成功写出 migrated.json',completed);
    const actual=await inspect({diff:legacyLayer+'/diff',work:legacyLayer+'/work'}),env=actual.ids[`p:${owner}/${legacy}:env`];
    for(const part of ['diff','work'])ctx.check('旧层 '+part+' 实际迁移到环境号并继承',typeof env==='number'&&JSON.stringify(actual.attrs[part])===JSON.stringify([env,true]),actual.attrs);
    const known=await usage(v=>{const p=v.projects.find(p=>p.project===name&&(p.ownerId||p.userId)===owner);return p?.outputs?.complete&&p?.environment?.complete;});
    ctx.check('平台迁移标记写入后输出与环境 complete',known.projects.some(p=>p.project===name&&p.outputs.complete&&p.environment.complete));
    const line=done.split('\n').find(l=>l.startsWith('完成后 /data1：'));const match=line?.match(/已用 ([\d,]+) 字节，未登记（编号 0）([\d,]+) 字节/);
    const [used,untracked]=match?match.slice(1).map(v=>Number(v.replaceAll(',',''))):[0,Infinity];
    ctx.check('迁移后 /data1 未登记接近 0',untracked<=Math.max(64*1024**2,used*0.02),{line,used,untracked});
    const after=await usage(v=>v.disks?.some(d=>d.roles.includes('workspace')&&d.items.some(i=>i.kind==='platform')));
    ctx.check('迁移后工作区盘列出平台运行数据',after.disks.find(d=>d.roles.includes('workspace')).items.some(i=>i.kind==='platform'));
    await job(['sh','-c','mkdir /usr/share/doc && echo restored > /usr/share/doc/gray-quota && echo "# after migration" >> /etc/profile'],'迁移后可在镜像 whiteout 原路径 mkdir 并写文件',legacy);
    await job(['python3','-c',"import os,stat; os.rename('/tmp/gray-quota-legacy-link','/tmp/gray-quota-link-moved'); assert os.readlink('/tmp/gray-quota-link-moved')=='/etc/profile'; assert stat.S_ISFIFO(os.stat('/tmp/gray-quota-legacy-fifo').st_mode)"],'迁移前的符号链接迁移后可在同目录 rename，FIFO 保留',legacy);
    // 灰度节点本来没有外部目录：建一个平台外的旧目录，验收整棵树只打编号、不设继承。
    const outside='/data2/gray-quota-external';
    await stackExec(ctx.stack,'gray-node-1','sh','-c',`mkdir -p ${outside}/sub && echo legacy > ${outside}/sub/file && ln -sfn sub ${outside}/link && chown -R gpuops:gpuops ${outside}`);
    // 在真实 quota 盘上暂停 train/ 的处理，val/ 的旧上传仍应能提交。
    const online=ctx.name('online'),base=facts.config.datasetsRoot+'/'+online,barrier='/run/gray-quota-online-'+ctx.key(),key=ctx.key(),bytes=Buffer.from('online upload');
    await stackExec(ctx.stack,'gray-node-1','python3','-I','-B','-c',`import os,sys
from pathlib import Path
root=Path(sys.argv[1]);outside=Path(sys.argv[2])
for path in (root,root/'train',root/'val'):path.mkdir(mode=0o700);os.chown(path,1001,1001)
for path in (root/'train/hold',root/'val/shared'):path.write_bytes(b'legacy');os.chown(path,1001,1001)
os.link(root/'val/shared',outside/'shared')`,base,outside);
    const upload={machine:ctx.machine,area:'dataset',dataset:online,path:'val/upload.txt',key,totalSize:bytes.length};
    await call(ctx,member,'data.upload.begin',upload);
    await call(ctx,member,'data.upload.chunk',{machine:ctx.machine,key,offset:0,data:bytes.toString('base64')});
    const externalFirst=await migrate('--only','external');ctx.check('external 可先运行',externalFirst.includes('[external]'));
    const claimed=await inspect({shared:outside+'/shared'});ctx.check('external 先运行时共享硬链接计入外部编号',typeof claimed.ids['x:'+outside]==='number'&&claimed.attrs.shared?.[0]===claimed.ids['x:'+outside],claimed.attrs);
    const script=`import json,os,signal,time
from pathlib import Path
ns={'__name__':'online_migrate','__file__':'quota-migrate.py'};exec(${JSON.stringify(source)},ns)
for signum in (signal.SIGTERM,signal.SIGHUP):signal.signal(signum,ns['terminate'])
config=json.load(open('/etc/gpuq-console/node-install.json'));tool=ns['Migration'](config,'/usr/local/libexec/stargate',only='datasets')
ready=Path(${JSON.stringify(barrier+'.ready')});resume=Path(${JSON.stringify(barrier+'.resume')});hold=Path(${JSON.stringify(base+'/train/hold')});inode=hold.stat().st_ino
original=tool.q.setx;paused=False
def setx(fd,value,inherit=None):
    global paused
    if not paused and os.fstat(fd).st_ino==inode:
        paused=True;ready.touch();deadline=time.monotonic()+60
        while not resume.exists():
            if time.monotonic()>deadline:raise TimeoutError('online upload did not release the walker')
            time.sleep(.02)
    return original(fd,value,inherit)
tool.q.setx=setx
tool.run(False)`;
    const running=stackExec(ctx.stack,'gray-node-1','python3','-I','-B','-c',script).then(value=>({value}),error=>({error}));
    let failure;
    try{
      await waitFor(()=>node('python3','-I','-B','-c',`import json,os;print(json.dumps(os.path.exists(${JSON.stringify(barrier+'.ready')})))`),Boolean,{timeoutMs:30000,intervalMs:200,what:'datasets walker 到达 train/'});
      const finished=await call(ctx,member,'data.upload.finish',{machine:ctx.machine,key});
      ctx.check('在线打标 train/ 时 val/ 的既有上传可原子提交',finished.state==='COMPLETE'&&finished.offset===bytes.length,finished);
    }catch(error){failure=error;}
    finally{await stackExec(ctx.stack,'gray-node-1','touch',barrier+'.resume');}
    const migrated=await running;
    await stackExec(ctx.stack,'gray-node-1','rm','-f','--',barrier+'.ready',barrier+'.resume');
    if(failure)throw failure;if(migrated.error)throw migrated.error;
    ctx.check('datasets 分组迁移成功',migrated.value.stdout.includes('[datasets]'));
    const onlineAttrs=await inspect({val:base+'/val',uploaded:base+'/val/upload.txt',shared:outside+'/shared'}),datasetId=onlineAttrs.ids['d:'+online];
    ctx.check('在线上传与硬链接最终归数据集编号',typeof datasetId==='number'&&onlineAttrs.attrs.val?.[0]===datasetId&&onlineAttrs.attrs.uploaded?.[0]===datasetId&&onlineAttrs.attrs.shared?.[0]===datasetId,onlineAttrs.attrs);
    const externalAfter=await migrate('--only','external');ctx.check('external 可在 datasets 后重跑',externalAfter.includes('[external]'));
    const tagged=await inspect({outside,sub:outside+'/sub',file:outside+'/sub/file'});const external=tagged.ids['x:'+outside];
    for(const key of ['outside','sub','file'])ctx.check('外部目录 '+key+' 只打编号、不设继承',typeof external==='number'&&external>0&&JSON.stringify(tagged.attrs[key])===JSON.stringify([external,false]),{external,attrs:tagged.attrs[key]});
  }]]);
}};
