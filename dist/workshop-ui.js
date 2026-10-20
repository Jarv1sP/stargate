import {createWorkshopNative} from './workshop-native.js';
import {escapeUI as esc} from './workbench-ui.js';
import {normalizeWorkshopPackage,WORKSHOP_PACKAGE_BYTES} from './workshop-package.js';
import {WORKSHOP_EXAMPLES} from './workshop-examples.js';
import {createWorkshopRuntime} from './workshop-runtime.js';

const permissionLabels={'resources.read':'读取 GPU 概况','jobs.read':'读取本人的任务','jobs.cancel':'经平台确认后取消任务','ui.navigate':'切换平台页面','platform.read':'读取团队项目、数据集与任务','platform.write':'创建项目、提交训练命令、管理数据与回收站','platform.ui':'打开平台原生终端、文件和管理面板'};
const kindLabel=(kind,presentation)=>presentation==='interface'?'整站界面':kind==='theme'?'主题与布局':'功能插件';
const versionLabel=version=>String(version).length>16?String(version).slice(0,12):String(version);
const permissionHTML=pkg=>(pkg.permissions||[]).length?`<ul class="workshop-permissions">${pkg.permissions.map(value=>`<li>${esc(permissionLabels[value])} <code>${esc(value)}</code></li>`).join('')}</ul>`:'<p class="muted">不申请数据或操作权限。</p>';

