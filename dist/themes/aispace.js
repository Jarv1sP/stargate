// Layout only: existing job buttons and controllers retain every operation/RPC.
// Mount once after the platform store exists; no navigation or backend adapter.
import {stateWord,elapsedTraining} from '../workbench-ui.js';

export function mount({store}) {
  const labels=['运行名称','状态','项目','服务器 / GPU','运行时间','运行时长','创建人','创建时间','操作'];
  const owned=new Set(),originalLabels=new Map(),moved=new Map();
  let disposed=false;
  const add=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;owned.add(node);return node;};
  function date(value) {if(value===null||value===undefined||value==='')return '未知';const d=new Date(typeof value==='number'?value*1000:value);return Number.isNaN(d.valueOf())?'未知':d.toLocaleString('zh-CN',{hour12:false});}
  function cleanup() {
    for(const [node,marker] of moved){if(marker.isConnected)marker.replaceWith(node);}moved.clear();
    for(const drawer of document.querySelectorAll('.aispace-detail')){
      drawer.classList.remove('aispace-detail');
      const tab=drawer.querySelector(`[data-tab="${drawer.dataset.aispacePreviousTab||'log'}"]`);
      tab?.setAttribute('aria-selected','true');delete drawer.dataset.aispacePreviousTab;
    }
    for(const node of owned)node.remove();owned.clear();
    for(const [node,text] of originalLabels)if(node.isConnected)node.textContent=text;originalLabels.clear();
  }
  function render() {
    if(disposed)return;
    observer.disconnect();
    if(document.body.dataset.workshopLayout!=='aispace'){cleanup();return;}
    {
      // Drop detached references when the existing controller replaces its rows.
      for(const node of owned)if(!node.isConnected)owned.delete(node);
      for(const node of originalLabels.keys())if(!node.isConnected)originalLabels.delete(node);
      const rows=document.querySelector('#jobs-room .jr-rows');
      const toolbar=document.querySelector('#jobs-room .jr-toolbar'),newJob=document.querySelector('#jobs-new');
      if(toolbar&&newJob&&!moved.has(newJob)){const marker=document.createComment('AISpace action position');newJob.before(marker);moved.set(newJob,marker);toolbar.append(newJob);}
      if(rows&&!rows.previousElementSibling?.classList.contains('aispace-table-head')){
        const head=add('div','aispace-table-head');head.setAttribute('aria-hidden','true');
        for(const label of labels){const cell=document.createElement('span');cell.textContent=label;head.append(cell);}rows.before(head);
      }
      for(const row of rows?.querySelectorAll('[data-job]')||[]) {
        const job=store.jobs?.find(item=>item.id===row.dataset.job);if(!job)continue;
        const member=store.users?.find(user=>user.id===job.userId);
        const creator=job.submitter?.name||job.submitter?.username||member?.name||member?.username||job.username||'成员未知';
        const values=[job.name||'训练',stateWord(job),job.project||'默认项目',`${job.machine||'未知'} / ${Number.isSafeInteger(job.cards)?job.cards+' 张':'未知'}`,date(job.latestAttempt?.startedAt),elapsedTraining(job)||'未知',creator,date(job.createdAt),'查看详情'];
        let cells=row.querySelector('.aispace-cells');
        if(!cells){cells=add('span','aispace-cells');for(let i=0;i<labels.length;i++){const cell=document.createElement('span');cell.className='aispace-cell';cell.dataset.label=labels[i];cells.append(cell);}row.append(cells);}
        for(const [i,cell] of [...cells.children].entries()) {
          const value=i===0?values[i]+'\n'+String(job.id).slice(0,8):values[i];
          if(cell.textContent!==value)cell.textContent=value;
          cell.title=i===0?values[i]+' / '+String(job.id):value;
          if(i===1)cell.dataset.state=job.state;
        }
      }
      for(const drawer of document.querySelectorAll('.jr-drawer')) {
        const tabs=drawer.querySelector('.jr-tabs');if(!tabs)continue;
        const title=drawer.querySelector('.jr-dr-title');
        if(title&&!title.querySelector('.aispace-breadcrumb'))title.prepend(add('div','aispace-breadcrumb','训练作业 / 详情'));
        if(!tabs.querySelector('[data-aispace-detail]')){
          drawer.classList.remove('aispace-detail');delete drawer.dataset.aispacePreviousTab;
          const button=add('button','aispace-detail-tab','运行详情');button.type='button';button.dataset.aispaceDetail='';button.setAttribute('role','tab');button.setAttribute('aria-selected','false');tabs.prepend(button);
          const log=tabs.querySelector('[data-tab=log]');if(log){originalLabels.set(log,log.textContent);log.textContent='训练日志';}
        }
      }
    }
    observer.observe(document.body,{childList:true,subtree:true});
  }
  function click(event) {
    if(document.body.dataset.workshopLayout!=='aispace')return;
    const drawer=event.target.closest('.jr-drawer');if(!drawer)return;
    const detail=event.target.closest('[data-aispace-detail]');
    if(detail){
      const selected=drawer.querySelector('[data-tab][aria-selected=true]');if(selected)drawer.dataset.aispacePreviousTab=selected.dataset.tab;
      for(const tab of drawer.querySelectorAll('.jr-tabs [role=tab]'))tab.setAttribute('aria-selected',String(tab===detail));
      drawer.classList.add('aispace-detail');
    }else if(event.target.closest('[data-tab]')){
      drawer.classList.remove('aispace-detail');drawer.querySelector('[data-aispace-detail]')?.setAttribute('aria-selected','false');
    }
  }
  const observer=new MutationObserver(render);
  window.addEventListener('stargate:theme-change',render);document.addEventListener('click',click);
  render();
  return {render,dispose(){disposed=true;observer.disconnect();window.removeEventListener('stargate:theme-change',render);document.removeEventListener('click',click);cleanup();}};
}
