import {approvedMember,memberState} from '../lib/accounts.mjs';
import {waitFor} from '../lib/context.mjs';
export default {id:'G03',title:'服务器资源与排队（FEATURES 二）',level:'fast',async run(ctx){
  const a=await approvedMember(ctx,'a');
  const state=await waitFor(()=>memberState(ctx,a),s=>s.gpuq?.hosts?.some(h=>h.id===ctx.machine&&h.reachable&&h.gpuq?.connected),{what:'采集器节点状态'});
  const host=state.gpuq.hosts.find(h=>h.id===ctx.machine);
  ctx.check('机器表为唯一灰度节点',state.machines.length===1&&state.machines[0].id===ctx.machine&&state.machines[0].cards===2);
  ctx.check('有两张模拟 GPU',host.gpus.length===2);
  for(const gpu of host.gpus){
    ctx.check('GPU 型号 '+gpu.index,gpu.model==='Gray Simulated GPU');
    for(const field of ['utilization','memoryTotalMiB','memoryUsedMiB','temperatureC'])ctx.check(field+' '+gpu.index,Number.isFinite(gpu[field]));
    ctx.check('GPU 使用者列表 '+gpu.index,Array.isArray(gpu.processes));
  }
  ctx.check('两块数据盘用量可用',host.disks.length===2&&host.disks.every(d=>['/data1','/data2'].includes(d.mountPoint)&&d.totalBytes>0&&d.usedBytes>=0&&d.availableBytes>0));
  ctx.check('排队信息可用',Array.isArray(host.gpuq.jobs)&&Array.isArray(state.jobs));
  ctx.check('平台总状态为真实执行模式',state.gpuqConnected&&state.executionEnabled&&state.jobsSimulated===false);
  const selected=await ctx.client.call(a.token,'projects.list',{machine:ctx.machine});
  ctx.check('单节点选机接口可用',Array.isArray(selected.result.projects));
}};
