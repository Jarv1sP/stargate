import {hasAdminSections} from './admin-ui.js';
import {endedJob,escapeUI as esc,stateHTML,stateClass,stateWord,trainingReadout,trajectoryHTML,parseTrainingCommand,infoHTML,boundarySweep,serverIdHTML,personalQuotaReadout} from './workbench-ui.js';
import {captureObject,dismissReveal,openDialogs} from './motion-ui.js';
import {recentFailure,failureReadKey,attentionCount,createAttentionReads,mergeAttentionActivities} from './attention-state.js';

const finite=value=>Number.isSafeInteger(value)&&value>=0;
const activeData=new Set(['UPLOADING','QUEUED','RUNNING','IMPORTING','DOWNLOADING','COPYING']);
const failedData=new Set(['FAILED','UNKNOWN','PARTIAL','UNCONFIRMED']);
export function controlSnapshot(store,{sessions=[],activities=[],activitiesComplete=false,focusJobId,now=Date.now(),seen=null}={}){
  const principal=store.principal,user=store.users.find(row=>row.id===principal?.userId);
  if(!principal)return {jobs:[],active:[],attention:[],approvals:[],failedJobs:[],servers:[],sessions:[],activities:[],focal:null,quota:null,usage:null,dataCount:null};
  const jobs=store.jobs,active=jobs.filter(row=>!endedJob(row));
  const focal=active.find(row=>row.id===focusJobId&&row.state==='RUNNING'&&!row.cancelRequested)||active.find(row=>row.state==='RUNNING'&&!row.cancelRequested)||null;
  const ownedSessions=sessions.filter(row=>row.userId===principal.userId);
  const ownedActivities=[...new Map(activities.filter(row=>typeof row.id==='string').map(row=>[row.id,row])).values()];
  const unread=(kind,row)=>recentFailure(row,now)&&!seen?.has(failureReadKey(kind,row)),failedJobs=jobs.filter(row=>row.state==='FAILED');
  const attention=jobs.filter(row=>row.state==='UNKNOWN'||row.state==='FAILED'&&unread('job',row)).map(row=>({id:'job:'+row.id,name:row.name||'训练',fact:row.error||row.latestAttempt?.failureReason||stateWord(row),action:row.state==='FAILED'?'查看诊断':'刷新核对',jobId:row.id,state:row.state,readKey:row.state==='FAILED'?failureReadKey('job',row):null}));
  for(const row of ownedActivities.filter(row=>failedData.has(row.state)&&(row.state!=='FAILED'||unread('data',row))))attention.push({id:'data:'+row.id,name:row.name||row.kind||'后台数据任务',fact:row.error||row.state,action:'查看数据任务',activityId:row.id,state:row.state,readKey:row.state==='FAILED'?failureReadKey('data',row):null});
  const approvals=principal.role==='admin'?store.users.filter(row=>row.enabled&&row.role!=='admin'&&!row.approvedAt&&row.total===0):[];
  const hosts=new Map((store.data?.gpuq?.hosts||[]).map(host=>[host.id,host]));
  const servers=(store.data?.machines||[]).map(machine=>{
    // Reachability alone is not a confirmed scheduler observation. Never paint
    // missing/failed collection as online or infer that unknown cards are free.
    const host=hosts.get(machine.id),fresh=store.production===true&&store.data?.gpuq?.stale===false&&host?.reachable===true&&host.gpuq?.connected===true&&host.gpuq?.health==='ok';
    const state=!fresh?'unknown':host.gpuq?.observeOnly?'observe':'online';
    const available=Array.isArray(host?.gpus)&&host.gpus.length===machine.cards&&new Set(host.gpus.map(gpu=>gpu.index)).size===machine.cards&&host.gpus.every(gpu=>Number.isSafeInteger(gpu.index)&&gpu.index>=0&&gpu.index<machine.cards&&gpu.processesAvailable===true&&Array.isArray(gpu.processes));
    const busy=fresh&&available?host.gpus.filter(gpu=>gpu.processes?.length>0).length:null;
    return {...machine,host,fresh,available,state,busy,quota:finite(user?.limits?.[machine.id])?user.limits[machine.id]:null};
  });
  const usage=user&&typeof store.usage==='function'?store.usage(user.id):null;
  return {jobs,active,attention,approvals,failedJobs,servers,sessions:ownedSessions,activities:ownedActivities,focal,quota:finite(user?.total)?user.total:null,usage,quotaReadout:personalQuotaReadout(user,usage),dataCount:activitiesComplete?ownedActivities.filter(row=>activeData.has(row.state)).length:null};
}
function sessionName(){return '容器终端 · 无 GPU';}
export function sessionStatus(session){return session.connectionState==='ended'?'已结束':session.connectionState==='connecting'?'连接中':session.connectionState==='unknown'?'连接待核对':session.detached?'已断开 · 可重连':'已连接';}
function monitorDot(server){return `<span class="cs-dot ${server.state==='online'?'':server.state}" aria-hidden="true"></span>`;}
function serverHint(server){return server.id+' · '+(server.busy===null?'进程占用未确认':`${server.busy}/${server.cards} 张有进程`)+(server.host?.checkedAt?' · 采集 '+new Date(server.host.checkedAt).toLocaleTimeString('zh-CN',{hour12:false}):'')+(server.state==='observe'?' · 仅观察':server.state==='unknown'?' · 暂时无法采集':'');}
function stateCounts(jobs){return ['st-run','st-start','st-queue','st-cancel','st-unk'].map(type=>({type,count:jobs.filter(job=>stateClass(job)===type).length,label:({'st-run':'运行中','st-start':'启动中','st-queue':'排队中','st-cancel':'正在取消','st-unk':'状态待核对'})[type]})).filter(row=>row.count>0);}
function stripHTML(snapshot){
  const focal=snapshot.focal,r=focal?trainingReadout(focal):null,session=snapshot.sessions.at(-1);
  const counts=stateCounts(snapshot.active);
  return (focal?`<button type="button" class="cs-seg cs-focal" data-control-job="${esc(focal.id)}" aria-label="打开 ${esc(focal.name)} 任务详情"><span class="r5-boundary-line" aria-hidden="true"></span>${stateHTML(focal,false)}<span class="cs-job"><span class="cs-name">${esc(focal.name||'训练')}</span>${r.percent===null?'':`<span class="cs-value">${r.percent}%</span>`}<span class="cs-meta">${r.percent===null?esc(r.description):`<progress class="cs-progress" max="100" value="${r.percent}" aria-label="训练上报进度"></progress>`}${esc(r.eta)}</span></span></button>`:'')+
    (counts.length||snapshot.attention.length?`<div class="cs-seg cs-counts">${counts.length?`<button type="button" class="cs-count-link" data-control-section="jobs" aria-label="查看进行中的训练"><span>任务</span>${counts.map(row=>`<span class="st ${row.type}" role="img" aria-label="${row.count} 项${row.label}"><span class="g" aria-hidden="true"></span>${row.count}</span>`).join('')}</button>`:''}${snapshot.attention.length?`<button type="button" class="cs-attention" data-control-section="attention" aria-label="${snapshot.attention.length} 项需要处理">${stateHTML({state:'FAILED'},false)}需处理 ${attentionCount(snapshot.attention.length)}</button>`:''}</div>`:'')+
    (session?`<button type="button" class="cs-seg" data-control-session="${esc(session.id)}"><span class="cs-dot ${session.detached?'observe':''}" aria-hidden="true"></span><span class="cs-small">${sessionName(session)}<small>${esc(session.id.slice(0,6))} · ${sessionStatus(session)}</small></span></button>`:'')+
    (snapshot.activities.length?`<button type="button" class="cs-seg" data-control-section="sessions"><span class="cs-small">后台数据${snapshot.dataCount===null?'':` · ${snapshot.dataCount} 项进行中`}<small>${snapshot.dataCount===null?'已读取的任务':'已确认状态'}</small></span></button>`:'')+
    (snapshot.servers.length?`<button type="button" class="cs-seg cs-server-list" data-control-section="servers" aria-label="我的服务器" title="${esc(snapshot.servers.map(serverHint).join('\n'))}"><span class="cs-server-label">我的服务器</span><span class="cs-server-summary" aria-hidden="true">${snapshot.servers.length} 台</span>${snapshot.servers.map(server=>`<span class="cs-server" title="${esc(serverHint(server))}">${monitorDot(server)}${serverIdHTML(server.id,'cs-server-id')}</span>`).join('')}</button>`:'')+
    '<button type="button" class="cs-seg cs-command" data-control-section="command" aria-label="总控与命令输入">⌘K</button>';
}
function overviewHTML(snapshot){
  const states=['online','observe','unknown'].map(state=>({state,count:snapshot.servers.filter(server=>server.state===state).length,label:{online:'在线',observe:'仅观察',unknown:'无法采集'}[state]})).filter(row=>row.count);
  const readout=snapshot.quotaReadout;
  return `<div class="mc-overview"><div class="mc-meter"><span class="mc-meter-label">${readout.exempt?'请求 · 不限个人额度':'额度'}</span><div class="mc-meter-value">${readout.value}<small>张</small></div></div><div class="mc-meter"><span class="mc-meter-label">进行中</span><div class="mc-meter-value">${snapshot.active.length}</div></div><div class="mc-meter ${snapshot.attention.length?'mc-meter-alert':''}"><span class="mc-meter-label">需处理</span><div class="mc-meter-value">${attentionCount(snapshot.attention.length)}</div></div><div class="mc-meter"><span class="mc-meter-label">我的服务器</span><div class="mc-meter-value">${snapshot.servers.length}<small>台</small></div><div class="mc-monitor">${states.map(row=>`<span class="mc-monitor-state" role="img" aria-label="${row.count} 台${row.label}"><span class="cs-dot ${row.state==='online'?'':row.state}" aria-hidden="true"></span>${row.count}<span class="mc-monitor-word">${row.label}</span></span>`).join('')}</div></div></div>`;
}
function attentionHTML(snapshot){
  if(!snapshot.attention.length&&!snapshot.failedJobs.length)return '';
  return `<section id="control-attention" aria-labelledby="control-attention-title"><div class="mc-attention-heading"><h2 class="control-section-title" id="control-attention-title">需要处理 · ${attentionCount(snapshot.attention.length)}</h2>${snapshot.attention.some(row=>row.readKey)?'<button type="button" class="button quiet" data-control-ack-all>全部知道了</button>':''}</div><div class="mc-attention">${snapshot.attention.map(row=>`<article class="mc-attention-item"><div class="mc-attention-title">${stateHTML({state:row.state||'PENDING'},false)}<strong title="${esc(row.name)}">${esc(row.name)}</strong></div><small title="${esc(row.fact)}">${esc(row.fact)}</small><div class="mc-attention-actions"><button type="button" class="button quiet" data-control-attention="${esc(row.id)}">${row.action}</button>${row.readKey?`<button type="button" class="button quiet" data-control-ack="${esc(row.id)}">知道了</button>`:''}</div></article>`).join('')}</div>${snapshot.failedJobs.length?`<a class="mc-failure-history" href="#work" data-control-history>查看全部失败 ${snapshot.failedJobs.length} 项</a>`:''}</section>`;
}
export function serverSlotsHTML(server){
  const gpus=new Map((server.host?.gpus||[]).map(gpu=>[gpu.index,gpu]));
  return `<div class="slots" aria-label="${esc(server.id)} 的 ${server.cards} 张显卡">${Array.from({length:finite(server.cards)?server.cards:0},(_,index)=>{
    const gpu=gpus.get(index),known=server.fresh&&server.available===true&&gpu?.processesAvailable===true&&Array.isArray(gpu.processes)&&Number.isFinite(gpu.memoryUsedMiB)&&gpu.memoryUsedMiB>=0&&Number.isFinite(gpu.memoryTotalMiB)&&gpu.memoryTotalMiB>0;
    return `<span class="slot ${known?(gpu.processes.length?'used':'free'):'unknown hatch'}" aria-label="GPU ${index} · ${known?gpu.processes.length+' 个进程 · 显存 '+gpu.memoryUsedMiB+' / '+gpu.memoryTotalMiB+' MiB':'占用未确认'}">${known?`<progress class="slot-vram" aria-label="GPU ${index} 已用显存" max="${gpu.memoryTotalMiB}" value="${Math.max(0,Math.min(gpu.memoryUsedMiB,gpu.memoryTotalMiB))}"></progress>`:''}<span>${index}</span></span>`;
  }).join('')}</div>`;
}

