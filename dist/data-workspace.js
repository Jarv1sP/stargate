import {uploadPersonalFile} from './personal-upload.js';
import {maintenanceFor,restoreMaintenanceControls,disableMaintenanceControls} from './maintenance-state.js';
// Editable personal data is deliberately separate from verified training data.
// Raw uploads never unpack or publish a dataset automatically.
import {CHUNK_BYTES,LARGE_RELAY_BYTES,hashBlob} from './dataset-upload.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const bytesLabel=value=>{const size=value;if(!Number.isFinite(size)||size<0)return '未知';return size<1024**2?(size/1024).toFixed(1)+' KiB':size<1024**3?(size/1024**2).toFixed(1)+' MiB':(size/1024**3).toFixed(2)+' GiB';};
export function workspacePath(value,{root=false}={}){
  if(root&&value==='.')return value;
  if(typeof value!=='string'||!value||new TextEncoder().encode(value).length>1024||/[\\\x00-\x1f\x7f]/.test(value)||value.split('/').some(bit=>!bit||bit==='.'||bit==='..'||new TextEncoder().encode(bit).length>255))throw Error('请填写 /data/mine 内的相对路径：不含开头斜杠或 ..，总长不超过 1024 字节、每段不超过 255 字节。');
  return value;
}
const alive=signal=>{if(signal?.aborted)throw Error('操作已停止。服务器已收到的文件片段会保留；重新上传前请确认是否覆盖。');};
function base64(bytes){let text='';for(let offset=0;offset<bytes.length;offset+=8192)text+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(text);}
export async function uploadWorkspaceFiles({files,directory='incoming',machine,overwrite=false,signal,call,onProgress=()=>{},allowRelay=false}){
  const selected=Array.from(files||[]),paths=new Set();if(!selected.length)throw Error('请先选择压缩包或文件。');
  const prefix=workspacePath(directory,{root:true}),totalBytes=selected.reduce((sum,file)=>sum+file.size,0);let completed=0;
  for(const file of selected){const name=workspacePath(file.name);if(name.includes('/')||paths.has(name))throw Error('文件名称重复或无效：'+name);paths.add(name);workspacePath(prefix==='.'?name:prefix+'/'+name);if(!Number.isSafeInteger(file.size)||file.size<0)throw Error('文件大小无效。');}
  if(totalBytes>LARGE_RELAY_BYTES&&allowRelay!==true)throw Error('超过 256 MiB 的文件上传需要确认 VPS 中转；也可改用下载链接让服务器直接下载。');
  for(const file of selected){
    const path=prefix==='.'?file.name:prefix+'/'+file.name;
    const sha256=await hashBlob(file,{signal});
    await uploadPersonalFile({machine,path,size:file.size,sha256,overwrite,signal,call,
      read:async(offset,length)=>new Uint8Array(await file.slice(offset,offset+length).arrayBuffer()),
      onProgress:row=>onProgress({path,bytes:completed+row.receivedBytes,totalBytes,key:row.key,state:row.state})});
    completed+=file.size;
  }
  return {files:selected.length,bytes:completed};
}
export function workspaceEntriesHTML(result){
  const parent=result?.path||'.';
  return (result?.entries||[]).map(entry=>{
    const path=parent==='.'?entry.name:parent+'/'+entry.name;
    return `<li><span>${entry.type==='directory'?'目录':entry.type==='file'?'文件':'不可下载'}</span><code title="${esc(entry.name)}">${esc(entry.name)}</code><small>${entry.type==='directory'?'':esc(bytesLabel(entry.size))}</small>${entry.type==='directory'?`<button class="button" type="button" data-workspace-path="${esc(path)}">打开</button>`:entry.type==='file'?`<button class="button" type="button" data-workspace-download="${esc(path)}">下载</button>`:''}</li>`;
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
export function dataWorkspaceHTML(){
  return `<section class="data-workspace-card" aria-labelledby="data-workspace-heading">
    <header><div><p class="data-workspace-eyebrow">在服务器上整理</p><h3 id="data-workspace-heading">个人数据目录</h3></div><span class="data-workspace-badge">不占用 GPU</span></header>
    <p class="muted">这里只有你在所选服务器上的文件。上传压缩包后，可在终端手动解压；不会自动解压或跨机同步。</p>
    <ol class="data-workspace-steps"><li>上传文件</li><li>终端整理</li><li>直接使用</li></ol>
    <form id="data-workspace-upload-form">
      <aside class="dataset-route" aria-label="个人数据上传通道"><div class="dataset-route-heading"><span class="dataset-route-label">经门户中转</span><span class="dataset-route-path"><span>你的电脑</span><i aria-hidden="true">→</i><span>平台中转</span><i aria-hidden="true">→</i><span>在服务器上整理</span></span></div><p>这里上传的文件经过平台中转。大文件可改用“下载链接”，由服务器直接下载。</p></aside>
      <div class="data-workspace-fields"><label class="field">压缩包或文件<input name="data-workspace-files" type="file" multiple required><small>支持断点续传；不会自动解压。</small></label><label class="field">保存目录<input name="data-workspace-upload-path" value="incoming" placeholder="incoming" required><small>相对 /data/mine 的路径；缺少的目录会自动创建。</small></label></div>
      <label class="data-workspace-overwrite"><input type="checkbox" name="data-workspace-overwrite">覆盖所选文件在此目录里的同名文件</label>
      <div id="data-workspace-relay-warning" class="dataset-relay-warning" hidden><label><input type="checkbox" name="data-workspace-relay-consent"><span>我确认通过 VPS 中转上传这 <strong id="data-workspace-relay-size"></strong> 文件</span></label><p>所选文件合计超过 256 MiB；中转带宽由所有用户共享，速度可能较慢。</p></div>
      <div class="file-actions"><button class="button" id="data-workspace-upload" type="submit">上传到数据空间</button><button class="button" id="data-workspace-cancel" type="button" hidden>停止传输</button></div>
      <progress id="data-workspace-progress" hidden aria-label="个人数据上传进度"></progress>
    </form>
    <div class="data-workspace-terminal"><div><h4>手动整理</h4><p class="muted">终端中的 <code>/data/mine</code> 就是这里。用 <code>tar</code>、<code>unzip</code> 等命令处理文件。</p></div><div class="file-actions"><button class="button" id="terminal-data-open" type="button">新建数据终端</button><button class="button quiet" id="terminal-data-reconnect" type="button">重连</button></div></div>
    <details class="data-workspace-browser"><summary>查看文件</summary><div class="data-workspace-browse-controls"><label class="field">目录<input name="data-workspace-browse-path" value="." aria-label="查看数据空间目录"></label><button class="button" id="data-workspace-refresh" type="button">刷新</button></div><ul id="data-workspace-files-list"></ul></details>
    <p id="data-workspace-status" role="status">文件保存后即可在开发和训练容器里读取，无需发布。</p>
    <p class="muted data-workspace-footnote">上传前请确认磁盘容量；停止上传会保留已收到的文件片段。</p>
  </section>`;
}
export function dataWorkspaceUI(store,section,toast,{onBusyChange=()=>{}}={}){
  let epoch=0,working=false,controller=null;
  const element=selector=>section.querySelector(selector);
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
    disableMaintenanceControls(card,'#data-workspace-upload,#terminal-data-open,#terminal-data-reconnect,#cloud-files-form [type=submit],[data-cloud-verify],[data-cloud-restore]',maintenanceFor(store.data?.operationalMaintenance,machine()));
    const stop=element('#data-workspace-cancel');if(stop){stop.hidden=!controller;stop.disabled=!controller;}
  }
  function reset(){epoch++;controller?.abort();controller=null;working=false;element('#data-workspace-files-list')?.replaceChildren();relayChoice(true);onBusyChange();}
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
    report('个人目录已刷新，可在 /data/mine 直接读写。');
  }
  section.addEventListener('submit',event=>{
    if(event.target.id!=='data-workspace-upload-form')return;event.preventDefault();
    const form=event.target;
    if(form.id==='data-workspace-upload-form')return run(async({call,report,machine,check})=>{
      const files=Array.from(form.elements['data-workspace-files'].files||[]),directory=workspacePath(form.elements['data-workspace-upload-path'].value.trim(),{root:true}),overwrite=form.elements['data-workspace-overwrite'].checked;
      const allowRelay=form.elements['data-workspace-relay-consent'].checked===true;
      if(files.reduce((sum,file)=>sum+file.size,0)>LARGE_RELAY_BYTES&&!allowRelay)throw Error('请先确认 VPS 中转上传，或改用下载链接导入。');
      if(overwrite&&!window.confirm('覆盖所选文件在目标目录里的同名文件？它们的旧内容将被替换，不能撤销。'))return;
      controller=new AbortController();controls();const progress=element('#data-workspace-progress');progress.hidden=false;progress.value=0;
      const result=await uploadWorkspaceFiles({files,directory,machine,overwrite,allowRelay,signal:controller.signal,call,onProgress:value=>{check();report('正在上传 '+value.path+' · '+bytesLabel(value.bytes)+' / '+bytesLabel(value.totalBytes));progress.max=Math.max(1,value.totalBytes);progress.value=value.totalBytes?value.bytes:1;}});
      check();report(`已上传 ${result.files} 个文件。打开数据终端手动解压、整理后直接使用。`);progress.value=progress.max=1;toast('文件已保存到在服务器上整理。');
    });
  });
  section.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.id==='data-workspace-cancel'){controller?.abort();return;}
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
  });
  section.addEventListener('change',event=>{if(event.target.name==='data-workspace-files')relayChoice(true);});
  return {get busy(){return working;},controls,reset};
}
