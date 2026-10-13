// STARGATE backend reply, training storage contract, 2026-10-08.
// Every capability is a read of the exact authenticated machine/version pair.
import {infoHTML} from './workbench-ui.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const keyOf=context=>JSON.stringify([context?.identity,context?.machine,context?.datasets]);
const byteLabel=value=>{
  const units=['B','KiB','MiB','GiB','TiB'];let index=0;
  while(value>=1024&&index<units.length-1){value/=1024;index++;}
  return `${Number(value.toFixed(2)).toLocaleString('zh-CN')} ${units[index]}`;
};
export function trainingStorageMessage(error){
  const storage=error?.storage,number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  if([409,503].includes(error?.status)&&error.code==='SUBMISSION_REJECTED'&&storage?.protocol===1&&
    storage.reasonCode==='TRAINING_STORAGE_INSUFFICIENT'&&number(storage.requiredBytes)&&number(storage.availableBytes)){
    return `空间不足 · 需要 ${byteLabel(storage.requiredBytes)} · 可用 ${byteLabel(storage.availableBytes)}`;
  }
  return error?.message||'';
}
export function trainingSelectionHTML(job){
  const summary=job?.selectionSummary;
  if(summary?.protocol!==1||!job.machine||summary.selectedMachine!==job.machine)return '';
  const reason=summary.reason==='local-workspace-and-resource-rank'?'按已有工作区、显卡和排队情况选择。':
    summary.reason==='storage-fit-and-resource-rank'&&summary.storageVerified===true?'按存储容量、显卡和排队情况选择。':'';
  const excluded=Array.isArray(summary.storageExcluded)?summary.storageExcluded.flatMap(item=>{
    const reason={'storage-insufficient':'空间不足','storage-unverified':'空间未核实'}[item?.reason];
    return typeof item?.machine==='string'&&reason?[`${item.machine} ${reason}`]:[];
  }):[];
  const lines=[...(reason?[reason]:[]),...excluded];
  const help=lines.length?infoHTML(lines.join('\n'),reason?'自动选择原因':'未选择的服务器').replace('<summary ',`<summary class="training-storage-info" title="${escape(lines.join('\n'))}" `):'';
  return `<div class="training-selection"><span class="training-selection-machine">已分配到 <span class="server-id" title="${escape(job.machine)}">${escape(job.machine)}</span></span>${help}</div>`;
}
export function createDatasetReadChoice({call,changed=()=>{}}){
  let generation=0,controller=null,pending=null,key='',state={available:false,reason:'',mode:'cache',loading:false};
  const reset=()=>{generation++;controller?.abort();controller=null;pending=null;key='';state={available:false,reason:'',mode:'cache',loading:false};};
  async function sync(context){
    if(!context?.identity||!context.machine||context.machine==='auto'||!context.datasets?.length){reset();return;}
    context=structuredClone(context);
    const next=keyOf(context);if(key===next)return pending;
    reset();key=next;state.loading=true;controller=new AbortController();const signal=controller.signal,turn=generation;
    const current=()=>turn===generation&&!signal.aborted;
    pending=(async()=>{
      const results=await Promise.allSettled(context.datasets.map(ref=>Promise.resolve().then(()=>call('datasets.training.capabilities',{machine:context.machine,dataset:ref.dataset,version:ref.version},{signal}))));
      if(!current())return;
      const values=results.map(result=>result.status==='fulfilled'?result.value:null);
      state.available=values.every((value,index)=>value?.protocol===1&&value.machine===context.machine&&
        value.dataset===context.datasets[index].dataset&&value.version===context.datasets[index].version&&value.warehouse?.available===true);
      state.reason=values.find((value,index)=>value?.machine===context.machine&&value.dataset===context.datasets[index].dataset&&value.version===context.datasets[index].version&&typeof value.warehouse?.reason==='string'&&value.warehouse.reason)?.warehouse.reason||'';
      state.loading=false;controller=null;
    })();
    return pending;
  }
  return {
    sync,reset,state:()=>({...state}),
    choose(mode){
      if(!['cache','warehouse'].includes(mode)||mode==='warehouse'&&!state.available)throw Error('仓库直读尚未确认。');
      if(state.mode!==mode){state.mode=mode;changed();}
    },
    args(context){
      if(state.mode==='cache')return {};
      if(!state.available||key!==keyOf(context))throw Error('数据读取方式已改变，请重新核对。');
      return {datasetReadMode:'warehouse'};
    }
  };
}
export function mountDatasetReadChoice(field,options){
  const caption=field.querySelector('.field-caption'),help=caption.querySelector('.ui-info>summary');
  const controls=document.createElement('span');controls.className='training-read-mode';controls.hidden=true;controls.setAttribute('role','group');controls.setAttribute('aria-label','数据读取方式');
  controls.innerHTML='<button type="button" class="button quiet" data-dataset-read-mode="cache" aria-pressed="true">缓存</button><button type="button" class="button quiet" data-dataset-read-mode="warehouse" aria-pressed="false">仓库直读</button>';
  caption.append(controls);
  const choice=createDatasetReadChoice(options);
  function render(){
    const state=choice.state();controls.hidden=!state.available;
    controls.setAttribute('aria-busy',String(state.loading));
    for(const button of controls.querySelectorAll('button')){button.setAttribute('aria-pressed',String(button.dataset.datasetReadMode===state.mode));button.disabled=options.locked();}
    if(help){const title=state.available?'省缓存空间；小文件随机读取可能更慢':state.reason;if(title)help.title=title;else help.removeAttribute('title');}
  }
  controls.addEventListener('click',event=>{const button=event.target.closest('[data-dataset-read-mode]');if(button&&!button.disabled){choice.choose(button.dataset.datasetReadMode);render();}});
  return {
    async sync(context){const request=choice.sync(context);render();await request;render();},
    args:context=>choice.args(context),
    warehouse:()=>choice.state().mode==='warehouse',
    reset(){choice.reset();render();}
  };
}
