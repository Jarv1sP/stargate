import {maintenanceFor,restoreMaintenanceControls,disableMaintenanceControls} from './maintenance-state.js';
import {copyHelp} from './copy-help-ui.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size=n=>!Number.isFinite(n)||n<0?'未知':n<1024?Math.round(n)+' B':n<1024**2?(n/1024).toFixed(1)+' KiB':n<1024**3?(n/1024**2).toFixed(1)+' MiB':(n/1024**3).toFixed(2)+' GiB';
const labels={QUEUED:'准备中',RUNNING:'下载中',CANCELING:'正在取消',PAUSED:'已暂停',READY:'已下载',FAILED:'失败',CANCELED:'已取消',UNKNOWN:'待核对'};
export const shareCapability=info=>info?.disabled!==true&&info?.configurationEnabled!==false;
export function checkedImportURL(value){
  let parsed;try{parsed=new URL(value);}catch{throw Error('请输入完整 HTTPS 下载链接。');}
  if(typeof value!=='string'||value.length>16384||/[\x00-\x20\x7f]/.test(value)||parsed.protocol!=='https:')throw Error('请使用HTTPS 下载链接。');
  return parsed.href;
}
export function importRows(rows=[]){return rows.map(r=>{
  const stopped=['PAUSED','FAILED','CANCELED','READY'].includes(r.state);
  const hint=r.state==='READY'?copyHelp('已下载','已保存到所选数据集或 /workspace，可在项目终端中使用。'):r.state==='CANCELING'?copyHelp('正在取消','等待下载进程停止；临时文件仍保留，请稍后刷新确认。'):r.state==='CANCELED'?copyHelp('已取消','临时文件仍占用空间；可继续同一任务，取消不会删除已下载内容。'):'';
  return `<li><div><strong>${esc(r.path)}</strong><p>${esc(labels[r.state]||'状态未确认')}${hint} · ${size(r.bytes)}${r.totalBytes!==undefined?' / '+size(r.totalBytes):''}</p>
    ${r.error?`<p class="form-error">${esc(r.error)}</p>`:''}
    ${stopped&&r.canResume&&r.sourceKind==='https'?`<details data-import-replace-panel="${esc(r.operationId)}"><summary>链接过期？换链接继续</summary><form data-import-replace="${esc(r.operationId)}"><label class="field">同一文件的新 HTTPS 链接<input name="cloud-resume-url" type="url" maxlength="16384" autocomplete="off" spellcheck="false" placeholder="https://…" required></label><p class="muted">只更新下载地址；仍保存到原位置。</p><button class="button" type="submit">换链接并继续</button></form></details>`:''}
    </div><div class="file-actions">
    ${stopped&&r.canResume?`<button class="button" type="button" data-import-resume="${esc(r.operationId)}">继续</button>`:''}
    ${['QUEUED','RUNNING','PAUSED','FAILED'].includes(r.state)?`<button class="button" type="button" data-import-cancel="${esc(r.operationId)}">取消</button>`:''}
    ${stopped?`<button class="button" type="button" data-import-discard="${esc(r.operationId)}">清理记录</button>`:''}
    </div></li>`;
}).join('')||'<li class="muted">暂无导入任务。</li>';}
export function cloudImportHTML(users=[]){return `<section class="data-workspace-card cloud-import" aria-labelledby="cloud-import-title">
  <header><div><p class="data-workspace-eyebrow">大文件推荐</p><h3 id="cloud-import-title">从链接导入</h3></div><span class="data-workspace-badge">服务器直下</span></header>
  <form id="cloud-import-form"><div class="data-workspace-fields"><label class="field"><span>来源${copyHelp('链接导入','文件保存到所选数据集或 /workspace，关闭网页后继续下载。')}</span><select name="cloud-source"><option value="https">HTTPS 下载链接</option><option value="aliyun">阿里云盘分享</option></select></label><label class="field">链接<input name="cloud-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://…" required></label></div>
  <div id="cloud-share-availability" hidden><span>阿里云盘分享暂不可用</span><button class="button" id="cloud-share-refresh" type="button">重新查询</button></div>
  <div id="cloud-share-fields" class="data-workspace-fields"><label class="field">提取码（可选）<input name="cloud-password" autocomplete="off" maxlength="16"></label><div class="field"><span>分享文件</span><button class="button" id="cloud-inspect" type="button">读取文件</button><select name="cloud-file" aria-label="选择分享文件"><option value="">先读取分享文件</option></select></div></div>
  <div class="data-workspace-fields"><label>目标<select name="cloud-target-area"><option value="dataset">数据集目录</option><option value="code">项目工作区</option></select></label><label>数据集 / 项目名称<input name="cloud-target-name" required></label><label>项目所属成员（可选）<select name="cloud-target-owner"><option value="">当前账号</option>${users.map(user=>`<option value="${esc(user.id)}">${esc(user.name||user.username)}</option>`).join('')}</select></label></div>
  <label class="field"><span>保存为${copyHelp('保存位置','填写目标数据集或 /workspace 内的相对文件路径。')}</span><input name="cloud-path" placeholder="incoming/dataset.zip" required></label>

  <div class="file-actions"><button class="button primary" type="submit">开始导入</button><button class="button" id="cloud-import-refresh" type="button">刷新进度</button></div></form>
  <aside id="cloud-import-pending" hidden><p>导入结果未确认。</p><details><summary>操作编号</summary><code id="cloud-import-pending-key"></code></details><button class="button" id="cloud-import-retry" type="button">用同一请求重试</button></aside>
  <p id="cloud-import-status" role="status">填写 HTTPS 下载链接。</p><ul id="cloud-import-list" class="cloud-import-list"></ul>
  </section>`;}
