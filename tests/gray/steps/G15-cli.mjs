import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname,resolve} from 'node:path';
import {project,call,waitJob,terminalStates,upload} from '../lib/exec.mjs';
import {adminSession} from '../lib/accounts.mjs';
import {command} from '../lib/cli.mjs';
import {sections} from '../lib/sections.mjs';
export default {features:["网页和 CLI 打开项目终端，断开重连、接管", "公告：定向发送、弹窗、外观、CLI 未读提醒和已读确认", "使用指南、帮助、CLI 安装（Linux/Windows/macOS）与更新"],id:'G15',title:'候选 CLI 登录、任务、终端及帮助（FEATURES 四、十）',level:'full',async run(ctx){
  const {name,member}=await project(ctx),src=join(dirname(ctx.stack.file),'src'),folder=resolve(ctx.artifacts,'cli');await mkdir(folder,{recursive:true});
  const executable=join(src,'build/gpuctl.mjs');
  let sequence=0,lastCLI;
  const cli=async(args,input='',json=true)=>{
    const result=await command(process.execPath,[executable,'--url',ctx.stack.origin,'--session-file',join(folder,'session.json'),...(json?['--json']:[]),...args],{cwd:src,input});
    await writeFile(join(folder,String(++sequence)+'.json'),JSON.stringify({args,code:result.code,signal:result.signal,stdout:result.stdout,stderr:result.stderr},null,2)+'\n');
    lastCLI=result;ctx.check('CLI '+args[0]+' 成功',result.code===0,result.stderr||result.stdout);
    return json?JSON.parse(result.stdout).data:result;
  };
  const logged=await cli(['login',member.username,'--password-stdin'],member.password+'\n');ctx.check('CLI登录成功',logged.loggedIn===true);
  await sections(ctx,[['状态与项目',async()=>{
    const state=await cli(['state']);ctx.check('CLI状态包含灰度节点',state.machines.some(m=>m.id===ctx.machine));
    const projects=await cli(['project','list','--machine',ctx.machine]);ctx.check('CLI项目列表包含项目',projects.projects.some(p=>p.project===name));
  }],['提交与日志',async()=>{
    const job=await cli(['run','--machine',ctx.machine,'--project',name,'--cards','1','--key',ctx.key(),'--','python','-u','-c',"print('GRAY_CLI')"]);
    ctx.check('CLI提交得到编号',!!job.id);
    const ended=await waitJob(ctx,member,job.id,terminalStates);const logs=await cli(['logs',job.id]);
    ctx.check('CLI能取得非空日志',typeof logs.text==='string'&&logs.text.length>0);
    ctx.check('CLI训练执行成功',ended.state==='SUCCEEDED'&&logs.text.includes('GRAY_CLI'),ended);
  }],['同步跳过已迁到数据集的目录',async()=>{
    const projectName=ctx.name('sync-links'),dataset=ctx.name('sync-data'),local=join(folder,'sync-source');
    await call(ctx,member,'projects.create',{machine:ctx.machine,project:projectName});
    await upload(ctx,member,{area:'dataset',dataset,path:'train/sentinel.txt',content:Buffer.from('dataset-original')});
    const setup=await call(ctx,member,'jobs.submit',{machine:ctx.machine,project:projectName,cards:1,key:ctx.key(),argv:['python','-c',`from pathlib import Path; import os; Path('/workspace/data').mkdir(); os.symlink('/datasets/${dataset}/train','/workspace/data/images')`]});
    ctx.check('数据集链接准备成功',(await waitJob(ctx,member,setup.id,terminalStates)).state==='SUCCEEDED');
    await mkdir(join(local,'data/images/deep'),{recursive:true});await writeFile(join(local,'data/images/sentinel.txt'),'local must not overwrite');await writeFile(join(local,'data/images/deep/new.txt'),'must not appear');await writeFile(join(local,'sync-code.txt'),'code-uploaded');
    const notice=`已跳过 data/images：服务器上已改为数据集 /datasets/${dataset}/train，本机这份可以删除`;
    const pushed=await cli(['push',local,'--machine',ctx.machine,'--project',projectName,'--via','relay']);
    ctx.check('push 完成并只上传代码',pushed.state==='COMPLETE'&&pushed.uploaded===1,pushed);
    ctx.check('push 每个跳过目录提示一次',lastCLI.stderr.split(notice).length===2,lastCLI.stderr);
    const sent=await cli(['run','--sync','--sync-dir',local,'--machine',ctx.machine,'--project',projectName,'--via','relay','--cards','1','--key',ctx.key(),'--','python','-c',`from pathlib import Path; import os; assert os.readlink('/workspace/data/images')=='/datasets/${dataset}/train'; assert Path('/workspace/sync-code.txt').read_text()=='code-uploaded'; assert Path('/datasets/${dataset}/train/sentinel.txt').read_text()=='dataset-original'; assert not Path('/datasets/${dataset}/train/deep/new.txt').exists(); print('GRAY_SYNC_DATASET_SKIPPED')`]);
    ctx.check('run --sync 每个跳过目录提示一次',lastCLI.stderr.split(notice).length===2,lastCLI.stderr);
    const ended=await waitJob(ctx,member,sent.id,terminalStates),logs=await cli(['logs',sent.id]);
    ctx.check('跳过数据后任务成功且数据集未被写入',ended.state==='SUCCEEDED'&&logs.text.includes('GRAY_SYNC_DATASET_SKIPPED'),{ended,logs});
  }],['CLI终端',async()=>{
    const terminal=await command('python3',[fileURLToPath(new URL('../../../scripts/gray-local/pty-cli.py',import.meta.url)),process.execPath,executable,'--url',ctx.stack.origin,'--session-file',join(folder,'session.json'),'ssh','--machine',ctx.machine,'--project',name],{cwd:src,input:"printf 'GRAY_%s\\n' CLI_TERMINAL; exit\n",timeoutMs:65000});
    await writeFile(join(folder,'terminal.log'),terminal.stdout+terminal.stderr);
    ctx.check('CLI项目终端执行成功',terminal.code===0&&terminal.stdout.includes('GRAY_CLI_TERMINAL'),{code:terminal.code,stderr:terminal.stderr});
  }],['公告提醒和确认',async()=>{
    const admin=await adminSession(ctx),announcement=(await call(ctx,admin,'community.posts.create',{key:ctx.key(),kind:'announcement',title:'CLI灰度未读公告',body:'CLI提醒测试',popup:true,audience:{type:'users',userIds:[member.userId]}})).post;
    const state=await command(process.execPath,[executable,'--url',ctx.stack.origin,'--session-file',join(folder,'session.json'),'state'],{cwd:src});
    await writeFile(join(folder,'announcement.log'),state.stdout+state.stderr);ctx.check('CLI提示未读公告',state.code===0&&(state.stdout+state.stderr).includes('CLI灰度未读公告'));
    await cli(['community','ack',announcement.id,'--revision',String(announcement.revision)]);
    ctx.check('CLI已读确认生效',!(await call(ctx,member,'community.announcements.pending')).posts.some(p=>p.id===announcement.id));
  }],['帮助、指南和安装入口',async()=>{
    const help=await cli(['help'], '',false);ctx.check('CLI帮助可读',help.stdout.includes('STARGATE')&&help.stdout.includes('project'));
    for(const path of ['/guide','/install.sh','/install.ps1']){const response=await ctx.client.raw(path,{method:'GET'});ctx.check('可读取 '+path,response.status===200&&response.text.length>200);}
    ctx.todo('https-installer','安装与覆盖更新脚本要求HTTPS，本任务门户仅为127.0.0.1 HTTP；未执行宿主安装');
    ctx.todo('other-os-install','Windows/macOS 真机安装和更新未测');ctx.todo('real-gpu','真GPU/CUDA/NCCL未测');
  }]]);
}};
