import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {checkpoint} from '../lib/checkpoint.mjs';
import datasets from './G06-datasets.mjs';
import {project,call,submit,waitJob,download,terminalStates} from '../lib/exec.mjs';
import {AssertionFailure} from '../lib/context.mjs';
import {memberState} from '../lib/accounts.mjs';
import {stackExec} from '../lib/stack.mjs';
export default {features:["提交任务（指定卡数、自动选服务器、指定 GPU），直接用当前工作区和 /datasets", "作业依赖（CLI --after，可重复或逗号分隔）：全部成功后同机按优先级调度，失败/取消自动取消；链内共用预留", "任务列表、日志、实时跟踪、诊断（CPU/内存/OOM）", "任务显示名、留言、通知", "训练进度上报、checkpoint 断点重跑（SDK）"],id:'G07',title:'指定、自动与指定 GPU 训练及观察（FEATURES 五）',level:'fast',async run(ctx){
  const {name,member}=await project(ctx);
  if(!ctx.shared.dataset)await datasets.run(ctx);
  const dataset=ctx.shared.dataset;
  ctx.shared.trained??=[];const failures=[];
  for(const [mode,extra] of [['fixed',{}],['auto',{machine:'auto'}],['gpu',{placement:{gpuIndices:[1],shared:false}}]]){
    ctx.log('G07 训练方式 '+mode);
    const argv=['python','-u','-c',"import sys,time,runpy;print('GRAY_BEGIN',flush=True);time.sleep(30);sys.argv=['train.py',sys.argv[1]];runpy.run_path('train.py',run_name='__main__')",'/datasets/'+dataset.name];
    const job=await submit(ctx,member,name,argv,extra);let successor;
    try{
      const running=await waitJob(ctx,member,job.id,['RUNNING',...terminalStates]);
      ctx.check(mode+' 训练进入运行',running.state==='RUNNING',running);
      ctx.check('任务列表有原编号',(await memberState(ctx,member)).jobs.some(j=>j.id===job.id));
      const args={machine:ctx.machine,nodeJobId:running.nodeJobId};
      await call(ctx,member,'tasks.display.set',{...args,name:'灰度 '+mode,description:'读取数据集并写训练输出'});
      ctx.check('任务显示名持久化',(await call(ctx,member,'tasks.display.get',args)).name==='灰度 '+mode);
      const note=await call(ctx,member,'community.notes.create',{key:ctx.key(),jobId:job.id,body:'灰度训练进行中'});
      ctx.check('任务留言存在',(await call(ctx,member,'community.notes.list')).notes.some(n=>n.id===note.note.id));
      if(mode==='fixed'){
        successor=await submit(ctx,member,name,['python','-c',`from pathlib import Path; p=Path('/job-outputs/${job.id}/result.json'); Path('/outputs/after.json').write_bytes(p.read_bytes()); print('AFTER_OK')`],{machine:'auto',after:[job.id],name:'依赖后续',scheduling:{rank:'P4',yieldPolicy:'never',restartPolicy:'never',checkpointable:false,mode:'queue'}});
        const queued=await waitJob(ctx,member,successor.id,['PENDING',...terminalStates]);
        ctx.check('后续已提前进入依赖所在节点队列且未分卡',queued.state==='PENDING'&&queued.machine===running.machine&&!!queued.nodeJobId&&!queued.assignedIndices?.length&&queued.queueReason?.includes('等待依赖'),queued);
        ctx.check('后续保留自己的 P4 优先级',queued.schedulerPriority===4,queued.schedulerPriority);
      }
      const ended=await waitJob(ctx,member,job.id,terminalStates);
      const diagnostics=await call(ctx,member,'jobs.diagnostics',{jobId:job.id});
      await mkdir(ctx.artifacts,{recursive:true});await writeFile(join(ctx.artifacts,'diagnostics-'+mode+'.json'),JSON.stringify(diagnostics,null,2)+'\n');
      ctx.check('诊断有 CPU 和内存计数',diagnostics.captures?.some(c=>c.resources?.counters?.['cpu.stat']&&Number.isFinite(c.resources?.peaks?.['memory.current'])),diagnostics);
      ctx.check(mode+' 训练成功',ended.state==='SUCCEEDED',ended);
      const log=await call(ctx,member,'jobs.logs',{jobId:job.id});
      ctx.check('日志包含训练开始和结果',log.text.includes('GRAY_BEGIN')&&log.text.includes('GRAY-TRAIN'));
      const bytes=await download(ctx,member,{area:'output',runId:job.id,path:'result.json'}),result=JSON.parse(bytes);
      if(successor){
        const finished=await waitJob(ctx,member,successor.id,terminalStates);ctx.check('依赖成功后后续作业自动成功',finished.state==='SUCCEEDED',finished);
        ctx.check('后续能读取前序完整输出',(await download(ctx,member,{area:'output',runId:successor.id,path:'after.json'})).equals(bytes));
      }
      ctx.check('训练读取的数据文件数和总字节数一致',result.files===dataset.files&&result.bytes===dataset.bytes,result);
      ctx.check('训练产出有限损失和准确率',result.loss.length===4&&result.loss.every(Number.isFinite)&&result.accuracy>=0&&result.accuracy<=1);
      ctx.check('任务只可见一张分配卡',result.visibleGpuUuids.length===1,result.visibleGpuUuids);
      if(mode==='gpu')ctx.check('指定 GPU 1 生效',result.visibleGpuUuids[0]==='GPU-00000000-0000-0000-0000-000000000002');
      const layout=await stackExec(ctx.stack,'gray-node-1','python3','-c',
        'import importlib.util,json,sys;from pathlib import Path;c=json.load(open("/etc/gpuq-console/node-install.json"));p=Path(c["releaseRoot"])/"current/node/job-resources.py";s=importlib.util.spec_from_file_location("resources",p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.allocated_cpus(json.loads(sys.argv[1]))))',JSON.stringify(result.visibleGpuUuids));
      const expected=JSON.parse(layout.stdout);
      ctx.check('容器亲和性等于分配卡的 CPU 段',JSON.stringify(result.cpu.affinity)===JSON.stringify(expected),{actual:result.cpu,expected});
      ctx.check('nproc 等于分到的核数（清掉 OMP 对显示的覆盖）',result.cpu.nproc===expected.length,result.cpu);
      ctx.check('六个线程变量默认取配额与 CPU 段的较小值',Object.keys(result.cpu.threads).length===6&&Object.values(result.cpu.threads).every(value=>value===String(Math.max(1,Math.min(Math.floor(result.cpu.quota),expected.length)))),result.cpu);
      const other=ctx.shared.trained.find(job=>job.result.visibleGpuUuids[0]!==result.visibleGpuUuids[0]);
      if(other)ctx.check('不同卡的两个作业 CPU 段不重叠',other.result.cpu.affinity.every(cpu=>!result.cpu.affinity.includes(cpu)),{previous:other.result.cpu,actual:result.cpu});
      ctx.check('诊断保留本次显存峰值，已结束的当前值为未知',diagnostics.gpuMetrics?.gpus?.length===1&&diagnostics.gpuMetrics.gpus.every(g=>Number.isFinite(g.memoryPeakMiB)&&g.utilization===null&&g.memoryUsedMiB===null),diagnostics.gpuMetrics);
      ctx.shared.trained.push({jobId:job.id,project:name,member,result,bytes:bytes.toString('base64')});

    }catch(error){
      ctx.shared.trainingError=error.message;
      try{ctx.note('失败任务日志 '+JSON.stringify(await call(ctx,member,'jobs.logs',{jobId:job.id})));}catch(logError){ctx.note('日志不可用：'+logError.message);}
      failures.push(mode+': '+error.message);
    }finally{
      const current=await call(ctx,member,'jobs.watch',{jobId:job.id});
      if(!terminalStates.includes(current.state)){await call(ctx,member,'jobs.cancel',{jobId:job.id});await waitJob(ctx,member,job.id,terminalStates);}
      if(successor){const current=await call(ctx,member,'jobs.watch',{jobId:successor.id});if(!terminalStates.includes(current.state)){await call(ctx,member,'jobs.cancel',{jobId:successor.id});await waitJob(ctx,member,successor.id,terminalStates);}}
    }
  }
  try{await checkpoint(ctx,member,name);}catch(error){failures.push('SDK进度/checkpoint：'+error.message);ctx.note('SDK子检查失败：'+error.message);}
  if(failures.length)throw new AssertionFailure(failures.join('；'));
}};
