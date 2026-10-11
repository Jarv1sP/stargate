import {maintenanceFor,restoreMaintenanceControls,disableMaintenanceControls} from './maintenance-state.js';
// Editable personal data is deliberately separate from verified training data.
// Raw uploads never unpack or publish a dataset automatically.
import {CHUNK_BYTES,LARGE_RELAY_BYTES} from './dataset-upload.js';
import {cloudFilesHTML,cloudFilesUI} from './cloud-files-ui.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const bytesLabel=value=>{const size=value;if(!Number.isFinite(size)||size<0)return '未知';return size<1024**2?(size/1024).toFixed(1)+' KiB':size<1024**3?(size/1024**2).toFixed(1)+' MiB':(size/1024**3).toFixed(2)+' GiB';};
export function workspacePath(value,{root=false}={}){
  if(root&&value==='.')return value;
  if(typeof value!=='string'||!value||new TextEncoder().encode(value).length>1024||/[\\\x00-\x1f\x7f]/.test(value)||value.split('/').some(bit=>!bit||bit==='.'||bit==='..'||new TextEncoder().encode(bit).length>255))throw Error('请填写 /data2 内的相对路径：不含开头斜杠或 ..，总长不超过 1024 字节、每段不超过 255 字节。');
  return value;
}
const alive=signal=>{if(signal?.aborted)throw Error('操作已停止。服务器已收到的文件片段会保留；重新上传前请确认是否覆盖。');};
function base64(bytes){let text='';for(let offset=0;offset<bytes.length;offset+=8192)text+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(text);}
export async function uploadWorkspaceFiles({files,directory='incoming',machine,overwrite=false,signal,call,onProgress=()=>{},allowRelay=false}){
  const selected=Array.from(files||[]),paths=new Set();if(!selected.length)throw Error('请先选择压缩包或文件。');
  const prefix=workspacePath(directory,{root:true}),totalBytes=selected.reduce((sum,file)=>sum+file.size,0);let completed=0;
  for(const file of selected){const name=workspacePath(file.name);if(name.includes('/')||paths.has(name))throw Error('文件名称重复或无效：'+name);paths.add(name);workspacePath(prefix==='.'?name:prefix+'/'+name);if(!Number.isSafeInteger(file.size)||file.size<0)throw Error('文件大小无效。');if(file.size>100*1024**3)throw Error('单个文件最多上传 100 GiB；更大文件请联系管理员线下导入。');}
  if(totalBytes>LARGE_RELAY_BYTES&&allowRelay!==true)throw Error('超过 256 MiB 的文件上传需要确认 VPS 中转；也可改用下载链接让服务器直接下载。');
  for(const file of selected){
    const path=prefix==='.'?file.name:prefix+'/'+file.name;let offset=0;
    do{
      alive(signal);const bytes=new Uint8Array(await file.slice(offset,offset+CHUNK_BYTES).arrayBuffer());alive(signal);
      if(bytes.length!==Math.min(CHUNK_BYTES,file.size-offset))throw Error('文件读取不完整；已停止上传。');
      // No automatic retry: a lost response may follow a durable write.
      const result=await call('datasets.workspace.put',{machine,path,offset,data:base64(bytes),truncate:offset===0&&overwrite});alive(signal);
      if(result.path!==path||result.size!==offset+bytes.length)throw Error('服务器没有确认这段文件的写入结果；请刷新检查，不会自动重复上传。');
      offset=result.size;onProgress({path,bytes:completed+offset,totalBytes});
    }while(offset<file.size);
    completed+=file.size;
  }
  return {files:selected.length,bytes:completed};
}
export function workspaceEntriesHTML(result){
  const parent=result?.path||'.';
  return (result?.entries||[]).map(entry=>{
    const path=parent==='.'?entry.name:parent+'/'+entry.name;
    return `<li><span>${entry.type==='directory'?'目录':entry.type==='file'?'文件':'不可下载'}</span><code title="${esc(entry.name)}">${esc(entry.name)}</code><small>${entry.type==='directory'?'':esc(bytesLabel(entry.size))}</small>${entry.type==='directory'?`<button class="button" type="button" data-workspace-path="${esc(path)}">打开</button>`:entry.type==='file'?`<button class="button" type="button" data-workspace-download="${esc(path)}">下载</button>`:''}${result.cleanupProtocol===1&&['file','directory'].includes(entry.type)?`<button class="button danger" type="button" data-workspace-remove="${esc(path)}" data-recursive="${entry.type==='directory'}">删除</button>`:''}</li>`;
  }).join('')||'<li class="data-workspace-empty">此目录为空。可上传文件，或在数据终端里创建目录。</li>';
}
export const WORKSPACE_DOWNLOAD_MEMORY_BYTES=100*1024**2;
export async function downloadWorkspaceFile({machine,path,call,write,signal,onProgress=()=>{},limitBytes=Infinity}){
  workspacePath(path);let offset=0,size=null;
  const check=()=>{if(signal?.aborted)throw Error('下载已停止。');};
  do{
    check();const result=await call('datasets.workspace.get',{machine,path,offset});check();
    if(result?.path!==path||result.offset!==offset||!Number.isSafeInteger(result.size)||result.size<0||size!==null&&result.size!==size||typeof result.eof!=='boolean')throw Error('文件读取结果不一致，请刷新后重新下载。');
    size=result.size;if(size>limitBytes)throw Error('此浏览器只能下载 100 MiB 以内的文件；大文件请换用支持直接保存文件的桌面浏览器。');
    if(typeof result.data!=='string'||result.data.length>Math.ceil(CHUNK_BYTES/3)*4||result.data.length%4||! /^[A-Za-z0-9+/]*={0,2}$/.test(result.data))throw Error('文件片段无效，下载已停止。');
    const bytes=Uint8Array.from(atob(result.data),char=>char.charCodeAt(0));
    if(bytes.length!==Math.min(CHUNK_BYTES,size-offset)||result.eof!==(offset+bytes.length===size))throw Error('文件片段不完整，下载已停止。');
    check();await write(bytes);check();offset+=bytes.length;onProgress({bytes:offset,totalBytes:size});
    if(result.eof)return {path,bytes:offset};
  }while(true);
}
export function workspaceRegistrationsHTML(result){
  if(!Array.isArray(result?.datasets))throw Error('空登记暂未确认，请重新查询。');
  return result.datasets.filter(row=>typeof row.dataset==='string'&&Array.isArray(row.versions)&&row.versions.length===0).map(row=>`<li><code title="${esc(row.dataset)}">${esc(row.name||row.dataset)}</code><span>没有登记版本</span></li>`).join('')||'<li>没有空登记。</li>';
}
export function publicationText(status){
  const phases={SCANNING:'扫描文件',REGISTERING:'登记数据集',REGISTERED:'登记完成',ARCHIVE_INTENT:'保存到仓库',MATERIALIZING:'复制与校验',COMPLETED:'完成'};
  const phase=typeof status.phase==='string'&&status.phase?phases[status.phase]||status.phase:'';
  if(status.state==='READY')return `已发布：${status.dataset}@${status.version}。可在数据集目录选择用于训练。`;
  if(status.state==='FAILED')return `发布失败${phase?' · '+phase:''}：`+(status.error||'请检查目录后重试。');
  if(status.state==='UNKNOWN')return '发布结果尚未确认，数据空间暂不可编辑。请联系管理员检查后台发布进程；不要重复发布。';
  if(status.state==='NOT_READY')return '这次发布的服务器缓存已不再就绪。原始数据仍保留，可从个人整理目录重新发布子目录。';
  if(status.state==='UNREGISTERED')return '这次发布的数据集登记已删除。原始数据仍保留，可从个人整理目录重新发布子目录。';
  if(status.state==='UNAVAILABLE')return '当前账号已无权使用这次发布的数据集。请联系管理员确认授权；原始个人目录不受影响。';
  if(status.state==='PUBLISHING'&&phase)return '发布中 · '+phase;
  return '服务器正在扫描、复制并校验文件；可离开页面，后台会继续。';
}
export function dataWorkspaceHTML(){
  return `<section class="data-workspace-card" aria-labelledby="data-workspace-heading">
    <header><div><p class="data-workspace-eyebrow">在服务器上整理</p><h3 id="data-workspace-heading">在 /data2 整理，再发布</h3></div><span class="data-workspace-badge">不占用 GPU</span></header>
    <p class="muted">这里只有你在所选服务器上的文件。上传压缩包后，可在终端手动解压；不会自动解压或跨机同步。</p>
    <ol class="data-workspace-steps"><li>上传文件</li><li>终端整理</li><li>发布数据集</li></ol>
    <form id="data-workspace-upload-form">
      <aside class="dataset-route" aria-label="个人数据上传通道"><div class="dataset-route-heading"><span class="dataset-route-label">经门户中转</span><span class="dataset-route-path"><span>你的电脑</span><i aria-hidden="true">→</i><span>平台中转</span><i aria-hidden="true">→</i><span>在服务器上整理</span></span></div><p>这里上传的文件经过平台中转。大文件可改用“下载链接”，由服务器直接下载。</p></aside>
      <div class="data-workspace-fields"><label class="field">压缩包或文件<input name="data-workspace-files" type="file" multiple required><small>单个文件最多 100 GiB；不会自动解压。</small></label><label class="field">保存目录<input name="data-workspace-upload-path" value="incoming" placeholder="incoming" required><small>相对 /data2 的路径；缺少的目录会自动创建。</small></label></div>
      <label class="data-workspace-overwrite"><input type="checkbox" name="data-workspace-overwrite">覆盖所选文件在此目录里的同名文件</label>
      <div id="data-workspace-relay-warning" class="dataset-relay-warning" hidden><label><input type="checkbox" name="data-workspace-relay-consent"><span>我确认通过 VPS 中转上传这 <strong id="data-workspace-relay-size"></strong> 文件</span></label><p>所选文件合计超过 256 MiB；中转带宽由所有用户共享，速度可能较慢。</p></div>
      <div class="file-actions"><button class="button" id="data-workspace-upload" type="submit">上传到数据空间</button><button class="button" id="data-workspace-cancel" type="button" hidden>停止传输</button></div>
      <progress id="data-workspace-progress" hidden aria-label="个人数据上传进度"></progress>
    </form>
    <div class="data-workspace-terminal"><div><h4>手动整理</h4><p class="muted">终端中的 <code>/data2</code> 就是这里。用 <code>tar</code>、<code>unzip</code> 等命令处理文件。</p></div><div class="file-actions"><button class="button" id="terminal-data-open" type="button">新建数据终端</button><button class="button quiet" id="terminal-data-reconnect" type="button">重连</button></div></div>
    <details class="data-workspace-browser"><summary>查看文件与发布进度</summary><div class="data-workspace-browse-controls"><label class="field">目录<input name="data-workspace-browse-path" value="." aria-label="查看数据空间目录"></label><button class="button" id="data-workspace-refresh" type="button">刷新</button></div><ul id="data-workspace-files-list"></ul><details id="data-workspace-registrations"><summary>空登记</summary><button class="button" id="data-workspace-registrations-refresh" type="button">重新查询</button><ul id="data-workspace-registrations-list" aria-live="polite"></ul></details></details>
    <form id="data-workspace-publish-form"><h4>发布为训练数据集</h4><p class="muted">先结束此机器上的所有数据终端，再发布整理好的子目录。发布会复制并校验文件，训练使用只读版本；原目录保留。</p><div class="data-workspace-fields"><label class="field">整理好的子目录<input name="data-workspace-publish-path" placeholder="my-data" required><small>例如 /data2/my-data，填写 my-data。</small></label><label class="field">数据集名称<input name="data-workspace-name" placeholder="my-data" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{0,39}" required></label></div><div class="file-actions"><button class="button primary" id="data-workspace-publish" type="submit">校验并发布</button></div></form>
    ${cloudFilesHTML()}
    <p id="data-workspace-status" role="status">上传只保存文件；数据整理完成后再发布。</p>
    <button class="button quiet" id="data-workspace-cleanup-status" type="button" hidden>查询上次清理</button>
    <button class="button danger" id="data-workspace-cleanup-retry" type="button" hidden>继续原清理</button>
    <p class="muted data-workspace-footnote">上传前请确认磁盘容量；停止上传会保留已收到的文件片段。</p>
  </section>`;
}
export function dataWorkspaceUI(store,section,toast,{onBusyChange=()=>{},refreshCatalog=()=>{}}={}){
  const cloud=cloudFilesUI(store,section,toast);
  let epoch=0,working=false,controller=null;
  const element=selector=>section.querySelector(selector);
  const cleanupStorageKey=()=>`stargate.workspace-cleanup.v1:${store.principal?.userId||''}:${machine()}`;
  function cleanupRecord(){try{const value=JSON.parse(localStorage.getItem(cleanupStorageKey())||'null');return value?.userId===store.principal?.userId&&value.machine===machine()&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.key||'')?value:null;}catch{return null;}}
  function saveCleanup(value){localStorage.setItem(cleanupStorageKey(),JSON.stringify(value));}
  function cleanupText(result){return `清理 ${result.path} · ${({QUEUED:'已排队',RUNNING:'处理中',FAILED:'失败',SUCCEEDED:'已完成'})[result.state]||'状态未确认'} · ${result.key}${result.error?' · '+result.error:''}`;}
  function confirmCleanup(result,request){if(result?.protocol!==1||result.key!==request.key||result.path!==request.path||result.recursive!==request.recursive||!['QUEUED','RUNNING','FAILED','SUCCEEDED','UNKNOWN'].includes(result.state))throw Error('清理结果未确认，请查询原编号。');return result;}
  const machine=()=>element('[name=dataset-machine]')?.value;
  const context=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration,machine(),epoch]);
  const valid=expected=>expected===context();
  function relayChoice(reset=false){
    const input=element('[name=data-workspace-files]'),warning=element('#data-workspace-relay-warning'),consent=element('[name=data-workspace-relay-consent]');if(!input||!warning||!consent)return;
    const total=Array.from(input.files||[]).reduce((sum,file)=>sum+file.size,0);warning.hidden=total<=LARGE_RELAY_BYTES;
    element('#data-workspace-relay-size').textContent=bytesLabel(total);if(reset)consent.checked=false;
  }
  function controls(){
    const card=section.querySelector('.data-workspace-card:not(.cloud-import)');if(!card)return;restoreMaintenanceControls(card);relayChoice();
    const enabled=store.production&&store.principal&&machine(),external=element('#dataset-upload-pause')?.hidden===false;
    for(const node of section.querySelectorAll('.data-workspace-card input,.data-workspace-card button'))node.disabled=!enabled||working||external;
    disableMaintenanceControls(card,'#data-workspace-upload,#data-workspace-publish,#terminal-data-open,#terminal-data-reconnect,#cloud-files-form [type=submit],[data-cloud-verify],[data-cloud-restore],[data-workspace-remove],#data-workspace-cleanup-retry',maintenanceFor(store.data?.operationalMaintenance,machine()));
    const stop=element('#data-workspace-cancel');if(stop){stop.hidden=!controller;stop.disabled=!controller;}
    const cleanup=element('#data-workspace-cleanup-status');if(cleanup)cleanup.hidden=!cleanupRecord();
    const retry=element('#data-workspace-cleanup-retry');if(retry)retry.hidden=cleanupRecord()?.retryable!==true;
    cloud.controls(working||external);
  }
  function reset(){epoch++;controller?.abort();controller=null;working=false;element('#data-workspace-files-list')?.replaceChildren();element('#data-workspace-registrations-list')?.replaceChildren();cloud.reset();relayChoice(true);onBusyChange();}
  async function run(action){
    if(working||!store.production||!store.principal||!machine())return;
    const expected=context();working=true;onBusyChange();controls();
    const check=()=>{if(!valid(expected))throw Error('账号或服务器已改变；旧操作已停止。');};
    const call=async(operation,args)=>{check();const result=await store.call(operation,args);check();return result;};
    const report=message=>{check();element('#data-workspace-status').textContent=message;};
    try{await action({expected,check,call,report,machine:machine()});}
    catch(error){if(valid(expected)){element('#data-workspace-status').textContent=error.message;toast(error.message);}}
    finally{if(valid(expected)){working=false;controller=null;onBusyChange();controls();}}
  }
  async function refresh({call,report,machine,check}){
    const path=workspacePath(element('[name=data-workspace-browse-path]').value.trim(),{root:true});
    const listing=await call('datasets.workspace.list',{machine,path});element('#data-workspace-files-list').innerHTML=workspaceEntriesHTML(listing);
    const status=await call('datasets.workspace.status',{machine});
    if(status.operationId||status.state!=='EDITABLE')report(publicationText(status));
    else report('个人目录已刷新。这里的文件可编辑，已发布的数据集不会随之改变。');
    if(status.state==='READY')await refreshCatalog();
    if(element('#data-workspace-registrations').open)await registrations({call,machine,check});
  }
  async function registrations({call,machine,check}){
    const root=element('#data-workspace-registrations-list');root.textContent='查询中';
    try{root.innerHTML=workspaceRegistrationsHTML(await call('datasets.list',{machine,includeEmpty:true}));}
    catch(error){check();root.textContent='空登记暂未确认';throw error;}
  }
  section.addEventListener('submit',event=>{
    if(!['data-workspace-upload-form','data-workspace-publish-form'].includes(event.target.id))return;event.preventDefault();
    const form=event.target;
    if(form.id==='data-workspace-upload-form')return run(async({call,report,machine,check})=>{
      const files=Array.from(form.elements['data-workspace-files'].files||[]),directory=workspacePath(form.elements['data-workspace-upload-path'].value.trim(),{root:true}),overwrite=form.elements['data-workspace-overwrite'].checked;
      const allowRelay=form.elements['data-workspace-relay-consent'].checked===true;
      if(files.reduce((sum,file)=>sum+file.size,0)>LARGE_RELAY_BYTES&&!allowRelay)throw Error('请先确认 VPS 中转上传，或改用下载链接导入。');
      if(overwrite&&!window.confirm('覆盖所选文件在目标目录里的同名文件？它们的旧内容将被替换，不能撤销。'))return;
      controller=new AbortController();controls();const progress=element('#data-workspace-progress');progress.hidden=false;progress.value=0;
      const result=await uploadWorkspaceFiles({files,directory,machine,overwrite,allowRelay,signal:controller.signal,call,onProgress:value=>{check();report('正在上传 '+value.path+' · '+bytesLabel(value.bytes)+' / '+bytesLabel(value.totalBytes));progress.max=Math.max(1,value.totalBytes);progress.value=value.totalBytes?value.bytes:1;}});
      check();report(`已上传 ${result.files} 个文件。打开数据终端手动解压、整理后，再发布子目录。`);progress.value=progress.max=1;toast('文件已保存到在服务器上整理。');
    });
    return run(async({call,report,machine,check})=>{
      const path=workspacePath(form.elements['data-workspace-publish-path'].value.trim()),name=form.elements['data-workspace-name'].value.trim();
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name))throw Error('名称需为 1–40 位字母、数字、下划线或连字符。');
      let result=await call('datasets.workspace.publish',{machine,path,name,key:crypto.randomUUID()});
      if(!result.operationId)throw Error('发布编号未确认。请用“刷新”查询后台状态，不要重复提交。');
      report(publicationText(result));
      // Six minutes of foreground progress, then require an explicit refresh.
      for(let count=0;result.state==='PUBLISHING'&&count<240;count++){await new Promise(resolve=>setTimeout(resolve,1500));check();result=await call('datasets.workspace.status',{machine,operationId:result.operationId});report(publicationText(result));}
      if(result.state==='READY'){toast('数据集已发布，可用于训练。');await refreshCatalog();}
      else if(result.state==='PUBLISHING')report('发布仍在后台进行。稍后点击“刷新”查看结果，不要重复提交。');
    });
  });
  section.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.id==='data-workspace-cancel'){controller?.abort();return;}
    if(button.id==='data-workspace-cleanup-status')return run(async({call,report,machine,check})=>{
      const request=cleanupRecord();if(!request)throw Error('当前账号没有保存的清理编号。');
      const result=confirmCleanup(await call('datasets.workspace.remove-status',{machine,key:request.key}),request);check();
      saveCleanup({...request,state:result.state,retryable:result.retryable===true});report(cleanupText(result));
    });
    if(button.id==='data-workspace-cleanup-retry')return run(async({call,report,machine,check})=>{
      const request=cleanupRecord();if(!request)throw Error('当前账号没有保存的清理编号。');
      const state=confirmCleanup(await call('datasets.workspace.remove-status',{machine,key:request.key}),request);check();
      if(state.retryable!==true)throw Error('原清理尚未确认可继续，请稍后查询。');
      if(!window.confirm('继续原清理 '+request.path+'？只处理原编号绑定的内容。'))return;
      check();saveCleanup({...request,state:'UNKNOWN',retryable:false});
      const result=confirmCleanup(await call('datasets.workspace.remove',{machine,key:request.key,path:request.path,recursive:request.recursive}),request);check();
      saveCleanup({...request,state:result.state,retryable:false});report(cleanupText(result));
    });
    if(button.hasAttribute('data-workspace-remove'))return run(async({call,report,machine,check})=>{
      const path=workspacePath(button.dataset.workspaceRemove),recursive=button.dataset.recursive==='true',previous=cleanupRecord();
      if(previous&&!['SUCCEEDED','FAILED'].includes(previous.state))throw Error('上次清理尚未确认完成，请先查询原编号。');
      const plan=await call('datasets.workspace.remove-plan',{machine,path,recursive});check();
      if(plan?.protocol!==1||plan.path!==path||plan.recursive!==recursive||plan.state!=='PREVIEW')throw Error('清理预览未确认。');
      if(!window.confirm(`永久删除 ${machine} 上本人数据目录中的 ${path}？${recursive?'包含全部子目录和文件。':''}此卷可用 ${bytesLabel(plan.volume?.availableBytes)}；实际释放量以清理后读数为准。无法通过回收站撤销。`))return;
      check();const key=previous?.state==='FAILED'&&previous.path===path&&previous.recursive===recursive?previous.key:crypto.randomUUID();
      const request={machine,path,recursive,key,userId:store.principal.userId,state:'UNKNOWN'};saveCleanup(request);
      report('清理编号：'+key+'；回包丢失后请查询此编号。');
      const result=confirmCleanup(await call('datasets.workspace.remove',{machine,path,recursive,key}),request);check();
      saveCleanup({...request,state:result.state});report(cleanupText(result));
    });
    if(button.hasAttribute('data-workspace-download'))return run(async({call,report,machine,check})=>{
      const path=workspacePath(button.dataset.workspaceDownload);controller=new AbortController();controls();let writer=null;const chunks=[];
      try{
        if(typeof window.showSaveFilePicker==='function'){
          const handle=await window.showSaveFilePicker({suggestedName:path.split('/').pop()});check();if(controller.signal.aborted)return;
          writer=await handle.createWritable();check();
        }
        report('正在下载 '+path);
        const result=await downloadWorkspaceFile({machine,path,call,signal:controller.signal,limitBytes:writer?Infinity:WORKSPACE_DOWNLOAD_MEMORY_BYTES,
          write:bytes=>writer?writer.write(bytes):chunks.push(bytes),onProgress:value=>{check();report('正在下载 '+path+' · '+bytesLabel(value.bytes)+' / '+bytesLabel(value.totalBytes));}});
        check();if(writer){await writer.close();writer=null;check();}else{
          const url=URL.createObjectURL(new Blob(chunks)),link=document.createElement('a');link.href=url;link.download=path.split('/').pop();link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        }
        report('已下载 '+path+' · '+bytesLabel(result.bytes));
      }catch(error){if(error.name==='AbortError'){check();report('已取消下载。');return;}throw error;}
      finally{if(writer)await writer.abort().catch(()=>{});}
    });
    if(button.dataset.workspacePath){element('[name=data-workspace-browse-path]').value=button.dataset.workspacePath;return run(refresh);}
    if(button.id==='data-workspace-refresh')return run(refresh);
    if(button.id==='data-workspace-registrations-refresh')return run(registrations);
  });
  section.addEventListener('toggle',event=>{if(event.target.id==='data-workspace-registrations'&&event.target.open)void run(registrations);},true);
  section.addEventListener('change',event=>{if(event.target.name==='data-workspace-files')relayChoice(true);});
  return {get busy(){return working;},controls,reset};
}
