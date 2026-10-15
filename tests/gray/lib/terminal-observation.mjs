import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {call} from './exec.mjs';
import {stackExec} from './stack.mjs';

// 仅观察原 close 请求的后续状态；不重发关闭，不改变失败结论。
export async function closeObserved(ctx,member,terminal){
  const started=Date.now(),args={machine:ctx.machine,id:terminal.id,project:terminal.project};
  try{return await call(ctx,member,'terminal.close',args);}
  catch(error){
    if(!/timed out|timeout/i.test(error.message))throw error;
    const observedAt=Date.now(),samples=[];
    for(let index=1;index<=12;index++){
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,observedAt+index*5000-Date.now())));
      try{
        const result=await call(ctx,member,'terminal.status',args);
        samples.push({afterTimeoutSeconds:(Date.now()-observedAt)/1000,afterCloseSeconds:(Date.now()-started)/1000,state:result.state,alive:result.alive});
        if(result.state==='STOPPED')break;
      }catch(statusError){samples.push({afterTimeoutSeconds:(Date.now()-observedAt)/1000,error:statusError.message});}
    }
    await mkdir(ctx.artifacts,{recursive:true});
    const stem=join(ctx.artifacts,'terminal-stop-'+terminal.id),unit='amax-term-'+terminal.id+'.service';
    try{
      const result=await stackExec(ctx.stack,'gray-node-1','runuser','-u','gpuops','--','env','XDG_RUNTIME_DIR=/run/user/1001','DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus','journalctl','--user','-u',unit,'--since',new Date(started).toISOString(),'-n','30','--no-pager');
      await writeFile(stem+'.log',result.stdout+result.stderr);
    }catch(logError){await writeFile(stem+'.log',String(logError));}
    const last=samples.at(-1),observation={id:terminal.id,unit,closeError:error.message,samples,stopped:last?.state==='STOPPED',observedSeconds:last?.afterTimeoutSeconds};
    await writeFile(stem+'.json',JSON.stringify(observation,null,2)+'\n');
    ctx.note('terminal.close 失败保留；停止观察：'+JSON.stringify(observation)+'；日志 '+stem+'.log；待确认是否为灰度环境因素');
    throw error;
  }
}
