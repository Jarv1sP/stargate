// The server selects recipients. This module only presents and acknowledges
// that selection; dismissing locally never fabricates a server read receipt.
import {applyAnnouncementAppearance} from './announcement-appearance.js';
export function createAnnouncementUI(store){
  const dialog=document.createElement('dialog');dialog.id='announcement-dialog';dialog.className='announcement-dialog';
  dialog.setAttribute('aria-labelledby','announcement-title');dialog.setAttribute('aria-describedby','announcement-body');
  dialog.innerHTML='<header><span id="announcement-type">公告</span><h2 id="announcement-title">公告</h2><p id="announcement-meta"></p></header><div id="announcement-body" tabindex="0"></div><p id="announcement-error" role="status"></p><footer><button class="button" id="announcement-later" type="button">稍后再看</button><button class="button primary" id="announcement-ack" type="button">我知道了</button></footer>';
  document.body.append(dialog);
  const q=selector=>dialog.querySelector(selector),deferred=new Set();
  let identity='',current=null,request=0,loading=false;
  const actor=()=>store.principal?`${store.principal.userId}:${store.authGeneration||0}`:'';
  const pending=()=>store.data?.announcements?.pending||[];
  const key=item=>`${item.id}:${item.revision}`;
  function clear(){request++;current=null;loading=false;dialog.close();q('#announcement-body').textContent='';q('#announcement-error').textContent='';}
  function later(){if(current)deferred.add(key(current));clear();}
  async function show(item){
    const stamp=actor(),turn=++request;current={...item};loading=true;
    q('#announcement-title').textContent='正在读取公告…';q('#announcement-body').textContent='';q('#announcement-meta').textContent='';q('#announcement-error').textContent='';q('#announcement-ack').disabled=true;
    dialog.showModal();q('#announcement-later').focus();
    try{
      const {post}=await store.call('community.posts.get',{id:item.id});
      if(turn!==request||stamp!==actor()||!dialog.open)return;
      if(post.kind!=='announcement')throw Error('公告内容不可用。');
      applyAnnouncementAppearance(dialog,post.appearance);
      current={id:post.id,revision:post.revision};
      q('#announcement-title').textContent=post.title;q('#announcement-body').textContent=post.body;
      q('#announcement-type').textContent=({notice:'公告',maintenance:'维护安排',outage:'故障通知'})[post.announcementType]||'公告';
      q('#announcement-meta').textContent=`${post.author?.name||post.author?.username||'管理员'} · ${new Date(post.updatedAt).toLocaleString('zh-CN')} · 第 ${post.revision} 版`;
      q('#announcement-ack').disabled=false;
    }catch(error){if(turn===request&&stamp===actor()){q('#announcement-title').textContent='公告暂不可用';q('#announcement-error').textContent=error.message;}}
    finally{if(turn===request)loading=false;}
  }
  function sync(){
    if(identity!==actor()){identity=actor();deferred.clear();clear();}
    if(!identity){clear();return;}
    if(current){
      const fresh=pending().find(item=>item.id===current.id);
      if(!fresh||fresh.revision!==current.revision)clear();else return;
    }
    if(document.hidden||document.querySelector('dialog[open]'))return;
    const next=pending().find(item=>!deferred.has(key(item)));
    if(next)void show(next);
  }
  q('#announcement-later').addEventListener('click',later);
  dialog.addEventListener('cancel',event=>{event.preventDefault();later();});
  q('#announcement-ack').addEventListener('click',async()=>{
    if(!current||loading||q('#announcement-ack').disabled)return;
    const selected={...current},stamp=actor(),turn=request;q('#announcement-ack').disabled=true;q('#announcement-error').textContent='';
    try{
      const result=await store.call('community.announcements.ack',{id:selected.id,revision:selected.revision});
      if(stamp!==actor()||turn!==request)return;
      store.data.announcements=result.announcements;clear();sync();
    }catch(error){
      if(stamp!==actor()||turn!==request)return;
      q('#announcement-error').textContent=error.message;
      q('#announcement-ack').disabled=false;
    }
  });
  // Login and unrelated editors may already own the top layer. Open as soon as
  // they close, rather than hiding or interrupting their unfinished controls.
  document.addEventListener('close',()=>queueMicrotask(sync),true);
  document.addEventListener('visibilitychange',sync);
  store.onAuthChange(()=>{identity='';deferred.clear();clear();});
  return ()=>queueMicrotask(sync);
}
