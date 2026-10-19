import {approvedMember,memberState,adminSession} from '../lib/accounts.mjs';
import {project,call,submit,waitJob,terminalStates} from '../lib/exec.mjs';
export default {features:["取消、优先级、完成情况、资源收尾；取消、调整优先级、GPU 交互任务的输入和关闭只限提交者本人或管理员，只读查询仍团队共享"],id:'G09',title:'取消、排队优先级与资源收尾（FEATURES 五）',level:'fast',async run(ctx){
  const {name,member}=await project(ctx),b=await approvedMember(ctx,'b'),admin=await adminSession(ctx),ids=[];
  try{
    const sleeper=await submit(ctx,member,name,['python','-u','sleeper.py']);ids.push(sleeper.id);
    ctx.check('sleeper 正在运行',(await waitJob(ctx,member,sleeper.id,['RUNNING',...terminalStates])).state==='RUNNING');
    for(const operation of ['jobs.cancel','jobs.priority']){
      const error=await ctx.client.refused(b.token,operation,{jobId:sleeper.id,priority:'P4'});
      ctx.check('他人操作返回403：'+operation,error.status===403&&error.body?.error==='只能操作自己的任务',error.body?.error);
    }
    const start=Date.now();await call(ctx,member,'jobs.cancel',{jobId:sleeper.id});
    const stopped=await waitJob(ctx,member,sleeper.id,terminalStates);
    ctx.check('取消在120秒内结束且状态取消',Date.now()-start<=120000&&stopped.state==='CANCELED',stopped);
    const held=await submit(ctx,member,name,['python','-u','sleeper.py'],{cards:2});ids.push(held.id);
    ctx.check('下一任务可占满2卡',(await waitJob(ctx,member,held.id,['RUNNING',...terminalStates])).state==='RUNNING');
    const queued=await submit(ctx,b,name,['python','-u','sleeper.py'],{ownerId:member.userId,priority:'high'});ids.push(queued.id);
    const pending=await waitJob(ctx,b,queued.id,['PENDING','RUNNING',...terminalStates]);
    ctx.check('两卡占用时新任务排队',pending.state==='PENDING',pending);
    ctx.check('high 预设使用 P4',pending.schedulerPriority===4,pending.schedulerPriority);
    const priority=await call(ctx,b,'jobs.priority',{jobId:queued.id,priority:'P1'});
    ctx.check('排队任务优先级改为P1',priority.schedulerPriority===1,priority);
    const changed=await call(ctx,admin,'jobs.priority',{jobId:queued.id,priority:'P2'});
    ctx.check('管理员可调整他人任务',changed.schedulerPriority===2,changed);
  }finally{
    for(const jobId of ids.reverse()){
      await call(ctx,admin,'jobs.cancel',{jobId});await waitJob(ctx,member,jobId,terminalStates);
      const completion=await call(ctx,member,'jobs.completion',{jobId});ctx.check('任务完成情况可见',completion.completed===true,completion);
      const resources=await call(ctx,member,'jobs.reconcile-resources',{jobId});ctx.note('资源收尾 '+jobId+' '+JSON.stringify(resources));
    }
  }
  const state=await memberState(ctx,member);
  ctx.check('本轮无未结束任务',state.jobs.filter(j=>ids.includes(j.id)).every(j=>terminalStates.includes(j.state)));
}};
