import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {checkpoint} from '../lib/checkpoint.mjs';
import datasets from './G06-datasets.mjs';
import {project,call,submit,waitJob,download,terminalStates} from '../lib/exec.mjs';
import {AssertionFailure} from '../lib/context.mjs';
import {memberState} from '../lib/accounts.mjs';
export default {id:'G07',title:'指定、自动与指定 GPU 训练及观察（FEATURES 五）',level:'fast',async run(ctx){
  const {name,member}=await project(ctx);
  if(!ctx.shared.dataset)await datasets.run(ctx);
  const dataset=ctx.shared.dataset;
  ctx.shared.trained??=[];const failures=[];
  for(const [mode,extra] of [['fixed',{}],['auto',{machine:'auto'}],['gpu',{placement:{gpuIndices:[1],shared:false}}]]){
    ctx.log('G07 训练方式 '+mode);
    const argv=['python','-u','-c',"import sys,time,runpy;print('GRAY_BEGIN',flush=True);time.sleep(30);sys.argv=['train.py',sys.argv[1]];runpy.run_path('train.py',run_name='__main__')",'/datasets/'+dataset.name];
    const job=await submit(ctx,member,name,argv,extra);
    try{
      const running=await waitJob(ctx,member,job.id,['RUNNING',...terminalStates]);
      ctx.check(mode+' 训练进入运行',running.state==='RUNNING',running);
      ctx.check('任务列表有原编号',(await memberState(ctx,member)).jobs.some(j=>j.id===job.id));
      const args={machine:ctx.machine,nodeJobId:running.nodeJobId};
      await call(ctx,member,'tasks.display.set',{...args,name:'灰度 '+mode,description:'读取数据集并写训练输出'});
      ctx.check('任务显示名持久化',(await call(ctx,member,'tasks.display.get',args)).name==='灰度 '+mode);
      const note=await call(ctx,member,'community.notes.create',{key:ctx.key(),jobId:job.id,body:'灰度训练进行中'});
      ctx.check('任务留言存在',(await call(ctx,member,'community.notes.list')).notes.some(n=>n.id===note.note.id));
      const ended=await waitJob(ctx,member,job.id,terminalStates);
      const diagnostics=await call(ctx,member,'jobs.diagnostics',{jobId:job.id});
      await mkdir(ctx.artifacts,{recursive:true});await writeFile(join(ctx.artifacts,'diagnostics-'+mode+'.json'),JSON.stringify(diagnostics,null,2)+'\n');
      ctx.check('诊断有 CPU 和内存计数',diagnostics.captures?.some(c=>c.resources?.counters?.['cpu.stat']&&Number.isFinite(c.resources?.peaks?.['memory.current'])),diagnostics);
      ctx.check(mode+' 训练成功',ended.state==='SUCCEEDED',ended);
      const log=await call(ctx,member,'jobs.logs',{jobId:job.id});
      ctx.check('日志包含训练开始和结果',log.text.includes('GRAY_BEGIN')&&log.text.includes('GRAY-TRAIN'));
      const bytes=await download(ctx,member,{area:'output',runId:job.id,path:'result.json'}),result=JSON.parse(bytes);
      ctx.check('训练读取的数据文件数和总字节数一致',result.files===dataset.files&&result.bytes===dataset.bytes,result);
      ctx.check('训练产出有限损失和准确率',result.loss.length===4&&result.loss.every(Number.isFinite)&&result.accuracy>=0&&result.accuracy<=1);
      ctx.check('任务只可见一张分配卡',result.visibleGpuUuids.length===1,result.visibleGpuUuids);
      if(mode==='gpu')ctx.check('指定 GPU 1 生效',result.visibleGpuUuids[0]==='GPU-00000000-0000-0000-0000-000000000002');
      ctx.shared.trained.push({jobId:job.id,project:name,member,result,bytes:bytes.toString('base64')});

    }catch(error){
      ctx.shared.trainingError=error.message;
      try{ctx.note('失败任务日志 '+JSON.stringify(await call(ctx,member,'jobs.logs',{jobId:job.id})));}catch(logError){ctx.note('日志不可用：'+logError.message);}
      failures.push(mode+': '+error.message);
    }finally{
      const current=await call(ctx,member,'jobs.watch',{jobId:job.id});
      if(!terminalStates.includes(current.state)){await call(ctx,member,'jobs.cancel',{jobId:job.id});await waitJob(ctx,member,job.id,terminalStates);}
    }
  }
  try{await checkpoint(ctx,member,name);}catch(error){failures.push('SDK进度/checkpoint：'+error.message);ctx.note('SDK子检查失败：'+error.message);}
  if(failures.length)throw new AssertionFailure(failures.join('；'));
}};
