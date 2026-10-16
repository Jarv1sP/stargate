import {quotaLedgerHTML} from './workbench-ui.js';
import {controlUI} from './control-ui.js';
import {roomForPage} from './navigation.js';
import {reducedMotion} from './motion-ui.js';
import {skyReading} from './sky-ui.js';
import {installWordmark} from './startup-ui.js';

export function shellUI(store,{navigate,getPage,toast}){
  const q=selector=>document.querySelector(selector),account=q('#account-menu'),nav=q('#room-nav');
  const indicator=document.createElement('span');indicator.className='nav-indicator';indicator.setAttribute('aria-hidden','true');nav.prepend(indicator);
  const control=controlUI(store,{navigate,toast,openSubmit:()=>{navigate('jobs');q('#jobs-new')?.click();},openJob:id=>{navigate('jobs');document.dispatchEvent(new CustomEvent('sg-open-job',{detail:{id}}));}});
  const scrolls=new Map();let entrance=[],underline;
  function updateIndicator(){
    const selected=nav.querySelector('[aria-current=page]');indicator.hidden=!selected||matchMedia('(max-width:759px)').matches;if(indicator.hidden)return;
    // As in the approved design the bar is as wide as the label, not the whole item.
    const box=selected.getBoundingClientRect(),parent=nav.getBoundingClientRect(),inset=parseFloat(getComputedStyle(selected).paddingLeft)||0;indicator.style.width=Math.max(0,box.width-inset*2)+'px';indicator.style.transform=`translateX(${box.left-parent.left+inset}px)`;
  }
  function update(){
    const page=getPage(),room=roomForPage(page);document.body.dataset.room=room;
    for(const item of nav.querySelectorAll('[data-nav]')){const active=item.dataset.nav===room;item.classList.toggle('active',active);if(active)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');}
    q('#account-avatar').textContent=(store.users.find(user=>user.id===store.principal?.userId)?.name||store.principal?.username||'S').slice(0,1);
    q('[data-shell-action=quota]').hidden=!store.principal;q('.help-links').hidden=true;
    if(page==='me')q('#me-content').innerHTML=store.principal?quotaLedgerHTML(store):'<p>登录后查看我的额度。</p>';
    control.update();updateIndicator();
  }
  function route(next,apply){
    const previous=getPage();if(next===previous){apply();return;}
    document.dispatchEvent(new CustomEvent('gpuq-route-leaving',{detail:{previous,next}}));scrolls.set(previous,scrollY);
    const before=indicator.getBoundingClientRect();for(const animation of entrance)animation.cancel();underline?.cancel();apply();scrollTo({top:scrolls.get(next)||0,behavior:'instant'});
    document.dispatchEvent(new CustomEvent('gpuq-route-entered',{detail:{previous,next}}));
    if(reducedMotion())return;
    // Rooms enter as in the approved design: the heading and the first blocks rise in turn.
    const target=q(`[data-page="${CSS.escape(next)}"]`);
    if(target){let root=target;while(root.children.length===1)root=root.firstElementChild;const heading=q('.page-heading'),blocks=[...(heading&&getComputedStyle(heading).display!=='none'?[heading]:[]),...[...root.children].filter(node=>!node.hidden&&node.tagName!=='DIALOG')].slice(0,5);
      entrance=blocks.map((node,index)=>node.animate([{opacity:0,transform:'translateY(12px)'},{opacity:1,transform:'none'}],{duration:600,delay:index*50,easing:'cubic-bezier(.16,1,.3,1)',fill:'backwards'}));}
    const after=indicator.getBoundingClientRect();if(before.width&&after.width&&!indicator.hidden)underline=indicator.animate([{transform:`translateX(${before.left-nav.getBoundingClientRect().left}px) scaleX(${before.width/after.width})`},{transform:indicator.style.transform}],{duration:500,easing:'cubic-bezier(.34,1.32,.5,1)'});
  }
  document.addEventListener('click',event=>{
    if(!account.contains(event.target))account.open=false;
    const action=event.target.closest('[data-shell-action]')?.dataset.shellAction;
    if(action==='quota'){navigate('me');account.open=false;}
    if(action==='admin'){navigate('admin');account.open=false;}
    if(event.target.closest('#edit-profile,#switch-account,.guide-link'))account.open=false;
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&account.open){account.open=false;q('#account-menu-toggle').focus();}});
  function sky(){const reading=skyReading();q('#sky-utc').textContent=reading.utc;q('#sky-utc').dateTime=new Date().toISOString();q('#sky-moon-label').textContent=reading.moon;q('#sky-moon-path').setAttribute('d',reading.path);q('#sky-mars').textContent=reading.mars;}
  sky();setInterval(()=>{if(!document.hidden)sky();},1000);
  addEventListener('scroll',()=>q('#app-topbar')?.classList.toggle('scrolled',scrollY>4),{passive:true});
  installWordmark();new ResizeObserver(updateIndicator).observe(nav);addEventListener('resize',()=>{for(const animation of entrance)animation.cancel();underline?.cancel();updateIndicator();});document.fonts?.ready.then(updateIndicator);
  matchMedia('(prefers-reduced-motion:reduce)').addEventListener('change',event=>{if(event.matches){for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();q('#startup-wordmark').hidden=true;}});
  store.onAuthChange(()=>{control.close();account.open=false;scrolls.clear();});
  return {update,route,control,syncStatus(state,time){q('#sync-label').textContent=state==='syncing'?'正在同步':state==='failed'?'同步失败，请刷新':'已同步 '+new Date(time||Date.now()).toLocaleTimeString('zh-CN',{hour12:false});q('#refresh-state').title=q('#sync-label').textContent;}};
}
