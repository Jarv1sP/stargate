// Unread @mentions pop up like an announcement. The server keeps the unread
// list: "我知道了" clears it there, "稍后再看" only quiets this page.
import {chatSegments} from './chat-content.js';
import {renderChatMentionBadge} from './community-ui.js';
const SHOWN=5;
const date=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'时间未知';};
export function createMentionPopup(store,{openChat,chatOpen}){
  const dialog=document.createElement('dialog');dialog.id='mention-dialog';dialog.className='mention-dialog';
  dialog.setAttribute('aria-labelledby','mention-title');dialog.setAttribute('aria-describedby','mention-meta');
  dialog.innerHTML='<header><h2 id="mention-title">有人在聊天室 @ 了你</h2><p id="mention-meta"></p></header><ol id="mention-list" tabindex="0"></ol><p id="mention-error" role="status"></p><footer><button class="button" id="mention-later" type="button">稍后再看</button><button class="button" id="mention-ack" type="button">我知道了</button><button class="button primary" id="mention-open" type="button">去聊天室</button></footer>';
  document.body.append(dialog);
  const q=selector=>dialog.querySelector(selector);
  // fetched: the unread count the cached list belongs to; seen: newest id already shown.
  let identity='',fetched=0,messages=[],total=0,seen=0,request=0;
  const actor=()=>store.principal?`${store.principal.userId}:${store.authGeneration||0}`:'';
  const unread=()=>Number(store.data?.chatMentions)||0;
  const top=()=>Number(messages[0]?.id)||0;
  function reset(){request++;fetched=0;messages=[];total=0;seen=0;if(dialog.open)dialog.close();}
  function close(){seen=Math.max(seen,top());q('#mention-error').textContent='';if(dialog.open)dialog.close();}
  function fill(){
    const list=q('#mention-list');list.replaceChildren();
    for(const item of messages.slice(0,SHOWN)){
      const row=document.createElement('li'),meta=document.createElement('p'),text=document.createElement('p');
      meta.className='mention-meta';meta.textContent=(item.author?.name||item.author?.username||'成员')+' · '+date(item.createdAt);
      text.className='mention-text';
      for(const part of chatSegments(item.body||'',store.users||[])){
        if(!part.user){text.append(part.text);continue;}
        const chip=document.createElement('span');chip.className='chat-mention'+(part.user.id===store.principal?.userId?' me':'');chip.textContent='@'+(part.user.name||part.user.username);chip.title=part.text;text.append(chip);
      }
      if(item.image)text.append((item.body?' ':'')+'[图片]');
      row.append(meta,text);list.append(row);
    }
    q('#mention-meta').textContent=total>SHOWN?`共 ${total} 条未读，下面是最新 ${SHOWN} 条。`:`${total} 条未读。`;
  }
  async function load(){
    const stamp=actor(),turn=++request,count=unread();fetched=count;
    try{
      const result=await store.call('community.chat.mentions',{});
      if(turn!==request||stamp!==actor())return;
      messages=result.messages||[];total=result.total||messages.length;sync();
    }catch{/* The nav badge still shows the count; retry when it changes. */}
  }
  function sync(){
    if(identity!==actor()){identity=actor();reset();}
    if(!identity)return;
    const count=unread();
    if(dialog.open){if(!count)close();return;}
    if(!count){fetched=0;messages=[];return;}
    if(chatOpen())return;
    if(count!==fetched){void load();return;}
    if(top()<=seen||document.hidden||document.querySelector('dialog[open]'))return;
    fill();q('#mention-error').textContent='';q('#mention-ack').disabled=false;dialog.showModal();q('#mention-open').focus();
  }
  q('#mention-later').addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  q('#mention-open').addEventListener('click',()=>{close();openChat();});
  q('#mention-ack').addEventListener('click',async()=>{
    const stamp=actor(),last=top();q('#mention-ack').disabled=true;q('#mention-error').textContent='';
    try{
      const result=await store.call('community.chat.read',{id:String(last)});
      if(stamp!==actor())return;
      if(store.data)store.data.chatMentions=result.chatMentions;fetched=result.chatMentions;renderChatMentionBadge(store);close();
    }catch(error){if(stamp===actor()){q('#mention-error').textContent=error.message;q('#mention-ack').disabled=false;}}
  });
  // Announcements and editors keep the top layer; show once they close.
  document.addEventListener('close',()=>queueMicrotask(sync),true);
  document.addEventListener('visibilitychange',sync);
  store.onAuthChange(()=>{identity='';reset();});
  return ()=>queueMicrotask(sync);
}
