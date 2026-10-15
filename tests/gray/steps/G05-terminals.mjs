import {stripVTControlCharacters} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {closeObserved} from '../lib/terminal-observation.mjs';
import {approvedMember} from '../lib/accounts.mjs';
import {project,call,openTerminal,terminalCommand,submit,waitJob,terminalStates} from '../lib/exec.mjs';
export default {features:["容器里自带 git，代码用 git 管理（pull/commit/push 用自己的 GitHub 凭据）", "网页和 CLI 打开项目终端，断开重连、接管", "带 GPU 的交互终端", "容器网络诊断"],id:'G05',title:'Git 终端、重连、接管与 GPU 终端（FEATURES 四）',level:'fast',async run(ctx){
  const {name,member}=await project(ctx),b=await approvedMember(ctx,'b');
  const terminal=await openTerminal(ctx,member,name);
  let closeError;
  try{
    const output=await terminalCommand(ctx,member,terminal,"git status; git -c user.name=g -c user.email=g@example.invalid commit --allow-empty -m gray; GIT_PAGER=cat git log -1; printf 'GRAY_%s\\n' GIT_DONE\n",'GRAY_GIT_DONE');
    ctx.check('git status/commit/log 有实际输出',/On branch/.test(output)&&/commit [a-f0-9]{20,}/.test(output)&&/gray/.test(output));
    await call(ctx,member,'terminal.detach',terminal);
    const reconnected=await openTerminal(ctx,member,name,{mode:'reconnect',id:terminal.id});
    const history=await call(ctx,member,'terminal.exchange',{...reconnected,offset:0});
    ctx.check('重连可读之前输出',Buffer.from(history.data,'base64').toString().includes('GRAY_GIT_DONE'));
    const taken=await openTerminal(ctx,b,name,{mode:'reconnect',id:terminal.id,takeover:true});
    const text=await terminalCommand(ctx,b,taken,"printf 'GRAY_%s\\n' B_TAKEOVER\n",'GRAY_B_TAKEOVER');
    ctx.check('B 接管 A 的终端成功',text.includes('GRAY_B_TAKEOVER'));
  }finally{try{await closeObserved(ctx,member,terminal);}catch(error){closeError=error;ctx.note('关闭失败保留，继续网络/GPU子检查：'+error.message);}}
  try{
  const network=await call(ctx,member,'projects.status',{machine:ctx.machine,project:name,diagnoseNetwork:true});
  ctx.check('容器网络诊断返回结果',network.network&&network.network.state!=='UNKNOWN',network.network);
  const gpu=await submit(ctx,member,name,['/bin/bash','--noprofile','--norc','-i'],{interactive:true,placement:{gpuIndices:[0],shared:false}});
  try{
    const running=await waitJob(ctx,member,gpu.id,['RUNNING',...terminalStates]);ctx.check('GPU 交互任务运行',running.state==='RUNNING',running.error);
    const session=await openTerminal(ctx,member,name,{mode:'reconnect',id:gpu.id});
    const text=await terminalCommand(ctx,member,session,"nvidia-smi --query-gpu=uuid --format=csv,noheader; printf 'GRAY_%s\\n' GPU_DONE\n",'GRAY_GPU_DONE');
    await mkdir(ctx.artifacts,{recursive:true});
    await writeFile(join(ctx.artifacts,'g05-gpu-terminal.txt'),text);
    // PTY 在首行 UUID 前输出 bracketed-paste 控制序列；只去显示控制码，仍严格核对唯一 UUID。
    const ids=stripVTControlCharacters(text).split(/\r?\n/).map(s=>s.trim()).filter(s=>/^GPU-[\da-f-]+$/.test(s));
    ctx.check('仅看到分配的第 0 张模拟卡',ids.length===1&&ids[0]==='GPU-00000000-0000-0000-0000-000000000001',ids);
  }finally{
    await call(ctx,member,'jobs.cancel',{jobId:gpu.id});await waitJob(ctx,member,gpu.id,terminalStates);
  }
  }catch(error){if(closeError)ctx.note('后续子检查另有失败：'+error.message);else throw error;}
  if(closeError)throw closeError;
}};
