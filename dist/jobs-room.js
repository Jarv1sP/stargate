// Tasks room, built from the approved prototype: one team list, a drawer per
// task and one sheet to submit. Every action reuses an existing portal call.
import {escapeUI as esc,stateWord,trainingReadout,elapsedTraining,missionGPUs,endedJob} from './workbench-ui.js';
import {placementFromForm} from './gpu-allocation-ui.js';
import {downloadBrowserPath} from './file-transfer-ui.js';
import {diagnosticsHTML,nativeObservationHTML,completionHTML} from './job-diagnostics-ui.js';
import {deleteJobOutputs,deletableResultJob,ownResultJob,resultPullCommand} from './job-results-ui.js';
import {reducedMotion} from './motion-ui.js';
import {confirmSheet} from './sheet-ui.js';

const QUEUED=['PENDING','QUEUED','SUBMITTING'],LIVE=['RUNNING','STARTING'];
const dotClass=job=>job.cancelRequested&&!endedJob(job)?'cancel':LIVE.includes(job.state)?'run':QUEUED.includes(job.state)?'queue':job.state==='FAILED'?'fail':'done';
const rank=job=>Number.isInteger(job.schedulerPriority)?job.schedulerPriority:null;
const seconds=value=>typeof value==='number'?value:Date.parse(value)/1000;
const clock=value=>{const t=seconds(value);if(!Number.isFinite(t))return '—';const d=new Date(t*1000);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');};
const bytes=n=>!Number.isFinite(n)?'':n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':n<1073741824?(n/1048576).toFixed(1)+' MB':(n/1073741824).toFixed(2)+' GB';
const shortServer=id=>String(id||'').replace(/^amax-/,'');
const STAGES=['提交','排队','启动','运行','结束'];
const stage=job=>QUEUED.includes(job.state)?1:job.state==='STARTING'?2:job.state==='RUNNING'?3:4;
const RING=245,ARC=327;
// Numbers ease up to their value, as in the approved design.
function tick(element,to,fix=0){if(!element)return;const from=parseFloat(element.dataset.v)||0;element.dataset.v=to;if(reducedMotion()||from===to){element.textContent=(+to).toFixed(fix);return;}const start=performance.now();(function frame(now){const k=Math.min(1,(now-start)/800),e=1-Math.pow(1-k,3);element.textContent=(from+(to-from)*e).toFixed(fix);if(k<1)requestAnimationFrame(frame);})(start);}
const falcon='<svg class="jr-f9" width="46" height="170" viewBox="0 0 60 220" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M30 6c6 9 7.5 20 7.5 30v34h-15V36c0-10 1.5-21 7.5-30z"/><path d="M22.5 70h15v9h-15z"/><path d="M24 79h12v104H24z"/><path d="M24 88l-6 3v4l6-1M36 88l6 3v4l-6-1"/><path d="M24 183l-11 20M36 183l11 20M30 183v20"/><path d="M6 205h48"/><path class="jr-plume" d="M27 186c0 8 3 14 3 14s3-6 3-14"/></svg>';
const tower='<svg class="jr-catch" viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="1.2" aria-label="已回收"><path d="M15 2v26M11 28h8"/><path class="jr-arm jr-arm-l" d="M4 12h11"/><path class="jr-arm jr-arm-r" d="M15 12h11"/><rect class="jr-booster" x="12.5" y="8" width="5" height="12" rx="1" fill="currentColor" stroke="none"/></svg>';

export function jobsRoom(store,{toast,machines,getPage}){
  const host=document.querySelector('#jobs-room'),actions=document.querySelector('.heading-actions');
  let scope='mine',search='',openId=null,tab='log',logTimer=0,clockTimer=0,submitKey=crypto.randomUUID(),noteKey=crypto.randomUUID(),busy=false,lastRows='';
  const seen=new Set();
  host.innerHTML=`<div class="jr-toolbar"><div class="jr-seg" role="group" aria-label="任务范围"><span class="jr-pill" aria-hidden="true"></span><button type="button" data-scope="mine" aria-pressed="true">我的</button><button type="button" data-scope="project" aria-pressed="false">本项目</button><button type="button" data-scope="all" aria-pressed="false">全部</button></div><input class="jr-search" type="search" placeholder="搜索任务" aria-label="搜索任务"></div><div class="jr-rows" role="list" aria-label="任务列表"></div>`;
  const newButton=document.createElement('button');newButton.type='button';newButton.className='jr-btn primary';newButton.id='jobs-new';newButton.hidden=true;
  newButton.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>新建任务';actions.prepend(newButton);
  const layer=document.createElement('div');layer.className='jr-layer';
  layer.innerHTML='<div class="jr-scrim"></div><aside class="jr-drawer" aria-label="任务详情" role="dialog" aria-modal="true"><div class="jr-dr-h"><div class="jr-dr-title"></div><button type="button" class="jr-x" aria-label="关闭">✕</button></div><div class="jr-dr-b"></div></aside><div class="jr-sheet" role="dialog" aria-modal="true" aria-label="新建任务"><div class="jr-sheet-in"></div></div>';
  document.body.append(layer);
  const $=s=>host.querySelector(s),drawer=layer.querySelector('.jr-drawer'),sheet=layer.querySelector('.jr-sheet'),scrim=layer.querySelector('.jr-scrim');

  const project=()=>{try{return JSON.parse(localStorage.getItem('sg-last-project')||'null');}catch{return null;}};
  const remember=value=>{try{localStorage.setItem('sg-last-project',JSON.stringify(value));}catch{}};
  function placePill(){const on=host.querySelector('.jr-seg [aria-pressed=true]'),pill=host.querySelector('.jr-pill');if(!on||!on.offsetWidth)return;pill.style.width=on.offsetWidth+'px';pill.style.transform=`translateX(${on.offsetLeft}px)`;}
  // Running first, then the queue in order, then finished; long lists come in pages.
  const group=job=>LIVE.includes(job.state)?0:QUEUED.includes(job.state)?1:2,PAGE=50;let limit=PAGE;
  function visible(){
    const me=store.principal?.userId,current=project(),text=search.trim().toLocaleLowerCase();
    return [...store.jobs].filter(job=>(scope==='all'||(scope==='mine'?job.userId===me:!!current&&job.machine===current.machine&&job.project===current.project))&&(!text||[job.id,job.name,job.username,job.project,job.machine,stateWord(job)].some(v=>String(v||'').toLocaleLowerCase().includes(text))))
      .sort((a,b)=>group(a)-group(b)||(group(a)===1?(seconds(a.createdAt)||0)-(seconds(b.createdAt)||0):(seconds(b.createdAt)||0)-(seconds(a.createdAt)||0)));
  }
  function timeText(job){if(QUEUED.includes(job.state))return job.cancelRequested?'正在取消':'排队中';const e=elapsedTraining(job);return e||stateWord(job);}
  function rowHTML(job){
    const readout=trainingReadout(job),running=job.state==='RUNNING'&&!job.cancelRequested,fresh=!seen.has(job.id);
    const status=job.state==='FAILED'?esc(job.error||job.failure?.message||'失败'):QUEUED.includes(job.state)&&job.queueReason?esc(job.queueReason):LIVE.includes(job.state)&&readout.description?esc(readout.description):esc(stateWord(job));
    return `<button type="button" class="jr-row${fresh&&lastRows?' jr-new':''}" role="listitem" data-job="${esc(job.id)}"><span class="jr-dot ${dotClass(job)}" aria-hidden="true"></span><span class="jr-main"><span class="jr-t">${esc(job.name||'训练')}</span>${running&&readout.percent!==null?`<span class="jr-prog" role="progressbar" aria-label="训练进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${readout.percent}"><b data-w="${readout.percent}"></b></span>`:`<span class="jr-s${job.state==='FAILED'?' fail':''}">${status}</span>`}</span><span class="jr-s jr-hide-m">${esc(job.username||'成员未知')} · ${esc(job.project||'默认项目')}</span><span class="jr-s jr-hide-m mono">${esc(shortServer(job.machine))} · ${Number.isSafeInteger(job.cards)?job.cards+' 张':'—'}${rank(job)!==null?' · P'+rank(job):''}</span><span class="jr-time mono">${esc(timeText(job))}</span></button>`;
  }
  function renderRows(){
    const rows=visible(),more=rows.length-limit,html=rows.length?rows.slice(0,limit).map(rowHTML).join('')+(more>0?`<button type="button" class="jr-more" data-more>再显示 ${Math.min(more,PAGE)} 个 · 共 ${rows.length} 个</button>`:''):`<div class="jr-empty">${falcon}<p>${search||scope!=='all'&&store.jobs.length?'没有符合条件的任务。':'发射台是空的。'}<br>新建一个任务，几秒后就会排上。</p><button type="button" class="jr-btn ghost" data-empty-new>新建任务</button></div>`;
    // Widths go through CSSOM: the portal CSP blocks inline style attributes.
    if(html!==lastRows){$('.jr-rows').innerHTML=html;lastRows=html;requestAnimationFrame(()=>{for(const bar of $('.jr-rows').querySelectorAll('[data-w]'))bar.style.width=bar.dataset.w+'%';});}
    for(const job of rows.slice(0,limit))seen.add(job.id);
  }

  // Drawer: a launch-webcast readout for one task.
  function openDrawer(){scrim.classList.add('on');drawer.classList.add('on');document.body.classList.add('jr-locked');}
  function close(){scrim.classList.remove('on');drawer.classList.remove('on');sheet.classList.remove('on');document.body.classList.remove('jr-locked');openId=null;clearInterval(logTimer);clearInterval(clockTimer);}
  function ringDash(fraction){return `${Math.max(0,Math.min(1,fraction))*RING} ${ARC}`;}
  function drawerHTML(job){
    const s=stage(job),gpus=LIVE.includes(job.state)?missionGPUs(job,store.data?.gpuq,machines):[],known=gpus.length&&gpus.every(g=>g.known);
    const util=gpus.length&&gpus.every(g=>g.utilization!==null)?Math.round(gpus.reduce((a,g)=>a+g.utilization,0)/gpus.length):null;
    const mem=known?gpus.reduce((a,g)=>a+Number(g.used),0):null,memTotal=known?gpus.reduce((a,g)=>a+Number(g.total),0):null;
    const readout=trainingReadout(job),landed=job.state==='SUCCEEDED',attempt=job.latestAttempt||{};
    const times=[job.createdAt,job.createdAt,attempt.startedAt,attempt.startedAt,endedJob(job)?attempt.finishedAt:null];
    const queued=QUEUED.includes(job.state),r=rank(job);
    return `<div class="jr-hud" data-util="${util??''}" data-mem="${mem??''}" data-mem-total="${memTotal??''}"><div class="jr-ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="trk"/><circle cx="60" cy="60" r="52" class="val" data-ring="util"/></svg><div><b ${util===null?'':`data-tick="${util}" data-fix="0"`}>${util===null?'未知':'0'}</b><span>GPU 利用率 %</span></div></div>
      <div class="jr-tplus"><div class="jr-eyebrow">${queued?'T−':'T+'}</div><b class="mono" data-tplus>${queued?'排队中':esc(elapsedTraining(job)||'—')}</b><span>${readout.percent===null?esc(readout.description||'进度未上报'):'进度 '+readout.percent+'%'+(readout.epoch?' · '+esc(readout.epoch):'')}</span></div>
      <div class="jr-ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="trk"/><circle cx="60" cy="60" r="52" class="val" data-ring="mem"/></svg><div><b ${mem===null?'':`data-tick="${mem.toFixed(1)}" data-fix="1"`}>${mem===null?'未知':'0.0'}</b><span>显存 GiB</span></div></div></div>
      <div class="jr-tl"><span class="jr-done-line"></span>${STAGES.map((name,i)=>{const cls=i<s?'past':i===s?(queued||LIVE.includes(job.state)?'now':'past'):'';if(i===4&&landed)return `<div class="past">${tower}${name}<small>${clock(times[i])}</small></div>`;return `<div class="${cls}"><i></i>${name}<small>${i<=s?clock(times[i]):'—'}</small></div>`;}).join('')}</div>
      ${job.state==='FAILED'?`<p class="jr-error">${esc(job.error||job.failure?.message||'任务失败，详情见日志。')}</p>`:''}
      <div class="jr-tabs" role="tablist"><button role="tab" data-tab="log" aria-selected="${tab==='log'}">日志</button><button role="tab" data-tab="out" aria-selected="${tab==='out'}">输出</button><button role="tab" data-tab="diag" aria-selected="${tab==='diag'}">诊断</button><button role="tab" data-tab="note" aria-selected="${tab==='note'}">留言</button><span class="jr-ul" aria-hidden="true"></span></div>
      <div class="jr-pane" data-pane="log" ${tab==='log'?'':'hidden'}><div class="jr-log" data-log role="log"><div>读取中…</div></div></div>
      <div class="jr-pane" data-pane="out" ${tab==='out'?'':'hidden'}><div data-outputs class="jr-files">读取中…</div><p class="jr-hint">同一台服务器上的新任务，可以直接读写 /job-outputs/${esc(job.id)}/。</p></div>
      <div class="jr-pane" data-pane="diag" ${tab==='diag'?'':'hidden'}><div data-diag>读取中…</div><div class="jr-recovery"><div data-recovery-result></div><div class="jr-recovery-actions"><button type="button" class="jr-btn ghost" data-recover="jobs.watch">刷新观察</button><button type="button" class="jr-btn ghost" data-recover="jobs.completion">查询完成状态</button><button type="button" class="jr-btn ghost" data-recover="jobs.reconcile-resources">任务资源收尾</button></div><p class="jr-hint">只读取服务器此刻的观察，不会改写历史或重新提交。</p></div></div>
      <div class="jr-pane" data-pane="note" ${tab==='note'?'':'hidden'}><div data-notes class="jr-notes"></div><form class="jr-note-form" data-note-form><textarea class="jr-input" name="body" maxlength="2000" placeholder="给这个任务留言，团队都能看到" aria-label="任务留言"></textarea><button class="jr-btn ghost" type="submit">发布留言</button></form></div>
      <div class="jr-foot">${queued&&!job.cancelRequested?`<div class="jr-seg" role="group" aria-label="优先级"><span class="jr-pill" aria-hidden="true"></span>${[0,1,2,3,4].map(p=>`<button type="button" data-priority="P${p}" aria-pressed="${p===r}">P${p}</button>`).join('')}</div>`:`<span class="jr-hint">优先级 ${r===null?'未知':'P'+r} · 只有排队中的任务能改</span>`}<span class="jr-foot-r">${job.interactive&&job.state==='RUNNING'&&job.userId===store.principal?.userId?`<button type="button" class="jr-btn ghost" data-gpu-shell="${esc(job.id)}">打开 GPU 终端</button>`:''}${job.userId===store.principal?.userId?`<button type="button" class="jr-link" data-notify aria-pressed="${job.notifications?.enabled===true}">${job.notifications?.enabled===true?'Telegram 通知 · 已开':'结束时 Telegram 通知我'}</button>`:''}${!endedJob(job)&&!job.cancelRequested?'<button type="button" class="jr-link danger" data-cancel>取消任务</button>':''}</span></div>`;
  }
  function animateDrawer(job){
    const hud=drawer.querySelector('.jr-hud');if(!hud)return;
    requestAnimationFrame(()=>{
      const util=Number(hud.dataset.util),mem=Number(hud.dataset.mem),total=Number(hud.dataset.memTotal);
      const u=drawer.querySelector('[data-ring=util]'),m=drawer.querySelector('[data-ring=mem]');
      if(u)u.style.strokeDasharray=hud.dataset.util?ringDash(util/100):`0 ${ARC}`;
      if(m)m.style.strokeDasharray=hud.dataset.mem&&total?ringDash(mem/total):`0 ${ARC}`;
      for(const number of drawer.querySelectorAll('[data-tick]'))tick(number,Number(number.dataset.tick),Number(number.dataset.fix));
      const line=drawer.querySelector('.jr-done-line');if(line)line.style.width=Math.min(stage(job),4)/4*80+'%';
      const c=drawer.querySelector('.jr-catch');if(c)setTimeout(()=>c.classList.add('caught'),reducedMotion()?0:700);
      placeSeg(drawer.querySelector('.jr-foot .jr-seg'));placeTabs();
    });
  }
  function placeSeg(seg){if(!seg)return;const on=seg.querySelector('[aria-pressed=true]'),pill=seg.querySelector('.jr-pill');if(!on){pill.style.width='0';return;}pill.style.width=on.offsetWidth+'px';pill.style.transform=`translateX(${on.offsetLeft}px)`;}
  function placeTabs(){const on=drawer.querySelector('.jr-tabs [aria-selected=true]'),ul=drawer.querySelector('.jr-ul');if(on&&ul){ul.style.width=on.offsetWidth+'px';ul.style.transform=`translateX(${on.offsetLeft}px)`;}}
  async function loadLog(id){
    try{const result=await store.call('jobs.logs',{jobId:id});if(openId!==id)return;const box=drawer.querySelector('[data-log]');if(!box)return;const atEnd=box.scrollTop+box.clientHeight>=box.scrollHeight-8;
      // Only new lines are added, so they slide in instead of the whole log redrawing.
      const lines=(result.text||'还没有日志。').replace(/\n$/,'').split('\n'),shown=[...box.children].map(row=>row.textContent),same=shown.length<=lines.length&&shown.every((text,index)=>text===lines[index]);
      if(!same)box.replaceChildren();for(const text of lines.slice(same?shown.length:0)){const row=document.createElement('div');row.textContent=text;box.append(row);}if(atEnd)box.scrollTop=box.scrollHeight;}
    catch(error){if(openId===id){const box=drawer.querySelector('[data-log]');if(box){const row=document.createElement('div');row.textContent='日志暂时读不到：'+error.message;box.replaceChildren(row);}}}
  }
  function outputTarget(job){return {machine:job.machine,project:job.project,ownerId:job.ownerId||job.userId,area:'output',runId:job.id};}
  async function loadOutputs(job,path='.'){
    const box=drawer.querySelector('[data-outputs]');if(!box)return;box.textContent='读取中…';
    try{
      const result=await store.call('files.list',{...outputTarget(job),path});if(openId!==job.id)return;
      const entries=result.entries||[];
      box.innerHTML=(path!=='.'?`<div class="jr-file"><button type="button" class="jr-link" data-out-path="${esc(path.split('/').slice(0,-1).join('/')||'.')}" data-out-dir>← 上一级</button><span></span><span></span></div>`:'')+(entries.length?entries.map(entry=>{const full=path==='.'?entry.name:path+'/'+entry.name,dir=entry.type==='directory';return `<div class="jr-file"><button type="button" class="jr-link mono" data-out-path="${esc(full)}" ${dir?'data-out-dir':''}>${esc(entry.name)}${dir?'/':''}</button><span class="jr-s">${dir?'目录':bytes(entry.size)}</span><span class="jr-file-acts"><button type="button" class="jr-link" data-out-download="${esc(full)}" ${dir?'data-out-dir-download':''}>下载</button>${!dir&&ownResultJob(store,job)?`<button type="button" class="jr-link" data-out-copy="${esc(full)}">复制命令</button>`:''}${deletableResultJob(store,job)?`<button type="button" class="jr-link danger" data-out-delete="${esc(full)}" ${dir?'data-out-dir-delete':''}>删除</button>`:''}</span></div>`;}).join(''):'<p class="jr-hint">还没有输出。</p>');
    }catch(error){if(openId===job.id)box.textContent='输出暂时读不到：'+error.message;}
  }
  async function loadDiagnostics(id){
    const box=drawer.querySelector('[data-diag]');if(!box)return;
    try{const result=await store.call('jobs.diagnostics',{jobId:id});if(openId===id)box.innerHTML=diagnosticsHTML(result);}
    catch(error){if(openId===id)box.textContent='诊断暂时读不到：'+error.message;}
  }
  async function loadNotes(id){
    const box=drawer.querySelector('[data-notes]');if(!box)return;
    try{const result=await store.call('community.notes.list',{limit:50});if(openId!==id)return;const notes=(result.notes||[]).filter(note=>note.jobId===id);
      box.innerHTML=notes.length?notes.map(note=>`<div class="jr-note"><div class="jr-s">${esc(note.authorName||note.username||'成员')} · ${clock(note.createdAt)}</div><div>${esc(note.body)}</div></div>`).join(''):'<p class="jr-hint">还没有留言。</p>';}
    catch(error){if(openId===id)box.textContent='留言暂时读不到：'+error.message;}
  }
  function loadTab(job){if(tab==='log')loadLog(job.id);if(tab==='out')loadOutputs(job);if(tab==='diag')loadDiagnostics(job.id);if(tab==='note')loadNotes(job.id);}
  function openJob(id){
    const job=store.jobs.find(item=>item.id===id);if(!job)return;openId=id;
    const r=rank(job);
    drawer.querySelector('.jr-dr-title').innerHTML=`<div class="jr-eyebrow mono">${esc(String(job.id).slice(0,8))} · ${esc(shortServer(job.machine))} · ${Number.isSafeInteger(job.cards)?job.cards+' 张':'—'}${r!==null?' · P'+r:''}</div><div class="jr-dr-name">${esc(job.name||'训练')}</div><div class="jr-dr-meta"><span class="jr-chip ${dotClass(job)}">${esc(stateWord(job))}</span><span class="jr-hint">${esc(job.username||'')} · ${esc(job.project||'默认项目')}</span></div>`;
    drawer.querySelector('.jr-dr-b').innerHTML=drawerHTML(job);openDrawer();animateDrawer(job);loadTab(job);
    clearInterval(logTimer);clearInterval(clockTimer);
    if(LIVE.includes(job.state)){logTimer=setInterval(()=>{if(tab==='log'&&openId===id&&!document.hidden)loadLog(id);},3000);clockTimer=setInterval(()=>{const current=store.jobs.find(item=>item.id===id),t=drawer.querySelector('[data-tplus]');if(current&&t)t.textContent=elapsedTraining(current)||'—';},1000);}
  }

  // Submission sheet: project, command, cards, where, optional GPUs and priority.
  async function projectsFor(){
    const rows=[];await Promise.all(machines.map(async machine=>{try{const result=await store.call('projects.list',{machine:machine.id});for(const p of result.projects||[])if(!p.archived)rows.push({machine:machine.id,project:p.project,ownerId:p.ownerId||p.userId,ownerName:p.ownerName||''});}catch{}}));
    return rows.sort((a,b)=>a.project.localeCompare(b.project)||a.machine.localeCompare(b.machine));
  }
  async function openSheet(){
    const me=store.principal?.userId,last=project();
    sheet.querySelector('.jr-sheet-in').innerHTML='<div class="jr-eyebrow">新建任务</div><div class="jr-sheet-title">读取项目…</div>';
    scrim.classList.add('on');sheet.classList.add('on');
    const options=await projectsFor(),mine=options.filter(p=>p.ownerId===me),list=mine.length?[...mine,...options.filter(p=>p.ownerId!==me)]:options;
    const chosen=list.find(p=>last&&p.machine===last.machine&&p.project===last.project&&p.ownerId===last.ownerId)||list[0];
    sheet.querySelector('.jr-sheet-in').innerHTML=`<div class="jr-eyebrow">新建任务</div><div class="jr-sheet-title">在 <span data-sheet-project>${esc(chosen?.project||'项目')}</span> 里训练</div>
      <form data-submit-form>
        <div class="jr-field"><label for="jr-project">项目</label><select class="jr-input" id="jr-project" name="project">${list.map((p,i)=>`<option value="${i}" ${p===chosen?'selected':''}>${esc(p.project)} · ${esc(shortServer(p.machine))}${p.ownerId!==me&&p.ownerName?' · '+esc(p.ownerName):''}</option>`).join('')}</select></div>
        <div class="jr-field"><label for="jr-command">命令</label><input class="jr-input mono" id="jr-command" name="command" required value="python train.py --data /datasets --output /outputs"></div>
        <div class="jr-grid"><div class="jr-field"><label>卡数</label><div class="jr-stepper"><button type="button" data-step="-1" aria-label="减少">−</button><span data-cards>1</span><button type="button" data-step="1" aria-label="增加">+</button></div></div>
          <div class="jr-field"><label for="jr-where">放在哪</label><select class="jr-input" id="jr-where" name="where"><option value="current">项目所在的服务器</option><option value="auto">自动：选空闲最多的服务器</option></select></div></div>
        <div class="jr-field" data-gpu-field><label>指定 GPU（可选）</label><div class="jr-gpus" data-gpus></div></div>
        <div class="jr-grid"><div class="jr-field"><label for="jr-name">名字（可选，最多 64 个字）</label><input class="jr-input" id="jr-name" name="name" maxlength="64" placeholder="例如：消融 · 无 assignment"></div>
          <div class="jr-field"><label for="jr-priority">优先级</label><select class="jr-input" id="jr-priority" name="priority"><option value="normal">普通</option><option value="high">高</option><option value="idle">最低 · 可中断</option></select></div></div>
        <p class="jr-error" data-submit-error hidden></p>
        <div class="jr-actions"><button type="button" class="jr-btn ghost" data-sheet-close>取消</button><button type="submit" class="jr-btn primary">提交</button></div>
      </form>`;
    const form=sheet.querySelector('[data-submit-form]');let cards=1,gpus=new Set();
    const current=()=>list[Number(form.project.value)];
    const drawGpus=()=>{const p=current(),machine=machines.find(m=>m.id===p?.machine),field=sheet.querySelector('[data-gpu-field]'),auto=form.where.value==='auto';field.hidden=auto||!machine;if(field.hidden)return;
      sheet.querySelector('[data-gpus]').innerHTML=Array.from({length:machine.cards},(_,i)=>`<button type="button" class="jr-gpu" data-gpu="${i}" aria-pressed="${gpus.has(i)}">${i}</button>`).join('');};
    drawGpus();
    form.addEventListener('change',event=>{if(event.target.name==='project'){gpus.clear();sheet.querySelector('[data-sheet-project]').textContent=current()?.project||'项目';}drawGpus();});
    form.addEventListener('click',event=>{
      const step=event.target.closest('[data-step]');if(step){cards=Math.max(1,Math.min(8,cards+Number(step.dataset.step)));const v=sheet.querySelector('[data-cards]');v.textContent=cards;if(!reducedMotion())v.animate([{transform:'scale(1)'},{transform:'scale(1.35)'},{transform:'scale(1)'}],{duration:350,easing:'cubic-bezier(.34,1.32,.5,1)'});}
      const gpu=event.target.closest('[data-gpu]');if(gpu){const i=Number(gpu.dataset.gpu);gpus.has(i)?gpus.delete(i):gpus.add(i);gpu.setAttribute('aria-pressed',gpus.has(i));}
      if(event.target.closest('[data-sheet-close]'))close();
    });
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;const error=sheet.querySelector('[data-submit-error]');error.hidden=true;
      const p=current();if(!p){error.textContent='请先在“项目”里新建一个项目。';error.hidden=false;return;}
      if(gpus.size&&gpus.size!==cards){error.textContent=`指定了 ${gpus.size} 张 GPU，卡数是 ${cards}，请保持一致。`;error.hidden=false;return;}
      const where=form.where.value==='auto'?{machine:'auto',machineSelection:{mode:'auto'}}:{machine:p.machine};
      let placement=null;
      try{placement=gpus.size&&where.machine!=='auto'?placementFromForm({get:key=>key==='gpu-placement'?'fixed':key==='gpu-indices'?[...gpus].sort((a,b)=>a-b).join(','):null},cards,null,null,form.priority.value):null;}
      catch(problem){error.textContent=problem.message;error.hidden=false;return;}
      const args={...where,project:p.project,ownerId:p.ownerId,cards,name:form.name.value.trim()||'train',priority:form.priority.value,argv:['/bin/bash','-c',form.command.value],key:submitKey,...(placement?{placement}:{})};
      busy=true;form.querySelector('[type=submit]').disabled=true;
      try{const job=await store.call('jobs.submit',args);remember({machine:p.machine,project:p.project,ownerId:p.ownerId});submitKey=crypto.randomUUID();close();await store.refresh().catch(()=>{});render();toast('已提交，正在排队',{launch:true});if(job?.id)setTimeout(()=>openJob(job.id),reducedMotion()?0:500);}
      catch(problem){error.textContent=problem.status&&problem.status<500?problem.message:'提交结果未知。请稍后在列表里查看；重新提交会沿用同一个编号，不会重复。';error.hidden=false;}
      finally{busy=false;form.querySelector('[type=submit]')?.removeAttribute('disabled');}
    });
    setTimeout(()=>form.command.focus(),200);
  }

  host.addEventListener('click',event=>{
    if(event.target.closest('[data-more]')){limit+=PAGE;renderRows();return;}
    const scopeButton=event.target.closest('[data-scope]');if(scopeButton){scope=scopeButton.dataset.scope;limit=PAGE;for(const b of host.querySelectorAll('[data-scope]'))b.setAttribute('aria-pressed',b===scopeButton);placePill();renderRows();return;}
    const row=event.target.closest('[data-job]');if(row){tab='log';openJob(row.dataset.job);return;}
    if(event.target.closest('[data-empty-new]'))openSheet();
  });
  $('.jr-search').addEventListener('input',event=>{search=event.target.value;limit=PAGE;renderRows();});
  // 本项目 follows the project open in the project room.
  document.addEventListener('gpuq-workspace-context',event=>{const {machine,project:name,ownerId}=event.detail||{};if(machine&&name)remember({machine,project:name,ownerId});});
  newButton.addEventListener('click',openSheet);
  scrim.addEventListener('click',close);drawer.querySelector('.jr-x').addEventListener('click',close);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]')&&(drawer.classList.contains('on')||sheet.classList.contains('on')))close();});
  drawer.addEventListener('click',async event=>{
    const job=store.jobs.find(item=>item.id===openId);if(!job)return;
    const tabButton=event.target.closest('[data-tab]');if(tabButton){tab=tabButton.dataset.tab;for(const b of drawer.querySelectorAll('[data-tab]'))b.setAttribute('aria-selected',b===tabButton);for(const pane of drawer.querySelectorAll('[data-pane]'))pane.hidden=pane.dataset.pane!==tab;placeTabs();loadTab(job);return;}
    const p=event.target.closest('[data-priority]');if(p&&p.getAttribute('aria-pressed')!=='true'){try{await store.call('jobs.priority',{jobId:job.id,priority:p.dataset.priority});for(const b of drawer.querySelectorAll('[data-priority]'))b.setAttribute('aria-pressed',b===p);placeSeg(p.closest('.jr-seg'));toast('优先级已改为 '+p.dataset.priority);await store.refresh().catch(()=>{});render();}catch(error){toast(error.message);}return;}
    if(event.target.closest('[data-cancel]')){confirmSheet({title:'取消这个任务？',body:'占用的卡会马上释放，输出保留。',action:'取消任务',run:async()=>{await store.call('jobs.cancel',{jobId:job.id});toast('已请求取消，占用的卡会释放');await store.refresh().catch(()=>{});render();openJob(job.id);}});return;}
    const out=event.target.closest('[data-out-path]');if(out&&out.hasAttribute('data-out-dir')){loadOutputs(job,out.dataset.outPath);return;}
    const copy=event.target.closest('[data-out-copy]');if(copy){try{await navigator.clipboard.writeText(resultPullCommand(job,copy.dataset.outCopy));toast('已复制下载命令，把 LOCAL_FILE 换成本地路径');}catch{toast(resultPullCommand(job,copy.dataset.outCopy));}return;}
    const remove=event.target.closest('[data-out-delete]');if(remove){if(!remove.dataset.confirm){remove.dataset.confirm='1';remove.textContent='确认删除';setTimeout(()=>{if(remove.isConnected){delete remove.dataset.confirm;remove.textContent='删除';}},4000);return;}
      try{await deleteJobOutputs(store,job,{path:remove.dataset.outDelete,recursive:remove.hasAttribute('data-out-dir-delete'),current:()=>openId===job.id});toast('已删除，7 天内可在项目回收站恢复');const parent=remove.dataset.outDelete.split('/').slice(0,-1).join('/')||'.';loadOutputs(job,parent);}catch(error){toast(error.message);}return;}
    const recover=event.target.closest('[data-recover]');if(recover){const box=drawer.querySelector('[data-recovery-result]'),buttons=drawer.querySelectorAll('[data-recover]');for(const b of buttons)b.disabled=true;box.innerHTML='<p class="jr-hint">查询中…</p>';
      try{const result=await store.call(recover.dataset.recover,{jobId:job.id});if(openId!==job.id)return;
        box.innerHTML=recover.dataset.recover==='jobs.watch'?nativeObservationHTML(result.nativeObservation):recover.dataset.recover==='jobs.completion'?completionHTML(result)+nativeObservationHTML(result.nativeObservation):(result?.resourcesReleased===true?'<p>任务资源已收尾</p>':'<p class="jr-error">资源尚未收尾，请稍后再试。</p>')+(result?.completion?completionHTML(result.completion):'');}
      catch(error){if(openId===job.id)box.innerHTML=`<p class="jr-error">${esc(recover.dataset.recover==='jobs.reconcile-resources'?'收尾结果未知：'+error.message+' 请先查询完成状态。':error.message)}</p>`;}
      finally{for(const b of buttons)b.disabled=false;}return;}
    if(event.target.closest('[data-notify]')){const enabled=job.notifications?.enabled!==true;try{await store.call('notifications.job',{jobId:job.id,enabled});toast(enabled?'Telegram 任务通知已开启':'Telegram 任务通知已关闭');await store.refresh().catch(()=>{});openJob(job.id);}catch(error){toast(error.message);}return;}
    const download=event.target.closest('[data-out-download]');if(download){try{toast('开始下载');await downloadBrowserPath((op,args)=>store.call(op,args),outputTarget(job),download.dataset.outDownload,{directory:download.hasAttribute('data-out-dir-download'),onRoute:toast});}catch(error){toast(error.message);}return;}
  });
  drawer.addEventListener('submit',async event=>{
    if(!event.target.matches('[data-note-form]'))return;event.preventDefault();const body=event.target.body.value.trim();if(!body)return;
    try{await store.call('community.notes.create',{body,jobId:openId,key:noteKey});noteKey=crypto.randomUUID();event.target.body.value='';loadNotes(openId);toast('留言已发布');}catch(error){toast(error.message);}
  });
  addEventListener('resize',()=>{placePill();placeTabs();});
  document.addEventListener('sg-open-job',event=>{const id=event.detail?.id;if(id){tab='log';openJob(id);}});

  function render(){
    const on=getPage()==='jobs'&&!!store.principal;newButton.hidden=!on;if(!on)return;
    renderRows();requestAnimationFrame(placePill);
    if(openId){const job=store.jobs.find(item=>item.id===openId);if(job){const chip=drawer.querySelector('.jr-chip');if(chip&&chip.textContent!==stateWord(job))openJob(openId);}}
  }
  return render;
}