export function createWorkshopUI(store,{navigate,toast,openProject}){
  const host=document.querySelector('#page-workshop'),widgets=document.querySelector('#workshop-widgets');
  const nativeView=createWorkshopNative({store,navigate,openProject,toast});
  let runtime=null;
  const bypass=new URL(location.href).searchParams.get('workshop')==='off';
  let actor=null,generation=0,active=false,items=[],installed=[],mineState='unknown',listState='idle',error='',busy=false;
  let mineAt=0,mineLoading=false,mineRequest=0,listLoading=false,selected=null,detailTurn=0,pending=null,previewing=false;
  let controller=new AbortController();
  host.innerHTML=`<div class="workshop-toolbar"><label class="workshop-search">搜索作品<input id="workshop-search" type="search" placeholder="名称、说明或作者" autocomplete="off"></label><label>类型<select id="workshop-kind"><option value="all">全部</option><option value="theme">主题与布局</option><option value="plugin">功能插件</option><option value="installed">我已安装</option></select></label><div class="workshop-actions"><button class="button" type="button" data-workshop="refresh">刷新</button><button class="button primary" type="button" data-workshop="create">发布作品</button></div></div><p id="workshop-status" role="status"></p><p id="workshop-error" class="form-error" role="alert"></p><div id="workshop-catalog" class="workshop-catalog"></div>
  <dialog id="workshop-detail" class="modal workshop-dialog" aria-labelledby="workshop-detail-title"><div class="modal-head"><h2 id="workshop-detail-title">作品详情</h2><button type="button" class="button" data-workshop="close-detail">关闭</button></div><div id="workshop-detail-content"></div></dialog>
  <dialog id="workshop-editor" class="modal workshop-dialog" aria-labelledby="workshop-editor-title"><div class="modal-head"><h2 id="workshop-editor-title">发布作品</h2><button type="button" class="button" data-workshop="close-editor">关闭</button></div><form id="workshop-publish-form"><div class="workshop-editor-fields"><label>从示例开始<select id="workshop-example"><option value="">选择示例</option>${WORKSHOP_EXAMPLES.map(example=>`<option value="${example.id}">${example.label}</option>`).join('')}</select></label><label>发布到<select id="workshop-publish-target"><option value="">新作品</option></select></label></div><label class="workshop-file">导入 JSON 文件<input id="workshop-file" type="file" accept="application/json,.json"></label><label>作品 JSON<textarea id="workshop-source" rows="16" spellcheck="false" required aria-describedby="workshop-source-note"></textarea></label><p id="workshop-source-note" class="muted">解析和查看源码不会执行插件。发布不等于安装。</p><div class="workshop-actions"><button type="button" class="button" data-workshop="validate">检查作品</button><button type="submit" id="workshop-publish" class="button primary">发布</button></div><p id="workshop-publish-status" role="status"></p><p id="workshop-publish-error" class="form-error" role="alert"></p><div id="workshop-package-summary"></div></form></dialog>
  <dialog id="workshop-confirm" class="modal workshop-dialog workshop-confirm" aria-labelledby="workshop-confirm-title"><form method="dialog"><h2 id="workshop-confirm-title"></h2><div id="workshop-confirm-content"></div><div class="modal-actions"><button class="button" value="cancel">返回</button><button id="workshop-confirm-accept" class="button primary" value="accept">确认</button></div></form></dialog>`;
  const dialogs=document.createElement('div');dialogs.id='workshop-dialogs';dialogs.append(...host.querySelectorAll('dialog'));document.body.append(dialogs);
  const q=selector=>host.querySelector(selector)||dialogs.querySelector(selector),detail=q('#workshop-detail'),editor=q('#workshop-editor'),confirmDialog=q('#workshop-confirm');
  const recovery=document.querySelector('#workshop-recovery');
  const safeURL=new URL(location.href);safeURL.searchParams.set('workshop','off');safeURL.hash='workshop';recovery.querySelector('a').href=safeURL.href;
  const supported=()=>store.production&&store.data?.frontendWorkshop?.version===1;
  const available=()=>Boolean(store.principal)&&supported();
  const current=stamp=>stamp===generation&&actor===identity();
  const identity=()=>store.principal?`${store.principal.userId}:${store.authGeneration}:${supported()}`:null;
  const pendingKey=()=>`stargate.workshop.publish:${store.principal?.userId}`;
  function resetSession(){
    generation++;controller.abort();controller=new AbortController();actor=identity();
    items=[];installed=[];mineState='unknown';listState='idle';error='';busy=false;mineAt=0;mineLoading=false;mineRequest++;listLoading=false;selected=null;detailTurn++;pending=null;
    runtime?.destroy();runtime=null;previewing=false;
    for(const dialog of [detail,editor,confirmDialog])dialog.close();
    q('#workshop-publish-form').reset();q('#workshop-package-summary').replaceChildren();q('#workshop-publish-error').textContent='';q('#workshop-publish-status').textContent='';
    q('#workshop-search').value='';q('#workshop-kind').value='all';draw();
  }
  store.onAuthChange(resetSession);
  function draw(){
    const enabled=available();
    q('#workshop-status').textContent=!store.principal?'登录后使用创意工坊。':!store.production?'演示环境暂不提供作品发布和安装。':!supported()?'当前门户未开放创意工坊。':bypass?'本页已停用主题和插件，已安装记录仍然保留。':mineState==='unknown'?'安装状态待确认，插件尚未启用。':mineState==='error'?'安装状态读取失败，插件已暂停。':previewing?'正在预览主题，尚未保存。':`已安装 ${installed.length} 项 · 固定版本，不自动升级`;
    q('#workshop-error').textContent=error;
    for(const button of host.querySelectorAll('[data-workshop="create"],[data-workshop="refresh"]'))button.disabled=!enabled||busy||listLoading;
    recovery.hidden=!enabled||!(active||installed.length||previewing||bypass||mineState!=='ready');
    recovery.querySelector('button').disabled=!enabled||busy;
    recovery.querySelector('[data-workshop-recovery-status]').textContent=previewing?'主题预览中':bypass?'安全模式':'';
    const needle=q('#workshop-search').value.trim().toLocaleLowerCase(),kind=q('#workshop-kind').value;
    const rows=kind==='installed'?installed.map(record=>record.item):items;
    const matches=rows.filter(item=>(kind==='all'||kind==='installed'||item.kind===kind)&&[item.name,item.description,item.author.name,item.author.username].some(value=>String(value||'').toLocaleLowerCase().includes(needle)));
    q('#workshop-catalog').innerHTML=matches.map(item=>{
      const own=installed.find(record=>record.item.id===item.id),state=mineState!=='ready'?'安装状态未知':own?`已安装 v${versionLabel(own.item.version)}`:'未安装';
      return `<article class="workshop-card"><div class="workshop-card-meta"><span>${kindLabel(item.kind,item.presentation)}</span><span>${esc(state)}</span></div><h2>${esc(item.name)}</h2><p class="workshop-description">${esc(item.description)}</p><p class="muted">${esc(item.author.name||item.author.username)} · <span title="${esc(item.version)}">v${esc(versionLabel(item.version))}</span></p><button type="button" class="button" data-workshop="detail" data-id="${esc(item.id)}" ${kind==='installed'?`data-version="${esc(item.version)}"`:''}>查看作品</button></article>`;
    }).join('')||`<p class="workshop-empty">${!enabled?'工坊暂不可用。':listState==='loading'?'正在读取作品…':listState==='error'?'作品读取失败，请重试。':needle?'没有匹配的作品。':kind==='installed'&&mineState!=='ready'?'安装状态尚未确认。':'暂无作品。可以从示例开始发布。'}</p>`;
  }
  async function loadMine(){
    if(mineLoading||busy||!available())return;
    const stamp=generation,request=++mineRequest;mineLoading=true;mineAt=Date.now();
    const fresh=()=>current(stamp)&&request===mineRequest;
    try{const result=await store.call('workshop.mine',{}, {signal:controller.signal});if(!fresh())return;installed=result.installed;mineState='ready';runtime.setInstalled(installed);}
    catch(cause){if(!fresh())return;mineState='error';runtime.setInstalled([]);error=cause.message;}
    finally{if(fresh()){mineLoading=false;draw();}}
  }
  async function loadList(){
    if(listLoading||!available())return;
    const stamp=generation;listLoading=true;listState='loading';draw();
    try{const result=await store.call('workshop.list',{}, {signal:controller.signal});if(!current(stamp))return;items=result.items;listState='ready';}
    catch(cause){if(!current(stamp))return;listState='error';error=cause.message;}
    finally{if(current(stamp)){listLoading=false;draw();}}
  }
  function stopPreview(){runtime?.previewTheme(null);previewing=false;draw();}
  function showDetail(){
    if(!selected)return;const {item,package:pkg}=selected,own=installed.find(record=>record.item.id===item.id);
    q('#workshop-detail-title').textContent=item.name;
    q('#workshop-detail-content').innerHTML=`<p>${esc(item.description)}</p><p class="muted">${esc(item.author.name||item.author.username)} · ${kindLabel(item.kind,item.presentation)} · <span title="${esc(item.version)}">v${esc(versionLabel(item.version))}</span></p><h3>安装后可用权限</h3>${permissionHTML(pkg)}${pkg.kind==='theme'?`<p class="muted">${pkg.theme.density==='compact'?'紧凑':'舒适'}间距 · ${pkg.theme.width==='wide'?'宽':'标准'}工作台 · ${pkg.theme.columns} 列小组件</p>`:pkg.presentation==='interface'?'<p class="muted">安装后替换整个可见界面，按 Ctrl + Alt + 0 恢复平台界面；作品仍在隔离环境中运行。</p>':'<p class="muted">插件在独立小组件内运行，不会获得终端、文件或管理员接口。</p>'}<p>${mineState!=='ready'?'安装状态尚未确认，请刷新。':own?`已安装 v${esc(versionLabel(own.item.version))}${own.item.version===item.version?'':'；更新需要重新确认权限。'}`:'尚未安装。'}</p><div class="workshop-actions">${pkg.kind==='theme'?'<button class="button" type="button" data-workshop="preview">预览主题</button><button class="button" type="button" data-workshop="stop-preview">停止预览</button>':''}<button type="button" class="button primary" data-workshop="install" ${busy||mineState!=='ready'||own?.item.version===item.version?'disabled':''}>${own?.item.version===item.version?'已安装此版本':'安装此版本'}</button>${own?'<button type="button" class="button" data-workshop="uninstall">停用作品</button>':''}${item.canEdit?'<button type="button" class="button" data-workshop="edit">发布新版本</button>':''}${item.canRemove?'<button type="button" class="button danger" data-workshop="remove">下架作品</button>':''}</div><details class="workshop-source-details"><summary>查看完整源码 JSON</summary><pre tabindex="0">${esc(JSON.stringify(pkg,null,2))}</pre></details>`;
  }
  async function openDetail(id,version){
    const turn=++detailTurn,stamp=generation;selected=null;stopPreview();q('#workshop-detail-title').textContent='作品详情';q('#workshop-detail-content').textContent='正在读取…';detail.showModal();
    try{const result=await store.call('workshop.get',{id,...(version?{version:Number(version)}:{})},{signal:controller.signal});if(!current(stamp)||turn!==detailTurn||!detail.open)return;selected=result;showDetail();}
    catch(cause){if(current(stamp)&&turn===detailTurn)q('#workshop-detail-content').textContent=cause.message;}
  }
  function confirmAction(title,html,label){
    q('#workshop-confirm-title').textContent=title;q('#workshop-confirm-content').innerHTML=html;q('#workshop-confirm-accept').textContent=label;confirmDialog.returnValue='cancel';confirmDialog.showModal();
    return new Promise(resolve=>confirmDialog.addEventListener('close',()=>resolve(confirmDialog.returnValue==='accept'),{once:true}));
  }
  async function write(operation,args,success){
    if(busy||!available())return;const stamp=generation;busy=true;mineRequest++;mineLoading=false;error='';draw();
    try{const result=await store.call(operation,args,{signal:controller.signal});if(!current(stamp))return;if(result.installed){installed=result.installed;mineState='ready';runtime.setInstalled(installed);}stopPreview();toast(success);if(selected)showDetail();return result;}
    catch(cause){if(current(stamp)){error=`${cause.message} 请刷新核对结果。`;mineState='unknown';runtime.setInstalled([]);}}
    finally{if(current(stamp)){busy=false;draw();if(selected)showDetail();if(mineState==='unknown')void loadMine();}}
  }
  function editorTargets(target=''){
    q('#workshop-publish-target').innerHTML='<option value="">新作品</option>'+items.filter(item=>item.canEdit).map(item=>`<option value="${esc(item.id)}">${esc(item.name)} · 新版本</option>`).join('');
    if(target&&!items.some(item=>item.id===target&&item.canEdit)){const option=document.createElement('option');option.value=target;option.textContent=selected?.item.name||target;q('#workshop-publish-target').append(option);}
    q('#workshop-publish-target').value=target;
  }
  function updatePending(){
    for(const input of editor.querySelectorAll('textarea,input,select,[data-workshop="validate"]'))input.disabled=Boolean(pending)||busy;
    q('#workshop-publish').disabled=busy;q('#workshop-publish').textContent=pending?'重试原发布':'发布';
    q('#workshop-publish-status').textContent=pending?`发布结果待确认 · 原请求 ${pending.key}`:'';
  }
  function openEditor(pkg=null,id=''){
    stopPreview();detail.close();editorTargets(id);q('#workshop-publish-error').textContent='';q('#workshop-package-summary').replaceChildren();
    try{pending=JSON.parse(sessionStorage.getItem(pendingKey())||'null');}catch{pending=null;}
    if(pending){q('#workshop-source').value=JSON.stringify(pending.package,null,2);editorTargets(pending.id||'');}
    else if(pkg)q('#workshop-source').value=JSON.stringify(pkg,null,2);
    updatePending();editor.showModal();
  }
  function checkPackage(){
    const pkg=normalizeWorkshopPackage(JSON.parse(q('#workshop-source').value));
    q('#workshop-package-summary').innerHTML=`<h3>${esc(pkg.name)}</h3><p>${kindLabel(pkg.kind,pkg.presentation)} · ${new TextEncoder().encode(JSON.stringify(pkg)).byteLength} 字节 · 尚未执行</p>${permissionHTML(pkg)}`;
    q('#workshop-publish-error').textContent='';return pkg;
  }
  q('#workshop-publish-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!available())return;const stamp=generation;busy=true;
    try{
      if(!pending){const pkg=checkPackage(),id=q('#workshop-publish-target').value;pending={key:crypto.randomUUID(),...(id?{id}:{}),package:pkg};try{sessionStorage.setItem(pendingKey(),JSON.stringify(pending));}catch{pending=null;throw Error('无法保存原发布编号，尚未发送。请允许浏览器会话存储。');}}
      updatePending();const result=await store.call('workshop.publish',pending,{signal:controller.signal});if(!current(stamp))return;
      sessionStorage.removeItem(pendingKey());pending=null;q('#workshop-publish-status').textContent='';editor.close();toast('作品已发布；安装需另行确认。');await loadList();selected=result;showDetail();detail.showModal();
    }catch(cause){if(current(stamp)){q('#workshop-publish-error').textContent=pending&&!cause.status?'发布结果待确认，请点击“重试原发布”。':cause.message;if([400,403,404,410,413].includes(cause.status)){sessionStorage.removeItem(pendingKey());pending=null;}}}
    finally{if(current(stamp)){busy=false;updatePending();draw();if(selected)showDetail();}}
  });
  q('#workshop-example').addEventListener('change',event=>{const example=WORKSHOP_EXAMPLES.find(value=>value.id===event.target.value);if(example){q('#workshop-source').value=JSON.stringify(example.package,null,2);q('#workshop-package-summary').replaceChildren();}});
  q('#workshop-file').addEventListener('change',async event=>{
    const file=event.target.files[0],stamp=generation;if(!file)return;
    try{if(file.size>WORKSHOP_PACKAGE_BYTES)throw Error('作品不能超过 128 KiB。');const source=await file.text();if(!current(stamp)||pending)return;q('#workshop-source').value=source;checkPackage();}catch(cause){if(current(stamp))q('#workshop-publish-error').textContent=cause.message;}
  });
  q('#workshop-search').addEventListener('input',draw);q('#workshop-kind').addEventListener('change',draw);
  detail.addEventListener('close',()=>{detailTurn++;stopPreview();});
  async function handleClick(event){
    const button=event.target.closest('[data-workshop]');if(!button||button.disabled||!available())return;const action=button.dataset.workshop,stamp=generation;
    try{
      if(action==='refresh'){error='';await Promise.all([loadMine(),loadList()]);if(selected)showDetail();}
      else if(action==='detail')await openDetail(button.dataset.id,button.dataset.version);
      else if(action==='close-detail')detail.close();
      else if(action==='create')openEditor();
      else if(action==='close-editor')editor.close();
      else if(action==='validate')checkPackage();
      else if(action==='edit'&&selected)openEditor(selected.package,selected.item.id);
      else if(action==='preview'&&selected){runtime.previewTheme(selected.package);previewing=true;draw();}
      else if(action==='stop-preview')stopPreview();
      else if(action==='install'&&selected){const {item,package:pkg}=selected;if(await confirmAction(`安装 ${item.name}？`,`<p>固定版本 v${esc(versionLabel(item.version))} · ${esc(item.author.name||item.author.username)}</p>${permissionHTML(pkg)}<p>${pkg.kind==='theme'?'替换本人当前主题，不影响其他成员。':pkg.presentation==='interface'?'安装后自动替换整个可见界面，替换本人已安装的其他整站界面。按 Ctrl + Alt + 0 恢复平台界面，不影响真实训练。':'只安装信任作者的插件。插件将获得以上数据与能力，并在自己的工作台运行。'}</p>`,'授权并安装')&&current(stamp)){const result=await write('workshop.install',{id:item.id,version:item.version,permissions:pkg.permissions||[]},'已安装，工作台已更新。');if(result&&pkg.presentation==='interface'){detail.close();selected=null;}}}
      else if(action==='uninstall'&&selected)await write('workshop.uninstall',{id:selected.item.id},'已停用作品。');
      else if(action==='remove'&&selected){const item=selected.item;if(await confirmAction(`下架 ${item.name}？`,'<p>所有使用者都会停用此作品，已发布的版本将不再可安装。</p>','下架并停用')&&current(stamp)){const result=await write('workshop.remove',{id:item.id},'作品已下架。');if(result){detail.close();selected=null;await Promise.all([loadList(),loadMine()]);}}}
    }catch(cause){if(current(stamp)){if(editor.open)q('#workshop-publish-error').textContent=cause.message;else{error=cause.message;draw();}}}
  }
  host.addEventListener('click',handleClick);dialogs.addEventListener('click',handleClick);
  recovery.querySelector('button').addEventListener('click',async()=>{
    if(!available())return;const stamp=generation;if(await confirmAction('恢复默认界面？','<p>停用本人安装的全部主题和插件，不删除已发布作品，也不影响训练。</p>','恢复默认')&&current(stamp)){runtime.previewTheme(null);runtime.setInstalled([]);previewing=false;await write('workshop.reset',{},'已恢复默认界面。');}
  });
  return {openNativeProject:detail=>nativeView.isOpen()?nativeView.open({view:'project',project:detail}):null,render(nextActive){
    if(actor!==identity())resetSession();
    if(!runtime&&available())runtime=createWorkshopRuntime({store,root:widgets,navigate,toast,nativeView,exitInterface:async id=>{detail.close();selected=null;await write('workshop.uninstall',{id},'已恢复平台界面。');}});
    if(!nextActive&&active){detail.close();editor.close();stopPreview();}
    const entered=nextActive&&!active;active=nextActive;
    if(available()){if(!mineAt||Date.now()-mineAt>60000)void loadMine();if(active&&(entered||listState==='idle'))void loadList();}
    runtime?.update();draw();
  },destroy(){controller.abort();runtime?.destroy();nativeView.destroy();dialogs.remove();}};
}
