import {approvedMember,memberState} from '../lib/accounts.mjs';
import {project,call,submit,waitJob,terminalStates} from '../lib/exec.mjs';
export default {id:'G09',title:'取消、排队优先级与资源收尾（FEATURES 五）',level:'fast',async run(ctx){
  const {name,member}=await project(ctx),b=await approvedMember(ctx,'b'),ids=[];
  try{
    const sleeper=await submit(ctx,member,name,['python','-u','sleeper.py']);ids.push(sleeper.id);
    ctx.check('sleeper 正在运行',(await waitJob(ctx,member,sleeper.id,['RUNNING',...terminalStates])).state==='RUNNING');
    const start=Date.now();await call(ctx,member,'jobs.cancel',{jobId:sleeper.id});
    const stopped=await waitJob(ctx,member,sleeper.id,terminalStates);
    ctx.check('取消在120秒内结束且状态取消',Date.now()-start<=120000&&stopped.state==='CANCELED',stopped);
    const held=await submit(ctx,member,name,['python','-u','sleeper.py'],{cards:2});ids.push(held.id);
    ctx.check('下一任务可占满2卡',(await waitJob(ctx,member,held.id,['RUNNING',...terminalStates])).state==='RUNNING');
    const queued=await submit(ctx,b,name,['python','-u','sleeper.py'],{ownerId:member.userId});ids.push(queued.id);
    const pending=await waitJob(ctx,b,queued.id,['PENDING','RUNNING',...terminalStates]);
    ctx.check('两卡占用时新任务排队',pending.state==='PENDING',pending);
    const priority=await call(ctx,b,'jobs.priority',{jobId:queued.id,priority:'P1'});
    ctx.check('排队任务优先级改为P1',priority.schedulerPriority===1,priority);
  }finally{
    for(const jobId of ids.reverse()){
      await call(ctx,member,'jobs.cancel',{jobId});await waitJob(ctx,member,jobId,terminalStates);
      const completion=await call(ctx,member,'jobs.completion',{jobId});ctx.check('任务完成情况可见',completion.completed===true,completion);
      const resources=await call(ctx,member,'jobs.reconcile-resources',{jobId});ctx.note('资源收尾 '+jobId+' '+JSON.stringify(resources));
    }
  }
  const state=await memberState(ctx,member);
  ctx.check('本轮无未结束任务',state.jobs.filter(j=>ids.includes(j.id)).every(j=>terminalStates.includes(j.state)));
}};
