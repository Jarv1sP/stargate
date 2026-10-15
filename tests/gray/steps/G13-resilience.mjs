import {project,call,submit,waitJob,terminalStates} from '../lib/exec.mjs';
import {memberState} from '../lib/accounts.mjs';
import {compose,stackExec} from '../lib/stack.mjs';
import {waitFor} from '../lib/context.mjs';
import {sections} from '../lib/sections.mjs';
const serviceArgs=['runuser','-u','gpuops','--','env','XDG_RUNTIME_DIR=/run/user/1001','DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus','systemctl','--user'];
function unresolved(job){return job.state==='UNKNOWN'||(job.state==='SUBMITTING'&&job.submissionState==='CHECKING'&&job.canRetryDispatch===false&&/确认|重查|核对/.test(job.error||''));}
async function healthy(ctx){return waitFor(async()=>{try{return (await ctx.client.raw('/healthz',{method:'GET'})).status===200;}catch{return false;}},Boolean,{what:'门户恢复'});}
export default {features:[],id:'G13',title:'门户、桥与调度器故障恢复（可靠性）',level:'full',async run(ctx){
  const {name,member}=await project(ctx);let running;
  await sections(ctx,[['训练正在执行',async()=>{
    running=await submit(ctx,member,name,['python','-u','-c',"import time;print('GRAY_ALIVE',flush=True);time.sleep(90)"]);
    // 提交到第一次 attempt 建立之间，日志接口明确返回尚无日志；只轮询读取，不重发任务。
    const observed=await waitFor(async()=>{
      const watch=await call(ctx,member,'jobs.watch',{jobId:running.id});
      let log={text:''};
      try{log=await call(ctx,member,'jobs.logs',{jobId:running.id});}
      catch(error){if(error.status!==400||!error.message.includes('job has no attempt log yet'))throw error;}
      return {watch,log};
    },v=>v.log.text.includes('GRAY_ALIVE')||terminalStates.includes(v.watch.state),{what:'真实训练开始'});
    ctx.check('重启前训练命令实际运行',observed.watch.state==='RUNNING'&&observed.log.text.includes('GRAY_ALIVE'),observed);
  }],['门户重启保留原任务',async()=>{
    await compose(ctx.stack,'restart','gray-portal');await healthy(ctx);
    ctx.check('门户重启原编号未丢',(await memberState(ctx,member)).jobs.filter(j=>j.id===running.id).length===1);
    const watch=await call(ctx,member,'jobs.watch',{jobId:running.id});ctx.note('重启后原任务 '+JSON.stringify(watch));
    ctx.check('重启后任务仍运行或成功',['RUNNING','SUCCEEDED'].includes(watch.state),watch);
  }],['桥重启恢复读取',async()=>{
    await compose(ctx.stack,'restart','gray-bridge');await compose(ctx.stack,'restart','gray-collector');
    const list=await waitFor(async()=>{try{return await call(ctx,member,'projects.list',{machine:ctx.machine});}catch{return null;}},v=>Array.isArray(v?.projects),{what:'桥只读恢复'});
    ctx.check('桥恢复后项目存在',list.projects.some(p=>p.project===name));
  }],['调度器离线提交与原编号恢复',async()=>{
    let job,offlineError,lastOffline;await stackExec(ctx.stack,'gray-node-1',...serviceArgs,'stop','gpuq.service');
    try{
      job=await submit(ctx,member,name,['python','-u','-c',"print('GRAY_RECOVERED')"]);
      const unknown=await waitFor(async()=>lastOffline=await call(ctx,member,'jobs.watch',{jobId:job.id}),v=>unresolved(v)||terminalStates.includes(v.state),{what:'调度器离线显示未知'});
      ctx.check('离线提交如实显示未知',unresolved(unknown),unknown);
    }catch(error){offlineError=error;ctx.note('离线状态检查失败：'+error.message+'；最后观察 '+JSON.stringify(lastOffline));}
    finally{await stackExec(ctx.stack,'gray-node-1',...serviceArgs,'start','gpuq.service');}
    if(job){
      const result=await waitJob(ctx,member,job.id,['RUNNING',...terminalStates]);
      ctx.check('恢复可查询原编号',result.id===job.id&&!!result.nodeJobId,result);
      const count=await stackExec(ctx.stack,'gray-node-1','python3','-c','import sqlite3,sys; db=sqlite3.connect("file:/srv/gpuq/state/gpuq.db?mode=ro",uri=True);print(db.execute("SELECT count(*) FROM jobs WHERE submit_key=?",(sys.argv[1],)).fetchone()[0])',job.id);
      ctx.check('节点原提交只创建一次',count.stdout.trim()==='1');
      await call(ctx,member,'jobs.cancel',{jobId:job.id});await waitJob(ctx,member,job.id,terminalStates);
    }
    if(offlineError)throw offlineError;
  }],['清理本步任务',async()=>{if(running){await call(ctx,member,'jobs.cancel',{jobId:running.id});await waitJob(ctx,member,running.id,terminalStates);}}]]);
}};
