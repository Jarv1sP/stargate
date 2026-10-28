import {uploadBrowserFile} from './personal-upload.js';
import {downloadBrowserPath,filePath} from './file-transfer-ui.js';
import {createTrashUI} from './trash-ui.js';
import {cloudImportHTML,cloudImportUI} from './cloud-import-ui.js';
import {transferBytes} from './data-route.js';
import {diskLabel,diskMediaLabel} from './disk-media.js';
import {copyHelp} from './copy-help-ui.js';
import {openSheet,closeSheet,confirmSheet} from './sheet-ui.js';
import {usableMachines,projectOwnerText} from './workbench-ui.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=id=>String(id||'').replace(/^amax-/,'');
const bytes=n=>!Number.isFinite(n)?'未知':n>=1024**4?(n/1024**4).toFixed(1)+' TiB':n>=1024**3?(n/1024**3).toLocaleString('en-US',{maximumFractionDigits:n>=100*1024**3?0:1})+' GiB':transferBytes(n);
const when=value=>{if(!value)return '时间未知';const date=new Date(typeof value==='number'?value*1000:value);return Number.isFinite(date.getTime())?date.toLocaleDateString('zh-CN'):'时间未知';};
const statisticsTime=value=>{const age=(Date.now()-Date.parse(value))/60000;return Number.isFinite(age)?`统计于 ${Math.max(0,Math.floor(age))} 分钟前`:'统计时间未知';};
export const directoryBytes=row=>!Number.isFinite(row?.size)?'未知':(row.complete===false?'至少 ':'')+bytes(row.size);
export function datasetRows(rows){return rows.map(row=>`<div class="dr-row dr-ds" data-dataset-row="${esc(row.dataset)}"><div class="dr-main"><div class="dr-t mono">${esc(row.name||row.dataset)}</div><div class="dr-s">${esc(row.ownerName||row.uploadedBy||'上传人未知')} 上传 · ${esc(when(row.modifiedAt))}</div></div><div class="dr-s dr-hide-m" data-directory-size>${directoryBytes(row)}</div><div class="dr-s dr-hide-m mono">共用 · /datasets/${esc(row.dataset)}</div><div class="dr-acts"><button type="button" class="jr-link" data-dataset-open="${esc(row.dataset)}">浏览</button><button type="button" class="jr-link" data-dataset-download="${esc(row.dataset)}">下载</button><button type="button" class="jr-link danger" data-dataset-delete="${esc(row.dataset)}">删除</button></div></div>`).join('');}
// One disk line of a server gauge; unknown capacity stays unknown.
export function gaugeDiskHTML(label,row,{loading=false}={}){
  if(loading)return `<div class="dr-disk">${label} · 读取中<div class="dr-skbar"></div></div>`;
  const known=Number.isFinite(row?.usedBytes)&&Number.isFinite(row?.availableBytes)&&Number.isFinite(row?.totalBytes)&&row.totalBytes>0;
  if(!known)return `<div class="dr-disk unk">${label} · 未知<div class="storage-bar is-unknown"></div></div>`;
  const low=row.availableBytes<64*1024**3,fill=Math.min(100,Math.max(0,row.usedBytes/row.totalBytes*100));
  return `<div class="dr-disk${low?' warn':''}">${label} · 可用 <span class="num">${bytes(row.availableBytes)}</span>${low?' · <span class="storage-warning">空间不足</span>':''}<div class="storage-bar"><i data-fill="${fill}"></i></div></div>`;
}
// Where one disk's used space goes. Parts that can't be read stay unknown;
// "其他" is derived only when every part has a measured size.
const MIX=[['files','项目文件'],['outputs','任务输出'],['environments','容器环境'],['datasets','数据集'],['trash','回收站'],['temporary','传输暂存'],['other','其他']];
const partOf=(rows,complete=true)=>{const known=rows.filter(row=>Number.isFinite(row?.size));return {size:rows.length&&!known.length?null:known.reduce((sum,row)=>sum+row.size,0),complete:complete&&rows.every(row=>Number.isFinite(row?.size)&&row.complete!==false)};};
const area=row=>Number.isFinite(row?.size)?{size:row.size,complete:row.complete!==false}:{size:null,complete:false};
const amount=row=>!Number.isFinite(row?.size)?'未知':(row.complete!==false?'':row.upper?'至多 ':'至少 ')+bytes(row.size);
function storageParts(disk,snapshot,{datasets=false}={}){
  if(!(Number.isFinite(disk?.usedBytes)&&Number.isFinite(disk?.totalBytes)&&disk.totalBytes>0))return null;
  const projects=snapshot?.projects||{},areas=projects.areas||{},parts={
    files:projects.error?area(null):partOf(projects.projects||[],projects.complete!==false),
    outputs:area(areas.outputs),environments:area(areas.environments),
    datasets:!datasets?null:snapshot?.datasets?.error?area(null):partOf(snapshot?.datasets?.datasets||[],snapshot?.datasets?.complete!==false),
    trash:area(areas.trash),temporary:area(areas.temporary)};
  const measured=Object.values(parts).filter(Boolean),sum=measured.reduce((total,row)=>total+(row.size||0),0);
  parts.other=measured.every(row=>Number.isFinite(row.size))?{size:Math.max(0,disk.usedBytes-sum),complete:measured.every(row=>row.complete),upper:true}:area(null);
  return parts;
}
export function storageMixHTML(disk,snapshot,options){
  const parts=storageParts(disk,snapshot,options);if(!parts)return '';
  const rows=MIX.filter(([key])=>parts[key]);
  return `<div class="dr-mix-head"><strong>空间构成</strong><span>${esc(diskLabel(disk))}</span><span class="dr-flex"></span><span class="num">已用 ${bytes(disk.usedBytes)} / ${bytes(disk.totalBytes)}</span>${copyHelp('空间构成','已用空间按用途拆开，合计等于已用。数据集随列表统计，其余各项由服务器每小时统计一次。其他是盘上不归平台管理的文件，以及日志、正在上传的文件等。读不全的标至少或至多，读不到的标未知。')}</div>
    <div class="dr-mix-bar" role="img" aria-label="${esc(rows.map(([key,label])=>label+' '+amount(parts[key])).join('，'))}">${rows.filter(([key])=>parts[key].size>0).map(([key,label])=>`<i data-k="${key}" data-fill="${Math.min(100,parts[key].size/disk.totalBytes*100)}" title="${esc(label+' '+amount(parts[key]))}"></i>`).join('')}</div>
    <ul class="dr-mix-legend">${rows.map(([key,label])=>`<li data-k="${key}"${Number.isFinite(parts[key].size)?'':' class="unk"'}><b></b>${label}<span class="num">${amount(parts[key])}</span></li>`).join('')}</ul>`;
}
// A project container's size is its files, its job outputs and its own
// container layers, shown as one number. A part read as unknown makes the total
// a lower bound.
const projectParts=row=>({files:{size:row.size,complete:row.complete!==false},outputs:row.outputs||area(null),environments:row.environment||area(null)});
const projectTotal=row=>{
  if(!Number.isFinite(row.size))return {size:null,complete:false};
  const parts=Object.values(projectParts(row));
  return {size:parts.reduce((sum,part)=>sum+(Number.isFinite(part.size)?part.size:0),0),complete:parts.every(part=>Number.isFinite(part.size)&&part.complete!==false)};
};
// Members' base images, task copies and runtime files: the container
// environment left after each project's own layers.
export function baseImages(snapshot){
  const projects=snapshot?.projects;if(!projects||projects.error)return null;
  const own=(projects.projects||[]).map(row=>row.environment||area(null));
  const total=projects.areas?.environments||area(null);if(!Number.isFinite(total.size))return area(null);
  // Project layers counted short leave this remainder as an upper bound.
  const short=own.some(part=>!Number.isFinite(part.size)||part.complete===false);
  return {size:Math.max(0,total.size-own.reduce((sum,part)=>sum+(Number.isFinite(part.size)?part.size:0),0)),complete:total.complete!==false&&!short,upper:total.complete!==false&&short};
}
const bar=(part,largest)=>`<span class="jr-prog">${part.size>0?`<b data-fill="${part.size/largest*100}"></b>`:''}</span>`;
const sizeCell=(total,largest)=>`<div class="dr-hide-m">${Number.isFinite(total.size)?bar(total,largest):'<span class="dr-unknown-bar"></span>'}</div>`;
export function projectStorageRows(rows,images=null){
  rows=rows.map(row=>({row,total:projectTotal(row)})).sort((a,b)=>(Number.isFinite(b.total.size)?b.total.size:-1)-(Number.isFinite(a.total.size)?a.total.size:-1));
  // Base images are platform plumbing, not a project: always the last row.
  if(images&&images.size!==0)rows.push({total:images});
  const largest=Math.max(1,...rows.map(({total})=>Number.isFinite(total.size)?total.size:0));
  return rows.map(({row,total})=>row
    ?`<div class="dr-row dr-ct"><div class="dr-main"><div class="dr-t mono">${esc(row.displayName||row.name||row.project)}</div><div class="dr-s">${esc(projectOwnerText(row)||row.ownerId||'未知')}${row.shared?'':' 的项目'}</div></div>${sizeCell(total,largest)}<div class="dr-s">${directoryBytes(total)}</div><div class="dr-acts dr-acts-on"><button type="button" class="jr-link" data-storage-project="${esc(row.project)}" data-owner-id="${esc(row.ownerId)}">打开</button></div></div>`
    :`<div class="dr-row dr-ct dr-base"><div class="dr-main"><div class="dr-t">基础镜像</div><div class="dr-s">新建容器用的系统镜像，以及任务运行时的副本和临时文件</div></div>${sizeCell(total,largest)}<div class="dr-s">${amount(total)}</div><div class="dr-acts dr-acts-on" aria-hidden="true"><span class="jr-link">打开</span></div></div>`).join('');
}
// Bar widths go through CSSOM: the portal CSP blocks inline style attributes.
const fills=root=>requestAnimationFrame(()=>{for(const bar of root.querySelectorAll('[data-fill]'))bar.style.width=bar.dataset.fill+'%';});
// The cover slides off only after fills() has set the widths.
const reveal=node=>requestAnimationFrame(()=>requestAnimationFrame(()=>node.classList.add('on')));
const sheetHead=(eyebrow,title)=>`<div class="pr-sheet-head"><div><div class="page-eyebrow">${eyebrow}</div><div class="pr-sheet-title">${title}</div></div><button type="button" class="jr-x" data-sheet-close aria-label="关闭">✕</button></div>`;

