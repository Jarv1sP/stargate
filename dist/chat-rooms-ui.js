// Private chat rooms: create one (platform admins), invite, remove and name room
// admins. The server decides who may do what; this dialog only offers the
// buttons that apply to the viewer's room role.
const ROLES={owner:'群主',admin:'管理员',member:'成员'};
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
function button(text,action,className='button'){const node=el('button',className,text);node.type='button';node.addEventListener('click',action);return node;}
const label=user=>user.name&&user.name!==user.username?`${user.name}（${user.username}）`:user.name||user.username||'成员';
export function createRoomDialog(store,{create,toast,onChange,onDelete}){
  const dialog=el('dialog','community-dialog chat-room-dialog');dialog.setAttribute('aria-labelledby','chat-room-dialog-title');
  dialog.innerHTML='<form><div class="modal-head"><h2 id="chat-room-dialog-title"></h2><button class="icon-button" type="button" data-room-close aria-label="关闭">×</button></div><label class="field" id="chat-room-name-field">名称<input name="name" maxlength="30" placeholder="例如：东方的太阳"></label><ul id="chat-room-member-list" class="chat-room-member-list"></ul><fieldset id="chat-room-invite"><legend>拉人进来</legend><div id="chat-room-candidates" class="chat-room-candidates"></div></fieldset><p class="form-error" id="chat-room-error" role="status"></p><div class="modal-actions"><button type="button" class="button" data-room-close>关闭</button><button type="submit" class="button primary" id="chat-room-submit"></button></div></form>';
  document.body.append(dialog);
  const q=selector=>dialog.querySelector(selector),form=q('form');
  const save=button('保存名称',()=>change('community.rooms.rename',{name:form.elements.name.value}));save.id='chat-room-rename';q('#chat-room-name-field').after(save);
  const remove=button('删除聊天室',async()=>{
    if(busy||!window.confirm(`确定删除「${current.name}」？里面的聊天记录和图片会一起删除，无法恢复。`))return;
    busy=true;remove.disabled=true;q('#chat-room-error').textContent='';
    try{const id=current.id;await store.call('community.rooms.delete',{room:id});dialog.close();toast('已删除聊天室。');onDelete(id);}catch(error){fail(error);}finally{busy=false;remove.disabled=false;}
  },'button danger');remove.id='chat-room-delete';q('.modal-actions').prepend(remove);
  let current=null,busy=false;
  const fail=error=>{q('#chat-room-error').textContent=error.message;};
  function candidates(exclude){
    const box=q('#chat-room-candidates');box.replaceChildren();
    const people=(store.users||[]).filter(user=>user.username&&user.enabled!==false&&!exclude.has(user.id)).sort((a,b)=>label(a).localeCompare(label(b),'zh-CN'));
    for(const user of people){const row=el('label'),box2=el('input');box2.type='checkbox';box2.name='invite';box2.value=user.id;row.append(box2,label(user));box.append(row);}
    if(!people.length)box.append(el('p','community-empty','所有成员都已在聊天室里。'));
    return people.length;
  }
  function render(){
    const creating=!current,mine=current?.role,manager=creating||mine==='owner'||mine==='admin';
    q('#chat-room-dialog-title').textContent=creating?'新建私密聊天室':`「${current.name}」成员与设置`;
    q('#chat-room-name-field').hidden=!manager;form.elements.name.value=current?.name||'';save.hidden=creating||!manager;remove.hidden=mine!=='owner';q('#chat-room-member-list').hidden=creating;q('#chat-room-error').textContent='';
    const list=q('#chat-room-member-list');list.replaceChildren();
    for(const member of current?.members||[]){
      const row=el('li'),who=el('span','chat-room-member',label(member));who.append(el('span','community-tag',ROLES[member.role]||'成员'));row.append(who);
      const actions=el('span','chat-room-member-actions');
      if(mine==='owner'&&member.role!=='owner')actions.append(button(member.role==='admin'?'取消管理员':'设为管理员',()=>change('community.rooms.members.role',{userId:member.id,role:member.role==='admin'?'member':'admin'}),'community-text-button'));
      if(member.role!=='owner'&&(mine==='owner'||mine==='admin'&&member.role==='member'))actions.append(button('移出',()=>{if(window.confirm(`确定把 ${label(member)} 移出「${current.name}」？`))change('community.rooms.members.remove',{userId:member.id});},'community-text-button danger'));
      row.append(actions);list.append(row);
    }
    q('#chat-room-invite').hidden=!manager;
    const open=manager?candidates(new Set(creating?[store.principal?.userId]:current.members.map(m=>m.id))):0;
    q('#chat-room-submit').hidden=!manager||!creating&&!open;q('#chat-room-submit').textContent=creating?'创建':'拉进聊天室';
  }
  async function change(operation,args){
    if(busy)return;busy=true;q('#chat-room-error').textContent='';
    try{const {room}=await store.call(operation,{room:current.id,...args});current=room;render();onChange(room);}catch(error){fail(error);}finally{busy=false;}
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    const invited=[...form.querySelectorAll('[name=invite]:checked')].map(box=>box.value);
    if(current&&!invited.length){
      const name=form.elements.name.value.trim();
      if(name!==current.name)return change('community.rooms.rename',{name});
      q('#chat-room-error').textContent='请先勾选要拉进来的人。';return;
    }
    busy=true;q('#chat-room-submit').disabled=true;q('#chat-room-error').textContent='';
    try{
      let room=current;
      if(!room){const name=form.elements.name.value.trim();if(!name)throw Error('请填写聊天室名称。');room=(await create('room','community.rooms.create',{name})).room;}
      if(invited.length)room=(await store.call('community.rooms.members.add',{room:room.id,userIds:invited})).room;
      const created=!current;current=room;onChange(room,created);
      if(created){dialog.close();toast(`已创建「${room.name}」。`);}else{render();toast('已拉进聊天室。');}
    }catch(error){fail(error);}finally{busy=false;q('#chat-room-submit').disabled=false;}
  });
  for(const node of dialog.querySelectorAll('[data-room-close]'))node.addEventListener('click',()=>dialog.close());
  return {
    open(room){current=room;form.reset();render();if(!dialog.open)dialog.showModal();(room?q('[data-room-close]'):form.elements.name).focus();},
    update(room){if(dialog.open&&current&&room?.id===current.id){current=room;render();}},
    close(){if(dialog.open)dialog.close();},
    remove(){dialog.remove();}
  };
}
