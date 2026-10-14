import {maintenanceFor} from './maintenance-state.js';
import {copyHelp} from './copy-help-ui.js';
import {serverIdHTML,escapeUI} from './workbench-ui.js';

export function terminalRequestContext(value){
  const {machine,project,ownerId}=value;
  return {machine,...(ownerId?{ownerId}:{}),...(project?{project}:{})};
}

export function terminalExitMessage(result){
  return Number.isInteger(result.exitCode)?`终端已结束（退出码 ${result.exitCode}）`:'终端已结束（退出码未提供）';
}
export function terminalStoppedMessage(result,id){
  return result?.id===id&&result.state==='STOPPED'
    ?'此终端已结束。原会话不能恢复；需要继续工作时，请明确新建独立终端。':null;
}
export function terminalContext({machine,project,ownerId}){
  if(typeof machine!=='string'||!machine||machine==='auto')throw Error('先选择一台服务器，再打开终端。');
  if(project!==undefined&&project!==''&&(typeof project!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(project)))throw Error('项目名称无效。');
  return {machine,...(ownerId?{ownerId}:{}),...(project?{project}:{})};
}

export function terminalLaunchContext(value){return terminalContext(value);}

// Persist only development identities, never attachment credentials or output.
export function projectTerminalStorage(storage){
  const prefix='gpuq.project-terminals.v2:',uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const valid=value=>typeof value?.userId==='string'&&!!value.userId&&typeof value.machine==='string'&&!!value.machine&&value.machine!=='auto'&&(value.project==null||value.project===''||/^[a-z][a-z0-9_-]{0,47}$/.test(value.project));
  const key=value=>prefix+encodeURIComponent(JSON.stringify([value.userId,value.machine,value.ownerId||value.userId,value.project||'']));
  function ids(name){try{const value=JSON.parse(storage?.getItem(name)||'null');return value?.protocol===1&&Array.isArray(value.ids)?[...new Set(value.ids.filter(id=>typeof id==='string'&&uuid.test(id)))]:[];}catch{return [];}}
  return {
    list(userId){
      const records=[];if(typeof userId!=='string'||!userId)return records;
      try{for(let index=0;index<storage?.length;index++){
        const name=storage.key(index);if(!name?.startsWith(prefix))continue;
        let scope;try{scope=JSON.parse(decodeURIComponent(name.slice(prefix.length)));}catch{continue;}
        if(!Array.isArray(scope)||scope.length!==4||scope[0]!==userId)continue;
        const value={userId:scope[0],machine:scope[1],ownerId:scope[2],project:scope[3]};
        if(valid(value))for(const id of ids(name))records.push({...value,id});
      }}catch{ /* Storage can be disabled; the in-memory directory still works. */ }
      return records;
    },
    remember(value){
      if(!valid(value)||!uuid.test(value.id))return;
      try{const name=key(value),saved=ids(name);if(!saved.includes(value.id))storage?.setItem(name,JSON.stringify({protocol:1,ids:[...saved,value.id]}));}catch{return false;}
      return !!storage;
    },
    forget(value){
      if(!valid(value))return;
      try{const name=key(value),saved=ids(name).filter(id=>id!==value.id);if(saved.length)storage?.setItem(name,JSON.stringify({protocol:1,ids:saved}));else storage?.removeItem(name);}catch{ /* A confirmed close is not undone by local storage failure. */ }
    }
  };
}

