// Owner-bound log/diagnostic viewer. Log evidence never rewrites task state.
import {formatTimestamp} from './time-format.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const statusNames={STARTING:'正在启动采集',CAPTURING:'采集中',COMPLETE:'本轮快照已保存',PARTIAL:'部分可用',UNAVAILABLE:'没有可用采集'};
const shown=value=>value===null||value===undefined?'未知':String(value);
const timestamp=value=>formatTimestamp(value);
const bytes=value=>Number.isFinite(value)?(value/1024**3).toFixed(2)+' GiB':'未知';
const leaseTime=value=>formatTimestamp(typeof value==='number'?value:null,{format:{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hour12:false}});
export function allocationHistoryHTML(bundle){
  if(bundle.historyAvailable!==true||!Array.isArray(bundle.allocationHistory))return '<p class="muted diagnostic-lease-unavailable">旧任务未记录精确租约时间，或节点尚未提供这项记录。</p>';
  const rows=bundle.allocationHistory.slice(0,256);
  return '<p class="muted">调度器记录的租约分配与释放时间，按浏览器时区显示；与 CUDA 实际执行时间可能不同。</p>'+(rows.length?`<div class="diagnostic-history diagnostic-lease-history"><table><caption class="sr-only">GPU 租约分配与释放记录</caption><thead><tr><th>记录 / 运行</th><th>GPU index / UUID</th><th>分配时间</th><th>释放时间 / 原因</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${esc(row.id)} / ${esc(row.attempt_id)}${row.source==='migrated_active'?'<br>升级时补记的活动租约':''}</td><td>#${esc(row.gpu_index)}<br>${esc(row.gpu_uuid)}</td><td>${esc(leaseTime(row.acquired_at))}</td><td>${esc(row.released_at===null||row.released_at===undefined?'尚无释放记录':leaseTime(row.released_at))}<br>${esc(row.release_reason||'未记录原因')}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">尚无 GPU 租约历史记录；不代表 GPU 占用时长为零。</p>')+(bundle.historyTruncated?`<p class="muted diagnostic-lease-truncated">当前仅显示最近 ${rows.length} 条记录，更早历史未包含${Number.isSafeInteger(bundle.historyNextBeforeId)?`（继续查询游标：${esc(bundle.historyNextBeforeId)}）`:''}。可联系管理员查询完整历史。</p>`:'');
}
export function diagnosticsHTML(bundle){
  const capture=bundle.captures?.[0],resources=capture?.resources||{},events=resources.counters?.['memory.events']||{},pids=resources.counters?.['pids.events']||{},peaks=resources.peaks||{};
  const logs=Array.isArray(capture?.logs)?capture.logs.slice(0,32):[],attempts=Array.isArray(bundle.attempts)?bundle.attempts.slice(0,16):[];
  return `<p class="diagnostic-summary"><strong>诊断：${esc(statusNames[bundle.state]||bundle.state||'未知')}</strong> · 调度状态：${esc(bundle.schedulerState||'UNKNOWN')}<br>${bundle.workerErrorEvidence?'检测到可能的 worker 错误线索（也可能来自正常退出日志），请结合退出码与调度状态查看。':'未发现已知错误特征，不代表所有 worker 健康。'} 日志线索不会自动判定任务失败。</p>
    <dl class="diagnostic-metrics"><div><dt>退出码 / 原因</dt><dd>${esc(shown(capture?.runnerExit?.exitCode))} / ${esc(capture?.unitExit?.Result||attempts[0]?.failure_reason||'未记录')}</dd></div><div><dt>内存${peaks['memory.peak']!==undefined?'内核峰值':'观测高水位'}</dt><dd>${esc(bytes(peaks['memory.peak']??peaks['memory.current']))}</dd></div><div><dt>进程 / 线程${peaks['pids.peak']!==undefined?'内核峰值':'观测高水位'}</dt><dd>${esc(shown(peaks['pids.peak']??peaks['pids.current']))}</dd></div><div><dt>OOM / OOM kill / PID 拒绝</dt><dd>${esc(shown(events.oom))} / ${esc(shown(events.oom_kill))} / ${esc(shown(pids.max))}</dd></div></dl>
    <p class="muted">${esc(capture?.error||bundle.note||'缺失数据为未知，不是零。')} 采集时间：${esc(timestamp(capture?.updatedAt))}。仅受管理 Ray 目录；自定义 /tmp 路径不在采集范围。分享前请检查尽力脱敏后的内容。</p>
    <h3>历史 GPU 分配</h3>${allocationHistoryHTML(bundle)}<h3>运行过程历史</h3><p class="muted">以下为调度器各次运行记录；开始 / 结束时间不冒充精确设备分配 / 释放时刻。</p>
    <div class="diagnostic-history"><table><thead><tr><th>运行 / 状态</th><th>GPU index / UUID</th><th>开始 / 结束</th></tr></thead><tbody>${attempts.map(attempt=>`<tr><td>${esc(attempt.id)}<br>${esc(attempt.state||'未知')}</td><td>${esc((attempt.gpu_indices||[]).join(', ')||'未记录')}<br>${esc((attempt.gpu_uuids||[]).join('\n')||'未记录')}</td><td>${esc(timestamp(attempt.started_at))}<br>${esc(timestamp(attempt.finished_at))}</td></tr>`).join('')||'<tr><td colspan="3">尚无运行历史。</td></tr>'}</tbody></table></div>
    <h3>Worker / Ray 日志尾部</h3><p class="muted">最多 32 个白名单文件，每个最多 64 KiB；只呈现有限尾部，不保证覆盖所有错误。</p>${logs.map(item=>`<details class="diagnostic-log"><summary>${esc(item.source)}${item.truncated?' · 已截断':''}</summary><pre>${esc(item.text)}</pre></details>`).join('')||'<p class="muted">暂无受管理 worker 日志；旧任务或自定义临时目录可能没有留存。</p>'}`;
}

const terminalStates=new Set(['SUCCEEDED','FAILED','CANCELED']);
const confirmedObservation=value=>value?.protocol==='native-observation-v1'&&value.readOnly===true&&value.status==='CONFIRMED';
export const completionMatchesJob=(value,job)=>value?.protocol==='job-completion-v1'&&value.readOnly===true&&value.jobId===job.id&&value.userId===job.userId&&value.machine===job.machine&&value.nodeJobId===(job.nodeJobId||null)&&typeof value.completed==='boolean'&&['SUCCEEDED','UNCONFIRMED'].includes(value.state)&&(!value.completed||value.state==='SUCCEEDED'&&!!value.completedAttempt?.id);
const observedStates={PENDING:'排队中',STARTING:'启动中',RUNNING:'运行中',PREEMPTING:'让位中',SUCCEEDED:'成功',FAILED:'失败',CANCELED:'已取消',LOST:'失联'};
export function nativeObservationHTML(observation){
  if(!confirmedObservation(observation))return '<p data-native-observation>服务器上的状态待确认</p>';
  const attempt=observation.latestAttempt;
  return `<p data-native-observation><strong>${observation.retryDetected?'已观察到服务器重试':'服务器当前观察'} · ${esc(observedStates[observation.state]||'待确认')}</strong></p><dl class="job-overview-grid"><div><dt>观察时间</dt><dd>${esc(timestamp(observation.observedAt))}</dd></div><div><dt>最近一次运行</dt><dd>${attempt?.ordinal?'第 '+esc(attempt.ordinal)+' 次':'尚未开始'}${attempt?.id?` · <code>${esc(attempt.id)}</code>`:''}</dd></div></dl>`;
}
export function completionHTML(value){
  if(!value)return '';
  const completed=value.protocol==='job-completion-v1'&&value.completed===true&&value.state==='SUCCEEDED';
  return `<p data-job-completion><strong>${completed?'已核验完成':'完成待确认'}</strong>${completed?` · 第 ${esc(value.completedAttempt?.ordinal??'未知')} 次运行 · ${esc(timestamp(value.observedAt))}`:''}</p>`;
}

export function createJobDiagnostics(store,getDialog,toast,options={}){
  let generation=0,diagnosticsRequest=0,jobId=null,bundle=null,bundleIdentity=null,displayIdentity=null,view='logs',installed=false,readingLogs=false,loadedLogs=false,lastLog=null;
  const principal=()=>store.principal?`${store.principal.userId}:${store.principal.role}:${store.authGeneration}`:null;
  const element=selector=>getDialog()?.querySelector(selector);
  let recoveryRequest=0,recoveryController=null,observation=null,completion=null,resourcesReleased=false,recoveryBusy=false,recoveryError='';
  const recoveryJob=()=>options.drawer?(store.jobs||[]).find(job=>job.id===jobId&&terminalStates.has(job.state)&&job.source!=='native'&&(job.userId===store.principal?.userId||store.principal?.role==='admin')):null;
  function clearRecovery(){recoveryRequest++;recoveryController?.abort();recoveryController=null;observation=null;completion=null;resourcesReleased=false;recoveryBusy=false;recoveryError='';}
  function renderRecovery(){
    const root=element('#job-recovery'),job=recoveryJob();if(!root||!job)return;
    const releasable=job.nodeJobId&&confirmedObservation(observation)&&terminalStates.has(observation.state);
    root.innerHTML=`<div class="field-caption"><h3>服务器上的观察</h3><details class="job-recovery-help"><summary aria-label="观察与历史说明"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 11v6M12 7v1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></summary><p>只显示查询时的观察。不会改写历史、重新提交或改变额度。释放数据租约会核对同一任务和所有进程；运行中或未知时拒绝。</p></details></div>${nativeObservationHTML(observation)}${completionHTML(completion)}${resourcesReleased?'<p data-resources-released>数据租约已释放</p>':''}${recoveryError?`<p class="form-error" role="alert">${esc(recoveryError)}</p>`:''}<div class="job-recovery-actions"><button class="button quiet" type="button" data-job-observe ${recoveryBusy?'disabled':''}>刷新观察</button><button class="button quiet" type="button" data-job-completion-check ${recoveryBusy?'disabled':''}>核验完成</button><button class="button quiet" type="button" data-job-release-resources ${recoveryBusy||!releasable?'disabled':''}>释放数据租约</button></div>`;
  }
  async function readRecovery(operation){
    const job=recoveryJob(),identity=principal(),context=generation;if(!job||recoveryBusy)return;
    if(operation==='jobs.reconcile-resources'){
      if(!job.nodeJobId||!confirmedObservation(observation)||!terminalStates.has(observation.state))return;
      if(!confirm('确认释放此任务的数据租约？服务器会先核对最近一次运行和所有进程均已结束；不会取消、重跑训练或改变历史记录。'))return;
      if(principal()!==identity||generation!==context||recoveryJob()!==job)return;
    }
    const request=++recoveryRequest,controller=new AbortController();recoveryController=controller;recoveryBusy=true;recoveryError='';
    if(operation==='jobs.watch'){observation=null;completion=null;resourcesReleased=false;}
    if(operation==='jobs.completion'){completion=null;options.onCompletion?.(null,job);}
    if(operation==='jobs.reconcile-resources')resourcesReleased=false;
    renderRecovery();
    const current=()=>request===recoveryRequest&&generation===context&&principal()===identity&&jobId===job.id&&getDialog()?.open&&!!recoveryJob();
    try{
      const result=await store.call(operation,{jobId:job.id},{signal:controller.signal});if(!current())return;
      if(operation==='jobs.watch'){
        if(result?.id!==job.id||result.userId!==job.userId||result.machine!==job.machine||result.state!==job.state)throw Error('服务器观察身份待确认，请重新查询。');
        observation=result.nativeObservation||null;
      }else if(operation==='jobs.completion'){
        if(!completionMatchesJob(result,job))throw Error('完成核验回执待确认，请重新查询。');
        completion=result;observation=result.nativeObservation||null;options.onCompletion?.(completion,job);
      }else{
        if(result?.protocol!=='job-resource-reconciliation-v1'||result.jobId!==job.id||result.resourcesReleased!==true)throw Error('数据租约释放待确认；请先核验完成，不要重新提交。');
        resourcesReleased=true;
        if(completionMatchesJob(result.completion,job)){completion=result.completion;observation=completion.nativeObservation||null;options.onCompletion?.(completion,job);}
      }
    }catch(error){if(current()&&error.name!=='AbortError')recoveryError=operation==='jobs.reconcile-resources'?'释放结果待确认：'+error.message+' 请先核验完成。':error.message;}
    finally{if(current()){recoveryBusy=false;recoveryController=null;renderRecovery();}}
  }
  function markViewed(){
    if(getDialog()?.open&&displayIdentity===principal()&&['overview','logs','diagnostics'].includes(view))document.dispatchEvent(new CustomEvent('gpuq-attention-viewed',{detail:{userId:store.principal?.userId,kind:'job',id:jobId}}));
  }
  function reset(){lastLog=null;clearRecovery();generation++;diagnosticsRequest++;if(options.drawer)document.dispatchEvent(new Event('gpuq-job-drawer-close'));jobId=null;bundle=null;bundleIdentity=null;displayIdentity=null;view='logs';const dialog=getDialog();if(dialog){dialog.close();element('#job-main-log').textContent='';element('#job-diagnostic-view').innerHTML='';element('#job-view-status').textContent='';element('#job-diagnostic-download').disabled=true;if(options.drawer){for(const key of ['overview','output','notes'])element('#job-'+key+'-view').replaceChildren();element('#job-log-title').textContent='训练详情';}}}
  function switchView(next){
    view=next;options.onView?.(next);element('#job-main-log').hidden=next!=='logs';element('#job-diagnostic-view').hidden=next!=='diagnostics';element('#job-log-view').setAttribute('aria-pressed',String(next==='logs'));element('#job-diagnostic-open').setAttribute('aria-pressed',String(next==='diagnostics'));
    if(options.drawer){for(const key of ['overview','output','notes'])element('#job-'+key+'-view').hidden=next!==key;for(const button of getDialog().querySelectorAll('[data-job-tab]')){const selected=button.dataset.jobTab===next;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}if(next==='output')options.output?.(jobId,element('#job-output-view'));if(next==='notes')options.notes?.(jobId,element('#job-notes-view'));}
    markViewed();
  }
  async function loadDiagnostics(){
    const requested=jobId,identity=principal(),context=generation,request=++diagnosticsRequest;if(!requested||!identity)return;
    element('#job-view-status').textContent='正在读取持久诊断包…';element('#job-diagnostic-download').disabled=true;
    element('#job-diagnostic-view').textContent='正在读取诊断与历史分配…';switchView('diagnostics');bundle=null;bundleIdentity=null;
    try{
      const result=await store.call('jobs.diagnostics',{jobId:requested});
      if(generation!==context||diagnosticsRequest!==request||principal()!==identity||jobId!==requested)return;
      if(result?.jobId!==requested)throw Error('诊断包任务身份不匹配，未显示。');
      bundle=result;bundleIdentity=identity;element('#job-diagnostic-view').innerHTML=diagnosticsHTML(result);element('#job-diagnostic-download').disabled=false;element('#job-view-status').textContent='诊断已读取；不会因此更改任务状态。';
    }catch(error){if(generation===context&&diagnosticsRequest===request&&principal()===identity){bundle=null;element('#job-diagnostic-view').textContent='诊断暂不可用：'+error.message;element('#job-view-status').textContent='主日志仍可查看；未把采集失败当作训练结果。';toast(error.message);}}
  }
  async function loadMainLog(){
    if(readingLogs||loadedLogs||!jobId)return;readingLogs=true;const id=jobId,identity=principal(),request=generation;
    try{const result=await store.call('jobs.logs',{jobId:id});if(generation===request&&principal()===identity&&jobId===id){loadedLogs=true;lastLog={id,identity,text:result.text};element('#job-main-log').textContent=result.text;if(['logs','overview'].includes(view))element('#job-view-status').textContent='';const preview=element('#job-log-preview');if(preview)preview.textContent=String(result.text||'暂无主日志。').split('\n').slice(0,18).join('\n');}}
    catch(error){if(generation===request&&principal()===identity&&jobId===id){element('#job-view-status').textContent='日志读取失败：'+error.message;
      if(lastLog?.id===id&&lastLog.identity===identity)element('#job-main-log').textContent=lastLog.text;
      else element('#job-main-log').textContent='主日志暂不可用：'+error.message;
      const preview=element('#job-log-preview');if(preview)preview.textContent=element('#job-main-log').textContent;toast(error.message);}}
    finally{if(generation===request)readingLogs=false;}
  }
  function install(){
    if(installed)return;installed=true;const dialog=getDialog(),pre=element('pre');pre.id='job-main-log';
    if(!document.querySelector('#job-diagnostic-styles')){const style=document.createElement('link');style.id='job-diagnostic-styles';style.rel='stylesheet';style.href=new URL('./job-diagnostics.css',import.meta.url).href;document.head.append(style);}
    const tools=document.createElement('div');tools.className='diagnostic-tools';tools.innerHTML='<button class="button" id="job-log-view" aria-pressed="true">主日志</button><button class="button" id="job-diagnostic-open" aria-pressed="false">诊断包 / 历史分配</button><button class="button" id="job-diagnostic-download" disabled>下载诊断 JSON</button><p id="job-view-status" role="status" aria-live="polite"></p>';
    pre.before(tools);const body=document.createElement('section');body.id='job-diagnostic-view';body.hidden=true;pre.after(body);
    if(options.drawer){
      dialog.classList.add('work-sheet','job-sheet');dialog.querySelector('.modal-head').classList.add('sheet-header','glass');tools.classList.add('job-tabs','glass');tools.setAttribute('role','tablist');tools.setAttribute('aria-label','任务详情分区');
      const overview=document.createElement('button');overview.type='button';overview.className='button quiet';overview.id='job-overview-tab';overview.textContent='概况';tools.prepend(overview);
      for(const [id,key,panel] of [['job-overview-tab','overview','job-overview-view'],['job-log-view','logs','job-main-log'],['job-diagnostic-open','diagnostics','job-diagnostic-view']]){const button=element('#'+id);button.dataset.jobTab=key;button.setAttribute('role','tab');button.setAttribute('aria-controls',panel);}
      for(const [key,label] of [['output','输出'],['notes','留言']]){const button=document.createElement('button');button.type='button';button.className='button quiet';button.textContent=label;button.dataset.jobTab=key;button.setAttribute('role','tab');button.setAttribute('aria-controls','job-'+key+'-view');tools.insertBefore(button,element('#job-diagnostic-download'));button.addEventListener('click',()=>switchView(key));}
      overview.addEventListener('click',()=>{switchView('overview');loadMainLog();});
      const content=document.createElement('div');content.className='sheet-scroll';for(const key of ['overview','output','notes']){const panel=document.createElement('section');panel.id='job-'+key+'-view';panel.hidden=true;panel.setAttribute('role','tabpanel');content.append(panel);}content.append(pre,body);dialog.append(content);
      const footer=document.createElement('div');footer.className='sheet-footer glass';footer.append(element('#job-view-status'),element('#job-diagnostic-download'));dialog.append(footer);
      tools.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...tools.querySelectorAll('[data-job-tab]')],index=buttons.indexOf(document.activeElement);const target=buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length];target.focus();target.click();});
      dialog.addEventListener('click',event=>{const action=event.target.closest('[data-job-observe],[data-job-completion-check],[data-job-release-resources]');if(action&&!action.disabled){readRecovery(action.hasAttribute('data-job-observe')?'jobs.watch':action.hasAttribute('data-job-completion-check')?'jobs.completion':'jobs.reconcile-resources');return;}const id=event.target.closest('[data-copy-job]')?.dataset.copyJob;if(id)navigator.clipboard.writeText(id).then(()=>toast('完整任务 ID 已复制。'),()=>toast('复制失败；请手动复制完整 ID。'));});
      if(options.dismiss)dialog.addEventListener('cancel',event=>{event.preventDefault();options.dismiss(dialog);});
    }
    element('#job-log-view').addEventListener('click',()=>{switchView('logs');loadMainLog();});
    element('#job-diagnostic-open').addEventListener('click',loadDiagnostics);
    element('#job-diagnostic-download').addEventListener('click',()=>{
      if(!bundle||bundle.jobId!==jobId||principal()!==bundleIdentity)return;
      const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='gpuq-diagnostics-'+jobId+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    dialog.addEventListener('close',()=>{if(dialog.open)return;clearRecovery();generation++;diagnosticsRequest++;bundle=null;bundleIdentity=null;displayIdentity=null;jobId=null;pre.textContent='';body.innerHTML='';element('#job-diagnostic-download').disabled=true;if(options.drawer){document.dispatchEvent(new Event('gpuq-job-drawer-close'));for(const key of ['overview','output','notes'])element('#job-'+key+'-view').replaceChildren();const url=new URL(location.href);url.searchParams.delete('job');history.replaceState(null,'',url);}});
  }
  async function openLogs(id,next='logs',origin=null){
    install();clearRecovery();readingLogs=false;loadedLogs=false;const identity=principal(),request=++generation;diagnosticsRequest++;displayIdentity=identity;jobId=id;bundle=null;bundleIdentity=null;element('#job-diagnostic-download').disabled=true;element('#job-diagnostic-view').innerHTML='';
    const job=options.drawer?(store.jobs||[]).find(item=>item.id===id):null;
    if(options.drawer){if(!job)throw Error('任务暂未出现在当前账号的状态中，请刷新核对。');element('#job-log-title').innerHTML=options.header?.(job)||esc(job.name||'训练详情');element('#job-overview-view').innerHTML=options.overview?.(job)||'';if(recoveryJob()){const recovery=document.createElement('section');recovery.id='job-recovery';recovery.className='job-recovery';element('#job-overview-view').prepend(recovery);observation=job.nativeObservation||null;renderRecovery();}const url=new URL(location.href);url.searchParams.set('job',id);history.replaceState(null,'',url);}
    switchView(options.drawer?next:'logs');element('#job-main-log').textContent=lastLog?.id===id&&lastLog.identity===identity?lastLog.text:'正在读取主日志…';element('#job-view-status').textContent='正在读取日志…';
    const dialog=getDialog();if(!dialog.open)dialog.showModal();
    markViewed();
    if(recoveryJob())readRecovery('jobs.watch');
    if(options.drawer){if(options.reveal)options.reveal(dialog,job,origin);else {const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;dialog.animate(reduce?[{opacity:0},{opacity:1}]:[{transform:'translateX(100%)'},{transform:'none'}],{duration:reduce?150:320,easing:'cubic-bezier(.4,0,.2,1)'});}if(next==='diagnostics')loadDiagnostics();}
    if(!options.drawer||['logs','overview'].includes(next))await loadMainLog();
  }
  return {install,openLogs,reset,sync(){if(displayIdentity!==null&&displayIdentity!==principal())reset();}};
}
