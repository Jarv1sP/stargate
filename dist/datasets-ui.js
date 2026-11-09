import {storageLimitUI} from './storage-limit-ui.js';
import {uploadBrowserFile} from './personal-upload.js';
import {downloadBrowserPath,filePath} from './file-transfer-ui.js';
import {createTrashUI} from './trash-ui.js';
import {cloudImportHTML,cloudImportUI} from './cloud-import-ui.js';
import {transferBytes} from './data-route.js';
import {diskLabel,diskMediaLabel} from './disk-media.js';
import {copyHelp} from './copy-help-ui.js';
import {openSheet,closeSheet,confirmSheet} from './sheet-ui.js';
import {usableMachines} from './workbench-ui.js';
import {storageBytes as bytes,statisticsTime,usageText,projectUsage,usagePartsText,projectOwnerLabel,itemBytes,ownerUsage} from './storage-usage.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=id=>String(id||'').replace(/^amax-/,'');
const when=value=>{if(!value)return '时间未知';const date=new Date(typeof value==='number'?value*1000:value);return Number.isFinite(date.getTime())?date.toLocaleDateString('zh-CN'):'时间未知';};
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
// Where one disk's used space goes, from the node's per-project accounting.
// The groups add up to the disk's used bytes; filesystem overhead may be a
// small negative and is shown as reported.
const GROUPS=[['project','项目'],['images','镜像与容器引擎'],['dataset','数据集'],['platform','平台运行数据'],['external','外部目录'],['unassignedOutputs','未归属输出'],['untracked','未登记'],['filesystem','文件系统开销']];
export function diskGroups(disk){
  return GROUPS.map(([kind,label])=>{
    const rows=new Map();let size=0;
    for(const item of disk.items.filter(row=>row?.kind===kind)){
      const value=itemBytes(item),key=kind==='external'?item.path:kind==='project'||kind==='images'?item.ownerId:null;size+=value;
      if(key!=null){const row=rows.get(key)||{label:kind==='external'?item.path:item.ownerName||item.ownerId||'未知',size:0};row.size+=value;rows.set(key,row);}
    }
    return {kind,label,size,rows:[...rows.values()].sort((a,b)=>b.size-a.size)};
  }).filter(group=>group.size!==0||group.kind==='filesystem');
}
const MIX_HELP='按项目记账统计，各项相加等于已用。项目按创建人分组，含项目文件、任务输出和容器环境；镜像与容器引擎每人一份；外部目录是数据盘上不归平台管理的目录；未登记是还没有记账的文件；文件系统开销是日志和元数据。回收站里的内容仍计入原项目，清空后释放。';
export function diskMixHTML(disk){
  const measured=Number.isFinite(disk?.usedBytes)&&Number.isFinite(disk?.totalBytes)&&disk.totalBytes>0;
  const head=`<div class="dr-mix-head"><strong>空间构成</strong><span>${esc(diskLabel(disk||{}))}</span><span class="mono">${esc(disk?.mountPoint||'')}</span><span class="dr-flex"></span><span class="num">已用 ${bytes(measured?disk.usedBytes:null)} / ${bytes(measured?disk.totalBytes:null)}</span>${copyHelp('空间构成',MIX_HELP)}</div>`;
  if(disk?.accounting!=='quota'||!Array.isArray(disk.items)||!measured)return `<section class="dr-mix">${head}<div class="dr-mix-bar is-unknown"></div><p class="dr-mix-note">${disk?.accounting==='unavailable'?'未开启项目记账，用量未知。':'用量未知，请稍后刷新。'}</p></section>`;
  const groups=diskGroups(disk),trash=Number.isFinite(disk.trashBytes)&&disk.trashBytes>0;
  return `<section class="dr-mix">${head}
    <div class="dr-mix-bar" role="img" aria-label="${esc(groups.map(group=>group.label+' '+bytes(group.size)).join('，'))}">${groups.filter(group=>group.size>0).map(group=>`<i data-k="${group.kind}" data-fill="${Math.min(100,group.size/disk.totalBytes*100)}" title="${esc(group.label+' '+bytes(group.size))}"></i>`).join('')}</div>
    <ul class="dr-mix-legend">${groups.map(group=>`<li class="dr-mix-g" data-k="${group.kind}"><div class="dr-mix-line"><b></b><span>${group.label}</span><span class="num">${bytes(group.size)}</span></div>${group.rows.length?`<ul class="dr-mix-sub">${group.rows.map(row=>`<li><span${group.kind==='external'?' class="mono"':''}>${esc(row.label)}</span><span class="num">${bytes(row.size)}</span></li>`).join('')}</ul>`:''}</li>`).join('')}<li class="dr-mix-g" data-k="free"><div class="dr-mix-line"><b></b><span>可用</span><span class="num">${bytes(disk.availableBytes)}</span></div></li></ul>${trash?`<p class="dr-mix-note">其中回收站 ${bytes(disk.trashBytes)}，7 天内可恢复。</p>`:''}</section>`;
}
// One composition per data disk of the server; no disk reading stays unknown.
export function storageMixHTML(projects){
  if(!projects||projects.error||!Array.isArray(projects.disks))return '<section class="dr-mix"><div class="dr-mix-head"><strong>空间构成</strong><span>未知，请刷新重试。</span></div></section>';
  return projects.disks.map(diskMixHTML).join('');
}
const bar=(part,largest)=>`<span class="jr-prog">${part.size>0?`<b data-fill="${part.size/largest*100}"></b>`:''}</span>`;
const sizeCell=(total,largest)=>`<div class="dr-hide-m">${Number.isFinite(total.size)?bar(total,largest):'<span class="dr-unknown-bar"></span>'}</div>`;
const largestOf=totals=>Math.max(1,...totals.map(total=>Number.isFinite(total.size)?total.size:0));
// A project's total is its files, its job outputs and its own container
// environment; the parts are listed under it.
export function projectStorageRows(rows,{admin=false}={}){
  rows=rows.map(row=>({row,usage:projectUsage(row)})).sort((a,b)=>(Number.isFinite(b.usage.total.size)?b.usage.total.size:-1)-(Number.isFinite(a.usage.total.size)?a.usage.total.size:-1));
  const largest=largestOf(rows.map(({usage})=>usage.total));
  return rows.map(({row,usage})=>`<div class="dr-row dr-ct" data-project-row="${esc(row.project)}" data-owner-id="${esc(row.ownerId)}"><div class="dr-main"><div class="dr-t mono">${esc(row.displayName||row.name||row.project)}</div><div class="dr-s">${esc(projectOwnerLabel(row))}${row.shared?'':' 的项目'}</div><div class="dr-s" data-project-parts>${usagePartsText(usage)}</div></div>${row.enforced===true&&row.limitBytes>0&&Number.isFinite(row.size)?`<div class="storage-bar" aria-label="项目文件用量"><i data-fill="${Math.min(100,Math.max(0,row.size/row.limitBytes*100))}"></i></div>`:sizeCell(usage.total,largest)}<div class="dr-s" data-project-total>${usageText(usage.total)}</div><div class="dr-acts dr-acts-on">${admin?`<button type="button" class="jr-link" data-storage-limit="${esc(row.project)}" data-owner-id="${esc(row.ownerId)}" data-desired-bytes="${esc(row.desiredLimitBytes??100_000_000_000)}">设上限</button>`:''}<button type="button" class="jr-link" data-storage-project="${esc(row.project)}" data-owner-id="${esc(row.ownerId)}">打开</button></div></div>`).join('');
}
export function ownerStorageRows(owners){
  if(!owners)return '<p class="storage-empty">未知：这台服务器还没有项目记账数据。</p>';
  if(!owners.length)return '<p class="storage-empty">还没有人占用空间。</p>';
  const largest=largestOf(owners.map(row=>row.total));
  return owners.map(row=>`<div class="dr-row dr-ow" data-owner-row="${esc(row.ownerId)}"><div class="dr-main"><div class="dr-t">${esc(row.ownerName||row.ownerId||'未知')}</div><div class="dr-s">项目 ${usageText(row.projects)} · 镜像与容器引擎 ${usageText(row.images)}</div></div>${sizeCell(row.total,largest)}<div class="dr-s" data-owner-total>${usageText(row.total)}</div></div>`).join('');
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
          {const place=find('[data-storage-projects]'),owners=find('[data-storage-owners]'),result=snapshot.projects;
            if(result.error){place.innerHTML='<p class="storage-empty">项目未知，请刷新重试。</p>';owners.innerHTML='<p class="storage-empty">按人汇总未知，请刷新重试。</p>';}
            else{
              owners.innerHTML=ownerStorageRows(ownerUsage(result.disks));fills(owners);
              place.innerHTML=projectStorageRows(result.projects||[],{admin:store.principal?.role==='admin'})||(result.complete===false?'<p class="storage-empty">项目未知，请刷新重试。</p>':'<p class="storage-empty">还没有项目。</p>');
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
            place.classList.remove('on');place.innerHTML=storageMixHTML(snapshot.projects);fills(place);reveal(place);
          }
          controls();
        }
        // Sizes come from the node's quota sample time, not from the portal's read time.
        const measuredAt=snapshot.projects?.checkedAt;
        node.dataset.checkedAt=measuredAt||'';
        find('[data-storage-caption]').textContent=snapshot.refreshing?'更新中':statisticsTime(measuredAt);
        if(!snapshot.refreshing)break;
        first=false;await new Promise(resolve=>setTimeout(resolve,1000));
      }while(current());
    }catch(error){if(current()){
      meter.querySelector('[data-volume="workspace"]').innerHTML=gaugeDiskHTML(diskLabel({kind:'workspace'}));meter.querySelector('[data-volume="datasets"]').hidden=false;meter.querySelector('[data-volume="datasets"]').innerHTML=gaugeDiskHTML(diskLabel({kind:'datasets'}));find('[data-ds-where]').textContent=' · /datasets';
      for(const list of ['projects','datasets','owners'])find(`[data-storage-${list}]`).innerHTML='<p class="storage-empty">未知，请刷新重试。</p>';find('[data-storage-mix]').innerHTML='';
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
        <div class="dr-mixes" data-storage-mix aria-label="空间构成"></div>
        <div class="dr-toolbar"><h2>${esc(short(row.id))} 上的数据集<span class="dr-where" data-ds-where> · /datasets</span></h2><span class="dr-flex"></span><small class="dr-caption" data-storage-caption></small><button type="button" class="jr-link" data-storage-refresh>刷新</button><a class="jr-link" href="#datasets/transfers">传输</a><button type="button" class="jr-link" data-storage-trash>回收站</button></div>
        <div class="dr-rows" data-storage-datasets data-dataset-list></div>
        <div class="dr-toolbar dr-gap"><h2>项目容器 · /workspace</h2><span class="dr-flex"></span><span class="jr-hint">按合计排序 · 后台定时统计</span>${copyHelp('项目用量','合计是项目文件、它在这台服务器上的任务输出和它自己的容器环境之和，与项目设置和 gpuctl project quota 同一份统计。共用项目同时显示创建人。读不全的标至少，读不到的显示未知。删除可能影响正在运行的任务。')}</div>
        <div class="dr-rows" data-storage-projects></div>
        <div class="dr-toolbar dr-gap"><h2>按人汇总</h2><span class="dr-flex"></span>${copyHelp('按人汇总','每人名下的项目（按创建人，含回收站里尚未清空的项目）加上本人的镜像与容器引擎，合计这台服务器所有数据盘。有盘未开启项目记账时标至少。')}</div>
        <div class="dr-rows" data-storage-owners></div>
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
    storageLimitUI(section,store,id=>loadCard(id,true),toast);
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
