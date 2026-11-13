// Task records only: restoring a row never dispatches a training job.
export function installJobHistory(store,host,toast){
  const button=document.createElement('button');button.type='button';button.className='jr-btn ghost';
  button.hidden=true;
  button.id='jobs-history-trash';button.textContent='记录回收站';host.querySelector('.jr-toolbar').append(button);
  const dialog=document.createElement('dialog');dialog.className='job-log-dialog job-history-dialog';
  dialog.setAttribute('aria-labelledby','job-history-title');
  dialog.innerHTML='<div class="modal-head"><h2 id="job-history-title">任务记录回收站</h2><div><button type="button" class="button quiet" data-history-refresh>刷新</button><button type="button" class="button" data-history-close>关闭</button></div></div><p>30 天后入回收站，7 天内可恢复。恢复记录不会重跑训练。</p><p data-history-error role="alert"></p><div data-history-list></div><button type="button" class="button" data-history-more hidden>加载更早记录</button>';
  document.body.append(dialog);
  const list=dialog.querySelector('[data-history-list]'),error=dialog.querySelector('[data-history-error]'),more=dialog.querySelector('[data-history-more]');
  const binding=()=>store.principal?.userId+':'+store.authGeneration;
  let owner,turn=0,readTurn=0,cursor=null;
  const current=epoch=>dialog.open&&epoch===turn&&owner===binding();
  async function load(reset=false){
    if(!dialog.open)return;
    const epoch=turn,request=++readTurn,fresh=()=>current(epoch)&&request===readTurn;
    if(reset){cursor=null;list.replaceChildren();}
    error.textContent='';more.disabled=true;
    try{
      const result=await store.call('jobs.history.list',cursor?{cursor}:{});
      if(!fresh())return;
      for(const job of result.jobs){
        const row=document.createElement('article');row.className='job-history-row';
        const text=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');
        name.textContent=job.name||job.id;detail.textContent=`${job.machine} · ${job.id} · 可恢复至 ${new Date(job.historyPurgeAt).toLocaleString()}`;
        text.append(name,detail);
        const restore=document.createElement('button');restore.type='button';restore.className='button';restore.textContent='恢复记录';restore.dataset.historyRestore=job.id;
        restore.addEventListener('click',async()=>{
          restore.disabled=true;
          try{
            const result=await store.call('jobs.history.restore',{jobId:job.id});
            if(!current(epoch))return;
            toast(result.message);await store.refresh().catch(()=>{});await load(true);
          }catch(reason){if(current(epoch)){error.textContent=reason.message;restore.disabled=false;}}
        });
        row.append(text,restore);list.append(row);
      }
      cursor=result.nextCursor;more.hidden=!cursor;
      if(!list.children.length)list.textContent='任务记录回收站为空。';
    }catch(reason){if(fresh())error.textContent=reason.message;}
    finally{if(fresh())more.disabled=false;}
  }
  button.addEventListener('click',()=>{turn++;owner=binding();dialog.showModal();dialog.querySelector('[data-history-close]').focus();load(true);});
  dialog.querySelector('[data-history-close]').addEventListener('click',()=>dialog.close());
  dialog.querySelector('[data-history-refresh]').addEventListener('click',()=>load(true));
  more.addEventListener('click',()=>load());
  dialog.addEventListener('close',()=>{if(!dialog.open){turn++;cursor=null;list.replaceChildren();}});
  return {sync(active){button.hidden=!active;if(dialog.open&&(!active||owner!==binding()))dialog.close();}};
}
