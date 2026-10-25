import {schedulingPolicy} from './scheduling-policy.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function schedulingFields(admin=false){return `<details id="custom-scheduling"><summary>高级排队与让位</summary><label><input type="checkbox" name="custom-policy">使用独立排队等级与让位策略</label><label>排队等级<select name="queue-rank">${[0,1,2,3,4].map(n=>`<option value="P${n}" ${n===2?'selected':''}>P${n}</option>`).join('')}</select></label><label>申请方式<select name="request-mode"><option value="">普通排队</option><option value="preempt1">请求其他任务保存后让位</option><option value="preempt2">请求其他任务立即让位</option></select></label><label>允许高优先级任务抢占我<select name="yield-policy"><option value="never">不允许</option><option value="now">立即让位，不保存</option><option value="save">本轮保存后让位</option></select></label><label>让位后<select name="restart-policy"><option value="on-preempt">自动重排（立即让位从头跑，保存后续训）</option><option value="never">结束，不自动重排</option></select></label><label><input type="checkbox" name="checkpointable">训练已接入 epoch checkpoint 和恢复适配器（DDP 全 rank 协同）</label><p id="custom-policy-note" class="muted"></p></details>`;}
export function schedulingFromForm(form,admin=false){return form.get('custom-policy')?schedulingPolicy({rank:form.get('queue-rank'),yieldPolicy:form.get('yield-policy'),restartPolicy:form.get('yield-policy')==='never'?'never':form.get('restart-policy'),checkpointable:form.get('checkpointable')==='on',...(form.get('request-mode')?{mode:form.get('request-mode')}:{})},admin):null;}

export function schedulingSummary(job){
  const policy=job.scheduling;
  if(!policy)return '';
  return '<small>'+escape(`申请：${policy.rank} · 让位 ${policy.yieldPolicy} · 恢复 ${policy.restartPolicy}`)+'</small>';
}