export function cloudImportUI(store,section,toast){
  let epoch=0,inspection=null,busy=false,timer=null;
  // Pending URLs and share inspections live only in this page's memory. Keep
  // the original request through uncertain replies and machine switches.
  const pending=new Map(),capabilities=new Map();
  const $=s=>section.querySelector(s),machine=()=>$('[name=dataset-machine]')?.value;
  const scope=()=>JSON.stringify([store.principal?.userId,store.authGeneration,machine()]);
  const context=()=>JSON.stringify([store.principal?.userId,store.authGeneration,machine(),epoch]);
  const report=t=>{const el=$('#cloud-import-status');if(el)el.textContent=t;};
  function controls(){
    const card=$('.cloud-import');if(!card)return;restoreMaintenanceControls(card);
    const owner=store.data?.users?.find(row=>row.id===store.principal?.userId);
    const disabled=busy||!store.production||!store.principal||!machine()||owner?.enabled===false,held=pending.get(scope()),aliyun=$('[name=cloud-source]')?.value==='aliyun',info=capabilities.get(scope()),unavailable=!shareCapability(info);
    for(const el of card.querySelectorAll('input,button:not([data-copy-help]),select'))el.disabled=disabled||!!held&&el.closest('#cloud-import-form')&&el.id!=='cloud-import-refresh';
    $('#cloud-share-availability').hidden=!aliyun||!unavailable;

    $('#cloud-share-fields').hidden=!aliyun;
    disableMaintenanceControls(card,'#cloud-import-form [type=submit],#cloud-inspect,#cloud-import-retry,[data-import-resume],[data-import-discard],[data-import-replace] [type=submit]',maintenanceFor(store.data?.operationalMaintenance,machine()));
    $('#cloud-import-pending').hidden=!held;$('#cloud-import-pending-key').textContent=held?.args.key||'';
  }
  function reset(forgetPending=true){epoch++;clearTimeout(timer);timer=null;inspection=null;busy=false;if(forgetPending){pending.clear();capabilities.clear();}}
  async function run(fn){if(busy||!store.production||!store.principal||!machine())return;const owner=store.data?.users?.find(row=>row.id===store.principal.userId);if(owner?.enabled===false){report('账号已停用，请重新登录或联系管理员。');return;}busy=true;controls();const expected=context();const check=()=>{if(expected!==context())throw Error('账号或服务器已改变。');};const call=async(op,args={})=>{check();const result=await store.call(op,args);check();return result;};try{await fn(call,check);}catch(e){if(expected===context()){report(e.message);toast(e.message);}}finally{if(expected===context()){busy=false;controls();}}}
  async function shareInfo(call){
    const key=scope();capabilities.delete(key);controls();
    const result=await call('cloud.info',{});capabilities.set(key,result);
    if($('[name=cloud-source]').value==='aliyun')report('');controls();return result;
  }
  async function list(call){
    const result=await call('cloud.import.list',{machine:machine()}),rows=result?.imports,held=pending.get(scope());
    if(!Array.isArray(rows))throw Error('导入列表未确认，请重新查询。');
    if(held&&rows.some(r=>r.operationId===held.args.key&&Object.hasOwn(labels,r.state)&&r.state!=='UNKNOWN')){pending.delete(scope());report('已找到原导入任务，没有重复创建。');}
    const drafts=new Map([...section.querySelectorAll('[data-import-replace-panel]')].map(el=>[el.dataset.importReplacePanel,{open:el.open,value:el.querySelector('input').value}]));
    $('#cloud-import-list').innerHTML=importRows(rows);
    for(const el of section.querySelectorAll('[data-import-replace-panel]')){const draft=drafts.get(el.dataset.importReplacePanel);if(draft){el.open=draft.open;el.querySelector('input').value=draft.value;}}
    clearTimeout(timer);
    if(rows.some(r=>['QUEUED','RUNNING','CANCELING','UNKNOWN'].includes(r.state)))timer=setTimeout(()=>{if(!document.hidden&&!section.hidden)run(list);},8000);
  }
  async function start(call,held){
    const key=scope();
    pending.set(key,held);controls();
    try{const result=await call('cloud.import.start',held.args);if(result?.state&&result.state!=='UNKNOWN'&&pending.get(key)===held)pending.delete(key);report(labels[result?.state]||'状态未知，请按原编号查询。');await list(call);}
    catch(error){
      if(pending.get(key)===held){
        held.uncertain=true;try{const result=await call('cloud.import.status',{machine:machine(),operationId:held.args.key});if(Object.hasOwn(labels,result.state)&&result.state!=='UNKNOWN'){pending.delete(key);report(labels[result.state]);await list(call);return;}}catch{ /* Only query the original ID; no automatic start replay. */ }
      }
      throw error;
    }
  }
  section.addEventListener('change',event=>{
    if(['cloud-url','cloud-password','cloud-source'].includes(event.target.name)){inspection=null;const files=$('[name=cloud-file]');if(files)files.innerHTML='<option value="">先读取分享文件</option>';}
    if(event.target.name==='cloud-file'){const file=inspection?.files.find(f=>f.id===event.target.value);if(file)$('[name=cloud-path]').value='incoming/'+file.name;}
    if(event.target.name==='dataset-machine'){reset(false);$('#cloud-import-list')?.replaceChildren();report('已切换服务器。点击刷新查看导入任务。');}
    if((event.target.name==='cloud-source'||event.target.name==='dataset-machine')&&$('[name=cloud-source]')?.value==='aliyun'&&!capabilities.has(scope()))run(shareInfo);
    controls();
  });
  section.addEventListener('submit',event=>{
    if(event.target.dataset.importReplace){event.preventDefault();return run(async call=>{const args={machine:machine(),operationId:event.target.dataset.importReplace,url:checkedImportURL(event.target.elements['cloud-resume-url'].value.trim())};await call('cloud.import.resume',args);report('已请求用新链接继续同一任务；仍保存到原位置。');await list(call);});}
    if(event.target.id!=='cloud-import-form')return;event.preventDefault();run(async call=>{
      if(pending.has(scope())){await start(call,pending.get(scope()));return;}
      const area=$('[name=cloud-target-area]').value,name=$('[name=cloud-target-name]').value.trim(),ownerId=$('[name=cloud-target-owner]').value.trim();const args={machine:machine(),area,...(area==='dataset'?{dataset:name}:{project:name,...(ownerId?{ownerId}:{})}),key:crypto.randomUUID(),path:$('[name=cloud-path]').value.trim()};
      if($('[name=cloud-source]').value==='aliyun'){if(!inspection)throw Error('请先读取分享文件。');args.inspectionId=inspection.inspectionId;args.fileId=$('[name=cloud-file]').value;if(!args.fileId)throw Error('请选择分享文件。');}
      else{args.url=checkedImportURL($('[name=cloud-url]').value.trim());}
      await start(call,{args:Object.freeze(args),uncertain:false});
    });
  });
  section.addEventListener('click',event=>{const b=event.target.closest('button');if(!b||b.disabled)return;
    if(b.id==='cloud-inspect')return run(async call=>{inspection=await call('cloud.inspect',{machine:machine(),url:$('[name=cloud-url]').value.trim(),password:$('[name=cloud-password]').value.trim()});$('[name=cloud-file]').innerHTML=inspection.files.map(f=>`<option value="${esc(f.id)}">${esc(f.name)} · ${size(f.size)}</option>`).join('');if(inspection.files[0])$('[name=cloud-path]').value='incoming/'+inspection.files[0].name;report(inspection.files.length?'选择文件，然后开始导入。':'没有可导入的文件。请将数据压缩后，直接分享压缩包。');});
    if(b.id==='cloud-share-refresh')return run(shareInfo);
    if(b.id==='cloud-import-refresh')return run(async call=>{if($('[name=cloud-source]').value==='aliyun'){try{await shareInfo(call);}catch(error){report(error.message);toast(error.message);}}await list(call);});
    if(b.id==='cloud-import-retry')return run(async call=>{const held=pending.get(scope());if(!held)return;try{const result=await call('cloud.import.status',{machine:machine(),operationId:held.args.key});if(result?.state&&result.state!=='UNKNOWN')pending.delete(scope());report(labels[result?.state]||'状态未知，请按原编号查询。');await list(call);return;}catch(error){if(error.status!==404)throw error;}await start(call,held);});
    if(b.dataset.importResume)return run(async call=>{await call('cloud.import.resume',{machine:machine(),operationId:b.dataset.importResume});report('已请求继续；后台会从断点继续。');await list(call);});
    if(b.dataset.importCancel)return run(async call=>{const result=await call('cloud.import.cancel',{machine:machine(),operationId:b.dataset.importCancel});report(result.state==='CANCELING'?'正在取消，临时文件仍保留；请等待状态变为“已取消”。':'已请求取消；临时文件仍保留，请刷新确认状态。');await list(call);});
    if(b.dataset.importDiscard)return run(async call=>{const args={machine:machine(),operationId:b.dataset.importDiscard};await call('cloud.import.discard',args);report('已删除，7 天内可在回收站恢复。');await list(call);});
  });
  return {reset,controls};
}
