import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export function counts(steps){return Object.fromEntries(['passed','failed','skipped','incomplete'].map(status=>[status,steps.filter(s=>s.status===status).length]));}
export async function writeReport(folder,report){
  await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'report.json'),JSON.stringify(report,null,2)+'\n');
  const lines=[`# 灰度结果：${report.result}`,'',`候选 ${report.revision}；未提交改动 ${report.source?.dirty?'是':'否'}；节点 ${report.nodePython}；级别 ${report.level}；${JSON.stringify(report.counts)}`,'',
    '| 步骤 | 结果 | 断言数 | 豁免数 | 说明 |','| --- | --- | --- | --- | --- |'];
  for(const s of report.steps)lines.push(`| ${s.id} ${s.title} | ${s.status} | ${s.assertions.length} | ${s.waived.length} | ${String(s.error||s.reason||s.notes.join('；')).replaceAll('|','/').replaceAll('\n',' ')} |`);
  lines.push('','## 未测与豁免');
  for(const w of report.waivedChecks)lines.push(`- ${w.id}：${w.reason}（${w.owner}；到期 ${w.expires}）`);
  await writeFile(join(folder,'summary.md'),lines.join('\n')+'\n');
}