export function datasetsUI(store,toast){
  const section=document.querySelector('#page-datasets');let identity='',machineIds='',turn=0,operationTurn=0,active=false,busy=false,selected='',path='.',cursor=null,cloud,trash;
  const q=s=>section.querySelector(s),machine=()=>q('[name=dataset-machine]')?.value,scope=()=>({machine:machine(),area:'dataset',dataset:selected});
  const card=id=>[...section.querySelectorAll('[data-storage-machine]')].find(node=>node.dataset.storageMachine===id);
  const gauge=id=>[...section.querySelectorAll('[data-gauge]')].find(node=>node.dataset.gauge===id);
  const status=text=>{for(const place of section.querySelectorAll('[data-dataset-status],[data-upload-status]'))place.textContent=text;};
  const actions=[['dr-import-open','ghost','导入'],['dr-upload-open','primary','上传数据集']].map(([id,kind,label])=>{const button=document.createElement('button');button.type='button';button.id=id;button.className='jr-btn dr-action '+kind;button.textContent=label;button.hidden=true;return button;});
  document.querySelector('.heading-actions')?.prepend(...actions);
  for(const action of actions)action.addEventListener('click',event=>{const button=event.currentTarget;if(!q('[name=dataset-machine]'))return;
    if(button.id==='dr-upload-open'){q('[data-upload-to]').textContent=short(machine());openSheet(q('#dataset-upload'));}
    if(button.id==='dr-import-open')openSheet(q('#dr-import-sheet'));});
  const controls=()=>{for(const button of section.querySelectorAll('[data-dataset-open],[data-dataset-download],[data-dataset-delete],[data-storage-trash],[data-storage-project],#dataset-upload-form button[type=submit],[data-file-path],#dataset-file-up,#dataset-file-more'))button.disabled=busy||!store.principal||!machine();cloud?.controls();trash?.update();};
  function showMachine(){const id=machine();for(const node of section.querySelectorAll('[data-gauge]'))node.setAttribute('aria-pressed',String(node.dataset.gauge===id));for(const node of section.querySelectorAll('[data-storage-machine]'))node.hidden=node.dataset.storageMachine!==id;}
  async function run(action){if(busy)return;const token=operationTurn;busy=true;controls();try{await action(()=>token===operationTurn);}catch(error){if(token===operationTurn){status(error.message);toast(error.message);}}finally{if(token===operationTurn){busy=false;controls();}}}
  async function loadCard(id,refresh=false){
    const node=card(id),meter=gauge(id),token=turn;if(!node||node.dataset.loading==='true')return;node.dataset.loading='true';
    const current=()=>token===turn&&node.isConnected,find=s=>node.querySelector(s);
    find('[data-storage-refresh]').disabled=true;find('[data-storage-caption]').textContent=refresh?'更新中':'读取中…';
    try{
      if(refresh)await store.call('storage.refresh',{machine:id});
      let first=true;
      do{
        const snapshot=(await store.call('storage.snapshot',{machine:id})).machines[0];if(!current())return;
        {const result=snapshot.quota.error?{}:snapshot.quota;
          // Workspace and datasets on one filesystem share a single measured disk.
          const volume=kind=>result.volumes?.find(row=>row.kind===kind),shared=volume('shared'),datasets=meter.querySelector('[data-volume="datasets"]');
          meter.querySelector('[data-volume="workspace"]').innerHTML=gaugeDiskHTML(diskLabel(shared||volume('workspace')||{kind:'workspace'}),shared||volume('workspace'));
          datasets.hidden=!!shared;datasets.innerHTML=shared?'':gaugeDiskHTML(diskLabel(volume('datasets')||{kind:'datasets'}),volume('datasets'));fills(meter);
          find('[data-ds-where]').textContent=' · '+diskMediaLabel((shared||volume('datasets'))?.media)+' /datasets';
        }
        if(first||!snapshot.refreshing){
          const quota=snapshot.quota.error?{}:snapshot.quota,volume=kind=>quota.volumes?.find(row=>row.kind===kind),shared=volume('shared'),disk=shared||volume('workspace');
          {const place=find('[data-storage-projects]'),result=snapshot.projects;
            if(result.error)place.innerHTML='<p class="storage-empty">项目未知，请刷新重试。</p>';
            else{
              place.innerHTML=projectStorageRows(result.projects||[],baseImages(snapshot))||(result.complete===false?'<p class="storage-empty">项目未知，请刷新重试。</p>':'<p class="storage-empty">还没有项目。</p>');
              if(result.complete===false)place.insertAdjacentHTML('beforeend','<p class="storage-empty">部分目录暂时读不到，列表可能不全。</p>');fills(place);
            }
          }
          {const place=find('[data-storage-datasets]'),result=snapshot.datasets;
            if(result.error)place.innerHTML='<p class="storage-empty">数据集未知，请刷新重试。</p>';
            else{
              place.innerHTML=datasetRows(result.datasets||[])||(result.complete===false?'<p class="storage-empty">数据集未知，请刷新重试。</p>':'<p class="storage-empty">还没有数据集，上传文件即可新建。</p>');
              if(result.complete===false)place.insertAdjacentHTML('beforeend','<p class="storage-empty">部分目录暂时读不到，列表可能不全。</p>');
            }
          }
          {const place=find('[data-storage-mix]');
            place.classList.remove('on');place.innerHTML=storageMixHTML(disk,snapshot,{datasets:!!shared});fills(place);reveal(place);
          }
          controls();
        }
        // Sizes come from the node's hourly sample when it reports one, not from the portal's read time.
        const measuredAt=snapshot.projects&&'areasCheckedAt' in snapshot.projects?snapshot.projects.areasCheckedAt:snapshot.checkedAt;
        node.dataset.checkedAt=measuredAt||'';
        find('[data-storage-caption]').textContent=snapshot.refreshing?'更新中':statisticsTime(measuredAt);
        if(!snapshot.refreshing)break;
        first=false;await new Promise(resolve=>setTimeout(resolve,1000));
      }while(current());
    }catch(error){if(current()){
      meter.querySelector('[data-volume="workspace"]').innerHTML=gaugeDiskHTML(diskLabel({kind:'workspace'}));meter.querySelector('[data-volume="datasets"]').hidden=false;meter.querySelector('[data-volume="datasets"]').innerHTML=gaugeDiskHTML(diskLabel({kind:'datasets'}));find('[data-ds-where]').textContent=' · /datasets';
      for(const list of ['projects','datasets'])find(`[data-storage-${list}]`).innerHTML='<p class="storage-empty">未知，请刷新重试。</p>';find('[data-storage-mix]').innerHTML='';
      node.dataset.checkedAt='';find('[data-storage-caption]').textContent='统计时间未知';toast(error.message);
    }}finally{if(current()){node.dataset.loading='false';find('[data-storage-refresh]').disabled=false;controls();}}
  }
  function selectMachine(id){if(id!==machine()){q('[name=dataset-machine]').value=id;q('[name=dataset-machine]').dispatchEvent(new Event('change',{bubbles:true}));}showMachine();}
  function showDataset(dataset){
    const place=card(machine())?.querySelector('[data-storage-datasets]');if(!place)return;
    const row=[...place.querySelectorAll('[data-dataset-row]')].find(node=>node.dataset.datasetRow===dataset);
    if(row)row.querySelector('[data-directory-size]').textContent='未知';
    else{place.querySelector('.storage-empty')?.remove();place.insertAdjacentHTML('beforeend',datasetRows([{dataset,size:null}]));}
    controls();
  }
  async function browse(target='.',next=false){const token=operationTurn;path=target;q('[data-dataset-current]').textContent=selected+(path==='.'?'':' / '+path);q('[data-dataset-files]').hidden=false;if(!next)q('[data-dataset-file-list]').innerHTML='<p class="storage-empty">读取中…</p>';let page;try{page=await store.call('files.list',{...scope(),path,limit:1000,...(next&&cursor?{cursor}:{})});}catch(error){if(token===operationTurn&&!next)q('[data-dataset-file-list]').innerHTML='<p class="storage-empty">文件列表未知，请重试。</p>';throw error;}if(token!==operationTurn)return;cursor=page.hasMore?page.nextCursor:null;const html=(page.entries||[]).filter(row=>['file','directory'].includes(row.type)).map(row=>`<button type="button" class="pr-file dr-file" data-file-path="${esc(filePath(path,row.name))}" data-file-type="${row.type}"><span class="pr-file-name mono">${esc(row.name)}${row.type==='directory'?'/':''}</span><span class="pr-file-size">${row.type==='file'?transferBytes(row.size):'目录'}</span><span class="pr-file-get">${row.type==='file'?'下载':'打开'}</span></button>`).join('');if(next)q('[data-dataset-file-list]').insertAdjacentHTML('beforeend',html);else q('[data-dataset-file-list]').innerHTML=html||'<p class="storage-empty">空目录。</p>';q('#dataset-file-up').hidden=path==='.';q('#dataset-file-more').hidden=!cursor;q('[name=upload-dataset]').value=selected;}
  function openDataset(dataset){selected=dataset;void run(async()=>{await browse();q('[data-dataset-files]').scrollIntoView({block:'nearest',behavior:'smooth'});});}
  function build(machines){
    cloud?.reset();
    section.innerHTML=`${machines.length?'':'<section class="dr-none"><h2>还没有开通服务器</h2><p>请联系管理员审批额度后，再上传数据集。</p></section>'}<div class="dr-gauges">${machines.map(row=>`<button type="button" class="dr-gauge" data-gauge="${esc(row.id)}" aria-pressed="false"><div class="dr-nm">${esc(short(row.id))}</div><div data-volume="workspace">${gaugeDiskHTML(diskLabel({kind:'workspace'}),null,{loading:true})}</div><div data-volume="datasets">${gaugeDiskHTML(diskLabel({kind:'datasets'}),null,{loading:true})}</div></button>`).join('')}</div>
      <div class="dr-cards">${machines.map(row=>`<article class="dr-machine" data-storage-machine="${esc(row.id)}" hidden>
        <section class="dr-mix" data-storage-mix aria-label="空间构成"></section>
        <div class="dr-toolbar"><h2>${esc(short(row.id))} 上的数据集<span class="dr-where" data-ds-where> · /datasets</span></h2><span class="dr-flex"></span><small class="dr-caption" data-storage-caption></small><button type="button" class="jr-link" data-storage-refresh>刷新</button><a class="jr-link" href="#datasets/transfers">传输</a><button type="button" class="jr-link" data-storage-trash>回收站</button></div>
        <div class="dr-rows" data-storage-datasets data-dataset-list></div>
        <div class="dr-toolbar dr-gap"><h2>项目容器 · /workspace</h2><span class="dr-flex"></span><span class="jr-hint">按大小排序 · 后台定时统计</span>${copyHelp('容量与目录大小','每个项目显示一个总大小：项目文件、它在这台服务器上的任务输出和它自己的容器环境（装进容器的依赖）加在一起。“基础镜像”是新建容器用的系统镜像，每位成员一份。读不全的标至少或至多，读不到的显示未知。删除可能影响正在运行的任务。')}</div>
        <div class="dr-rows" data-storage-projects></div>
      </article>`).join('')}</div>
      <section class="dr-browse" data-dataset-files hidden><div class="dr-toolbar"><h2 class="mono" data-dataset-current></h2><span class="dr-flex"></span><button type="button" class="jr-link" id="dataset-file-up" hidden>← 上一级</button><button type="button" class="jr-link" data-browse-close>收起</button></div><div class="dr-files" data-dataset-file-list></div><button type="button" class="jr-btn ghost" id="dataset-file-more" hidden>下一页</button></section>
      <p class="dr-status" data-dataset-status role="status"></p>
      <dialog class="pr-sheet" id="dataset-upload" aria-label="上传数据集"><div class="pr-sheet-in">${sheetHead('上传数据集','到 <span data-upload-to></span>')}
        <form id="dataset-upload-form"><label hidden>服务器<select name="dataset-machine">${machines.map(row=>`<option value="${esc(row.id)}">${esc(row.id)}</option>`).join('')}</select></label>
          <label>数据集名字<input class="mono" name="upload-dataset" required placeholder="新名字，或已有数据集的名字" spellcheck="false" autocomplete="off"></label>
          <div class="dr-drop" data-upload-drop><span data-upload-picked>把文件或文件夹拖到这里</span><span class="dr-drop-or"><button type="button" class="jr-link" data-pick-files>选择文件</button> · <button type="button" class="jr-link" data-pick-folder>选择文件夹</button></span></div>
          <input name="upload-files" type="file" multiple hidden><input name="upload-folder" type="file" webkitdirectory multiple hidden>
          <details class="dr-more"><summary>放到数据集里的子目录（可选）</summary><label>子目录<input class="mono" name="upload-directory" value="." spellcheck="false"></label></details>
          <p class="jr-hint">只走校园网直连。断网后再选同一批文件上传，会从断点继续。</p><p class="dr-status" data-upload-status role="status"></p>
          <div class="jr-actions"><button type="button" class="jr-btn ghost" data-sheet-close>取消</button><button type="submit" class="jr-btn primary">上传</button></div></form></div></dialog>
      <dialog class="pr-sheet dr-wide" id="dr-import-sheet" aria-label="导入"><div class="pr-sheet-in">${sheetHead('导入','从链接或云盘拿数据')}<div class="storage-import">${cloudImportHTML(store.users||store.data?.users||[])}</div></div></dialog>
      <dialog class="pr-sheet" id="dr-trash-sheet" aria-label="回收站"><div class="pr-sheet-in">${sheetHead('回收站','7 天内可恢复')}</div></dialog>`;
    trash=createTrashUI({call:(...args)=>store.call(...args),getContext:()=>({owner:store.principal?.userId,machine:machine(),enabled:!!store.principal&&!!machine(),isAdmin:store.principal?.role==='admin'}),changed:(row,result)=>{if(row.kind==='dataset'&&result.state==='RESTORED')showDataset(row.dataset||row.originalPath.split('/').pop());status(result.state==='RESTORED'?'已恢复，统计将在后台更新。':result.state==='PURGED'?'已彻底删除。':'结果未知，请按原编号查询：'+row.key);},toast});
    q('#dr-trash-sheet .pr-sheet-in').append(trash.element);trash.element.querySelector('summary').hidden=true;cloud ||= cloudImportUI(store,section,toast);
    q('[name=dataset-machine]').addEventListener('change',()=>{operationTurn++;busy=false;selected='';q('[data-dataset-files]').hidden=true;q('[data-dataset-file-list]').replaceChildren();status('');showMachine();controls();});
    for(const dialog of section.querySelectorAll('dialog'))dialog.addEventListener('cancel',event=>{event.preventDefault();closeSheet(dialog);});
    const picked=()=>{const files=[...q('[name=upload-files]').files,...q('[name=upload-folder]').files];q('[data-upload-picked]').textContent=files.length?`已选 ${files.length} 个文件 · ${transferBytes(files.reduce((sum,file)=>sum+file.size,0))}`:'把文件或文件夹拖到这里';};
    for(const name of ['upload-files','upload-folder'])q(`[name=${name}]`).addEventListener('change',picked);
    const drop=q('[data-upload-drop]');for(const type of ['dragenter','dragover'])drop.addEventListener(type,event=>{if(!event.dataTransfer?.types?.includes('Files'))return;event.preventDefault();drop.classList.add('over');});
    drop.addEventListener('dragleave',event=>{if(!drop.contains(event.relatedTarget))drop.classList.remove('over');});
    drop.addEventListener('drop',event=>{drop.classList.remove('over');if(!event.dataTransfer?.files?.length)return;event.preventDefault();q('[name=upload-folder]').value='';q('[name=upload-files]').files=event.dataTransfer.files;picked();});
    section.onclick=event=>{const b=event.target.closest('button');if(!b||b.disabled)return;
      if(b.dataset.gauge)return void selectMachine(b.dataset.gauge);
      if(b.hasAttribute('data-sheet-close'))return void closeSheet(b.closest('dialog'));
      if(b.hasAttribute('data-pick-files'))return void q('[name=upload-files]').click();
      if(b.hasAttribute('data-pick-folder'))return void q('[name=upload-folder]').click();
      if(b.hasAttribute('data-browse-close')){selected='';q('[data-dataset-files]').hidden=true;return;}
      const target=b.closest('[data-storage-machine]')?.dataset.storageMachine;
      if(b.hasAttribute('data-storage-refresh'))return void loadCard(target,true);
      if(b.hasAttribute('data-storage-trash')){openSheet(q('#dr-trash-sheet'));trash.element.open=true;return;}
      if(b.dataset.storageProject)return document.dispatchEvent(new CustomEvent('gpuq-open-project',{detail:{userId:store.principal.userId,authGeneration:store.authGeneration,machine:target,project:b.dataset.storageProject,ownerId:b.dataset.ownerId}}));
      if(b.dataset.datasetOpen)return openDataset(b.dataset.datasetOpen);
      if(b.dataset.datasetDownload)return void run(()=>downloadBrowserPath((...args)=>store.call(...args),{machine:machine(),area:'dataset',dataset:b.dataset.datasetDownload},'.',{directory:true,onRoute:status,onProgress:row=>status(row.path+' · '+row.offset+' / '+row.size)}));
      if(b.dataset.datasetDelete){const dataset=b.dataset.datasetDelete;return void confirmSheet({title:`删除 ${dataset}？`,body:'所有人共用这个数据集。删除后在回收站保留 7 天，正在用它的任务可能受影响。',action:'删除',run:()=>{void run(async current=>{const cache='dataset-delete:'+store.principal.userId+':'+machine()+':'+dataset,key=sessionStorage.getItem(cache)||crypto.randomUUID();sessionStorage.setItem(cache,key);status('正在删除…');const result=await store.call('datasets.delete',{machine:machine(),dataset,key});if(!current())return;if(result.state==='TRASHED'){sessionStorage.removeItem(cache);b.closest('[data-dataset-row]')?.remove();if(selected===dataset){selected='';q('[data-dataset-files]').hidden=true;}status('已删除，7 天内可在回收站恢复。');toast('已移到回收站');}else status('结果未知，请按原编号查询：'+key);});}});}
      if(b.dataset.filePath)return void run(()=>b.dataset.fileType==='directory'?browse(b.dataset.filePath):downloadBrowserPath((...args)=>store.call(...args),scope(),b.dataset.filePath,{onRoute:status,onProgress:row=>status(row.path+' · '+row.offset+' / '+row.size)}));
      if(b.id==='dataset-file-up')return void run(()=>browse(path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.'));
      if(b.id==='dataset-file-more')return void run(()=>browse(path,true));
    };
    q('#dataset-upload-form').addEventListener('submit',event=>{event.preventDefault();void run(async current=>{
      const files=[...q('[name=upload-files]').files,...q('[name=upload-folder]').files].sort((a,b)=>(a.webkitRelativePath||a.name).localeCompare(b.webkitRelativePath||b.name)),dataset=q('[name=upload-dataset]').value.trim(),folder=q('[name=upload-directory]').value.trim()||'.';if(!files.length)throw Error('请选择文件或目录。');
      // Each file keeps its upload key until it finishes, so choosing the same files again resumes.
      const cache='dataset-upload:'+store.principal.userId+':'+machine()+':'+dataset+':'+folder,keys=JSON.parse(localStorage.getItem(cache)||'{}');
      for(const file of files){const relative=file.webkitRelativePath||file.name,target=folder==='.'?relative:folder+'/'+relative,identity=target+'|'+file.size+'|'+file.lastModified;keys[identity]||=crypto.randomUUID();localStorage.setItem(cache,JSON.stringify(keys));const memory=cache+':'+keys[identity]+':via',route={via:localStorage.getItem(memory),save:via=>localStorage.setItem(memory,via)};await uploadBrowserFile(file,{call:(...args)=>store.call(...args),machine:machine(),area:'dataset',dataset,path:target,key:keys[identity],route,onRoute:message=>{if(current())status(message);},overwrite:true,onProgress:row=>{if(current())status(target+' · '+transferBytes(row.offset)+' / '+transferBytes(file.size));}});if(!current())return;delete keys[identity];localStorage.setItem(cache,JSON.stringify(keys));localStorage.removeItem(memory);}
      localStorage.removeItem(cache);showDataset(dataset);status('上传完成；统计将在后台更新。');toast('上传完成');
      q('[name=upload-files]').value='';q('[name=upload-folder]').value='';picked();closeSheet(q('#dataset-upload'));
    });});
  }
  document.addEventListener('gpuq-open-dataset',event=>{const detail=event.detail||{};if(detail.userId!==store.principal?.userId||!q('[name=dataset-machine]'))return;if(busy){toast('请等待当前数据操作完成，再打开数据集。');return;}selectMachine(detail.machine);openDataset(detail.dataset);});
  return ()=>{
    const next=JSON.stringify([store.authGeneration,store.principal?.userId]),machines=usableMachines(store),ids=machines.map(row=>row.id).join(',');
    if(next!==identity||ids!==machineIds||!q('[name=dataset-machine]')){identity=next;machineIds=ids;turn++;operationTurn++;busy=false;active=false;build(machines);showMachine();}
    const visible=!!store.principal&&!section.hidden;for(const action of actions)action.hidden=!visible||!machines.length;
    if(visible&&!active){active=true;for(const row of machines)void loadCard(row.id);}
    if(!visible&&active){active=false;turn++;for(const node of section.querySelectorAll('[data-storage-machine]'))node.dataset.loading='false';}
    for(const node of section.querySelectorAll('[data-storage-machine][data-checked-at]'))if(node.dataset.loading!=='true')node.querySelector('[data-storage-caption]').textContent=statisticsTime(node.dataset.checkedAt);
    controls();
  };
}
