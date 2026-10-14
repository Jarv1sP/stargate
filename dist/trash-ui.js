const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const trashReference=(machine,row)=>({machine,key:row.key,kind:row.kind,...(row.ownerId?{ownerId:row.ownerId}:{}),...(row.project?{project:row.project}:{})});
export function trashLabel(row){return ({project:'项目',dataset:'数据集',output:'输出'})[row.kind]+' · '+(row.originalPath||row.dataset||row.project||row.jobId||row.key);}
export function createTrashUI({call,getContext,changed=()=>{},toast=()=>{}}){
  const element=document.createElement('details');element.className='project-trash';
  element.innerHTML='<summary>回收站（7 天内可恢复）</summary><button type="button" class="button quiet" data-trash-refresh>刷新</button><div data-trash-items></div><p data-trash-status role="status"></p>';
  const q=s=>element.querySelector(s);let identity='',turn=0;
  const status=text=>{q('[data-trash-status]').textContent=text;};
  async function load(){
    const context=getContext(),token=++turn;if(!context.machine||!context.enabled)return;
    status('读取中…');
    try{
      const result=await call('projects.retire.list',{machine:context.machine});if(token!==turn)return;
      q('[data-trash-items]').replaceChildren();
      for(const row of result.items||[]){
        const line=document.createElement('section');line.className='project-trash-row';
        const expiry=typeof row.retainUntil==='number'?new Date(row.retainUntil*1000):new Date(row.retainUntil);
        line.innerHTML=`<span>${esc(trashLabel(row))}</span><small>${esc(row.actor?.name||row.actor?.userId||row.actor||'')} · ${Number.isFinite(expiry.getTime())?esc(expiry.toLocaleString('zh-CN'))+' 到期':'到期时间未知'}</small><div class="file-actions"><button type="button" class="button" data-trash-restore>恢复</button>${context.isAdmin?'<button type="button" class="button danger" data-trash-purge>彻底删除</button>':''}</div>`;
        line.addEventListener('click',async event=>{
          const button=event.target.closest('button');if(!button||button.disabled)return;
          const action=button.hasAttribute('data-trash-purge')?'purge':'restore';
          if(action==='purge'&&!window.confirm('彻底删除此条目？删除后不能恢复。'))return;
          button.disabled=true;
          try{const result=await call('projects.retire.'+action,trashReference(context.machine,row));if(token!==turn)return;status(result.state==='RESTORED'?'已恢复':result.state==='PURGED'?'已彻底删除':'结果未知，请按原编号查询：'+row.key);await changed(row,result);await load();}
          catch(error){if(token===turn)status(error.message+'；原编号 '+row.key);}
          finally{if(token===turn)button.disabled=false;}
        });
        q('[data-trash-items]').append(line);
      }
      status(result.items?.length?'':'回收站为空。');
    }catch(error){if(token===turn){status(error.message);toast(error.message);}}
  }
  q('[data-trash-refresh]').addEventListener('click',()=>void load());
  element.addEventListener('toggle',()=>{if(element.open)void load();});
  return {element,load,update(){const c=getContext(),next=JSON.stringify([c.owner,c.machine,c.enabled]);if(next!==identity){identity=next;turn++;q('[data-trash-items]').replaceChildren();status('');if(element.open)void load();}q('[data-trash-refresh]').disabled=!c.enabled;}};
}