export function terminalUI(store,toast){
  // xterm needs a response-specific CSP nonce for its dynamic sizing styles.
  const nonce=document.querySelector('meta[name="gpuq-style-nonce"]')?.content;
  const terminalDocument=new Proxy(document,{get(target,key){
    if(key==='createElement')return(...args)=>{const element=target.createElement(...args);if(nonce&&element.tagName==='STYLE')element.nonce=nonce;return element;};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  function withNonceStyles(render){
    // xterm's viewport consults window.document even with documentOverride.
    // Apply the response nonce before insertion during its synchronous setup,
    // then restore the native factory; the site's CSP remains unchanged.
    const create=document.createElement;
    document.createElement=function(...args){const element=Reflect.apply(create,this,args);if(nonce&&element.tagName==='STYLE')element.nonce=nonce;return element;};
    try{return render();}finally{document.createElement=create;}
  }
  let dialog,term,fit,session,timer,inputScheduled=false,idleDelay=80,busy=false,input=new Uint8Array(),offset=0,closing=false,lastSize='',generation=0,currentActor=null,currentWorkspace='',workspaceGeneration=0,openingGeneration=0,backoff=0;
  // This directory only contains session identities and public UI state.
  // The sole attached connection owns its token; detach erases it even if its
  // response is lost. Temporary stale/close connections release theirs too.
  const sessions=new Map();
  let savedStorage;try{savedStorage=globalThis.localStorage;}catch{ /* Private storage may be disabled. */ }
  const savedSessions=projectTerminalStorage(savedStorage);
  let restoredActor='',recoveryController=null,storageWarning=false;
  const paused=target=>!!target&&!!maintenanceFor(store.data?.operationalMaintenance,target.machine);
  const identity=value=>JSON.stringify([value.userId,value.machine,value.ownerId,value.project||'']);
  const args=value=>({...terminalRequestContext(value),id:value.id,clientId:value.clientId,writerToken:value.writerToken});
  function remember(value){
    const {writerToken,writeUntil,authGeneration,...record}=value;sessions.set(value.id,{...record});
    if(savedSessions.remember(record)===false&&!storageWarning){storageWarning=true;toast('无法保存会话 ID，请复制后再刷新。');}
  }
  function forget(record){savedSessions.forget(record);sessions.delete(record.id);}
  function restoreDirectory(){
    const userId=store.principal?.userId,stamp=JSON.stringify([userId,store.authGeneration]);
    if(!userId||store.authPending||restoredActor===stamp)return;restoredActor=stamp;
    for(const record of savedSessions.list(userId))if(!sessions.has(record.id))sessions.set(record.id,{...record,detached:true,connectionState:'unknown',recovered:true});
  }
  function announce(){restoreDirectory();document.dispatchEvent(new CustomEvent('gpuq-terminal-state',{detail:{sessions:[...sessions.values()].filter(value=>value.userId===store.principal?.userId).map(value=>({...value}))}}));}
  function cancelRecovery(){recoveryController?.abort();recoveryController=null;}
  async function verifyRecovered(machine,project,ownerId){
    const userId=store.principal?.userId,auth=store.authGeneration,workspace=workspaceGeneration;
    if(!userId||store.authPending||!project||!store.data?.machines?.some(node=>node.id===machine))return;
    const records=[...sessions.values()].filter(record=>record.recovered&&record.userId===userId&&record.machine===machine&&record.project===project&&(record.ownerId||userId)===(ownerId||userId));
    if(!records.length)return;
    const controller=new AbortController();recoveryController=controller;
    const current=()=>!controller.signal.aborted&&userId===store.principal?.userId&&auth===store.authGeneration&&workspace===workspaceGeneration;
    try{for(const record of records){
      let result;try{result=await store.call('terminal.status',{...terminalRequestContext(record),id:record.id},{signal:controller.signal});}catch{if(!current())return;}
      if(!current())return;if(sessions.get(record.id)!==record)continue;
      const confirmed=result?.id===record.id;
      remember({...record,connectionState:confirmed&&result.state==='STOPPED'?'ended':confirmed&&result.state==='ALIVE'?'detached':'unknown'});announce();
    }}finally{if(recoveryController===controller)recoveryController=null;}
  }
  function connectionNote(text='',{query=false,reconnect=false,ended=false}={}){
    const note=document.querySelector('#terminal-connection-note');
    if(note){note.textContent=text;note.hidden=!text;note.className='st '+(ended?'st-cancel':'st-unknown');}
    for(const [id,show]of [['terminal-query',query],['terminal-retry',reconnect],['terminal-new',ended]]){const button=document.querySelector('#'+id);if(button)button.hidden=!show;}
  }
  function syncMaintenance(){
    const locked=paused(session),canWrite=!!session&&session.connectionState==='connected'&&!locked&&!closing;
    const interrupt=document.querySelector('#terminal-interrupt'),note=document.querySelector('#terminal-maintenance-note');
    if(interrupt)interrupt.disabled=!canWrite;
    if(note){note.hidden=!locked;note.textContent=locked?'维护中：输入暂停，仍可查看输出或结束终端。':'';}
    if(term?.options)term.options.disableStdin=!canWrite;
    if(locked)input=new Uint8Array();
  }
  function stopInput(target,text,{expired=false}={}){
    clearTimeout(timer);inputScheduled=false;input=new Uint8Array();backoff=0;
    target.connectionState='unknown';if(expired)delete target.writerToken;
    remember(target);announce();connectionNote(text,{query:!!target.writerToken,reconnect:true});syncMaintenance();
  }
  function attachmentCurrent(target){return target.userId===store.principal?.userId&&target.authGeneration===store.authGeneration;}
  function usable(target){
    if(!target.writerToken||Date.now()>=target.writeUntil){stopInput(target,'连接已过期，请重连。',{expired:true});return false;}
    return attachmentCurrent(target);
  }
  async function release(target,call=(operation,fields)=>store.call(operation,fields)){
    const request=target.writerToken?args(target):null;
    delete target.writerToken;target.detached=true;target.connectionState='detached';remember(target);announce();
    if(request)await call('terminal.detach',request);
  }
  async function detach(releaseWriter=true,invalidateOpening=true){
    if(invalidateOpening)openingGeneration++;
    const previous=session;clearTimeout(timer);inputScheduled=false;generation++;session=null;input=new Uint8Array();backoff=0;dialog?.close();
    if(previous&&releaseWriter)try{await release(previous);}catch{toast('断开未确认；终端仍保留，请稍后重连。');}
    else if(previous)delete previous.writerToken;
  }
  store.onAuthChange?.(async call=>{
    cancelRecovery();restoredActor='';
    const previous=session,request=previous?.writerToken?args(previous):null;currentActor=null;detach(false);announce();
    term?.dispose();term=null;document.querySelector('#terminal-screen')?.replaceChildren();
    for(const id of ['terminal-title','terminal-session-note','terminal-maintenance-note','terminal-connection-note']){const node=document.querySelector('#'+id);if(node)node.textContent='';}
    // Copy the old connection request before detach clears its token, using the
    // old identity transport. It can only release, never close, a terminal.
    if(request)try{await call('terminal.detach',request);}catch{toast('旧终端断开未确认；原账号可重连检查。');}
  });
  function enqueue(text){
    if(!session||session.connectionState!=='connected'||closing||paused(session)||!usable(session))return false;
    const data=new TextEncoder().encode(text);if(input.length+data.length>1048576){toast('待发送内容过多，请稍后再粘贴。');return false;}
    const next=new Uint8Array(input.length+data.length);next.set(input);next.set(data,input.length);input=next;return true;
  }
  function schedule(delay){clearTimeout(timer);inputScheduled=false;timer=setTimeout(()=>{timer=null;inputScheduled=false;exchange();},delay);}
  function sendSoon(){if(session?.connectionState==='connected'&&!busy&&!inputScheduled){schedule(20);inputScheduled=true;}}
  function openRequest(target,mode,id){return {...terminalRequestContext(target),key:crypto.randomUUID(),clientId:crypto.randomUUID(),mode,...(mode==='reconnect'?{id}:{})};}
  function connection(result,target,request,startedAt){
    if(typeof result?.id!=='string'||!result.id||typeof result.writerToken!=='string'||!result.writerToken)throw Error('终端连接未确认，未发送输入。');
    return {...target,id:result.id,clientId:request.clientId,writerToken:result.writerToken,authGeneration:store.authGeneration,writeUntil:startedAt+30000,detached:false,connectionState:'connecting'};
  }
  function takeoverError(error){return /another active writer|active writer/.test(error.message);}
  async function requestAttachment(target,request,lifecycle,current){
    try{return await store.call('terminal.open',request,lifecycle);}catch(error){
      if(!current())throw Error('终端请求已过期，没有切换当前终端。');
      if(request.mode==='reconnect'&&/not reachable|has ended/.test(error.message)){
        const observed=await store.call('terminal.status',{...terminalRequestContext(target),id:request.id});
        if(!current())throw Error('终端请求已过期，没有切换当前终端。');
        const text=terminalStoppedMessage(observed,request.id);
        if(text)throw Object.assign(Error(text),{code:'TERMINAL_STOPPED',id:request.id});
      }
      if(request.mode!=='reconnect'||!takeoverError(error)||!window.confirm('接管会让另一处失去输入权，已发出的命令不能撤回。确认接管？'))throw error;
      if(!current())throw Error('登录或项目已改变，请重新选择终端。');
      return store.call('terminal.open',{...request,key:crypto.randomUUID(),takeover:true},lifecycle);
    }
  }
  async function closeSession(record,{signal}={}){
    signal?.throwIfAborted();const owner=store.principal?.userId,auth=store.authGeneration,attached=session?.id===record.id;
    if(attached){closing=true;clearTimeout(timer);inputScheduled=false;syncMaintenance();}
    try{
      const result=await store.call('terminal.close',{...terminalRequestContext(record),id:record.id},{signal});
      if(owner!==store.principal?.userId||auth!==store.authGeneration)return;
      if(result?.closed!==true&&result?.state!=='STOPPED'){if(attached)stopInput(session,'终端状态未知，请按原编号查询：'+record.id);throw Error('终端状态未知，请按原编号查询：'+record.id);}
      forget(record);if(attached)await detach(false);announce();
    }finally{closing=false;syncMaintenance();}
  }
  async function exchange(queryOnly=false){
    if(!session||busy||closing||session.connectionState==='ended')return;
    if(session.connectionState!=='connected'&&!backoff&&!queryOnly)return;
    clearTimeout(timer);inputScheduled=false;
    const target=session,turn=generation;if(!usable(target))return;
    busy=true;const startedAt=Date.now();let bytes=new Uint8Array(),delay=null;
    try{
      syncMaintenance();if(target.connectionState==='connected'&&!queryOnly){bytes=input.slice(0,8192);input=input.slice(bytes.length);}
      const size={cols:term.cols,rows:term.rows},sizeKey=JSON.stringify(size);
      const result=await store.call('terminal.exchange',{...args(target),offset,input:btoa(String.fromCharCode(...bytes)),...(sizeKey===lastSize?{}:size)});
      if(turn!==generation||session!==target||!attachmentCurrent(target))return;
      if(!Number.isSafeInteger(result?.offset)||result.offset<0||typeof result.exited!=='boolean')throw Error('终端暂未返回结果，请重连查看。');
      lastSize=sizeKey;if(result.data){
        const output=Uint8Array.from(atob(result.data),char=>char.charCodeAt(0));term.write(output);
      }offset=result.offset;
      // The node may renew only near expiry. A confirmed exchange guarantees
      // at least 15 seconds from its start, never a guessed 30-second extension.
      target.writeUntil=startedAt+15000;
      if(result.exited){
        input=new Uint8Array();backoff=0;target.connectionState='ended';remember(target);announce();
        const text=terminalExitMessage(result);term.writeln('\r\n['+text+']');connectionNote(text,{ended:true});syncMaintenance();return;
      }
      if(backoff){backoff=0;target.connectionState='connected';remember(target);announce();connectionNote('连接已恢复，之前的输入未重发。');syncMaintenance();}
      if(queryOnly){connectionNote('输出已查询；继续输入前请重连。',{query:true,reconnect:true});return;}
      idleDelay=bytes.length||result.data?80:Math.min(750,Math.ceil(idleDelay*1.5));delay=input.length?0:idleDelay;
    }catch(error){
      if(turn!==generation||session!==target)return;
      input=new Uint8Array();
      if(error.status===429){
        backoff=Math.min(8000,backoff?backoff*2:1000);target.connectionState='unknown';remember(target);announce();
        connectionNote((bytes.length?'本次输入未发送，未自动重发。':'')+'请求繁忙，稍后重新查询。',{reconnect:true});syncMaintenance();delay=backoff;
      }else{
        const expired=/writer lease expired|attachment expired|taken over/.test(error.message);
        const text=bytes.length?'输入未确认，未自动重发。':'连接未确认，请重连。';
        stopInput(target,expired?'连接已过期或已被接管，请重连。'+(bytes.length?'输入未确认，未自动重发。':''):text,{expired});
        const reason=expired?'连接已过期或已被接管':error.message;
        term?.writeln('\r\n['+reason+'；'+text+']');
      }
    }finally{busy=false;if(turn!==generation&&session&&!closing)schedule(0);}
    if(turn===generation&&session&&!closing&&delay!==null)schedule(delay);
  }
  function ensureDialog(){
    if(dialog)return;dialog=document.createElement('dialog');dialog.className='terminal-dialog';dialog.setAttribute('aria-labelledby','terminal-title');
    dialog.innerHTML='<div class="modal-head"><h2 id="terminal-title"></h2><div><button class="button quiet" id="terminal-collapse">收起</button><button class="button" id="terminal-interrupt">Ctrl+C</button> <button class="button" id="terminal-disconnect">断开</button> <button class="button danger" id="terminal-stop">结束终端</button></div></div><p id="terminal-maintenance-note" class="terminal-maintenance-note" role="status" hidden></p><div id="terminal-screen"></div><div class="terminal-recovery"><span id="terminal-connection-note" role="status" hidden></span><button class="button quiet" id="terminal-query" hidden>重新查询</button><button class="button" id="terminal-retry" hidden>重连</button><button class="button" id="terminal-new" hidden>新建终端</button></div><div class="terminal-footer"><p id="terminal-session-note" class="muted"></p>'+copyHelp('断开和结束','断开保留终端和已有命令；结束终端会停止其中的命令。输入未确认时不会自动重发，请重连后检查输出。','/guide/development')+'</div>';
    document.body.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();detach();});
    if(typeof ResizeObserver==='function')new ResizeObserver(()=>{if(dialog.open&&term)fit?.fit();}).observe(document.querySelector('#terminal-screen'));
  }
  document.addEventListener('gpuq-workspace-context',event=>{
    const {userId,machine,project,ownerId}=event.detail,next=JSON.stringify([userId,machine,ownerId,project||'']);
    if(currentActor!==userId||currentWorkspace!==next){cancelRecovery();currentActor=userId;currentWorkspace=next;workspaceGeneration++;detach();announce();verifyRecovered(machine,project,ownerId);}
  });
  document.addEventListener('gpuq-route-leaving',cancelRecovery);
  window.addEventListener('pagehide',cancelRecovery);
  function revealMotion(){const reduce=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion:reduce)').matches:true;dialog.animate?.(reduce?[{opacity:0},{opacity:1}]:[{clipPath:'inset(100% 0 0 0)'},{clipPath:'inset(0)'}],{duration:reduce?150:320,easing:'cubic-bezier(.2,0,0,1)'});}
  async function openTerminal(button,knownTarget=null){
    button.disabled=true;let pendingOpen=null;
    try{
      const projectControl=document.querySelector('[name=workspace-project]');
      const selectedProject=projectControl?.selectedOptions?.[0]?.dataset?.project||projectControl?.value;
      const target=terminalLaunchContext({machine:knownTarget?.machine??document.querySelector('[name=terminal-machine]')?.value,project:knownTarget?.project??selectedProject,ownerId:knownTarget?.ownerId??projectControl?.selectedOptions?.[0]?.dataset?.ownerId});
      if(paused(target))throw Error('维护中：不能新开或重连开发终端；已连接终端仍可断开或结束。');
      const userId=store.principal?.userId,auth=store.authGeneration,workspace=workspaceGeneration;if(!userId)throw Error('请先登录。');
      const reconnect=button.id.endsWith('-reconnect'),matching=[...sessions.values()].filter(value=>identity(value)===identity({...target,userId}));
      const id=reconnect?(knownTarget?.id||window.prompt('输入要重连的会话 ID。其他客户端仍在操作时不会自动接管。',matching.at(-1)?.id||'')?.trim()):null;
      if(reconnect&&!id)return;
      const known=id?sessions.get(id):null;
      const request=openRequest(target,reconnect?'reconnect':'new',id),opening=++openingGeneration;
      const current=()=>opening===openingGeneration&&workspace===workspaceGeneration&&auth===store.authGeneration&&currentActor===userId;
      await detach(true,false);if(!current())return;
      let retained;const startedAt=Date.now();
      const lifecycle={
        accept:result=>{retained=connection(result,{...target,userId},request,startedAt);remember(retained);announce();},
        onStale:async(result,call)=>{if(result?.writerToken)await release(connection(result,{...target,userId},request,startedAt),call);}
      };
      pendingOpen={...target,userId,id:reconnect?id:request.key,clientId:request.clientId,connectionState:'unknown',detached:true,authGeneration:auth};
      await requestAttachment(target,request,lifecycle,current);
      pendingOpen=null;
      if(!current()){try{await release(retained);}catch{toast('旧终端写入权释放未确认，请原账号重连检查。');}toast('终端选择已改变；旧终端保留在原入口，没有自动连接。');return;}
      session=retained;session.connectionState='connected';remember(session);announce();generation++;offset=0;input=new Uint8Array();closing=false;lastSize='';idleDelay=80;backoff=0;
      ensureDialog();
      const label='容器终端 · 无 GPU';
      const title=document.querySelector('#terminal-title');title.textContent=target.machine+' · '+(target.project?target.project+' · ':'')+label+' · '+retained.id;
      const machineLabel=target.machine.length<=8?'<span class="server-id terminal-server-id" title="'+escapeUI(target.machine)+'">'+escapeUI(target.machine)+'</span>':serverIdHTML(target.machine,'terminal-server-id');
      title.innerHTML=machineLabel+'<span> · '+escapeUI((target.project?target.project+' · ':'')+label)+'</span><code class="terminal-session-id" title="'+escapeUI(retained.id)+'">'+escapeUI(retained.id)+'</code>';
      document.querySelector('#terminal-session-note').textContent='容器终端 · 无 GPU';
      connectionNote();dialog.showModal();revealMotion();term?.dispose();document.querySelector('#terminal-screen').replaceChildren();
      term=new globalThis.Terminal({documentOverride:terminalDocument,cursorBlink:false,fontFamily:'Geist Mono, monospace',fontSize:14,scrollback:3000,theme:{background:'#060607',foreground:'#D8D9D4'},allowProposedApi:false});
      fit=new globalThis.FitAddon.FitAddon();term.loadAddon(fit);withNonceStyles(()=>{term.open(document.querySelector('#terminal-screen'));fit.fit();});
      term.onData(data=>{if(enqueue(data))sendSoon();});syncMaintenance();term.focus();exchange();
    }catch(error){
      if(pendingOpen&&pendingOpen.userId===store.principal?.userId&&pendingOpen.authGeneration===store.authGeneration&&(error.code==='REQUEST_TIMEOUT'||error instanceof TypeError||/reply lost|connection reset|请求超时/i.test(error.message))){
        remember(pendingOpen);announce();toast('终端连接未确认；会话 ID '+pendingOpen.id+'，请用原 ID 重连检查。');
      }else if(error.code==='TERMINAL_STOPPED'&&pendingOpen?.id===error.id&&pendingOpen.userId===store.principal?.userId&&pendingOpen.authGeneration===store.authGeneration){
        pendingOpen.connectionState='ended';remember(pendingOpen);announce();pendingOpen=null;toast(error.message);
      }else toast(error.message);
    }finally{button.disabled=false;}
  }
  document.addEventListener('gpuq-terminal-reveal',event=>{
    const {id,userId}=event.detail||{},known=sessions.get(id);if(userId!==store.principal?.userId||known?.userId!==userId)return;
    if(session?.id===id){ensureDialog();if(!dialog.open){dialog.showModal();revealMotion();}fit?.fit();term?.focus();return;}
    openTerminal({id:'terminal-reconnect',disabled:false},known);
  });
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-gpu-shell]');if(!button)return;
    const job=store.data?.jobs?.find(job=>job.id===button.dataset.gpuShell);
    if(!job?.interactive||job.state!=='RUNNING')return;
    openTerminal({id:'terminal-reconnect',disabled:false},{id:job.id,machine:job.machine,project:job.project,ownerId:job.ownerId||job.userId,userId:store.principal?.userId});
  });
  document.addEventListener('gpuq-terminal-state-request',announce);
  document.addEventListener('gpuq-maintenance-state',syncMaintenance);
  document.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(['terminal-open','terminal-reconnect'].includes(button.id))await openTerminal(button);
    if(button.id==='terminal-collapse')dialog?.close();
    if(button.id==='terminal-interrupt'&&enqueue('\x03')){clearTimeout(timer);exchange();}
    if(button.id==='terminal-disconnect')await detach();
    if(button.id==='terminal-query'&&!backoff)await exchange(true);
    if(button.id==='terminal-retry'&&session)await openTerminal({id:'terminal-reconnect',disabled:false},session);
    if(button.id==='terminal-new'&&session)await openTerminal({id:'terminal-open',disabled:false},session);
    if(button.id==='terminal-stop'&&session){
      closing=true;clearTimeout(timer);inputScheduled=false;button.disabled=true;syncMaintenance();
      try{await closeSession(session);}catch(error){toast(error.message);closing=false;}finally{button.disabled=false;syncMaintenance();}
    }

  });
  window.addEventListener('resize',()=>{if(dialog?.open)fit?.fit();});
  announce();
}
