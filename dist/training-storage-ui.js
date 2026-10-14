// Show the actual server selection and resource shortage without a preflight.
import {infoHTML,escapeUI as escape} from './workbench-ui.js';
const byteLabel=value=>{
  const units=['B','KiB','MiB','GiB','TiB'];let index=0;
  while(value>=1024&&index<units.length-1){value/=1024;index++;}
  return `${Number(value.toFixed(2)).toLocaleString('zh-CN')} ${units[index]}`;
};
export function trainingStorageMessage(error){
  const storage=error?.storage,number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  if([409,503].includes(error?.status)&&error.code==='SUBMISSION_REJECTED'&&number(storage.requiredBytes)&&number(storage.availableBytes)){
    return `空间不足 · 需要 ${byteLabel(storage.requiredBytes)} · 可用 ${byteLabel(storage.availableBytes)}`;
  }
  return error?.message||'';
}
export function trainingSelectionHTML(job){
  const summary=job?.selectionSummary;
  if(!job?.machine)return '';
  const reason='按项目工作区和显卡、内存情况选择。';
  const excluded=Array.isArray(summary?.storageExcluded)?summary.storageExcluded.flatMap(item=>{
    const reason={'storage-insufficient':'空间不足','storage-unverified':'空间未核实'}[item?.reason];
    return typeof item?.machine==='string'&&reason?[`${item.machine} ${reason}`]:[];
  }):[];
  const lines=[...(reason?[reason]:[]),...excluded];
  const help=lines.length?infoHTML(lines.join('\n'),reason?'自动选择原因':'未选择的服务器').replace('<summary ',`<summary class="training-storage-info" title="${escape(lines.join('\n'))}" `):'';
  return `<div class="training-selection"><span class="training-selection-machine">已分配到 <span class="server-id" title="${escape(job.machine)}">${escape(job.machine)}</span></span>${help}</div>`;
}
