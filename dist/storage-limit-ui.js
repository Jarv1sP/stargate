import {openSheet,closeSheet} from './sheet-ui.js';
export function storageLimitUI(section,store,refresh,toast){
  const dialog=document.createElement('dialog');dialog.className='pr-sheet';dialog.setAttribute('aria-label','项目文件上限');
  dialog.innerHTML='<div class="pr-sheet-in"><div class="pr-sheet-head"><div class="pr-sheet-title">项目文件上限</div><button type="button" class="jr-x" data-limit-close aria-label="关闭">✕</button></div><form><label>上限（GB，1 GB = 10⁹ 字节）<input name="limit-gb" type="number" min="0.000001" step="any" required></label><p class="jr-hint">节点开关由安装配置控制。保存后等待节点应用。</p><p role="status" data-limit-status></p><div class="jr-actions"><button type="button" class="jr-btn ghost" data-limit-close>取消</button><button class="jr-btn primary" type="submit">保存</button></div></form></div>';
  section.append(dialog);let ref;
  const close=()=>closeSheet(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  for(const button of dialog.querySelectorAll('[data-limit-close]'))button.onclick=close;
  section.addEventListener('click',event=>{
    const button=event.target.closest('[data-storage-limit]');if(!button||store.principal?.role!=='admin')return;
    ref={machine:button.closest('[data-storage-machine]').dataset.storageMachine,ownerId:button.dataset.ownerId,project:button.dataset.storageLimit};
    dialog.querySelector('input').value=Number(button.dataset.desiredBytes||100_000_000_000)/1e9;
    dialog.querySelector('[data-limit-status]').textContent='';openSheet(dialog);
  });
  dialog.querySelector('form').onsubmit=async event=>{
    event.preventDefault();const button=dialog.querySelector('[type=submit]'),status=dialog.querySelector('[data-limit-status]');button.disabled=true;
    try{const bytes=Math.round(Number(dialog.querySelector('input').value)*1e9);const result=await store.call('projects.storage.limit.set',{...ref,bytes});
      toast(result.synced?'已保存，等待节点应用。':'已保存，节点恢复后自动推送。');await refresh(ref.machine);close();
    }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  };
}
