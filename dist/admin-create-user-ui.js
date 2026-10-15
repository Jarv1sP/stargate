import {copyHelp} from './copy-help-ui.js';

// Only the confirmed admin section mounts this form. Persist the username,
// never the password, before submitting a non-idempotent account request.
export function mountCreateUser(store,root,ctx,{active,canCreate,onCreated,toast}){
  const button=root.querySelector('[data-member-create]'),key='stargate.create-user.v1:'+ctx.principal.userId;
  if(globalThis.GPUQ_CENTRAL_IDENTITY){
    button.textContent='统一账号中心';
    button.addEventListener('click',()=>location.assign(new URL('/account',globalThis.GPUQ_CENTRAL_IDENTITY.portal).href),{signal:ctx.signal});
    return {render(){button.disabled=false;},dispose(){}};
  }
  const dialog=document.createElement('dialog');dialog.id='create-user-dialog';dialog.className='modal member-dialog compact';dialog.setAttribute('aria-labelledby','create-user-title');root.append(dialog);
  dialog.innerHTML=`<form id="create-user-form"><div class="modal-head"><div class="copy-caption"><h2 id="create-user-title">新建账号</h2>${copyHelp('新账号权限','新账号是普通成员，额度为 0。批准授权后才能使用服务器。')}</div><button type="button" class="icon-button" data-create-user-close aria-label="关闭">×</button></div><label class="field">用户名<input name="username" required minlength="2" maxlength="24" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label class="field">姓名<input name="name" maxlength="32" autocomplete="off"></label><label class="field">初始密码<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label><p class="form-error" role="alert" data-create-user-error></p><p role="status" data-create-user-state></p><div class="modal-actions"><button type="button" class="button" data-create-user-close>关闭</button><button type="button" class="button" data-create-user-query hidden>重新查询</button><button type="submit" class="button primary">创建账号</button></div></form>`;
  const form=dialog.querySelector('form'),status=dialog.querySelector('[data-create-user-state]'),error=dialog.querySelector('[data-create-user-error]'),query=dialog.querySelector('[data-create-user-query]');
  let pending=null,busy=false;
  try{const value=JSON.parse(localStorage.getItem(key));if(value&&typeof value.username==='string'&&value.username.length<=24)pending={username:value.username};}catch{}
  const current=()=>!ctx.signal.aborted&&active()&&!store.authPending&&store.principal?.role==='admin'&&store.principal.userId===ctx.principal.userId;
  function render(){
    button.disabled=!canCreate();button.title=button.disabled?'请先保存或撤销额度草稿。':'';
    for(const field of form.querySelectorAll('input'))field.disabled=busy||!!pending;
    if(pending)form.elements.username.value=pending.username;
    form.querySelector('[type=submit]').hidden=!!pending;form.querySelector('[type=submit]').disabled=busy;
    query.hidden=!pending;query.disabled=busy;status.textContent=pending?(busy?'正在确认 · ':'创建结果待确认 · ')+pending.username:'';
  }
  function clearPending(){try{localStorage.removeItem(key);}catch{}pending=null;}
  button.addEventListener('click',()=>{if(!current()||!canCreate())return;error.textContent='';render();dialog.showModal();},{signal:ctx.signal});
  dialog.addEventListener('click',event=>{if(event.target.closest('[data-create-user-close]'))dialog.close();},{signal:ctx.signal});
  dialog.addEventListener('close',()=>{form.reset();error.textContent='';},{signal:ctx.signal});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!current()||busy||pending||!canCreate())return;
    const fields=new FormData(form),username=String(fields.get('username')).trim(),name=String(fields.get('name')).trim();
    const request={username,password:fields.get('password'),role:'member',...(name?{name}:{})};
    error.textContent='';
    try{localStorage.setItem(key,JSON.stringify({username}));}catch{toast('浏览器未保存恢复记录，请记下用户名：'+username);}
    pending={username};busy=true;render();
    try{
      const result=await store.call('users.create',request);
      clearPending();
      if(!current())return;
      dialog.close();onCreated(result);toast('账号已创建 · 额度为 0');
    }catch(cause){
      // A complete 4xx response is a refusal; transport/5xx stays uncertain.
      if(cause.status>=400&&cause.status<500&&cause.status!==408)clearPending();
      if(current())error.textContent=pending?'请求已发出，结果未确认，请重新查询。':cause.message;
    }finally{
      request.password=null;form.elements.password.value='';busy=false;if(current())render();
    }
  },{signal:ctx.signal});
  query.addEventListener('click',async()=>{
    if(!current()||busy||!pending)return;busy=true;error.textContent='';render();
    try{
      await store.refresh();if(!current())return;
      const user=store.users.find(row=>row.username===pending.username);
      if(user){clearPending();dialog.close();onCreated(user);toast('账号已在列表中');}
      else error.textContent='目录中还没有这个账号，请稍后重新查询。';
    }catch(cause){if(current())error.textContent=cause.message;}
    finally{busy=false;if(current())render();}
  },{signal:ctx.signal});
  ctx.subscribe(()=>{if(current())render();});render();
  return {render,dispose(){dialog.close();form.reset();dialog.remove();}};
}
