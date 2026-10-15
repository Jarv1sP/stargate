import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname,resolve} from 'node:path';
import {project,call,waitJob,terminalStates} from '../lib/exec.mjs';
import {adminSession} from '../lib/accounts.mjs';
import {command} from '../lib/cli.mjs';
import {sections} from '../lib/sections.mjs';
export default {id:'G15',title:'候选 CLI 登录、任务、终端及帮助（FEATURES 四、十）',level:'full',async run(ctx){
  const {name,member}=await project(ctx),src=join(dirname(ctx.stack.file),'src'),folder=resolve(ctx.artifacts,'cli');await mkdir(folder,{recursive:true});
  const build=await command(process.execPath,['scripts/build-client.mjs'],{cwd:src,timeoutMs:120000});ctx.check('候选 build:client 成功',build.code===0,build.stderr);
  let sequence=0;
  const cli=async(args,input='',json=true)=>{
    const result=await command(process.execPath,[join(src,'cli.mjs'),'--url',ctx.stack.origin,'--session-file',join(folder,'session.json'),...(json?['--json']:[]),...args],{cwd:src,input});
    await writeFile(join(folder,String(++sequence)+'.json'),JSON.stringify({args,code:result.code,signal:result.signal,stdout:result.stdout,stderr:result.stderr},null,2)+'\n');
    ctx.check('CLI '+args[0]+' 成功',result.code===0,result.stderr||result.stdout);
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
  }],['CLI终端',async()=>{
    const terminal=await command('python3',[fileURLToPath(new URL('../../../scripts/gray-local/pty-cli.py',import.meta.url)),process.execPath,join(src,'cli.mjs'),'--url',ctx.stack.origin,'--session-file',join(folder,'session.json'),'ssh','--machine',ctx.machine,'--project',name],{cwd:src,input:"printf 'GRAY_%s\\n' CLI_TERMINAL; exit\n",timeoutMs:65000});
    await writeFile(join(folder,'terminal.log'),terminal.stdout+terminal.stderr);
    ctx.check('CLI项目终端执行成功',terminal.code===0&&terminal.stdout.includes('GRAY_CLI_TERMINAL'),{code:terminal.code,stderr:terminal.stderr});
  }],['公告提醒和确认',async()=>{
    const admin=await adminSession(ctx),announcement=(await call(ctx,admin,'community.posts.create',{key:ctx.key(),kind:'announcement',title:'CLI灰度未读公告',body:'CLI提醒测试',popup:true,audience:{type:'users',userIds:[member.userId]}})).post;
    const state=await command(process.execPath,[join(src,'cli.mjs'),'--url',ctx.stack.origin,'--session-file',join(folder,'session.json'),'state'],{cwd:src});
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
