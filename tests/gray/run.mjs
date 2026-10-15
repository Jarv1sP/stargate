import {readdir,readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContext,SkipStep} from './lib/context.mjs';
import {InfraError} from './lib/http.mjs';
import {loadStack} from './lib/stack.mjs';
import {counts,writeReport} from './lib/report.mjs';
import {uncoveredFeatures} from './lib/coverage.mjs';
export function resultStatus(steps){return !steps.length||steps.some(s=>s.status==='failed')?'failed':'passed';}
export function parseArgs(argv){
  const options={level:'fast'};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];if(!['--stack','--level','--only','--report'].includes(key)||!argv[i+1])throw Error('参数无效：'+key);
    options[key.slice(2)]=argv[++i];
  }
  if(!options.stack||!['fast','full'].includes(options.level))throw Error('需要 --stack，level 为 fast/full');
  return options;
}
export async function runStep(ctx,step){
  const record={id:step.id,title:step.title,features:step.features||[],status:'passed',attempts:0,assertions:[],notes:[],todo:[],calls:[]};
  ctx.step=record;const started=Date.now();
  for(;;){
    record.attempts++;
    try{await step.run(ctx);break;}
    catch(error){
      if(error instanceof SkipStep){record.status='skipped';record.reason=error.message;break;}
      // 只在尚未发送任何业务调用时重试基础设施错误，避免整步重放写操作。
      if(error instanceof InfraError&&record.attempts<2&&record.calls.length===0){record.notes.push('基础设施错误，重试一次：'+error.message);continue;}
      record.status='failed';record.error=error.name+': '+error.message;break;
    }
  }
  record.durationMs=Date.now()-started;ctx.step=null;return record;
}
export async function runGray(options){
  const stack=await loadStack(options.stack),folder=options.report||dirname(stack.file);
  const ctx=createContext({stack,artifacts:folder});
  const files=(await readdir(new URL('./steps/',import.meta.url))).filter(n=>/^G\d\d-.*\.mjs$/.test(n)).sort();
  const all=await Promise.all(files.map(async n=>(await import(new URL('./steps/'+n,import.meta.url))).default));
  const only=options.only?.split(',');
  if(only?.some(id=>!all.some(s=>s.id===id)))throw Error('未知步骤');
  const selected=all.filter(s=>(options.level==='full'||s.level==='fast')&&(!only||only.includes(s.id)));
  const steps=[];
  try{for(const step of selected){console.error('执行 '+step.id+' '+step.title);const record=await runStep(ctx,step);steps.push(record);console.error(record.status+(record.error?' '+record.error:''));}}
  finally{for(const cleanup of ctx.cleanups.reverse())await cleanup();}
  const markdown=await readFile(resolve(dirname(stack.file),'src/docs/FEATURES.md'),'utf8');
  const report={version:1,revision:stack.commit,source:stack.source,nodePython:stack.nodePython,nodeRelease:stack.nodeRelease,authenticationMode:stack.identityMode?'central':'local',level:options.level,result:resultStatus(steps),counts:counts(steps),steps,
    uncoveredFeatures:uncoveredFeatures(markdown,steps.filter(s=>s.status==='passed')),createdAt:new Date().toISOString()};
  await writeReport(folder,report);return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const report=await runGray(parseArgs(process.argv.slice(2)));console.log(JSON.stringify({result:report.result,...report.counts}));process.exitCode=report.result==='passed'?0:1;}
  catch(error){console.error(error);process.exitCode=2;}
}
