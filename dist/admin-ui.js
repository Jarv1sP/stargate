// Section modules own their requests and controls. The frame owns access and lifetime.
export const ADMIN_SECTIONS=Object.freeze([
  {id:'members',title:'成员与额度',order:10},
  {id:'maintenance',title:'维护模式',order:20},
  {id:'cloud',title:'云盘连接',order:30},
].map(Object.freeze));
const validId=id=>typeof id==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(id);
export function createAdminRegistry(){
  const sections=new Map(),listeners=new Set();
  const notify=()=>{for(const listener of listeners)listener();};
  return {
    register(section){
      if(!section||!validId(section.id)||typeof section.mount!=='function'||!Number.isFinite(section.order)||
        section.unmount!==undefined&&typeof section.unmount!=='function')throw new TypeError('无效的后台区块');
      const title=section.title??ADMIN_SECTIONS.find(row=>row.id===section.id)?.title;
      if(typeof title!=='string'||!title.trim())throw new TypeError('后台区块需要标题');
      if(sections.has(section.id))throw new Error('后台区块已注册：'+section.id);
      const definition=Object.freeze({...section,title});sections.set(section.id,definition);notify();
      return ()=>{if(sections.get(section.id)!==definition)return;sections.delete(section.id);notify();};
    },
    list(){return [...sections.values()].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));},
    get:id=>sections.get(id),
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  };
}
const registry=createAdminRegistry();
export const registerAdminSection=section=>registry.register(section);
export const hasAdminSections=()=>registry.list().length>0;
export const onAdminSectionsChange=listener=>registry.subscribe(listener);
export function adminSectionForRoute(route){
  const value=String(route??'').replace(/^#/,'');
  return /^admin\/[a-z][a-z0-9-]{0,63}$/.test(value)?value.slice(6):ADMIN_SECTIONS[0].id;
}
export const adminHashForRoute=route=>String(route??'').replace(/^#/,'')==='admin'?'#admin':'#admin/'+adminSectionForRoute(route);

export function createAdminUI(store,{getPage,navigate,toast},sections=registry){
  const q=selector=>document.querySelector(selector),root=q('#page-admin'),frame=q('#admin-frame'),denied=q('#admin-denied'),content=q('#admin-content');
  const mounted=new Map();let selectedSection=null,scrolledRoute=null;
  const identity=()=>JSON.stringify([store.principal?.userId,store.principal?.role,store.authGeneration]);
  const permitted=()=>!!store.principal&&store.principal.role==='admin'&&!store.authPending;
  function stop(id){
    const previous=mounted.get(id);if(!previous)return;mounted.delete(id);
    previous.controller.abort(new DOMException('后台区块已关闭','AbortError'));previous.listeners.clear();
    try{previous.definition.unmount?.();}catch{console.warn('后台区块卸载未完成');}
    previous.el.remove();
  }
  function stopAll(){for(const id of [...mounted.keys()])stop(id);selectedSection=null;scrolledRoute=null;}
  function mount(definition,key,index){
    const controller=new AbortController(),el=document.createElement('section'),listeners=new Set();el.className='admin-section-host';el.id='admin-section-'+definition.id;el.dataset.adminSection=definition.id;
    content.insertBefore(el,content.children[index]||null);
    const entry={definition,key,controller,el,listeners};mounted.set(definition.id,entry);
    const current=()=>mounted.get(definition.id)===entry&&!controller.signal.aborted&&permitted()&&getPage()==='admin'&&identity()===key;
    const ctx=Object.freeze({store,signal:controller.signal,principal:Object.freeze({...store.principal}),
      toast:message=>{if(current())toast(message);},navigate:route=>{if(current())navigate(route);},
      subscribe(listener){if(typeof listener!=='function')throw new TypeError('需要更新函数');if(!current())return()=>{};listeners.add(listener);listener();return()=>listeners.delete(listener);},
    });
    const failed=()=>{if(!current())return;const message=document.createElement('p'),retry=document.createElement('button');
      message.textContent='暂时无法显示这个区块。';retry.type='button';retry.className='button quiet';retry.textContent='重新打开';
      retry.addEventListener('click',()=>{if(current()){stop(definition.id);update();}});el.replaceChildren(message,retry);};
    try{Promise.resolve(definition.mount(el,ctx)).catch(failed);}catch{failed();}
  }
  function update(){
    const active=getPage()==='admin',allowed=permitted(),rows=sections.list();
    if(!active||!allowed){stopAll();content.replaceChildren();}
    frame.hidden=!allowed||!rows.length;denied.hidden=allowed;
    if(!active||!allowed)return;
    if(!rows.length){stopAll();navigate('work');return;}
    const key=identity();
    for(const [id,entry] of mounted)if(entry.key!==key||sections.get(id)!==entry.definition)stop(id);
    for(const [index,definition] of rows.entries()){
      const entry=mounted.get(definition.id);
      if(!entry){mount(definition,key,index);continue;}
      if(content.children[index]!==entry.el)content.insertBefore(entry.el,content.children[index]||null);
      for(const listener of entry.listeners){try{listener();}catch{console.warn('后台区块更新未完成');}}
    }
    const requested=location.hash==='#admin'?null:adminSectionForRoute(location.hash),id=sections.get(requested)?requested:rows[0].id;selectedSection=id;root.dataset.adminCurrentSection=id;
    if(requested&&!sections.get(requested))history.replaceState(null,'','#admin/'+id);
    if(!root.hidden&&scrolledRoute!==location.hash){scrolledRoute=location.hash;mounted.get(id)?.el.scrollIntoView({block:'start',behavior:'instant'});}
  }
  const unsubscribe=sections.subscribe(update),authCleanup=store.onAuthChange?.(()=>{stopAll();frame.hidden=true;denied.hidden=false;});
  return {update,dispose(){stopAll();unsubscribe();authCleanup?.();},currentSection:()=>selectedSection};
}
