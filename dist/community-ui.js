// The collaboration surface talks only to authenticated, durable server APIs.
// User content is plain text. No localStorage, markdown execution or HTML input.
import {createSubmissionKeys} from './submission-keys.js';
import {createTaskNotesUI,taskNotesMarkup} from './task-notes-ui.js';
import {revealSheet,dismissSheet} from './motion-ui.js';
import {copyHelp} from './copy-help-ui.js';
import {defaultAppearance,applyAnnouncementAppearance} from './announcement-appearance.js';
export {createSubmissionKeys} from './submission-keys.js';
const kinds={announcement:'公告',feedback:'问题反馈',discussion:'讨论'};
const statuses={open:'待处理',investigating:'处理中',resolved:'已解决',closed:'已关闭'};
const types={notice:'通知',maintenance:'维护',outage:'故障'};
const date=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'时间未知';};
const principal=store=>store.principal?JSON.stringify([store.principal.userId,store.principal.role]):'';
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
function button(text,action,className='button'){const node=el('button',className,text);node.type='button';node.addEventListener('click',action);return node;}
export function mergeCommunityItems(previous,incoming){const seen=new Set();return [...previous,...incoming].filter(item=>!seen.has(item.id)&&seen.add(item.id));}
export function createCommunityUI(store,toast){
  const root=document.querySelector('#page-community'),keys=createSubmissionKeys();
  const wide={matches:false};
  let identity='',epoch=0,visible=false,tab='posts',ready=false,infoBusy=false,loading=false,timer=null;
  let posts=[],postCursor=null,postRequest=0,selected=null,comments=[],commentCursor=null,detailRequest=0,commentRequest=0;
  const commentDrafts=new Map();
  let messages=[],chatCursor=null,chatBefore=null,chatBusy=false,history=false,unread=0,lastChatReconcile=0,chatLoaded=false,postsLoaded=false;
  let detail,composer,notes,notesCapable=false,editing=null,composeBusy=false,commentBusy=false,chatSending=false;
  const q=selector=>root.querySelector(selector),context=()=>epoch+':'+identity;
  const valid=stamp=>stamp===context()&&identity===principal(store);
  const admin=()=>store.principal?.role==='admin';
  const postsShown=()=>wide.matches||tab==='posts',chatShown=()=>wide.matches||tab==='chat';
  const message=(text,error=false)=>{q('#community-status').textContent=text;q('#community-status').classList.toggle('form-error',error);};
  let chatStatus='',chatFailed=false,postStatus='',postFailed=false;
  function postMessage(text,error=false){postStatus=text;postFailed=error;if(wide.matches||tab==='posts')message(text,error);}
  function chatMessage(text,error=false){chatStatus=text;chatFailed=error;q('#chat-status').textContent=text;q('#chat-status').classList.toggle('form-error',error);if(!wide.matches&&tab==='chat')message(text,error);}
  // Fit the companion rail between its actual starting point and the shared
  // control strip. A maintenance notice or wrapped heading can change that
  // space; the chat composer must remain reachable in the same viewport.
  let fitFrame=0;
  function fitChat(){
    cancelAnimationFrame(fitFrame);fitFrame=requestAnimationFrame(()=>{
      const rail=q('#community-chat');if(!rail)return;
      if(!wide.matches||!visible){rail.style.removeProperty('height');return;}
      const strip=document.querySelector('#control-strip'),boundary=strip&&!strip.hidden?strip.getBoundingClientRect().top-12:innerHeight-24;
      const height=Math.max(180,Math.min(900,boundary-Math.max(88,rail.getBoundingClientRect().top)));
      const value=Math.floor(height)+'px';if(rail.style.height!==value)rail.style.height=value;
    });
  }
  const railObserver=new ResizeObserver(fitChat);
  for(const node of document.querySelectorAll('.page-heading,.demo-note,#operational-maintenance,#control-strip'))railObserver.observe(node);
  addEventListener('resize',fitChat);addEventListener('scroll',fitChat,{passive:true});
  function stop(){clearTimeout(timer);timer=null;}
  function reset(){epoch++;stop();notes?.reset();notes=null;notesCapable=false;tab='posts';ready=false;infoBusy=false;loading=false;chatBusy=false;composeBusy=false;commentBusy=false;chatSending=false;posts=[];postCursor=null;selected=null;comments=[];messages=[];chatCursor=null;chatBefore=null;history=false;unread=0;chatLoaded=false;postsLoaded=false;chatStatus='';chatFailed=false;postStatus='';postFailed=false;keys.reset();commentDrafts.clear();editing=null;detail?.close();composer?.close();detail?.remove();composer?.remove();detail=null;composer=null;root.replaceChildren();}
  store.onAuthChange?.(()=>{identity='';reset();});
  function install(){
    root.innerHTML=`<div class="community-tabs" id="community-tabs" role="tablist" aria-label="协作内容"><button type="button" role="tab" data-community-tab="posts">帖子</button><button type="button" role="tab" data-community-tab="chat">聊天</button></div>
      <p id="community-status" role="status" aria-live="polite"></p>
      <div class="community-layout"><section id="community-forum" role="tabpanel"><div class="community-toolbar"><label><span class="field-caption"><span>类型</span>${copyHelp('协作区','帖子用于公告与问题反馈，聊天用于即时交流。留言不会改变额度、排队或取消任务。','/guide/queue')}</span><select id="community-kind"><option value="">全部帖子</option><option value="announcement">公告</option><option value="feedback">问题反馈</option><option value="discussion">讨论</option></select></label><label id="community-filter-label" hidden><span class="field-caption">处理状态</span><select id="community-filter"><option value="">全部</option><option value="open">待处理</option><option value="investigating">处理中</option><option value="resolved">已解决</option><option value="closed">已关闭</option></select></label><div class="community-toolbar-actions"><button class="button" id="community-refresh" type="button">刷新</button><button class="button primary" id="community-create" type="button">发帖</button></div></div><div class="community-feed-focus hero-frame"><span class="hero-label">公告与最新帖子</span><div id="community-posts" class="community-posts" tabindex="0" aria-label="公告与最新帖子"></div></div><button class="button community-more" id="community-more" type="button" hidden>加载更多</button></section>
      <section id="community-chat" role="tabpanel" hidden><div class="chat-topline"><div><div class="copy-caption"><h3>实验室聊天</h3>${copyHelp('公共聊天','登录成员可见，消息保留 30 天，重要进展请发帖保存。请勿发送密码或令牌。','/guide/queue')}</div></div><button class="button" id="chat-refresh" type="button">刷新</button></div><p id="chat-status" role="status" aria-live="polite" hidden></p><details id="community-task-notes" class="community-task-notes" hidden><summary><span class="copy-caption"><span>任务留言</span>${copyHelp('任务留言','任务留言随任务确认结束删除，非任务留言需手动删除。所有登录成员可见，任务状态未知或停止尚未确认时继续保留。','/guide/results')}</span></summary>${taskNotesMarkup}</details><button class="button community-more" id="chat-older" type="button" hidden>查看更早消息</button><button class="button community-more" id="chat-latest" type="button" hidden>返回最新消息</button><div id="community-messages" class="community-messages" tabindex="0" aria-label="公共聊天消息"></div><button class="button chat-new" id="chat-new" type="button" hidden>查看新消息</button><form id="community-chat-form"><label for="community-chat-body">发送消息</label><textarea id="community-chat-body" rows="3" maxlength="2000" required placeholder="交流计划，协调排队。"></textarea><div class="chat-compose-footer"><p>保留 30 天</p><button class="button" type="submit">发送消息</button></div><p id="chat-error" class="form-error" role="status"></p></form></section></div>`;
    for(const [index,node] of [...root.querySelectorAll('[data-community-tab]')].entries()){
      node.id='community-tab-'+node.dataset.communityTab;node.setAttribute('aria-controls',node.dataset.communityTab==='chat'?'community-chat':'community-forum');
      node.addEventListener('click',()=>selectTab(node.dataset.communityTab));
      node.addEventListener('keydown',event=>{const all=[...root.querySelectorAll('[data-community-tab]')].filter(item=>!item.hidden),current=all.indexOf(node);let next;if(event.key==='ArrowRight')next=(current+1)%all.length;if(event.key==='ArrowLeft')next=(current+all.length-1)%all.length;if(event.key==='Home')next=0;if(event.key==='End')next=all.length-1;if(next!==undefined){event.preventDefault();all[next].focus();selectTab(all[next].dataset.communityTab);}});
    }
    q('#community-kind').addEventListener('change',()=>{setTabs();loadPosts();});q('#community-filter').addEventListener('change',()=>loadPosts());q('#community-refresh').addEventListener('click',()=>loadPosts());q('#community-more').addEventListener('click',()=>loadPosts(true));q('#community-create').addEventListener('click',()=>openComposer('post'));
    q('#chat-refresh').addEventListener('click',()=>{history=false;loadChat('refresh');});q('#chat-older').addEventListener('click',()=>loadChat('older'));q('#chat-latest').addEventListener('click',()=>{history=false;loadChat('refresh');});
    q('#chat-new').addEventListener('click',()=>{q('#community-messages').scrollTop=q('#community-messages').scrollHeight;unread=0;q('#chat-new').hidden=true;});
    const announcements=button('全部公告',()=>{q('#community-kind').value='announcement';if(tab!=='posts')selectTab('posts');else{setTabs();loadPosts();}});announcements.id='community-announcements';
    const publish=button('发布公告',()=>{if(admin())openComposer('post',null,true);});publish.id='community-publish-announcement';publish.hidden=!admin();
    q('.community-toolbar-actions').append(announcements,publish);
    notes=createTaskNotesUI(root,store,toast);q('#task-note-form [type=submit]').classList.remove('primary');q('#community-task-notes').addEventListener('toggle',syncNotes);q('#community-chat-form').addEventListener('submit',sendChat);setTabs();
    for(const control of root.querySelectorAll('button,input,select,textarea'))if(!control.dataset.communityTab&&!control.hasAttribute('data-copy-help'))control.disabled=true;
  }
  function setTabs(){
    q('#community-task-notes').hidden=!ready||!notesCapable;
    q('#community-tabs').hidden=wide.matches;q('#chat-status').hidden=!wide.matches;
    q('#community-chat-form [type=submit]').classList.toggle('primary',!wide.matches);
    for(const node of root.querySelectorAll('[data-community-tab]')){const active=node.dataset.communityTab===tab;node.setAttribute('aria-selected',String(active));node.tabIndex=active?0:-1;}
    q('#community-forum').hidden=!postsShown();q('#community-chat').hidden=!chatShown();q('#community-filter-label').hidden=q('#community-kind').value!=='feedback';
    q('#community-forum').setAttribute('aria-labelledby','community-tab-posts');q('#community-chat').setAttribute('aria-labelledby','community-tab-chat');
    if(ready)message(wide.matches||tab==='posts'?postStatus:chatStatus,wide.matches||tab==='posts'?postFailed:chatFailed);fitChat();
  }
  function syncNotes(){notes?.sync(visible&&chatShown()&&q('#community-task-notes').open,ready&&notesCapable);}
  async function enable(){
    if(infoBusy||ready||!identity)return;infoBusy=true;const stamp=context();message('正在连接协作区…');
    try{const info=await store.call('community.info',{});if(!valid(stamp))return;if(info?.enabled!==true)throw Error('协作区尚未启用');ready=true;notesCapable=Array.isArray(info.capabilities)&&info.capabilities.includes('task-notes-v1');setTabs();for(const control of root.querySelectorAll('button,input,select,textarea'))control.disabled=false;syncNotes();message('');await Promise.all([...(postsShown()?[loadPosts()]:[]),...(chatShown()?[loadChat('refresh')]:[])]);}
    catch(error){if(valid(stamp))message('协作区暂不可用，请稍后刷新。尚未发送任何内容。',true);}
    finally{if(valid(stamp))infoBusy=false;}
  }
  function selectTab(next){if(!['posts','chat'].includes(next)||next===tab)return;tab=next;stop();setTabs();message('');syncNotes();if(tab==='posts'){posts=[];postsLoaded=false;postCursor=null;renderPosts();}if(!ready){enable();return;}if(tab==='chat')loadChat(messages.length?'poll':'refresh');else loadPosts();}
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
  async function moderate(change){if(!selected)return;const current=selected,stamp=context();try{const result=await store.call('community.posts.update',{id:current.id,revision:current.revision,...change});if(!valid(stamp)||selected?.id!==current.id)return;selected=result.post;renderDetail();loadPosts();detail.querySelector('#community-detail-status').textContent='已更新。';}catch(error){if(valid(stamp)&&selected?.id===current.id)detail.querySelector('#community-detail-status').textContent=error.status===409?'帖子已被更新，请重新打开后再操作。':error.message;}}
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
  function composerKind(){const form=composer.querySelector('form'),post=editing?.type==='post',announcement=post&&form.elements.kind.value==='announcement';composer.querySelector('#community-kind-field').hidden=!post;composer.querySelector('#community-type-field').hidden=!announcement;composer.querySelector('#community-pin-field').hidden=!announcement||Boolean(editing?.item);composer.querySelector('#community-announcement-target').hidden=!announcement||store.data?.announcements?.version!==1;composer.querySelector('#community-audience-members').hidden=form.elements.audience.value!=='users';}
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
  async function sendComposer(event){event.preventDefault();if(composeBusy||!editing)return;composeBusy=true;const stamp=context(),current=editing,form=event.currentTarget,submit=form.querySelector('[type=submit]'),kind=current.item?.kind||form.elements.kind.value;submit.disabled=true;const error=composer.querySelector('#community-compose-error');error.textContent='';form.elements.title.readOnly=true;form.elements.body.readOnly=true;for(const name of ['kind','announcementType','pinned'])form.elements[name].disabled=true;lockAudience(true);const fields={body:form.elements.body.value,...(current.type==='post'?{title:form.elements.title.value,...(kind==='announcement'?{announcementType:form.elements.announcementType.value,...(!current.item?{pinned:form.elements.pinned.checked}:{}),...(store.data?.announcements?.version===1?audienceFields():{})}:{})}:{})};try{
      const result=current.item?await store.call('community.'+({post:'posts',comment:'comments',message:'chat'}[current.type])+'.update',{id:current.item.id,revision:current.item.revision,...fields}):await create('post','community.posts.create',{kind,...fields});
      if(!valid(stamp))return;dismissSheet(composer);editing=null;if(result.deleted)toast('这条内容已被删除，没有重复发布。');else toast(current.item?'修改已保存。':'已发布。');
      if(current.type==='post'){loadPosts();if(selected?.id===current.item?.id&&result.post){selected=result.post;renderDetail();}}
      else if(current.type==='comment')loadComments();else loadChat('refresh');
    }catch(e){if(valid(stamp)){const uncertain=!current.item&&keys.hasUncertain('post');error.textContent=uncertain?'发送结果未确认。请重试原内容，不会重复发帖。':e.status===409?'内容已被更新。你的文字仍保留，请取消并重新打开最新内容后再修改。':e.message;form.elements.title.readOnly=uncertain;form.elements.body.readOnly=uncertain;form.elements.kind.disabled=uncertain||Boolean(current.item);form.elements.announcementType.disabled=uncertain;form.elements.pinned.disabled=uncertain;}}
    finally{if(valid(stamp)){composeBusy=false;submit.disabled=false;lockAudience(!current.item&&keys.hasUncertain('post'));}}
  }
  async function remove(type,item){if(!window.confirm('确定删除这'+(type==='post'?'篇帖子及其回复':type==='message'?'条消息':'条回复')+'？'))return;const stamp=context();try{await store.call('community.'+({post:'posts',comment:'comments',message:'chat'}[type])+'.delete',{id:item.id,revision:item.revision});if(!valid(stamp))return;if(type==='post'){if(selected?.id===item.id)dismissSheet(detail,{drilldown:true});loadPosts();}else if(type==='comment')loadComments();else{messages=messages.filter(row=>row.id!==item.id);renderMessages(false);}toast('已删除。');}catch(error){if(valid(stamp))toast(error.status===409?'内容已被更新，请刷新后重新确认删除。':error.message);}}
  function arm(){stop();if(visible&&ready&&chatShown()&&!document.hidden&&!history)timer=setTimeout(()=>loadChat('poll'),5000);}
  async function loadChat(mode){
    if(!ready||chatBusy)return;chatBusy=true;
    const stamp=context(),scroll=q('#community-messages'),atEnd=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<80;
    try{
      let more=false;
      // Three pages per turn bounds catch-up work. The next timer resumes the
      // actual cursor, never the server's global latestCursor.
      for(let page=0;page<(mode==='poll'?3:1);page++){
        const recentPage=mode==='refresh'||mode==='poll'&&!chatCursor;
        const result=await store.call('community.chat.list',{limit:50,...(mode==='older'&&chatBefore?{before:chatBefore}:mode==='poll'&&chatCursor?{after:chatCursor}:{})});if(!valid(stamp))return;
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
        const recent=await store.call('community.chat.list',{limit:50});if(!valid(stamp))return;
        const oldest=recent.messages[0]?.id;
        messages=oldest?[...messages.filter(row=>BigInt(row.id)<BigInt(oldest)),...recent.messages].slice(-200):[];
        chatBefore=recent.hasMore?messages[0]?.id||null:null;lastChatReconcile=Date.now();
      }
      renderMessages(mode==='refresh'||(atEnd&&mode!=='older'));q('#chat-older').hidden=!chatBefore;q('#chat-latest').hidden=!history;
      chatLoaded=true;chatMessage(history?'正在查看历史消息。返回最新消息后恢复自动更新。':'');
    }catch(error){if(valid(stamp))chatMessage('消息读取失败：'+error.message,true);}finally{if(valid(stamp)){chatBusy=false;arm();}}
  }
  function renderMessages(toEnd){const list=q('#community-messages'),oldTop=list.scrollTop;list.replaceChildren();for(const item of messages){const row=el('article','chat-message'+(item.author?.id===store.principal?.userId?' own':''));row.dataset.messageId=item.id;const avatar=el('span','chat-avatar',(item.author?.name||item.author?.username||'成员').slice(0,1));avatar.setAttribute('aria-hidden','true');const body=el('div','chat-message-content');body.append(el('p','community-meta',(item.author?.name||item.author?.username||'成员')+' · '+date(item.createdAt)),el('p','community-body',item.body),itemActions(item,'message'));row.append(avatar,body);list.append(row);}if(!messages.length)list.append(el('p','community-empty','还没有消息，先聊聊用卡计划吧。'));if(toEnd){list.scrollTop=list.scrollHeight;unread=0;}else list.scrollTop=oldTop;q('#chat-new').hidden=!unread;q('#chat-new').textContent=unread+' 条新消息 · 查看';}
  async function sendChat(event){event.preventDefault();if(chatSending||!ready)return;chatSending=true;const stamp=context(),form=event.currentTarget,input=q('#community-chat-body'),submit=form.querySelector('[type=submit]');submit.disabled=true;input.readOnly=true;q('#chat-error').textContent='';try{const result=await create('chat','community.chat.send',{body:input.value});if(!valid(stamp))return;input.value='';input.readOnly=false;if(result.deleted)q('#chat-error').textContent='这条消息已删除或过期，没有重新发送。';history=false;await loadChat('refresh');}catch(error){if(valid(stamp)){const unknown=keys.hasUncertain('chat');input.readOnly=unknown;q('#chat-error').textContent=unknown?'发送结果未确认。请重试原内容，不会重复发送。':error.message;}}finally{if(valid(stamp)){chatSending=false;submit.disabled=false;}}}
  const layoutObserver=new ResizeObserver(([entry])=>{
    const next=entry.contentRect.width>=56*parseFloat(getComputedStyle(document.documentElement).fontSize);
    if(next===wide.matches)return;wide.matches=next;
    if(!identity||!q('#community-kind'))return;setTabs();syncNotes();stop();
    if(!visible||!ready)return;if(postsShown()&&!postsLoaded)loadPosts();if(chatShown()&&!chatLoaded)loadChat('refresh');else arm();
  });
  layoutObserver.observe(root);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(visible&&ready&&chatShown()){loadChat('poll');}});
  return function sync(isVisible){const next=principal(store);if(next!==identity){identity=next;reset();if(next)install();}visible=Boolean(isVisible&&next);if(next)syncNotes();fitChat();if(!visible){stop();return;}if(!ready)enable();else arm();};
}
