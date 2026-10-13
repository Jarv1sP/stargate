import {escapeUI as esc,serverSelectLabel,containerContextPrompt} from './workbench-ui.js';
import {controlUI,sessionStatus} from './control-ui.js';
import {sharedObject,captureObject} from './motion-ui.js';
import {roomForPage,roomOrder} from './navigation.js';
import {hasAdminSections} from './admin-ui.js';

const rank=page=>{const index=roomOrder.indexOf(roomForPage(page));return index<0?roomOrder.length:index;};
export function shellUI(store,{navigate,getPage,toast}){
  const q=selector=>document.querySelector(selector),account=q('#account-menu'),nav=q('#room-nav'),context=q('#shell-context');
  const reduced=()=>matchMedia('(prefers-reduced-motion:reduce)').matches,phone=()=>matchMedia('(max-width:759px)').matches;
  let page=null,roomAnimation=null,headingAnimation=null,ghost=null,contextActor=null,notice='',phoneAction=null,phoneActionPlace=null;
  const scrolls=new Map(),routeSlides=new Map(),indicator=document.createElement('span');indicator.className='nav-indicator';indicator.setAttribute('aria-hidden','true');nav.prepend(indicator);nav.classList.add('has-indicator');
  const control=controlUI(store,{navigate,getPage,toast,openSubmit:()=>document.dispatchEvent(new CustomEvent('gpuq-open-submit')),openJob:(id,view='overview',origin)=>document.dispatchEvent(new CustomEvent('gpuq-open-job',{detail:{id,view,origin}}))});
  function syncContext(){
    const machine=q('[name=workspace-machine]'),project=q('[name=workspace-project]'),active=getPage();
    context.hidden=!store.principal||!machine||!['work','datasets','transfers'].includes(active);
    for(const [original,target] of [[machine,q('#context-machine')],[project,q('#context-project')]]){if(!original)continue;if(target.innerHTML!==original.innerHTML)target.innerHTML=original.innerHTML;target.value=original.value;target.disabled=original.disabled;target.title=original.selectedOptions[0]?.textContent||original.value;}
    const choice=project?.selectedOptions?.[0],selector=q('#context-machine'),prompt=containerContextPrompt({environmentMode:active==='work'?choice?.dataset.environmentMode:undefined,trainingTarget:q('[name=training-target]')?.value,source:choice?.dataset.machine,focus:machine?.value});
    if(selector){
      const empty=selector.querySelector('option[value=""]');if(empty)empty.textContent=prompt.empty;
      const caption=[...selector.closest('label').childNodes].find(node=>node.nodeType===Node.TEXT_NODE);if(caption)caption.textContent=prompt.label;
      selector.setAttribute('aria-label',prompt.ariaLabel);
      selector.toggleAttribute('data-training-context',prompt.label==='训练');
    }
    serverSelectLabel(selector);if(selector)selector.title=prompt.title;
    const projectLabel=q('#context-project')?.closest('label'),projectCaption=projectLabel&&[...projectLabel.childNodes].find(node=>node.nodeType===Node.TEXT_NODE);
    if(projectCaption){projectLabel.dataset.originalCaption??=projectCaption.textContent;projectCaption.textContent=prompt.label==='训练'?'项目':projectLabel.dataset.originalCaption;}
    q('#context-note').textContent=project?.value?'项目':'个人工作区';
    if(active==='work'&&store.principal){const choice=project?.selectedOptions[0],source=choice?.dataset.machine||machine?.value;q('#page-title').textContent=choice?.dataset.project||'个人工作区';q('#page-description').textContent=source?source+' · '+(project?.value?'项目':'个人工作区'):'选择我的项目，或新建个人容器。';}
  }
  for(const [proxy,name] of [['#context-machine','workspace-machine'],['#context-project','workspace-project']])q(proxy).addEventListener('change',event=>{const original=q(`[name=${name}]`);if(original){original.value=event.target.value;original.dispatchEvent(new Event('change',{bubbles:true}));}});
  document.addEventListener('gpuq-workspace-context',event=>{if(event.detail.userId!==store.principal?.userId)return;queueMicrotask(syncContext);});
  document.addEventListener('gpuq-workspace-rendered',syncContext);
  document.addEventListener('change',event=>{if(event.target.matches('[name=training-target]'))queueMicrotask(syncContext);});
  document.addEventListener('click',event=>{
    if(!account.contains(event.target))account.open=false;
    const action=event.target.closest('[data-shell-action]')?.dataset.shellAction;
    if(action==='profile'){q('#edit-profile').click();account.open=false;}
    if(action==='logout'){q('#switch-account').click();account.open=false;}
    if(action==='new-project'){navigate('work');const target=q('#project-create');if(target){target.open=true;target.scrollIntoView({block:'center',behavior:'instant'});target.querySelector('input')?.focus();}}
    if(action==='terminal')q('#terminal-open')?.click();
    if(action==='admin'){navigate('admin');account.open=false;}
    if(action==='guide')q('.guide-link').click();
    if(action==='files'){navigate('work');const target=q('#workspace-files');if(target){target.open=true;target.scrollIntoView({block:'center',behavior:'instant'});}}
    if(event.target.closest('#edit-profile,#switch-account'))account.open=false;
    const server=event.target.closest('[data-use-machine]');if(server){const name=server.closest('[data-resource-machine],[data-resource-selected]')?.querySelector('h2')||q(`[data-resource-machine="${CSS.escape(server.dataset.useMachine)}"] h2`),from=captureObject(name);queueMicrotask(()=>{if(q('#context-machine')?.value===server.dataset.useMachine)sharedObject(from,q('#context-machine'));});}
  });
  function updateIndicator(animate=false){
    const selected=nav.querySelector('.nav-item.active');if(!selected||phone()){indicator.hidden=true;return;}
    indicator.hidden=false;const rect=selected.getBoundingClientRect(),parent=nav.getBoundingClientRect(),previous=indicator.getBoundingClientRect();
    indicator.style.left=rect.left-parent.left+'px';indicator.style.top=rect.top-parent.top+'px';indicator.style.width=rect.width+'px';indicator.style.height=rect.height+'px';
    if(animate&&!reduced()&&previous.width)indicator.animate([{transform:`translateX(${previous.left-rect.left}px) scaleX(${previous.width/rect.width})`},{transform:'none'}],{duration:220,easing:'cubic-bezier(.2,0,0,1)'});
  }
  function syncNavigation(){
    const active=roomForPage(getPage()),selected=phone()?({maintenance:'me',admin:'me'}[active]||active):active;
    for(const item of nav.querySelectorAll('[data-nav]')){const current=item.dataset.nav===selected;item.classList.toggle('active',current);if(current)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');}
  }
  function markDesktopSlide(target,animation){
    if(phone()||reduced())return;
    target.classList.add('desktop-route-slide');routeSlides.set(target,animation);
    const clear=()=>{if(routeSlides.get(target)===animation){routeSlides.delete(target);target.classList.remove('desktop-route-slide');}};
    animation.finished.then(clear,clear);
  }
  function route(next,apply){
    const previous=getPage();if(previous===next){apply();return;}
    document.dispatchEvent(new CustomEvent('gpuq-route-leaving',{detail:{previous,next}}));
    scrolls.set(previous,scrollY);roomAnimation?.cancel();headingAnimation?.cancel();ghost?.remove();
    if(roomForPage(previous)===roomForPage(next)){
      for(const [target,animation] of routeSlides){animation.cancel();target.classList.remove('desktop-route-slide');}routeSlides.clear();
      apply();scrollTo({top:scrolls.get(next)||0,behavior:'instant'});return;
    }
    const outgoing=q(`[data-page="${CSS.escape(previous)}"]`),rect=outgoing?.getBoundingClientRect(),direction=rank(next)>=rank(previous)?1:-1;
    if(outgoing&&rect.height&&!phone()&&!reduced()){
      ghost=outgoing.cloneNode(true);ghost.removeAttribute('id');ghost.removeAttribute('data-page');ghost.setAttribute('aria-hidden','true');ghost.inert=true;ghost.classList.add('room-ghost');
      const originals=[outgoing,...outgoing.querySelectorAll('*')];for(const [index,element] of [ghost,...ghost.querySelectorAll('*')].entries()){element.removeAttribute('style');for(const name of originals[index].style)element.style.setProperty(name,originals[index].style.getPropertyValue(name));for(const attr of [...element.attributes])if(['id','name','form'].includes(attr.name)||attr.name.startsWith('data-')||attr.name.startsWith('on'))element.removeAttribute(attr.name);}
      // Transition ghosts are pictures, not another plugin instance. inert does
      // not prevent a cloned iframe from loading or executing its own scripts.
      const originalFrames=outgoing.querySelectorAll('iframe');
      for(const [index,frame] of [...ghost.querySelectorAll('iframe')].entries()){
        const size=originalFrames[index].getBoundingClientRect(),placeholder=document.createElement('div');
        placeholder.className=frame.className;placeholder.style.width=size.width+'px';placeholder.style.height=size.height+'px';frame.replaceWith(placeholder);
      }
      const clone=ghost,layer=document.createElement('div');layer.className='room-transition-layer';layer.setAttribute('aria-hidden','true');layer.inert=true;
      clone.style.position='absolute';clone.style.left=rect.left+'px';clone.style.top=rect.top+'px';clone.style.width=rect.width+'px';layer.append(clone);document.body.append(layer);ghost=layer;
      const title=captureObject(q('.page-heading'));if(title){const heading=title.element;heading.style.position='absolute';heading.style.left=title.rect.left+'px';heading.style.top=title.rect.top+'px';heading.style.width=title.rect.width+'px';layer.append(heading);heading.animate([{opacity:1,transform:'none'},{opacity:0,transform:`translateX(${-direction*24}px)`}],{duration:180,easing:'cubic-bezier(.4,0,1,1)'});}
      const exit=clone.animate([{opacity:1,transform:'translateX(0)'},{opacity:0,transform:`translateX(${-direction*24}px)`}],{duration:180,easing:'cubic-bezier(.4,0,1,1)'});exit.finished.then(()=>layer.remove(),()=>layer.remove());
    }
    apply();scrollTo({top:scrolls.get(next)||0,behavior:'instant'});
    const incoming=q(`[data-page="${CSS.escape(next)}"]`);
    if(incoming){roomAnimation=incoming.animate(phone()||reduced()?[{opacity:0},{opacity:1}]:[{opacity:0,transform:`translateX(${direction*24}px)`},{opacity:1,transform:'none'}],{duration:reduced()?150:phone()?200:280,delay:phone()||reduced()?0:60,easing:'cubic-bezier(.2,.8,.2,1)'});markDesktopSlide(incoming,roomAnimation);}
    headingAnimation=q('.page-heading').animate(phone()||reduced()?[{opacity:0},{opacity:1}]:[{opacity:0,transform:`translateX(${direction*24}px)`},{opacity:1,transform:'none'}],{duration:reduced()?150:phone()?200:280,delay:phone()||reduced()?0:60,easing:'cubic-bezier(.2,.8,.2,1)'});
    markDesktopSlide(q('.page-heading'),headingAnimation);
    updateIndicator(true);
  }
  function updateMobileAction(){
    if(phoneAction&&(!phone()||getPage()!=='work')){phoneActionPlace?.after(phoneAction);phoneActionPlace?.remove();phoneActionPlace=null;phoneAction=null;}
    const action=q('#open-submit'),headingControl=q('.heading-actions [data-shell-action=control]');if(headingControl)headingControl.hidden=phone()&&!q('#mobile-control').hidden;
    if(phone()&&getPage()==='work'&&action){if(!phoneAction){phoneActionPlace=document.createComment('workbench primary action');action.before(phoneActionPlace);phoneAction=action;q('#mobile-control').append(action);}action.hidden=!store.principal;}
  }
  function updateBottomReserve(){
    const scale=document.body.getBoundingClientRect().width/document.body.offsetWidth||1;
    const targets=[q('#control-strip'),q('#mobile-control'),nav].filter(node=>node&&!node.hidden&&getComputedStyle(node).position==='fixed'&&node.getClientRects().length);
    const occupied=targets.reduce((value,node)=>Math.max(value,innerHeight-node.getBoundingClientRect().top),0);
    const reserve=occupied>0?Math.ceil((occupied+20)/scale):0;
    document.body.style.setProperty('--bottom-reserve',reserve+'px');
  }
  const reserveObserver=new ResizeObserver(updateBottomReserve);
  for(const node of [q('#control-strip'),q('#mobile-control'),nav])if(node)reserveObserver.observe(node);
  new MutationObserver(updateBottomReserve).observe(q('#control-strip'),{attributes:true,attributeFilter:['hidden']});
  new MutationObserver(updateBottomReserve).observe(q('#mobile-control'),{attributes:true,attributeFilter:['hidden']});
  addEventListener('resize',updateBottomReserve);
  function renderMe(){
    const user=store.users.find(row=>row.id===store.principal?.userId),snapshot=control.snapshot(),host=q('#me-content');
    if(!user){host.textContent='登录后查看自己的账号和工作区。';return;}
    host.innerHTML=`<section class="me-hero hero-frame"><span class="hero-label">我的账号</span><h2 class="disp">${esc(user.name||user.username)}</h2><p class="mono">${esc(user.username)} · ${user.role==='admin'?'管理员':'成员'}</p><div class="me-telemetry"><div><span class="label">${snapshot.quotaReadout.exempt?'已占用':'额度占用 / 上限'}</span><strong>${snapshot.quotaReadout.value} <small>张</small></strong>${snapshot.quotaReadout.exempt?'<span class="wb-telemetry-note">不限个人额度</span>':''}</div><div><span class="label">已授权服务器</span><strong>${snapshot.servers.length} <small>台</small></strong></div></div></section><div class="me-actions"><button type="button" class="button quiet" data-shell-action="profile" ${q('#edit-profile').hidden?'hidden':''}>设置姓名</button><button type="button" class="button quiet" data-shell-action="files">个人工作区与文件</button><button type="button" class="button quiet" data-shell-action="control">会话与后台任务</button>${store.principal?.role==='admin'&&hasAdminSections()?'<button type="button" class="button quiet" data-shell-action="admin">管理后台</button>':''}<button class="button quiet" type="button" data-shell-action="guide">使用指南</button><button type="button" class="button quiet" data-shell-action="logout">退出登录</button></div>${snapshot.sessions.length?'<h3 class="me-section-title">保留的终端会话</h3>'+snapshot.sessions.map(session=>`<article class="mc-row"><span class="mono">${esc(session.machine)} · ${esc(session.project||'个人工作区')}</span><p class="muted">${esc(sessionStatus(session))}</p><code class="control-full-id">${esc(session.id)}</code><button type="button" class="button quiet" data-control-session="${esc(session.id)}">${session.detached?'重连':'展开'}终端</button></article>`).join(''):''}`;
  }
  function update(){
    if(contextActor!==store.principal?.userId){contextActor=store.principal?.userId;scrolls.clear();context.hidden=true;}
    const changed=page!==null&&roomForPage(page)!==roomForPage(getPage());page=getPage();document.body.dataset.room=roomForPage(page);
    q('#account-avatar').textContent=(store.users.find(user=>user.id===store.principal?.userId)?.name||store.principal?.username||'S').slice(0,1);
    if(notice!==q('#mode-note').textContent)notice=q('#mode-note').textContent;
    syncContext();syncNavigation();control.update();updateMobileAction();updateBottomReserve();renderMe();updateIndicator(changed);
    if(page==='work')q('#page-title').classList.add('work-project-title');else q('#page-title').classList.remove('work-project-title');
  }
  function syncStatus(state,time){q('#sync-label').textContent=state==='syncing'?'正在同步':state==='failed'?'同步失败，保留已确认状态':'已同步 '+new Date(time||Date.now()).toLocaleTimeString('zh-CN',{hour12:false});q('#refresh-state').title=q('#sync-label').textContent;}
  const clearGhosts=()=>{roomAnimation?.cancel();headingAnimation?.cancel();ghost?.remove();for(const layer of document.querySelectorAll('.object-transition-layer'))layer.remove();};
  addEventListener('resize',()=>{clearGhosts();syncNavigation();control.update();updateMobileAction();updateIndicator();});
  store.onAuthChange(()=>{clearGhosts();control.close(true);account.open=false;scrolls.clear();context.hidden=true;});
  requestAnimationFrame(()=>{const initial=q('[data-page]:not([hidden])');initial?.animate([{opacity:0},{opacity:1}],{duration:reduced()?150:220,easing:'linear'});});
  return {update,route,syncStatus,control};
}
