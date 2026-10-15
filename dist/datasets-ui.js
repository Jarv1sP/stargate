import {uploadBrowserFile} from './personal-upload.js';
import {downloadBrowserPath,filePath} from './file-transfer-ui.js';
import {createTrashUI} from './trash-ui.js';
import {cloudImportHTML,cloudImportUI} from './cloud-import-ui.js';
import {transferBytes} from './data-route.js';
import {copyHelp} from './copy-help-ui.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const directoryBytes=row=>!Number.isFinite(row?.size)?'未知':(row.complete===false?'至少 ':'')+transferBytes(row.size);
export function datasetRows(rows){return rows.map(row=>`<section class="storage-dataset" data-dataset-row="${esc(row.dataset)}"><div class="storage-row-heading"><strong>${esc(row.name||row.dataset)}</strong><span data-directory-size>${directoryBytes(row)}</span></div><p>上传人 ${esc(row.ownerName||row.uploadedBy||'未知')}　修改于 ${esc(row.modifiedAt?new Date(typeof row.modifiedAt==='number'?row.modifiedAt*1000:row.modifiedAt).toLocaleString('zh-CN'):'未知')}</p><div class="file-actions"><button type="button" class="button quiet" data-dataset-open="${esc(row.dataset)}">浏览</button><button type="button" class="button quiet" data-dataset-download="${esc(row.dataset)}">下载</button><button type="button" class="button danger" data-dataset-delete="${esc(row.dataset)}">删除</button></div></section>`).join('');}
export function storageVolumeHTML(kind,row){
  const known=Number.isFinite(row?.usedBytes)&&Number.isFinite(row?.availableBytes)&&Number.isFinite(row?.totalBytes),bytes=n=>!Number.isFinite(n)?'未知':n>=1024**4?(n/1024**4).toFixed(1)+' TiB':n>=1024**3?(n/1024**3).toLocaleString('en-US',{maximumFractionDigits:n>=100*1024**3?0:1})+' GiB':transferBytes(n);
  return `<div class="storage-volume-heading"><h3>${kind==='workspace'?'工作区盘 <small>SSD</small>':'数据集盘 <small>HDD</small>'}</h3><span>${kind==='workspace'?'/workspace':'/datasets'}</span></div><dl class="storage-figures"><div><dt>已用</dt><dd>${bytes(row?.usedBytes)}</dd></div><div><dt>可用</dt><dd>${bytes(row?.availableBytes)}</dd></div><div><dt>总量</dt><dd>${bytes(row?.totalBytes)}</dd></div></dl><div class="storage-bar${known?'':' is-unknown'}" aria-label="${known?'磁盘已用 '+bytes(row.usedBytes):'磁盘容量未知'}">${known?`<i data-fill="${Math.min(100,Math.max(0,row.totalBytes?row.usedBytes/row.totalBytes*100:0))}"></i>`:''}</div>${Number.isFinite(row?.availableBytes)&&row.availableBytes<64*1024**3?'<p class="storage-warning">空间不足</p>':''}`;
}
export function datasetsUI(store,toast){
  const section=document.querySelector('#page-datasets');let identity='',machineIds='',turn=0,operationTurn=0,active=false,busy=false,selected='',path='.',cursor=null,cloud,trash;
  const q=s=>section.querySelector(s),machine=()=>q('[name=dataset-machine]')?.value,scope=()=>({machine:machine(),area:'dataset',dataset:selected});
  const card=id=>[...section.querySelectorAll('[data-storage-machine]')].find(node=>node.dataset.storageMachine===id);
  const status=text=>{q('[data-dataset-status]').textContent=text;};
  const controls=()=>{for(const button of section.querySelectorAll('[data-dataset-open],[data-dataset-download],[data-dataset-delete],[data-storage-upload],[data-storage-trash],[data-storage-project],#dataset-upload-form button,[data-file-path],#dataset-file-up,#dataset-file-more'))button.disabled=busy||!store.principal||!machine();cloud?.controls();trash?.update();};
  async function run(action){if(busy)return;const token=operationTurn;busy=true;controls();try{await action(()=>token===operationTurn);}catch(error){if(token===operationTurn){status(error.message);toast(error.message);}}finally{if(token===operationTurn){busy=false;controls();}}}
  async function loadCard(id){
    const node=card(id),token=turn;if(!node||node.dataset.loading==='true')return;node.dataset.loading='true';
    const current=()=>token===turn&&node.isConnected,find=s=>node.querySelector(s);
    find('[data-storage-refresh]').disabled=true;find('[data-storage-caption]').textContent='读取中…';
    for(const kind of ['workspace','datasets'])find(`[data-volume="${kind}"]`).innerHTML=storageVolumeHTML(kind);
    for(const list of ['projects','datasets'])find(`[data-storage-${list}]`).textContent='读取中…';
    try{
      const result=await store.call('projects.quota',{machine:id});if(!current())return;
      for(const kind of ['workspace','datasets']){const place=find(`[data-volume="${kind}"]`);place.innerHTML=storageVolumeHTML(kind,result.volumes?.find(row=>row.kind===kind));const fill=place.querySelector('[data-fill]');if(fill)fill.style.width=fill.dataset.fill+'%';}
    }catch{if(current())find('[data-storage-caption]').textContent='容量未知，请刷新重试。';}
    if(!current())return;
    await Promise.all([
      (async()=>{const place=find('[data-storage-projects]');try{
        const result=await store.call('projects.list',{machine:id,includeUsage:true});if(!current())return;
        place.innerHTML=(result.projects||[]).map(row=>`<div class="storage-project"><div><strong>${esc(row.displayName||row.name||row.project)}</strong><small>${esc(row.ownerName||row.ownerId||'未知')}</small></div><span>${directoryBytes(row)}</span><button type="button" class="button quiet" data-storage-project="${esc(row.project)}" data-owner-id="${esc(row.ownerId)}">打开</button></div>`).join('')||(result.complete===false?'<p class="storage-empty">项目未知，请刷新重试。</p>':'<p class="storage-empty">还没有项目。</p>');
        if(result.complete===false)place.insertAdjacentHTML('beforeend','<p class="storage-empty">部分目录暂时读不到，列表可能不全。</p>');
      }catch{if(current())place.textContent='项目未知，请刷新重试。';}})(),
      (async()=>{const place=find('[data-storage-datasets]');try{
        const result=await store.call('datasets.list',{machine:id});if(!current())return;
        place.innerHTML=datasetRows(result.datasets||[])||(result.complete===false?'<p class="storage-empty">数据集未知，请刷新重试。</p>':'<p class="storage-empty">还没有数据集，上传文件即可新建。</p>');
        if(result.complete===false)place.insertAdjacentHTML('beforeend','<p class="storage-empty">部分目录暂时读不到，列表可能不全。</p>');
      }catch{if(current())place.textContent='数据集未知，请刷新重试。';}})()
    ]);
    if(current()){node.dataset.loading='false';find('[data-storage-refresh]').disabled=false;if(find('[data-storage-caption]').textContent==='读取中…')find('[data-storage-caption]').textContent='读取于 '+new Date().toLocaleTimeString('zh-CN');controls();}
  }
  function selectMachine(id){if(id!==machine()){q('[name=dataset-machine]').value=id;q('[name=dataset-machine]').dispatchEvent(new Event('change',{bubbles:true}));}}
  function showDataset(dataset){
    const place=card(machine())?.querySelector('[data-storage-datasets]');if(!place)return;
    const row=[...place.querySelectorAll('[data-dataset-row]')].find(node=>node.dataset.datasetRow===dataset);
    if(row)row.querySelector('[data-directory-size]').textContent='未知';
    else{place.querySelector('.storage-empty')?.remove();place.insertAdjacentHTML('beforeend',datasetRows([{dataset,size:null}]));}
    controls();
  }
  async function browse(target='.',next=false){const token=operationTurn;path=target;q('[data-dataset-current]').textContent=selected+' / '+path;q('[data-dataset-files]').hidden=false;if(!next)q('[data-dataset-file-list]').textContent='读取中…';let page;try{page=await store.call('files.list',{...scope(),path,limit:1000,...(next&&cursor?{cursor}:{})});}catch(error){if(token===operationTurn&&!next)q('[data-dataset-file-list]').textContent='文件列表未知，请重试。';throw error;}if(token!==operationTurn)return;cursor=page.hasMore?page.nextCursor:null;const html=(page.entries||[]).filter(row=>['file','directory'].includes(row.type)).map(row=>`<button type="button" class="button quiet" data-file-path="${esc(filePath(path,row.name))}" data-file-type="${row.type}">${row.type==='directory'?'▱':'□'} ${esc(row.name)} ${row.type==='file'?transferBytes(row.size):''}</button>`).join('');if(next)q('[data-dataset-file-list]').insertAdjacentHTML('beforeend',html);else q('[data-dataset-file-list]').innerHTML=html||'<p>空目录。</p>';q('#dataset-file-more').hidden=!cursor;q('[name=upload-dataset]').value=selected;}
  function build(machines){
    cloud?.reset();section.innerHTML=`<header class="storage-heading"><p>项目工作区放在 SSD，数据集放在 HDD。${copyHelp('容量与目录大小','盘容量包含同盘的其他内容。项目大小统计项目目录，不分摊共享容器镜像；读不到的部分标为至少，完全读不到显示未知。删除可能影响正在运行的任务。')}</p></header><nav class="data-room-tabs"><a href="#datasets" aria-current="page">容量与目录</a><a href="#datasets/transfers">传输与导入</a></nav><div class="storage-cards">${machines.map(row=>`<article class="storage-server" data-storage-machine="${esc(row.id)}"><header><div><h3 title="${esc(row.id)}">${esc(row.id)}</h3><span>${esc(row.model)} · ${esc(row.cards)}张</span></div><div class="storage-server-actions"><small data-storage-caption></small><button type="button" class="button" data-storage-refresh>刷新</button><button type="button" class="button" data-storage-trash>回收站</button></div></header><div class="storage-disks"><section><div data-volume="workspace">${storageVolumeHTML('workspace')}</div><h4>项目</h4><div data-storage-projects></div></section><section><div data-volume="datasets">${storageVolumeHTML('datasets')}</div><div class="storage-list-heading"><h4>数据集</h4><button type="button" class="button" data-storage-upload>上传</button></div><div data-storage-datasets data-dataset-list></div></section></div></article>`).join('')}</div><section class="storage-tools"><label>操作服务器<select name="dataset-machine">${machines.map(row=>`<option value="${esc(row.id)}">${esc(row.id)}</option>`).join('')}</select></label><section data-dataset-files hidden><h3 data-dataset-current></h3><button type="button" class="button quiet" id="dataset-file-up">上一级</button><div class="file-actions" data-dataset-file-list></div><button type="button" class="button" id="dataset-file-more" hidden>下一页</button></section><details class="data-workspace-card" id="dataset-upload"><summary>上传到新建或已有数据集</summary><form id="dataset-upload-form"><label>数据集目录名<input name="upload-dataset" required></label><label>目标相对目录<input name="upload-directory" value="."></label><label>选择文件<input name="upload-files" type="file" multiple></label><label>或选择目录<input name="upload-folder" type="file" webkitdirectory multiple></label><label>续传编号（新上传留空）<input name="upload-key"></label><button type="submit" class="button primary">上传 / 续传</button></form></details><p data-dataset-status role="status"></p><details class="storage-import"><summary>云盘与链接导入</summary>${cloudImportHTML(store.principal?.role==='admin',store.users||store.data?.users||[])}</details></section>`;
    trash=createTrashUI({call:(...args)=>store.call(...args),getContext:()=>({owner:store.principal?.userId,machine:machine(),enabled:!!store.principal&&!!machine(),isAdmin:store.principal?.role==='admin'}),changed:(row,result)=>{if(row.kind==='dataset'&&result.state==='RESTORED')showDataset(row.dataset||row.originalPath.split('/').pop());status(result.state==='RESTORED'?'已恢复，点击刷新更新目录大小。':result.state==='PURGED'?'已彻底删除。':'结果未知，请按原编号查询：'+row.key);},toast});q('.storage-tools').append(trash.element);cloud ||= cloudImportUI(store,section,toast);
    q('[name=dataset-machine]').addEventListener('change',()=>{operationTurn++;busy=false;selected='';q('[data-dataset-files]').hidden=true;q('[data-dataset-file-list]').replaceChildren();status('');controls();});
    section.onclick=event=>{const b=event.target.closest('button');if(!b||b.disabled)return;const target=b.closest('[data-storage-machine]')?.dataset.storageMachine;
      if(b.hasAttribute('data-storage-refresh'))return void loadCard(target);
      if(target)selectMachine(target);
      if(b.hasAttribute('data-storage-trash')){trash.element.open=true;trash.element.scrollIntoView({block:'nearest'});return;}
      if(b.hasAttribute('data-storage-upload')){q('#dataset-upload').open=true;q('#dataset-upload').scrollIntoView({block:'nearest'});return;}
      if(b.dataset.storageProject)return document.dispatchEvent(new CustomEvent('gpuq-open-project',{detail:{userId:store.principal.userId,authGeneration:store.authGeneration,machine:target,project:b.dataset.storageProject,ownerId:b.dataset.ownerId}}));
      if(b.dataset.datasetOpen){selected=b.dataset.datasetOpen;return void run(async()=>{await browse();q('[data-dataset-files]').scrollIntoView({block:'nearest'});});}
      if(b.dataset.datasetDownload)return void run(()=>downloadBrowserPath((...args)=>store.call(...args),{machine:machine(),area:'dataset',dataset:b.dataset.datasetDownload},'.',{directory:true,onProgress:row=>status(row.path+' · '+row.offset+' / '+row.size)}));
      if(b.dataset.datasetDelete)return void run(async current=>{const dataset=b.dataset.datasetDelete,cache='dataset-delete:'+store.principal.userId+':'+machine()+':'+dataset,key=sessionStorage.getItem(cache)||crypto.randomUUID();sessionStorage.setItem(cache,key);status('删除编号：'+key);const result=await store.call('datasets.delete',{machine:machine(),dataset,key});if(!current())return;if(result.state==='TRASHED'){sessionStorage.removeItem(cache);b.closest('[data-dataset-row]').remove();if(selected===dataset){selected='';q('[data-dataset-files]').hidden=true;}status('已删除，7 天内可在回收站恢复。');}else status('结果未知，请按原编号查询：'+key);});
      if(b.dataset.filePath)return void run(()=>b.dataset.fileType==='directory'?browse(b.dataset.filePath):downloadBrowserPath((...args)=>store.call(...args),scope(),b.dataset.filePath,{onProgress:row=>status(row.path+' · '+row.offset+' / '+row.size)}));
      if(b.id==='dataset-file-up')return void run(()=>browse(path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.'));
      if(b.id==='dataset-file-more')return void run(()=>browse(path,true));
    };
    q('#dataset-upload-form').addEventListener('submit',event=>{event.preventDefault();void run(async current=>{
      const files=[...q('[name=upload-files]').files,...q('[name=upload-folder]').files].sort((a,b)=>(a.webkitRelativePath||a.name).localeCompare(b.webkitRelativePath||b.name)),dataset=q('[name=upload-dataset]').value.trim(),folder=q('[name=upload-directory]').value.trim()||'.';if(!files.length)throw Error('请选择文件或目录。');
      const key=q('[name=upload-key]').value.trim()||crypto.randomUUID();q('[name=upload-key]').value=key;
      const cache='dataset-upload:'+store.principal.userId+':'+key,keys=JSON.parse(localStorage.getItem(cache)||'{}');
      for(const file of files){const relative=file.webkitRelativePath||file.name,target=folder==='.'?relative:folder+'/'+relative;keys[target]||=files.length===1?key:crypto.randomUUID();localStorage.setItem(cache,JSON.stringify(keys));await uploadBrowserFile(file,{call:(...args)=>store.call(...args),machine:machine(),area:'dataset',dataset,path:target,key:keys[target],overwrite:true,onProgress:row=>{if(current())status(target+' · '+row.offset+' / '+file.size+' · '+key);}});if(!current())return;}
      showDataset(dataset);status('上传完成 · '+key+'；点击刷新更新目录大小。');q('[name=upload-key]').value='';
    });});
  }
  return ()=>{
    const next=JSON.stringify([store.authGeneration,store.principal?.userId]),machines=store.principal?store.data?.machines||[]:[],ids=machines.map(row=>row.id).join(',');
    if(next!==identity||ids!==machineIds||!q('[name=dataset-machine]')){identity=next;machineIds=ids;turn++;operationTurn++;busy=false;active=false;build(machines);}
    const visible=!!store.principal&&!section.hidden;
    if(visible&&!active){active=true;for(const row of machines)void loadCard(row.id);}
    if(!visible&&active){active=false;turn++;for(const node of section.querySelectorAll('[data-storage-machine]'))node.dataset.loading='false';}
    controls();
  };
}
