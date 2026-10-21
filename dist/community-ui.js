// The collaboration surface talks only to authenticated, durable server APIs.
// User content is plain text. No localStorage, markdown execution or HTML input.
import {createSubmissionKeys} from './submission-keys.js';
import {createTaskNotesUI,taskNotesMarkup} from './task-notes-ui.js';
import {revealSheet,dismissSheet,reducedMotion} from './motion-ui.js';
import {copyHelp} from './copy-help-ui.js';
import {defaultAppearance,applyAnnouncementAppearance} from './announcement-appearance.js';
import {chatSegments} from './chat-content.js';
import {createChatComposer} from './chat-compose-ui.js';
import {createRoomDialog} from './chat-rooms-ui.js';
export {createSubmissionKeys} from './submission-keys.js';
const kinds={announcement:'公告',feedback:'问题反馈',discussion:'讨论'};
const statuses={open:'待处理',investigating:'处理中',resolved:'已解决',closed:'已关闭'};
const types={notice:'通知',maintenance:'维护',outage:'故障'};
const date=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'时间未知';};
const principal=store=>store.principal?JSON.stringify([store.principal.userId,store.principal.role]):'';
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
function button(text,action,className='button'){const node=el('button',className,text);node.type='button';node.addEventListener('click',action);return node;}
// Unread @mentions of this account, shown on every 协作 entry.
export function renderChatMentionBadge(store){
  const count=store.principal?Number(store.data?.chatMentions)||0:0;
  for(const item of document.querySelectorAll('[data-nav="community"]')){
    let badge=item.querySelector('.nav-mention');
    if(!count){badge?.remove();continue;}
    if(!badge){badge=el('span','nav-mention');item.append(badge);}
    badge.textContent='@'+(count>99?'99+':count);badge.title=count+' 条消息提到了你';
  }
}
export function mergeCommunityItems(previous,incoming){const seen=new Set();return [...previous,...incoming].filter(item=>!seen.has(item.id)&&seen.add(item.id));}
export function createCommunityUI(store,toast){
  const root=document.querySelector('#page-community'),keys=createSubmissionKeys();
  const wide={matches:false};
  let identity='',epoch=0,visible=false,tab='posts',ready=false,infoBusy=false,loading=false,timer=null;
  let posts=[],postCursor=null,postRequest=0,selected=null,comments=[],commentCursor=null,detailRequest=0,commentRequest=0;
  const commentDrafts=new Map();
  let messages=[],chatCursor=null,chatBefore=null,chatBusy=false,history=false,unread=0,lastChatReconcile=0,chatLoaded=false,postsLoaded=false;
  let chatComposer=null,chatImages=new Map(),mentionRead='',roomMotion=false;
  let mentionObserver=null;const seenMentions=new Set();
  let rooms=[],room=null,canCreateRoom=false,roomsAt=0,roomsMentions=-1,roomDialog=null;
  let detail,composer,notes,notesCapable=false,editing=null,composeBusy=false,commentBusy=false,chatSending=false;
  const q=selector=>root.querySelector(selector),context=()=>epoch+':'+identity;
  const valid=stamp=>stamp===context()&&identity===principal(store);
  const admin=()=>store.principal?.role==='admin';
  const postsShown=()=>wide.matches||tab==='posts',chatShown=()=>wide.matches||tab==='chat';
  const message=(text,error=false)=>{q('#community-status').textContent=text;q('#community-status').classList.toggle('form-error',error);fitChat();};
  let chatStatus='',chatFailed=false,postStatus='',postFailed=false;
  function postMessage(text,error=false){postStatus=text;postFailed=error;if(wide.matches||tab==='posts')message(text,error);}
  function chatMessage(text,error=false){const changed=text!==chatStatus;chatStatus=text;chatFailed=error;q('#chat-status').textContent=text;q('#chat-status').classList.toggle('form-error',error);if(!wide.matches&&tab==='chat'){message(text,error);if(changed&&!error)showChatCard();}}
  // Use the measured top, including notices and the workshop's borrowed panel.
  let fitFrame=0;
  function fitChat(){
    cancelAnimationFrame(fitFrame);fitFrame=requestAnimationFrame(()=>{
      const rail=q('#community-chat');if(!rail||!visible||!chatShown())return;
      const strip=document.querySelector('#room-nav'),bottom=strip&&getComputedStyle(strip).position==='fixed'?innerHeight-strip.getBoundingClientRect().top+8:0;
      rail.style.setProperty('--chat-top',Math.ceil(Math.max(wide.matches?88:0,rail.getBoundingClientRect().top))+'px');rail.style.setProperty('--chat-bottom',bottom+'px');
    });
  }
  function showChatCard(){if(!wide.matches)requestAnimationFrame(()=>{const card=q('#community-chat');if(card&&card.getBoundingClientRect().bottom>innerHeight-parseFloat(card.style.getPropertyValue('--chat-bottom')||0))card.scrollIntoView({block:'start'});});}
  const railObserver=new ResizeObserver(fitChat);
  for(const node of document.querySelectorAll('.page-heading,.demo-note,#operational-maintenance,#room-nav'))railObserver.observe(node);
  addEventListener('resize',fitChat);addEventListener('scroll',fitChat,{passive:true});
  function stop(){clearTimeout(timer);timer=null;}
  function reset(){chatComposer?.destroy();mentionObserver?.disconnect();seenMentions.clear();roomMotion=false;epoch++;stop();notes?.reset();notes=null;notesCapable=false;tab='posts';ready=false;infoBusy=false;loading=false;chatBusy=false;composeBusy=false;commentBusy=false;chatSending=false;posts=[];postCursor=null;selected=null;comments=[];messages=[];chatCursor=null;chatBefore=null;history=false;unread=0;chatLoaded=false;postsLoaded=false;chatComposer=null;chatImages=new Map();mentionRead='';rooms=[];room=null;canCreateRoom=false;roomsAt=0;roomsMentions=-1;roomDialog?.close();roomDialog?.remove();roomDialog=null;chatStatus='';chatFailed=false;postStatus='';postFailed=false;keys.reset();commentDrafts.clear();editing=null;detail?.close();composer?.close();detail?.remove();composer?.remove();detail=null;composer=null;root.replaceChildren();}
  store.onAuthChange?.(()=>{identity='';reset();});
  function install(){
    root.innerHTML=`<div class="community-tabs" id="community-tabs" role="tablist" aria-label="协作内容"><button type="button" role="tab" data-community-tab="posts">帖子</button><button type="button" role="tab" data-community-tab="chat">聊天</button></div>
      <p id="community-status" role="status" aria-live="polite"></p>
      <div class="community-layout"><section id="community-forum" role="tabpanel"><div class="community-toolbar"><label><span class="field-caption"><span>类型</span>${copyHelp('协作区','帖子用于公告与问题反馈，聊天用于即时交流。留言不会改变额度、排队或取消任务。','/guide/queue')}</span><select id="community-kind"><option value="">全部帖子</option><option value="announcement">公告</option><option value="feedback">问题反馈</option><option value="discussion">讨论</option></select></label><label id="community-filter-label" hidden><span class="field-caption">处理状态</span><select id="community-filter"><option value="">全部</option><option value="open">待处理</option><option value="investigating">处理中</option><option value="resolved">已解决</option><option value="closed">已关闭</option></select></label><div class="community-toolbar-actions"><button class="button" id="community-refresh" type="button">刷新</button><button class="button primary" id="community-create" type="button">发帖</button></div></div><div class="community-feed-focus hero-frame"><span class="hero-label">公告与最新帖子</span><div id="community-posts" class="community-posts" tabindex="0" aria-label="公告与最新帖子"></div></div><button class="button community-more" id="community-more" type="button" hidden>加载更多</button><details id="community-task-notes" class="community-task-notes" hidden><summary><span class="copy-caption"><span>任务留言</span>${copyHelp('任务留言','任务留言随任务确认结束删除，非任务留言需手动删除。所有登录成员可见，任务状态未知或停止尚未确认时继续保留。','/guide/results')}</span></summary>${taskNotesMarkup}</details></section>
      <section id="community-chat" role="tabpanel" hidden><div class="chat-topline"><div><div class="copy-caption"><h3 id="chat-room-title">实验室聊天</h3><span id="chat-room-private" class="community-tag" hidden>私密</span>${copyHelp('聊天说明','实验室聊天所有登录成员可见；私密聊天室只有成员可见。消息和图片保留 30 天。输入 @ 选择成员提醒对方；图片可粘贴、拖入或点图片按钮选择。请勿发送密码或令牌。','/guide/queue')}</div></div><div class="chat-topline-actions"><button class="chat-tool" id="chat-room-settings" type="button" aria-label="成员与设置" title="成员与设置" hidden><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></svg><span id="chat-room-count" aria-hidden="true"></span></button><button class="chat-tool" id="chat-refresh" type="button" aria-label="刷新" title="刷新"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></svg></button></div></div><div id="chat-rooms" class="chat-rooms" role="tablist" aria-label="聊天室" hidden></div><p id="chat-status" role="status" aria-live="polite" hidden></p><div class="chat-timeline"><div class="chat-history"><button class="community-text-button" id="chat-older" type="button" hidden>查看更早消息</button><button class="community-text-button" id="chat-latest" type="button" hidden>返回最新消息</button></div><div id="community-messages" class="community-messages" tabindex="0" aria-label="公共聊天消息"></div><button class="button chat-new" id="chat-new" type="button" hidden><span aria-hidden="true">↓</span><span></span></button></div><form id="community-chat-form"><label for="community-chat-body">发送消息</label><div class="chat-compose-box"><textarea id="community-chat-body" rows="1" maxlength="2000" required placeholder="输入消息，@ 提醒" title="回车发送，Shift+回车换行"></textarea><button class="chat-send" type="submit" aria-label="发送消息" title="发送消息（回车）"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 12 6-6 6 6M12 6v13"/></svg></span></button></div><p id="chat-error" class="form-error" role="status"></p></form></section></div>`;
    for(const [index,node] of [...root.querySelectorAll('[data-community-tab]')].entries()){
      node.id='community-tab-'+node.dataset.communityTab;node.setAttribute('aria-controls',node.dataset.communityTab==='chat'?'community-chat':'community-forum');
      node.addEventListener('click',()=>selectTab(node.dataset.communityTab));
      node.addEventListener('keydown',event=>{const all=[...root.querySelectorAll('[data-community-tab]')].filter(item=>!item.hidden),current=all.indexOf(node);let next;if(event.key==='ArrowRight')next=(current+1)%all.length;if(event.key==='ArrowLeft')next=(current+all.length-1)%all.length;if(event.key==='Home')next=0;if(event.key==='End')next=all.length-1;if(next!==undefined){event.preventDefault();all[next].focus();selectTab(all[next].dataset.communityTab);}});
    }
    q('#community-kind').addEventListener('change',()=>{setTabs();loadPosts();});q('#community-filter').addEventListener('change',()=>loadPosts());q('#community-refresh').addEventListener('click',()=>loadPosts());q('#community-more').addEventListener('click',()=>loadPosts(true));q('#community-create').addEventListener('click',()=>openComposer('post'));
    q('#chat-refresh').addEventListener('click',()=>{history=false;loadChat('refresh');});q('#chat-older').addEventListener('click',()=>loadChat('older'));q('#chat-latest').addEventListener('click',()=>{history=false;loadChat('refresh');});
    q('#chat-new').addEventListener('click',()=>{q('#community-messages').scrollTo({top:q('#community-messages').scrollHeight,behavior:reducedMotion()?'instant':'smooth'});unread=0;q('#chat-new').hidden=true;});
    q('#community-messages').addEventListener('scroll',()=>{readMentions();const list=q('#community-messages');if(list.scrollHeight-list.scrollTop-list.clientHeight<40){unread=0;q('#chat-new').hidden=true;}},{passive:true});
    mentionObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){const row=entry.target;mentionObserver.unobserve(row);if(seenMentions.has(row.dataset.messageId))continue;seenMentions.add(row.dataset.messageId);if(!reducedMotion())row.classList.add('mention-arrival');}},{root:q('#community-messages'),threshold:.25});
    q('#chat-room-settings').addEventListener('click',()=>{const current=currentRoom();if(current)roomsDialog().open(current);});
    const announcements=button('全部公告',()=>{q('#community-kind').value='announcement';if(tab!=='posts')selectTab('posts');else{setTabs();loadPosts();}});announcements.id='community-announcements';
    const publish=button('发布公告',()=>{if(admin())openComposer('post',null,true);});publish.id='community-publish-announcement';publish.hidden=!admin();
    q('.community-toolbar-actions').append(announcements,publish);
    notes=createTaskNotesUI(root,store,toast);q('#task-note-form [type=submit]').classList.remove('primary');q('#community-task-notes').addEventListener('toggle',syncNotes);q('#community-chat-form').addEventListener('submit',sendChat);
    chatComposer=createChatComposer({form:q('#community-chat-form'),input:q('#community-chat-body'),onError:text=>{q('#chat-error').textContent=text;},
      members:()=>{const inside=currentRoom()&&new Set(currentRoom().members.map(m=>m.id));return (store.users||[]).filter(user=>user.username&&user.enabled!==false&&user.id!==store.principal?.userId&&(!inside||inside.has(user.id)));}});renderRooms();setTabs();
    for(const control of root.querySelectorAll('button,input,select,textarea'))if(!control.dataset.communityTab&&!control.hasAttribute('data-copy-help'))control.disabled=true;
  }
  function setTabs(){
    q('#community-task-notes').hidden=!ready||!notesCapable;
    q('#community-tabs').hidden=wide.matches;q('#chat-status').hidden=!wide.matches;
    for(const node of root.querySelectorAll('[data-community-tab]')){const active=node.dataset.communityTab===tab;node.setAttribute('aria-selected',String(active));node.tabIndex=active?0:-1;}
    q('#community-forum').hidden=!postsShown();q('#community-chat').hidden=!chatShown();q('#community-filter-label').hidden=q('#community-kind').value!=='feedback';
    q('#community-forum').setAttribute('aria-labelledby','community-tab-posts');q('#community-chat').setAttribute('aria-labelledby','community-tab-chat');
    if(ready)message(wide.matches||tab==='posts'?postStatus:chatStatus,wide.matches||tab==='posts'?postFailed:chatFailed);fitChat();
  }
  function syncNotes(){notes?.sync(visible&&postsShown()&&q('#community-task-notes').open,ready&&notesCapable);}
  async function enable(){
    if(infoBusy||ready||!identity)return;infoBusy=true;const stamp=context();message('正在连接协作区…');
    try{if(!valid(stamp))return;ready=true;notesCapable=true;setTabs();for(const control of root.querySelectorAll('button,input,select,textarea'))control.disabled=false;syncNotes();message('');await Promise.all([...(postsShown()?[loadPosts()]:[]),...(chatShown()?[loadChat('refresh'),loadRooms()]:[])]);}
    catch(error){if(valid(stamp))message('协作区暂不可用，请稍后刷新。尚未发送任何内容。',true);}
    finally{if(valid(stamp))infoBusy=false;}
  }
  function selectTab(next){if(!['posts','chat'].includes(next)||next===tab)return;tab=next;stop();setTabs();message('');syncNotes();if(next==='chat')showChatCard();if(tab==='posts'){posts=[];postsLoaded=false;postCursor=null;renderPosts();}if(!ready){enable();return;}if(tab==='chat')loadChat(messages.length?'poll':'refresh');else loadPosts();}
  async function loadPosts(more=false){
    if(!ready||!postsShown()||(more&&loading))return;loading=true;const stamp=context(),request=++postRequest,kind=q('#community-kind').value;postMessage(more?'正在加载更多…':'正在读取帖子…');q('#community-posts').setAttribute('aria-busy','true');fitChat();
    try{const result=await store.call('community.posts.list',{...(kind?{kind}:{}),...(kind==='feedback'&&q('#community-filter').value?{status:q('#community-filter').value}:{}),...(more&&postCursor?{cursor:postCursor}:{}),limit:20});if(!valid(stamp)||request!==postRequest||!postsShown())return;posts=more?mergeCommunityItems(posts,result.posts):result.posts;postCursor=result.nextCursor;postsLoaded=true;renderPosts();postMessage('');}
    catch(error){if(valid(stamp)&&request===postRequest&&postsShown())postMessage('读取失败：'+error.message,true);}
    finally{if(valid(stamp)&&request===postRequest){loading=false;q('#community-refresh').disabled=false;q('#community-posts').setAttribute('aria-busy','false');fitChat();}}
  }
  function renderPosts(){
    const list=q('#community-posts');list.replaceChildren();
    for(const [index,post] of [...posts.filter(post=>post.pinned),...posts.filter(post=>!post.pinned)].entries()){const card=el('article','community-post'+(post.pinned?' is-pinned':'')+(index===0?' is-focal':'')),open=button('',()=>openPost(post.id),'community-post-open');open.dataset.postId=post.id;open.title=post.title;
      const top=el('div','community-post-top');if(post.pinned)top.append(el('span','community-tag pinned','置顶'));top.append(el('span','community-tag '+post.kind,kinds[post.kind]||'帖子'));if(post.kind==='feedback')top.append(el('span','community-tag '+post.status,statuses[post.status]||post.status));else if(post.kind==='announcement'&&post.announcementType!=='notice')top.append(el('span','community-tag '+post.announcementType,types[post.announcementType]||'通知'));
      open.append(top,el('h3','',post.title));if(index===0)open.append(el('p','community-excerpt',post.body));
      const meta=el('div','community-meta');if(index===0)meta.append(el('span','',post.author?.name||post.author?.username||'成员'),el('time','',date(post.createdAt)));meta.append(el('span','',Number.isSafeInteger(post.commentCount)&&post.commentCount>=0?post.commentCount+' 条回复':'回复数未确认'));open.append(meta);card.append(open);list.append(card);}
    if(!posts.length)list.append(el('div','community-empty',postsLoaded?'还没有帖子，可以分享问题或进展。':'帖子尚未确认，正在读取。'));
    q('#community-more').hidden=!postCursor;
  }
  function ensureDetail(){if(detail)return;detail=el('dialog','community-dialog community-detail');detail.setAttribute('aria-labelledby','community-post-title');detail.innerHTML='<div class="modal-head"><div><p id="community-post-meta" class="community-meta"></p><h2 id="community-post-title"></h2></div><button type="button" class="icon-button" data-community-close aria-label="关闭帖子">×</button></div><div class="community-sheet-body"><div id="community-post-actions" class="community-post-actions"></div><div id="community-post-body" class="community-body"></div><p id="community-detail-status" role="status" aria-live="polite"></p><div class="community-replies-heading"><h3>回复</h3><button class="button" id="community-replies-refresh" type="button">刷新回复</button></div><div id="community-comments"></div><button class="button community-more" id="community-comments-more" type="button" hidden>加载更多回复</button></div><form id="community-comment-form"><label for="community-comment-body">写一条回复</label><textarea id="community-comment-body" maxlength="4000" rows="3" required placeholder="补充进展、复现信息或解决办法。"></textarea><div class="modal-actions"><button type="submit" class="button primary">发送回复</button></div><p class="form-error" id="community-comment-error" role="status"></p></form>';document.body.append(detail);detail.querySelector('[data-community-close]').addEventListener('click',()=>dismissSheet(detail,{drilldown:true}));detail.querySelector('#community-comment-form').addEventListener('submit',sendComment);detail.querySelector('#community-replies-refresh').addEventListener('click',()=>loadComments());detail.querySelector('#community-comments-more').addEventListener('click',()=>loadComments(true));const ownedDetail=detail;detail.addEventListener('cancel',event=>{event.preventDefault();dismissSheet(detail,{drilldown:true});});detail.addEventListener('close',()=>{if(detail!==ownedDetail||detail.open)return;detailRequest++;selected=null;comments=[];detail.querySelector('#community-post-body').textContent='';detail.querySelector('#community-comments').replaceChildren();detail.querySelector('#community-comment-body').value='';});}
  async function openPost(id){ensureDetail();const stamp=context(),request=++detailRequest;selected=null;commentCursor=null;detail.querySelector('#community-post-title').textContent='正在读取…';detail.querySelector('#community-post-meta').textContent='';detail.querySelector('#community-post-body').textContent='';detail.querySelector('#community-comments').replaceChildren();detail.querySelector('#community-post-actions').replaceChildren();const input=detail.querySelector('#community-comment-body');input.value=commentDrafts.get(id)||'';input.readOnly=commentBusy||keys.hasUncertain('comment:'+id);input.oninput=()=>commentDrafts.set(id,input.value);detail.querySelector('#community-comment-error').textContent=input.readOnly?'上次发送结果未确认，请重试原内容。':'';detail.querySelector('#community-detail-status').textContent='';if(!detail.open){detail.showModal();revealSheet(detail,{drilldown:true});}
    try{const result=await store.call('community.posts.get',{id});if(!valid(stamp)||request!==detailRequest||!detail.open)return;selected=result.post;renderDetail();await loadComments();}
    catch(error){if(valid(stamp)&&request===detailRequest){detail.querySelector('#community-post-title').textContent='帖子暂不可用';detail.querySelector('#community-detail-status').textContent=error.message;}}
  }
  function renderDetail(){if(!selected)return;const post=selected;detail.querySelector('#community-post-title').textContent=post.title;detail.querySelector('#community-post-meta').textContent=(kinds[post.kind]||'帖子')+(post.kind==='feedback'?' · '+statuses[post.status]:'')+' · '+(post.author?.name||post.author?.username||'成员')+' · '+date(post.createdAt);detail.querySelector('#community-post-body').textContent=post.body;const actions=detail.querySelector('#community-post-actions');actions.replaceChildren();
    if(post.canEdit)actions.append(button('编辑',()=>openComposer('post',post)));
    if(post.canModerate){
      if(post.kind==='feedback'){const label=el('label','','处理状态'),select=el('select');for(const [value,text] of Object.entries(statuses)){const option=el('option','',text);option.value=value;select.append(option);}select.value=post.status;label.append(select);actions.append(label,button('更新状态',()=>moderate({status:select.value})));}
      if(post.kind==='announcement')actions.append(button(post.pinned?'取消置顶':'置顶',()=>moderate({pinned:!post.pinned})));
    }
    if(post.canDelete)actions.append(button('删除',()=>remove('post',post),'button danger'));
  }
  async function moderate(change){if(!selected)return;const current=selected,stamp=context();try{const result=await store.call('community.posts.update',{id:current.id,...change});if(!valid(stamp)||selected?.id!==current.id)return;selected=result.post;renderDetail();loadPosts();detail.querySelector('#community-detail-status').textContent='已更新。';}catch(error){if(valid(stamp)&&selected?.id===current.id)detail.querySelector('#community-detail-status').textContent=error.status===409?'帖子已被更新，请重新打开后再操作。':error.message;}}
  async function loadComments(more=false){if(!selected)return;const id=selected.id,stamp=context(),request=++commentRequest,opened=detailRequest;try{const result=await store.call('community.comments.list',{postId:id,...(more&&commentCursor?{cursor:commentCursor}:{}),limit:50});if(!valid(stamp)||request!==commentRequest||opened!==detailRequest||selected?.id!==id)return;comments=more?[...comments,...result.comments]:result.comments;commentCursor=result.nextCursor;renderComments();}catch(error){if(valid(stamp)&&request===commentRequest&&selected?.id===id)detail.querySelector('#community-detail-status').textContent='回复暂不可用：'+error.message;}}
  function itemActions(item,type){const actions=el('div','community-item-actions');if(item.canEdit)actions.append(button('编辑',()=>openComposer(type,item),'community-text-button'));if(item.canDelete)actions.append(button('删除',()=>remove(type,item),'community-text-button danger'));return actions;}
  function renderComments(){const list=detail.querySelector('#community-comments');list.replaceChildren();for(const item of comments){const row=el('article','community-comment');row.dataset.commentId=item.id;row.append(el('p','community-meta',(item.author?.name||item.author?.username||'成员')+' · '+date(item.createdAt)),el('p','community-body',item.body),itemActions(item,'comment'));list.append(row);}if(!comments.length)list.append(el('p','community-empty','还没有回复。'));detail.querySelector('#community-comments-more').hidden=!commentCursor;}
  async function create(channel,operation,payload){const stamp=context(),request=keys.request(channel,payload);try{const result=await store.call(operation,request);if(valid(stamp))keys.confirmed(channel);return result;}catch(error){if(valid(stamp)){if(error.status===507)keys.confirmed(channel);else if(!error.status||error.status>=500)keys.uncertain(channel);else if(!keys.hasUncertain(channel))keys.confirmed(channel);}throw error;}}
  async function sendComment(event){event.preventDefault();if(commentBusy||!selected)return;commentBusy=true;const id=selected.id,stamp=context(),form=event.currentTarget,input=form.querySelector('textarea'),submit=form.querySelector('[type=submit]'),body=input.value;commentDrafts.set(id,body);submit.disabled=true;input.readOnly=true;const error=detail.querySelector('#community-comment-error');error.textContent='';try{const result=await create('comment:'+id,'community.comments.create',{postId:id,body});if(!valid(stamp))return;commentDrafts.delete(id);if(selected?.id!==id)return;input.value='';input.readOnly=false;error.textContent=result.deleted?'这条回复已被删除，没有重新发布。':'';await loadComments();}catch(e){if(valid(stamp)&&selected?.id===id){error.textContent=keys.hasUncertain('comment:'+id)?'发送结果未确认。请重试原内容，不会重复创建回复。':e.message;input.readOnly=keys.hasUncertain('comment:'+id);}}finally{if(valid(stamp)){commentBusy=false;submit.disabled=false;if(selected)input.readOnly=keys.hasUncertain('comment:'+selected.id);}}}
  function ensureComposer(){
    if(composer)return;composer=el('dialog','community-dialog community-composer');composer.setAttribute('aria-labelledby','community-compose-title');
    composer.innerHTML=`<form id="community-compose-form"><div class="modal-head"><div class="copy-caption"><h2 id="community-compose-title"></h2>${copyHelp('发布内容','所有登录成员可见。反馈问题时请附操作步骤、任务编号和错误信息。','/guide/queue')}</div><button class="icon-button" type="button" data-compose-close aria-label="关闭编辑器">×</button></div><div class="community-sheet-body"><label class="field" id="community-kind-field">类型<select name="kind"><option value="feedback">问题反馈</option><option value="discussion">讨论</option>${admin()?'<option value="announcement">公告</option>':''}</select></label><label class="field" id="community-title-field">标题<input name="title" maxlength="120" required placeholder="用一句话说明内容"></label><label class="field" id="community-type-field">公告类型<select name="announcementType"><option value="notice">通知</option><option value="maintenance">维护安排</option><option value="outage">故障通知</option></select></label><label class="field">内容<textarea name="body" rows="8" maxlength="8000" required placeholder="写下内容"></textarea></label><label class="community-pin" id="community-pin-field"><input type="checkbox" name="pinned">置顶这条公告</label><p class="community-compose-note">请勿填写密码或令牌。</p><p class="form-error" id="community-compose-error" role="status"></p></div><div class="modal-actions"><button type="button" class="button" data-compose-close>取消</button><button type="submit" class="button primary">发布</button></div></form>`;
    const targeting=el('div');targeting.id='community-announcement-target';
    targeting.innerHTML='<label class="field">谁能看到<select name="audience"><option value="all">全部登录成员</option><option value="users">指定成员（可多选）</option><option value="member">普通成员</option><option value="admin">管理员</option></select></label><div id="community-audience-members" role="group" aria-label="公告接收成员" hidden></div><label class="community-pin"><input type="checkbox" name="popup">打开网站时弹出大公告</label>';
    composer.querySelector('[name=body]').closest('label').before(targeting);
    targeting.insertAdjacentHTML('beforeend','<details id="announcement-appearance-editor"><summary>布局与颜色</summary><label class="field">布局<select name="layout"><option value="standard">标准</option><option value="centered">居中</option><option value="compact">紧凑</option></select></label><div class="announcement-colors"><label>背景<input type="color" name="background"></label><label>文字<input type="color" name="textColor"></label><label>强调色<input type="color" name="accent"></label></div><section class="announcement-preview" aria-label="公告预览"><header><small>公告预览</small><h3></h3></header><p></p></section></details>');
    composer.querySelector('form').addEventListener('input',previewAppearance);
    targeting.querySelector('[name=audience]').addEventListener('change',composerKind);
    document.body.append(composer);for(const node of composer.querySelectorAll('[data-compose-close]'))node.addEventListener('click',()=>{if(composeBusy)return;if(keys.hasUncertain('post')){toast('发送结果尚未确认，请先重试原内容。');return;}dismissSheet(composer);});composer.addEventListener('cancel',event=>{event.preventDefault();if(!composeBusy&&!keys.hasUncertain('post'))dismissSheet(composer);});composer.querySelector('form').addEventListener('submit',sendComposer);composer.querySelector('[name=kind]').addEventListener('change',composerKind);
  }
  function composerKind(){const form=composer.querySelector('form'),post=editing?.type==='post',announcement=post&&form.elements.kind.value==='announcement';composer.querySelector('#community-kind-field').hidden=!post;composer.querySelector('#community-type-field').hidden=!announcement;composer.querySelector('#community-pin-field').hidden=!announcement||Boolean(editing?.item);composer.querySelector('#community-announcement-target').hidden=!announcement;composer.querySelector('#community-audience-members').hidden=form.elements.audience.value!=='users';}
  function appearanceFields(){const f=composer.querySelector('form').elements;return {layout:f.layout.value,background:f.background.value,text:f.textColor.value,accent:f.accent.value};}
  function previewAppearance(){const f=composer.querySelector('form').elements,p=composer.querySelector('.announcement-preview');applyAnnouncementAppearance(p,appearanceFields());p.querySelector('h3').textContent=f.title.value||'公告标题';p.querySelector('p').textContent=f.body.value||'这里显示公告正文。';}
  function audienceFields(){const form=composer.querySelector('form'),type=form.elements.audience.value;return {appearance:appearanceFields(),popup:form.elements.popup.checked,audience:type==='all'?{type:'all'}:type==='users'?{type:'users',userIds:[...form.querySelectorAll('[name=audienceUser]:checked')].map(n=>n.value)}:{type:'role',role:type}};}
  function lockAudience(locked){for(const field of composer.querySelectorAll('[name=audience],[name=audienceUser],[name=popup],#announcement-appearance-editor input,#announcement-appearance-editor select'))field.disabled=locked;}
  function fillAudience(item,announcement){
    const form=composer.querySelector('form'),audience=item?.audience||{type:'all'},members=composer.querySelector('#community-audience-members');
    form.elements.audience.value=audience.type==='role'?audience.role:audience.type;
    form.elements.popup.checked=item?item.popup===true:announcement;
    form.elements.pinned.checked=item?item.pinned===true:announcement;
    const style=item?.appearance||defaultAppearance;
    for(const [name,key] of [['layout','layout'],['background','background'],['textColor','text'],['accent','accent']])form.elements[name].value=style[key];
    previewAppearance();
    members.replaceChildren();
    for(const user of store.users){
      const label=el('label'),check=el('input');check.type='checkbox';check.name='audienceUser';check.value=user.id;check.checked=audience.userIds?.includes(user.id)||false;
      label.append(check,el('span','',user.name||user.username));members.append(label);
    }
    lockAudience(false);composerKind();
    if(!item&&announcement)composer.querySelector('#community-compose-title').textContent='发布公告';
  }
  function openComposer(type,item=null,announcement=false){
    ensureComposer();if(composeBusy)return;if(keys.hasUncertain('post')){if(!composer.open){composer.showModal();revealSheet(composer);}toast('请先确认上次发送结果。');return;}
    const filter=q('#community-kind').value;editing={type,item,kind:item?.kind||(announcement?'announcement':filter&&!(filter==='announcement'&&!admin())?filter:'feedback')};
    const form=composer.querySelector('form'),post=type==='post';form.reset();
    form.elements.kind.value=editing.kind;form.elements.kind.disabled=Boolean(item);form.elements.pinned.disabled=false;
    form.elements.title.value=post?item?.title||'':'';form.elements.body.value=item?.body||'';
    form.elements.body.maxLength=post?8000:type==='message'?2000:4000;form.elements.announcementType.value=item?.announcementType||'notice';
    form.elements.title.required=post;form.elements.title.disabled=!post;composer.querySelector('#community-title-field').hidden=!post;
    composer.querySelector('#community-compose-title').textContent=item?'编辑'+(post?'帖子':type==='message'?'消息':'回复'):'发帖';
    composer.querySelector('[type=submit]').textContent=item?'保存修改':'发布';composer.querySelector('#community-compose-error').textContent='';
    for(const field of [form.elements.title,form.elements.body])field.readOnly=false;
    form.elements.announcementType.disabled=false;fillAudience(item,announcement);
    if(!composer.open){composer.showModal();revealSheet(composer);}(post?form.elements.title:form.elements.body).focus();
  }
  async function sendComposer(event){event.preventDefault();if(composeBusy||!editing)return;composeBusy=true;const stamp=context(),current=editing,form=event.currentTarget,submit=form.querySelector('[type=submit]'),kind=current.item?.kind||form.elements.kind.value;submit.disabled=true;const error=composer.querySelector('#community-compose-error');error.textContent='';form.elements.title.readOnly=true;form.elements.body.readOnly=true;for(const name of ['kind','announcementType','pinned'])form.elements[name].disabled=true;lockAudience(true);const fields={body:form.elements.body.value,...(current.type==='post'?{title:form.elements.title.value,...(kind==='announcement'?{announcementType:form.elements.announcementType.value,...(!current.item?{pinned:form.elements.pinned.checked}:{}),...audienceFields()}:{})}:{})};try{
      const result=current.item?await store.call('community.'+({post:'posts',comment:'comments',message:'chat'}[current.type])+'.update',{id:current.item.id,...fields}):await create('post','community.posts.create',{kind,...fields});
      if(!valid(stamp))return;dismissSheet(composer);editing=null;if(result.deleted)toast('这条内容已被删除，没有重复发布。');else toast(current.item?'修改已保存。':'已发布。');
      if(current.type==='post'){loadPosts();if(selected?.id===current.item?.id&&result.post){selected=result.post;renderDetail();}}
      else if(current.type==='comment')loadComments();else loadChat('refresh');
    }catch(e){if(valid(stamp)){const uncertain=!current.item&&keys.hasUncertain('post');error.textContent=uncertain?'发送结果未确认。请重试原内容，不会重复发帖。':e.status===409?'内容已被更新。你的文字仍保留，请取消并重新打开最新内容后再修改。':e.message;form.elements.title.readOnly=uncertain;form.elements.body.readOnly=uncertain;form.elements.kind.disabled=uncertain||Boolean(current.item);form.elements.announcementType.disabled=uncertain;form.elements.pinned.disabled=uncertain;}}
    finally{if(valid(stamp)){composeBusy=false;submit.disabled=false;lockAudience(!current.item&&keys.hasUncertain('post'));}}
  }
  async function remove(type,item){if(!window.confirm('确定删除这'+(type==='post'?'篇帖子及其回复':type==='message'?'条消息':'条回复')+'？'))return;const stamp=context();try{await store.call('community.'+({post:'posts',comment:'comments',message:'chat'}[type])+'.delete',{id:item.id});if(!valid(stamp))return;if(type==='post'){if(selected?.id===item.id)dismissSheet(detail,{drilldown:true});loadPosts();}else if(type==='comment')loadComments();else{messages=messages.filter(row=>row.id!==item.id);renderMessages(false);}toast('已删除。');}catch(error){if(valid(stamp))toast(error.status===409?'内容已被更新，请刷新后重新确认删除。':error.message);}}
  function arm(){stop();if(visible&&ready&&chatShown()&&!document.hidden&&!history)timer=setTimeout(()=>loadChat('poll'),5000);}
  async function loadChat(mode){
    if(!ready||chatBusy)return;chatBusy=true;
    // Switching rooms mid-request drops this answer and reloads the new room.
    const stamp=context(),place=room,scope=place?{room:place}:{},here=()=>valid(stamp)&&place===room,scroll=q('#community-messages'),atEnd=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<80;
    try{
      let more=false;
      // Three pages per turn bounds catch-up work. The next timer resumes the
      // actual cursor, never the server's global latestCursor.
      for(let page=0;page<(mode==='poll'?3:1);page++){
        const recentPage=mode==='refresh'||mode==='poll'&&!chatCursor;
        const result=await store.call('community.chat.list',{limit:50,...scope,...(mode==='older'&&chatBefore?{before:chatBefore}:mode==='poll'&&chatCursor?{after:chatCursor}:{})});if(!here())return;
        if(mode==='older'){history=true;messages=mergeCommunityItems(result.messages,messages);chatBefore=result.hasMore?result.nextCursor:null;}
        else if(recentPage){messages=result.messages;chatCursor=result.latestCursor;chatBefore=result.hasMore?result.nextCursor:null;history=false;lastChatReconcile=Date.now();}
        else{
          const ids=new Set(messages.map(row=>row.id)),newRows=result.messages.filter(row=>!ids.has(row.id));
          const dropped=messages.length+newRows.length>200;messages=[...messages,...newRows].slice(-200);
          if(result.messages.length)chatCursor=result.nextCursor||result.messages.at(-1).id;
          if(chatBefore||dropped)chatBefore=messages[0]?.id||null;if(!atEnd)unread+=newRows.length;
        }
        more=!recentPage&&Boolean(result.hasMore);if(mode!=='poll'||!more)break;
      }
      // Incremental IDs do not announce edits/deletes. Reconcile only the
      // latest 50-message window, without replacing drafts or older history.
      if(mode==='poll'&&!more&&!history&&Date.now()-lastChatReconcile>=30000){
        const recent=await store.call('community.chat.list',{limit:50,...scope});if(!here())return;
        const oldest=recent.messages[0]?.id;
        messages=oldest?[...messages.filter(row=>BigInt(row.id)<BigInt(oldest)),...recent.messages].slice(-200):[];
        chatBefore=recent.hasMore?messages[0]?.id||null:null;lastChatReconcile=Date.now();
      }
      q('#chat-older').hidden=!chatBefore;q('#chat-latest').hidden=!history;renderMessages(mode==='refresh'||(atEnd&&mode!=='older'),mode!=='older'&&chatLoaded&&!roomMotion);if(roomMotion){roomMotion=false;const list=q('#community-messages');list.classList.remove('chat-swapping');void list.offsetWidth;list.classList.add('chat-swapping');}
      chatLoaded=true;chatMessage(history?'正在查看历史消息。返回最新消息后恢复自动更新。':'');
      const mentioned=Number(store.data?.chatMentions)||0;if(mentioned!==roomsMentions||Date.now()-roomsAt>30000){roomsMentions=mentioned;loadRooms();}
    }catch(error){if(here()){chatMessage('消息读取失败：'+error.message,true);if(place&&error.status===404){unavailableRoom();loadRooms();}}}finally{if(valid(stamp)){chatBusy=false;if(place!==room)loadChat('refresh');else arm();}}
  }
  // Private rooms sit under the lab chat; the server lists only the viewer's rooms.
  function currentRoom(){return rooms.find(item=>item.id===room)||null;}
  function roomsDialog(){roomDialog??=createRoomDialog(store,{create,toast,onChange:(next,created)=>{rooms=[...rooms.filter(item=>item.id!==next.id),next].sort((a,b)=>Number(a.id)-Number(b.id));if(created)switchRoom(next.id);else renderRooms();},onDelete:id=>{rooms=rooms.filter(item=>item.id!==id);switchRoom(null);}});return roomDialog;}
  function unavailableRoom(){roomDialog?.close();toast('这个聊天室已不可用，已回到实验室聊天。');switchRoom(null);}
  async function loadRooms(){
    const stamp=context();roomsAt=Date.now();
    try{
      const result=await store.call('community.rooms.list');if(!valid(stamp))return;
      rooms=result.rooms||[];canCreateRoom=result.canCreate===true;
      if(room&&!rooms.some(item=>item.id===room))unavailableRoom();else renderRooms();
      roomDialog?.update(currentRoom());
    }catch{if(valid(stamp))roomsAt=0;}
  }
  function renderRooms(){
    const bar=q('#chat-rooms');if(!bar)return;bar.replaceChildren();bar.hidden=!rooms.length&&!canCreateRoom;
    const total=Number(store.data?.chatMentions)||0,lab=Math.max(0,total-rooms.reduce((sum,item)=>sum+(item.mentions||0),0));
    for(const item of [{id:null,name:'实验室聊天',mentions:lab},...rooms]){
      const chip=button('',()=>switchRoom(item.id),'chat-room'+(item.id?' private':''));
      chip.dataset.roomId=item.id||'';chip.title=item.name;chip.setAttribute('role','tab');chip.setAttribute('aria-selected',String(item.id===room));
      chip.append(el('span','chat-room-name',item.name));
      if(item.mentions)chip.append(el('span','chat-room-mention','@'+item.mentions));bar.append(chip);
    }
    if(canCreateRoom)bar.append(button('+ 私密聊天室',()=>roomsDialog().open(null),'chat-room chat-room-new'));
    const current=currentRoom(),name=current?current.name:'实验室聊天';
    const empty=q('.chat-empty strong');if(empty)empty.textContent=current?'这是「'+name+'」的开始':'还没有消息';
    q('#chat-room-count').textContent=current?String(current.members.length):'';q('#chat-room-title').textContent=name;q('#chat-room-title').title=name;q('#chat-room-private').hidden=!current;q('#chat-room-settings').hidden=!current;
    q('#community-messages').setAttribute('aria-label',current?current.name+'的消息':'公共聊天消息');
  }
  function switchRoom(next){
    if(next===room)return;stop();roomMotion=true;room=next;messages=[];chatCursor=null;chatBefore=null;history=false;unread=0;mentionRead='';chatLoaded=false;
    q('#chat-error').textContent='';renderRooms();q('.chat-room[aria-selected=true]')?.scrollIntoView({block:'nearest',inline:'nearest'});renderMessages(true);loadChat('refresh');
  }
  function chatBody(item){
    const body=el('p','community-body');
    for(const part of chatSegments(item.body,store.users||[])){
      if(!part.user){body.append(part.text);continue;}
      const tag=el('span','chat-mention'+(part.user.id===store.principal?.userId?' me':''),'@'+(part.user.name||part.user.username));tag.title=part.text;body.append(tag);
    }
    return body;
  }
  // One element per picture: re-rendering on every poll must not reload or flash it.
  function chatImage(image){
    let link=chatImages.get(image.url);
    if(!link){
      link=el('a','chat-image');link.href=image.url;link.target='_blank';link.rel='noopener';link.setAttribute('aria-label','查看原图');
      const img=el('img');img.alt='聊天图片';img.width=image.width;img.height=image.height;img.loading='lazy';img.decoding='async';img.src=image.url;
      link.append(img);chatImages.set(image.url,link);
    }
    return link;
  }
  function dayLabel(value){
    const d=new Date(value),today=new Date(),yesterday=new Date();yesterday.setDate(today.getDate()-1);
    if(d.toDateString()===today.toDateString())return '今天';if(d.toDateString()===yesterday.toDateString())return '昨天';
    return (d.getFullYear()===today.getFullYear()?'':d.getFullYear()+'年')+(d.getMonth()+1)+'月'+d.getDate()+'日';
  }
  function sameGroup(a,b){return a&&b&&a.author?.id===b.author?.id&&new Date(a.createdAt).toDateString()===new Date(b.createdAt).toDateString()&&Math.abs(new Date(b.createdAt)-new Date(a.createdAt))<=300000;}
  function renderMessages(toEnd,animate=false){
    const list=q('#community-messages'),oldTop=list.scrollTop,known=new Set([...list.querySelectorAll('[data-message-id]')].map(row=>row.dataset.messageId)),shown=new Set();
    mentionObserver?.disconnect();list.replaceChildren();
    for(const [index,item] of messages.entries()){
      const previous=messages[index-1],grouped=sameGroup(previous,item),continued=sameGroup(item,messages[index+1]),own=item.author?.id===store.principal?.userId;
      if(!previous||new Date(previous.createdAt).toDateString()!==new Date(item.createdAt).toDateString())list.append(el('div','chat-day',dayLabel(item.createdAt)));
      const body=item.body?chatBody(item):null,mine=body?.querySelector('.chat-mention.me'),name=item.author?.name||item.author?.username||'成员';
      const row=el('article','chat-message'+(own?' own':'')+(mine?' mentions-me':'')+(grouped?' is-grouped':'')+(continued?' has-next':'')+(animate&&!known.has(String(item.id))?' is-new':''));row.dataset.messageId=item.id;row.title=name+' · '+date(item.createdAt);
      if(!own&&!grouped){const avatar=el('span','chat-avatar',Array.from(name)[0]);avatar.setAttribute('aria-hidden','true');row.append(avatar);}
      const content=el('div','chat-message-content'),meta=el('div','community-meta');
      if(!grouped){meta.append(el('span','chat-author',name),el('time','',date(item.createdAt)));}
      meta.append(itemActions(item,'message'));content.append(meta);
      const bubble=el('div','chat-bubble');if(item.image){shown.add(item.image.url);bubble.append(chatImage(item.image));}if(body)bubble.append(body);content.append(bubble);row.append(content);list.append(row);
      if(mine&&!seenMentions.has(String(item.id)))mentionObserver?.observe(row);
    }
    for(const url of chatImages.keys())if(!shown.has(url))chatImages.delete(url);
    if(!messages.length){const empty=el('div','community-empty chat-empty'),icon=el('span','chat-empty-icon');icon.setAttribute('aria-hidden','true');icon.innerHTML='<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z"/><path d="M7 10h8M7 14h5"/></svg>';empty.append(icon,el('strong','',room?'这是「'+(currentRoom()?.name||'聊天室')+'」的开始':'还没有消息'),el('span','',room?'只有聊天室成员能看到这里的消息':'输入 @ 可以提醒成员'));list.append(empty);}
    if(toEnd){list.scrollTop=list.scrollHeight;unread=0;}else list.scrollTop=oldTop;
    q('#chat-new').hidden=!unread;q('#chat-new span:last-child').textContent=unread+' 条新消息';readMentions();
  }
  // Seeing the newest messages clears this account's unread @mentions.
  async function readMentions(){
    const list=q('#community-messages'),last=messages.at(-1)?.id;
    if(!last||last===mentionRead||!(Number(store.data?.chatMentions)>0)||!visible||!chatShown()||history||list.scrollHeight-list.scrollTop-list.clientHeight>40)return;
    const stamp=context();mentionRead=last;
    try{const place=room,result=await store.call('community.chat.read',{id:last,...(place?{room:place}:{})});if(valid(stamp)&&store.data){store.data.chatMentions=result.chatMentions;renderChatMentionBadge(store);const read=rooms.find(item=>item.id===place);if(read)read.mentions=0;roomsMentions=result.chatMentions;renderRooms();}}
    catch{if(valid(stamp))mentionRead='';}
  }
  async function sendChat(event){event.preventDefault();if(chatSending||!ready)return;const form=event.currentTarget,input=q('#community-chat-body'),payload=chatComposer.payload();if(!payload.body.trim()&&!payload.image)return;chatSending=true;const stamp=context(),submit=form.querySelector('[type=submit]');submit.disabled=true;input.readOnly=true;chatComposer.lock(true);q('#chat-error').textContent='';try{const result=await create('chat','community.chat.send',{...payload,...(room?{room}:{})});if(!valid(stamp))return;input.value='';input.readOnly=false;chatComposer.clear();chatComposer.lock(false);if(result.deleted)q('#chat-error').textContent='这条消息已删除或过期，没有重新发送。';history=false;await loadChat('refresh');}catch(error){if(valid(stamp)){const unknown=keys.hasUncertain('chat');input.readOnly=unknown;chatComposer.lock(unknown);q('#chat-error').textContent=unknown?'发送结果未确认。请重试原内容，不会重复发送。':error.message;}}finally{if(valid(stamp)){chatSending=false;submit.disabled=false;}}}
  const layoutObserver=new ResizeObserver(([entry])=>{
    const next=entry.contentRect.width>=56*parseFloat(getComputedStyle(document.documentElement).fontSize);
    if(next===wide.matches)return;wide.matches=next;
    if(!identity||!q('#community-kind'))return;setTabs();syncNotes();stop();
    if(!visible||!ready)return;if(postsShown()&&!postsLoaded)loadPosts();if(chatShown()&&!chatLoaded)loadChat('refresh');else arm();
  });
  layoutObserver.observe(root);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(visible&&ready&&chatShown()){loadChat('poll');}});
  function sync(isVisible){const next=principal(store);if(next!==identity){identity=next;reset();if(next)install();}visible=Boolean(isVisible&&next);if(next)syncNotes();fitChat();if(!visible){stop();return;}if(!ready)enable();else arm();}
  // The @mention pop-up opens the chat tab and skips while the chat is on screen.
  sync.showChat=(target=null)=>{if(!identity)return;if(!ready){tab='chat';room=target;renderRooms();return;}if(tab!=='chat')selectTab('chat');switchRoom(target);};
  sync.chatOpen=()=>visible&&chatShown();
  return sync;
}
