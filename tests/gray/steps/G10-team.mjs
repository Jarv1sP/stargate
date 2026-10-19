import {waitFor} from '../lib/context.mjs';
import {approvedMember,memberState} from '../lib/accounts.mjs';
import {project,call,upload,download,trashRestore,openTerminal,terminalCommand,submit,waitJob,terminalStates} from '../lib/exec.mjs';
import {closeObserved} from '../lib/terminal-observation.mjs';
import {trained} from './G08-outputs.mjs';
import {sections} from '../lib/sections.mjs';
export default {features:["新建项目（可填一个 Git 仓库地址，创建时自动克隆进 /workspace）、列出、切换、删除（进 7 天回收站，可恢复）", "训练输出：浏览、下载、删除（进回收站，可恢复）", "列出数据集（名字、大小、上传人、修改时间）、浏览文件", "删除（进 7 天回收站，可恢复）"],id:'G10',title:'登录墙、管理权限与团队共用（FEATURES 两道墙）',level:'full',async run(ctx){
  const {name,member:a}=await project(ctx),b=await approvedMember(ctx,'b'),base={machine:ctx.machine,project:name,ownerId:a.userId};
  await sections(ctx,[
    ['登录和管理权限',async()=>{
      for(const op of ['state','projects.list','datasets.list','files.list','jobs.watch','terminal.status'])ctx.check('未登录 '+op,(await ctx.client.refused(null,op,base)).status===401);
      for(const [op,args] of [['users.create',{username:ctx.name('denied'),password:ctx.password()}],['maintenance.set',{scope:'all',enabled:true,reason:'禁止成员操作'}],['invites.rotate',{role:'member'}]])ctx.check('成员不能管理 '+op,(await ctx.client.refused(b.token,op,args)).status===403);
    }],
    ['团队项目和终端',async()=>{
      ctx.check('B 可见 A 项目',(await call(ctx,b,'projects.list',{machine:ctx.machine})).projects.some(p=>p.project===name));
      const bytes=Buffer.from('team B writes A project\n');await upload(ctx,b,{...base,area:'code',path:'team.txt',content:bytes});
      ctx.check('A可读B写入',(await download(ctx,a,{...base,area:'code',path:'team.txt'})).equals(bytes));
      const terminal=await openTerminal(ctx,b,name);
      try{await terminalCommand(ctx,b,terminal,"printf 'GRAY_%s\\n' TEAM; exit\n",'GRAY_TEAM');}
      finally{await closeObserved(ctx,b,terminal);}
    }],
    ['团队项目删除和恢复',async()=>{
      const bytes=Buffer.from('team B writes A project\n');
      await trashRestore(ctx,b,{key:ctx.key(),remove:'projects.retire',args:base,kind:'project'});
      ctx.check('B恢复A项目后字节保留',(await download(ctx,b,{...base,area:'code',path:'team.txt'})).equals(bytes));
    }],
    ['团队数据集',async()=>{
      const dataset=ctx.shared.dataset?.name||ctx.name('team-data'),bytes=Buffer.from('shared dataset\n');
      if(!ctx.shared.dataset)await upload(ctx,a,{dataset,area:'dataset',path:'team.txt',content:bytes});
      ctx.check('B 可见 A 数据集',(await call(ctx,b,'datasets.list',{machine:ctx.machine})).datasets.some(d=>d.name===dataset));
      await upload(ctx,b,{dataset,area:'dataset',path:'team.txt',content:bytes});
      ctx.check('B下载团队数据集',(await download(ctx,b,{dataset,area:'dataset',path:'team.txt'})).equals(bytes));
      await trashRestore(ctx,b,{key:ctx.key(),remove:'datasets.delete',args:{machine:ctx.machine,dataset},kind:'dataset'});
    }],
    ['团队任务',async()=>{
      const job=await submit(ctx,a,name,['python','-u','sleeper.py']);
      try{
        ctx.check('B能看到A任务',(await memberState(ctx,b)).jobs.some(j=>j.id===job.id));
        // 第一次 attempt 建立前没有日志；在原有 120 秒界限内只读等待真实执行输出。
        const observed=await waitFor(async()=>{
          const watch=await call(ctx,b,'jobs.watch',{jobId:job.id});let log={text:''};
          try{log=await call(ctx,b,'jobs.logs',{jobId:job.id});}
          catch(error){if(error.status!==400||!error.message.includes('job has no attempt log yet'))throw error;}
          return {watch,log};
        },v=>v.log.text.includes('GRAY-SLEEPER')||terminalStates.includes(v.watch.state),{what:'B读取A任务真实日志'});
        ctx.check('B可读取A任务执行日志',observed.log.text.includes('GRAY-SLEEPER'),observed);
      }finally{await call(ctx,a,'jobs.cancel',{jobId:job.id});await waitJob(ctx,b,job.id,terminalStates);}
    }],
    ['团队训练输出',async()=>{
      ctx.check('G07训练输出可用',!!ctx.shared.trained?.length,'前置训练失败或未运行，不能证明输出协作');
      const item=await trained(ctx),args={area:'output',runId:item.jobId,path:'result.json'};
      ctx.check('B下载A训练输出',(await download(ctx,b,args)).equals(Buffer.from(item.bytes,'base64')));
      await trashRestore(ctx,b,{key:ctx.key(),remove:'outputs.delete',args:{jobId:item.jobId,path:'result.json'},kind:'output'});
    }],
  ]);
}};