export function controlUI(store,{navigate,getPage,toast,openSubmit,openJob}){
  const strip=document.querySelector('#control-strip'),pill=document.querySelector('#live-pill'),mobile=document.querySelector('#mobile-control'),dialog=document.querySelector('#mission-control'),content=document.querySelector('#mission-control-content');
  let sessions=[],activities=[],activitiesComplete=false,focusJobId=null,actor=null,snapshot=controlSnapshot(store),expanded=false,source='command',commands=[],recent=[],cursor=0,closing=null,returnFocus=null,gPending=0,lastStrip='',previousJobs=new Map(),liveStates=new Set(),naturalDraft=null,naturalGeneration=0;
  const stripPlace=document.createComment('persistent control strip');strip.before(stripPlace);
  const reads=createAttentionReads();
  let dataRevision=0,dataReadGeneration=0,dataReading=false,dataReadAt=0,dataController=null;
  async function readActivities(){
    if(dataReading||!store.principal||!store.production||store.data?.transfers?.version!==1||document.hidden||Date.now()-dataReadAt<15000)return;
    const owner=store.principal.userId,auth=store.authGeneration,revision=dataRevision,request=++dataReadGeneration,controller=new AbortController();
    dataReading=true;dataReadAt=Date.now();dataController=controller;
    const current=()=>request===dataReadGeneration&&store.principal?.userId===owner&&store.authGeneration===auth;
    let rows=[],cursor=0,complete=false;const cursors=new Set();
    try{
      // Metadata only: owner-filtered SQLite pages, no catalog, node or write.
      for(let page=0;page<100;page++){
        const result=await store.call('transfers.list',{cursor,limit:50},{signal:controller.signal});if(!current()||dataRevision!==revision)return;
        if(!Array.isArray(result?.transfers))throw Error('传输目录待确认');
        rows=mergeAttentionActivities(rows,result.transfers,owner,false);
        if(result.nextCursor===null){complete=result.partial!==true;break;}
        if(!Number.isSafeInteger(result.nextCursor)||result.nextCursor<=0||cursors.has(result.nextCursor))throw Error('传输分页待确认');
        cursor=result.nextCursor;cursors.add(cursor);
      }
      if(current()&&dataRevision===revision){activities=mergeAttentionActivities(activities,rows,owner,complete);activitiesComplete=complete;}
    }catch{if(current()&&dataRevision===revision)activitiesComplete=false;}
    finally{if(current()){dataReading=false;dataController=null;dataReadAt=Date.now();update();}}
  }
  function resetActivities(){dataReadGeneration++;dataController?.abort();dataController=null;dataReading=false;dataReadAt=0;dataRevision++;activities=[];activitiesComplete=false;}

  function acknowledge(keys,manual=false){
    if(!reads.acknowledge(store.principal?.userId,keys)&&manual)toast('浏览器未保存已读，仍显示最近 24 小时的失败。');
    update();
  }
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function actionButton(id,label,code='',run){return {id,label,code,run};}
  function makeCommands(){
    const machine=document.querySelector('[name=workspace-machine]')?.value,project=document.querySelector('[name=workspace-project]')?.value;
    const rows=[actionButton('work','工作台','gpuctl jobs',()=>navigate('work')),actionButton('resources','算力总览','gpuctl state',()=>navigate('resources')),actionButton('datasets','存储','gpuctl data list',()=>navigate('datasets')),actionButton('transfers','传输与导入','gpuctl transfer list',()=>navigate('transfers')),actionButton('community','协作区','',()=>navigate('community'))];
    if(machine&&document.querySelector('#train-form'))rows.unshift(actionButton('submit','提交训练'+(project?' · '+project:''),'gpuctl run '+machine,openSubmit));
    const terminal=document.querySelector('#terminal-open');if(terminal&&!terminal.disabled&&machine)rows.push(actionButton('terminal','打开开发终端','gpuctl ssh '+machine,()=>terminal.click()));
    for(const job of snapshot.active)rows.push(actionButton('job:'+job.id,'查看任务 · '+job.name,'gpuctl watch '+job.id,()=>openJob(job.id)));
    if(store.principal?.role==='admin'&&hasAdminSections())rows.push(actionButton('admin','管理后台','',()=>navigate('admin')));
    return rows;
  }
  const commandMachines=()=>{const user=store.users.find(row=>row.id===store.principal?.userId);return (store.data?.machines||[]).filter(row=>user?.limits?.[row.id]>0);};
  function renderNatural(){
    const root=dialog.querySelector('#control-training-preview');if(!root)return;
    const draft=naturalDraft;root.hidden=!draft;dialog.classList.toggle('training-preview',!!draft);dialog.querySelector('.mc-body')?.classList.toggle('has-natural',!!draft);if(!draft)return;
    root.innerHTML=`<h2 id="control-training-title">预填训练</h2><p>${serverIdHTML(draft.machine)} · ${draft.cards} 张 · /datasets/${esc(draft.dataset)}</p><pre>${esc(draft.command)}</pre><button class="button primary" type="button" data-natural-use>预填提交</button><button class="button quiet" type="button" data-natural-back>返回</button>`;
  }
  function reviewTraining(text){const parsed=parseTrainingCommand(text,commandMachines());if(!parsed)return;naturalDraft={...parsed,project:document.querySelector('[name=workspace-project]')?.selectedOptions[0]?.dataset.project||''};renderNatural();}
  function updateCommands(){
    const input=dialog.querySelector('#control-command'),search=input?.value.trim().toLocaleLowerCase()||'';
    commands=commands.filter(row=>row.id!=='parse-training');const raw=input?.value||'',parsed=parseTrainingCommand(raw,commandMachines());if(parsed)commands.unshift({...actionButton('parse-training','预填训练配置','',()=>reviewTraining(raw)),keepOpen:true});
    const ordered=[...recent.map(id=>commands.find(row=>row.id===id)).filter(Boolean),...commands.filter(row=>!recent.includes(row.id))];
    const visible=ordered.filter(row=>row.id==='parse-training'||(row.label+' '+row.code).toLocaleLowerCase().includes(search)).slice(0,expanded||search?24:3);cursor=Math.min(cursor,Math.max(0,visible.length-1));
    const root=dialog.querySelector('#control-suggestions');root.className=expanded||search?'mc-suggestions':'mc-recent';root.innerHTML=visible.length?visible.map((row,index)=>`<button type="button" id="control-option-${index}" title="${esc(row.code)}" class="${expanded||search?'mc-suggestion':'button quiet mc-recent-action'} ${cursor===index?'selected':''}" data-command-id="${esc(row.id)}" role="option" aria-selected="${cursor===index}"><span>${esc(row.label)}</span></button>`).join(''):'<p class="mc-command-empty">未找到匹配操作</p>';
    input?.setAttribute('aria-activedescendant',visible.length?'control-option-'+cursor:'');
  }
  function panelHTML(){
    return `<div class="mc-head glass"><div class="sr-only" id="mission-control-title">总控</div><input class="mc-input" id="control-command" aria-label="输入操作或跳转" role="combobox" aria-autocomplete="list" aria-controls="control-suggestions" aria-expanded="true" autocomplete="off" placeholder="输入页面、动作或训练命令…"><button type="button" class="button quiet mc-close" data-control-close aria-label="关闭总控">关闭</button></div>${overviewHTML(snapshot)}<div class="mc-body"><div id="control-suggestions" role="listbox" aria-label="可执行的操作"></div><section id="control-training-preview" class="mc-natural" aria-labelledby="control-training-title" hidden></section>${attentionHTML(snapshot)}<div class="mc-cols"><section class="mc-col" id="control-jobs"><h3>我的训练</h3>${snapshot.active.map(job=>`<article class="mc-row"><button type="button" class="mc-row-name" data-control-job="${esc(job.id)}">${stateHTML(job,false)}${esc(job.name||'训练')}</button><p class="mc-row-fact">${serverIdHTML(job.machine)} · ${Number.isSafeInteger(job.cards)?job.cards+' 张':'卡数未确认'} · ${esc(stateWord(job))}</p>${job.queueReason?infoHTML(job.queueReason,'等待原因'):''}${trajectoryHTML(job)}<div class="mc-row-actions"><button type="button" class="button quiet" data-control-job="${esc(job.id)}">详情</button><button type="button" class="button quiet" data-control-logs="${esc(job.id)}">日志</button><button type="button" class="button quiet" data-control-output="${esc(job.id)}">输出</button><button type="button" class="button danger" data-control-cancel="${esc(job.id)}" ${job.cancelRequested?'disabled':''}>取消</button></div></article>`).join('')||'<p class="mc-row-fact">没有进行中的训练。</p>'}</section><section class="mc-col" id="control-sessions"><h3>会话与数据</h3>${snapshot.sessions.map(session=>`<article class="mc-row"><button type="button" class="mc-row-name" data-control-session="${esc(session.id)}">${esc(sessionName(session))} · ${serverIdHTML(session.machine)}</button><p class="mc-row-fact">${esc(sessionStatus(session))}${session.project?' · '+esc(session.project):''}</p><code class="control-full-id">${esc(session.id)}</code><div class="mc-row-actions"><button type="button" class="button quiet" data-copy-session="${esc(session.id)}">复制 ID</button><button type="button" class="button quiet" data-control-session="${esc(session.id)}">${session.detached?'重连':'展开'}</button></div></article>`).join('')}${snapshot.activities.map(row=>`<article class="mc-row"><span class="mc-row-name">${esc(row.name||row.kind||'后台数据任务')}</span><p class="mc-row-fact">${serverIdHTML(row.machine||'')} · ${esc(row.state)}</p><button type="button" class="button quiet" data-control-activity="${esc(row.id)}">查看任务</button></article>`).join('')}${!snapshot.sessions.length&&!snapshot.activities.length?'<p class="mc-row-fact">暂无已确认的会话或后台数据任务。</p>':''}</section><section class="mc-col" id="control-servers"><h3>我的服务器</h3>${snapshot.servers.map(server=>`<article class="mc-server"><div class="mc-server-head"><strong title="${esc(server.id)}">${serverIdHTML(server.id)}</strong><span>${{online:'监控在线',observe:'仅观察',unknown:'暂时无法采集'}[server.state]}</span></div>${serverSlotsHTML(server)}<p class="mc-row-fact">${snapshot.quotaReadout.exempt?'不限个人额度 · 单次最多 '+server.cards+' 张':'额度 '+(server.quota??'—')+' 张'}${server.host?.checkedAt?' · 更新于 '+esc(new Date(server.host.checkedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})):''}</p><button type="button" class="button quiet" data-control-machine="${esc(server.id)}">查看逐卡</button></article>`).join('')||'<p class="mc-row-fact">暂无已授权服务器。</p>'}</section></div></div><footer class="mc-footer"><div class="mc-footer-command"><span>⌘K 命令</span>${infoHTML('训练命令按「服务器 两张卡 跑 命令 用 数据集」填写。解析后预填提交参数。','中文命令用法')}</div><span>G W 工作台 · G C 算力 · G D 存储 · G X 协作</span><span>Esc 关闭</span></footer>`;
  }
  function close(immediate=false){
    if(!dialog.open)return;
    const finish=()=>{dialog.close();stripPlace.after(strip);closing=null;markOpen();returnFocus?.focus({preventScroll:true});};
    if(immediate){closing?.cancel();finish();return;}
    if(closing)return;
    closing=dismissReveal(dialog,content);stripPlace.after(strip);markOpen();returnFocus?.focus({preventScroll:true});
    closing?.finished.then(()=>{closing=null;},()=>{});
  }
  function open(section='command'){
    if(!store.principal)return;
    closing?.cancel();closing=null;source=section;expanded=section==='command';naturalDraft=null;naturalGeneration++;dialog.classList.remove('training-preview');commands=makeCommands();cursor=0;
    const showing=dialog.open;if(!showing){returnFocus=document.activeElement;content.innerHTML=panelHTML();dialog.append(strip);dialog.showModal();content.animate(reduced()?[{opacity:0},{opacity:1}]:[{clipPath:'inset(100% 0 0 0)'},{clipPath:'inset(0 0 0 0)'}],{duration:reduced()?150:320,easing:'cubic-bezier(.2,.8,.2,1)'});}
    updateCommands();dialog.querySelector('#control-command').focus({preventScroll:true});
    if(section!=='command')requestAnimationFrame(()=>{const target=dialog.querySelector('#control-'+section),body=dialog.querySelector('.mc-body');if(target&&body){const top=target.getBoundingClientRect().top-body.getBoundingClientRect().top;if(top<0||top>body.clientHeight-60)body.scrollTop+=top-12;target.animate([{borderTopColor:'var(--ink-3)'},{borderTopColor:'var(--line)'}],{duration:reduced()?150:220});}});
    markOpen();
  }
  function markOpen(){for(const segment of strip.querySelectorAll('[data-control-section]'))segment.classList.toggle('is-open',dialog.open&&segment.dataset.controlSection===source);}
  function runCommand(id){const row=commands.find(row=>row.id===id);if(!row)return;recent=[id,...recent.filter(value=>value!==id)].slice(0,3);if(!row.keepOpen)close(true);row.run();}
  function triggerJob(id,attribute='jobDetail',origin=null){const saved=captureObject(origin);close(true);if(attribute==='jobDetail')return openJob(id,'overview',saved);const button=[...document.querySelectorAll('button')].find(element=>element.dataset[attribute]===id);button?.click();}
  document.addEventListener('click',event=>{
    if(event.target.closest('[data-control-history]')){event.preventDefault();close(true);navigate('work');document.dispatchEvent(new CustomEvent('gpuq-show-job-history',{detail:{userId:store.principal?.userId,state:'FAILED'}}));return;}
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.hasAttribute('data-control-ack-all')){acknowledge(snapshot.attention.map(row=>row.readKey).filter(Boolean),true);return;}
    if(button.dataset.controlAck){const row=snapshot.attention.find(item=>item.id===button.dataset.controlAck);if(row?.readKey)acknowledge([row.readKey],true);return;}
    if(button.hasAttribute('data-natural-back')){naturalDraft=null;naturalGeneration++;renderNatural();dialog.querySelector('#control-command')?.focus();return;}
    if(button.hasAttribute('data-natural-use')){const draft=naturalDraft;if(!draft)return;const detail={machine:draft.machine,trainingConfig:{cards:draft.cards,command:draft.command,project:draft.project}};close(true);naturalDraft=null;document.dispatchEvent(new CustomEvent('gpuq-open-submit',{detail}));return;}
    if(button.dataset.controlSection){if(dialog.open&&source===button.dataset.controlSection)close();else open(button.dataset.controlSection);}
    if(button.dataset.shellAction==='control'&&!button.dataset.controlSection)open('jobs');
    if(button.hasAttribute('data-control-close'))close();
    if(button.dataset.commandId)runCommand(button.dataset.commandId);
    if(button.dataset.controlJob)triggerJob(button.dataset.controlJob,'jobDetail',button);
    for(const [key,attribute] of [['controlLogs','jobLogs'],['controlOutput','jobOutput'],['controlCancel','jobCancel']])if(button.dataset[key])triggerJob(button.dataset[key],attribute);
    if(button.dataset.copySession)navigator.clipboard.writeText(button.dataset.copySession).then(()=>toast('完整会话 ID 已复制。'),()=>toast('复制失败，请选中完整会话 ID 复制。'));
    if(button.dataset.controlSession){const session=snapshot.sessions.find(row=>row.id===button.dataset.controlSession);if(session){close(true);document.dispatchEvent(new CustomEvent('gpuq-terminal-reveal',{detail:{id:session.id,userId:store.principal.userId}}));}}
    if(button.dataset.controlMachine){close(true);navigate('resources');document.dispatchEvent(new CustomEvent('gpuq-open-resource',{detail:{machine:button.dataset.controlMachine,userId:store.principal?.userId}}));}
    if(button.dataset.controlActivity){close(true);navigate('transfers');document.dispatchEvent(new CustomEvent('gpuq-reveal-data-activity',{detail:{id:button.dataset.controlActivity,userId:store.principal?.userId}}));}
    if(button.dataset.controlAttention){const row=snapshot.attention.find(item=>item.id===button.dataset.controlAttention);if(!row)return;close(true);if(row.jobId){if(row.state==='UNKNOWN')document.querySelector('#refresh-state').click();else openJob(row.jobId,'diagnostics');}else {navigate('transfers');document.dispatchEvent(new CustomEvent('gpuq-reveal-data-activity',{detail:{id:row.activityId,userId:store.principal?.userId}}));}}
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();}});
  dialog.addEventListener('input',event=>{if(event.target.id==='control-command'){naturalDraft=null;naturalGeneration++;renderNatural();cursor=0;updateCommands();}});
  document.addEventListener('keydown',event=>{
    const editing=event.target.closest('input,textarea,select,[contenteditable=true]');
    if(openDialogs().some(layer=>layer!==dialog))return;
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!(event.ctrlKey&&event.target.closest('.terminal-dialog'))){event.preventDefault();open('command');return;}
    if(event.target.id==='control-command'&&['ArrowDown','ArrowUp','Enter'].includes(event.key)){event.preventDefault();const rows=[...dialog.querySelectorAll('[data-command-id]')];if(!rows.length)return;if(event.key==='Enter')return runCommand(rows[cursor].dataset.commandId);cursor=(cursor+(event.key==='ArrowDown'?1:-1)+rows.length)%rows.length;updateCommands();return;}
    if(editing||event.metaKey||event.ctrlKey||event.altKey)return;
    if(event.key==='.'||event.key==='?'){event.preventDefault();open('command');return;}
    if(event.key.toLowerCase()==='g'){gPending=Date.now();return;}
    if(Date.now()-gPending<1500){gPending=0;const route={w:'work',c:'resources',d:'datasets',x:'community'}[event.key.toLowerCase()];if(route){event.preventDefault();close(true);navigate(route);}}
    if(event.key==='Escape')document.querySelector('#account-menu').open=false;
  });
  document.addEventListener('gpuq-terminal-state',event=>{sessions=event.detail.sessions||[];update();});
  document.addEventListener('gpuq-data-activities',event=>{const detail=event.detail;if(detail?.userId!==store.principal?.userId||!Array.isArray(detail.items))return;dataRevision++;activities=mergeAttentionActivities(activities,detail.items,detail.userId,detail.complete===true);activitiesComplete=detail.complete===true;update();});
  document.addEventListener('gpuq-focused-job',event=>{if(store.jobs.some(job=>job.id===event.detail.id)){focusJobId=event.detail.id;update();}});
  document.addEventListener('gpuq-attention-viewed',event=>{
    const {userId,kind,id}=event.detail||{};if(!userId||userId!==store.principal?.userId)return;
    const row=kind==='job'?store.jobs.find(job=>job.id===id&&job.state==='FAILED'):kind==='data'?activities.find(item=>item.id===id&&item.state==='FAILED'):null;
    if(row&&recentFailure(row))acknowledge([failureReadKey(kind,row)]);
  });
  store.onAuthChange(()=>{close(true);naturalDraft=null;naturalGeneration++;sessions=[];resetActivities();recent=[];focusJobId=null;actor=null;lastStrip='';previousJobs.clear();liveStates.clear();strip.replaceChildren();pill.replaceChildren();content.replaceChildren();strip.hidden=true;mobile.hidden=true;});
  function update(){
    if(actor!==store.principal?.userId){actor=store.principal?.userId;focusJobId=null;recent=[];}
    readActivities();
    snapshot=controlSnapshot(store,{sessions,activities,activitiesComplete,focusJobId,seen:reads.read(store.principal?.userId)});
    const boundaries=snapshot.jobs.filter(job=>previousJobs.get(job.id)?.state==='STARTING'&&job.state==='RUNNING').map(job=>job.id);
    for(const job of snapshot.jobs){const previous=previousJobs.get(job.id),percent=trainingReadout(job).percent;if(previous&&(previous.state!==job.state||previous.percent!==percent))liveStates.add(stateClass(job));}previousJobs=new Map(snapshot.jobs.map(job=>[job.id,{state:job.state,percent:trainingReadout(job).percent}]));
    strip.hidden=!store.principal;const html=stripHTML(snapshot);if(lastStrip!==html){lastStrip=html;strip.innerHTML=html;}for(const id of boundaries)boundarySweep([...strip.querySelectorAll('[data-control-job]')].find(row=>row.dataset.controlJob===id));markOpen();for(const glyph of strip.querySelectorAll('.st'))glyph.classList.toggle('is-live',liveStates.has([...glyph.classList].find(value=>value.startsWith('st-'))));
    const r=snapshot.focal?trainingReadout(snapshot.focal):null;pill.hidden=!store.principal||getPage()==='work'||!snapshot.focal&&!snapshot.attention.length;mobile.hidden=!store.principal||pill.hidden&&!mobile.querySelector('#open-submit');pill.dataset.controlSection=snapshot.attention.length?'attention':'jobs';pill.innerHTML=(snapshot.focal?`${stateHTML(snapshot.focal,false)}<span class="cs-name">${esc(snapshot.focal.name)}</span>${r.percent===null?'':`<span>${r.percent}%</span>`}`:'总控')+(snapshot.attention.length?`<span class="cs-attention">需处理 ${attentionCount(snapshot.attention.length)}</span>`:'');
    dialog.classList.toggle('m-full',matchMedia('(max-width:759px)').matches);
    if(dialog.open){const template=document.createElement('template');template.innerHTML=panelHTML();dialog.querySelector('.mc-overview').replaceWith(template.content.querySelector('.mc-overview'));const body=dialog.querySelector('.mc-body'),top=body.scrollTop,focused=dialog.contains(document.activeElement)?document.activeElement?.id:null;body.replaceChildren(...template.content.querySelector('.mc-body').childNodes);commands=makeCommands();updateCommands();body.scrollTop=top;renderNatural();if(focused)dialog.querySelector('#'+CSS.escape(focused))?.focus({preventScroll:true});}
  }
  return {update,open,close,snapshot:()=>snapshot};
}
