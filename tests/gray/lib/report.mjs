import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export function counts(steps){return Object.fromEntries(['passed','failed','skipped'].map(status=>[status,steps.filter(s=>s.status===status).length]));}
export async function writeReport(folder,report){
  await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'report.json'),JSON.stringify(report,null,2)+'\n');
  const lines=[`# 灰度结果：${report.result}`,'',`候选 ${report.revision}；节点 ${report.nodePython}；级别 ${report.level}；${JSON.stringify(report.counts)}`,'',
    '| 步骤 | 结果 | 断言数 | 说明 |','| --- | --- | --- | --- |'];
  for(const s of report.steps)lines.push(`| ${s.id} ${s.title} | ${s.status} | ${s.assertions.length} | ${String(s.error||s.reason||s.notes.join('；')).replaceAll('|','/').replaceAll('\n',' ')} |`);
  lines.push('','## 未覆盖的功能');
  for(const text of report.uncoveredFeatures)lines.push('- '+text);
  lines.push('','## 各步骤未测项');
  for(const step of report.steps){
    if(step.status==='skipped')lines.push(`- ${step.id}：${step.reason}`);
    for(const item of step.todo)lines.push(`- ${step.id} / ${item.id}：${item.text}`);
  }
  await writeFile(join(folder,'summary.md'),lines.join('\n')+'\n');
}
