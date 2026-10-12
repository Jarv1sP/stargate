import {maintenanceFor} from './maintenance-state.js';
import {copyHelp} from './copy-help-ui.js';
import {serverIdHTML,escapeUI} from './workbench-ui.js';
import {rootQueueForbidden,rootQueueHint} from './host-diagnostics-ui.js';

// The exported project action shares the same confirmed close flow as the UI.
// No connection credentials leave terminalUI's memory.
export function endProjectTerminals({machine,project},{signal}={}){
  signal?.throwIfAborted();
  terminalContext({machine,project});
  if(!project)return Promise.reject(Error('先选择要结束开发终端的项目。'));
  let onAbort;
  const pending=new Promise((resolve,reject)=>{
    if(signal){onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});}
    const detail={machine,project,signal,resolve,reject,handled:false};
    document.dispatchEvent(new CustomEvent('gpuq-project-terminals-close',{detail}));
    if(!detail.handled)reject(Error('终端尚未准备好。'));
  });
  return pending.finally(()=>{if(onAbort)signal.removeEventListener('abort',onAbort);});
}

export function terminalRequestContext(value){
  const {machine,project,hostAdmin,dataWorkspace}=value;
  // Project terminals, including personal containers, never request hostAdmin.
  return {machine,...(project?{project}:{}),...(dataWorkspace?{dataWorkspace:true}:{}),...(!project?{hostAdmin:hostAdmin===true}:{})};
}

export function terminalExitMessage(result){
  return Number.isInteger(result.exitCode)?`终端已结束（退出码 ${result.exitCode}）`:'终端已结束（退出码未提供）';
}
export function terminalStoppedMessage(result,id){
  return result?.protocol==='terminal-session-status-v1'&&result.id===id&&result.state==='STOPPED'&&result.evidence?.confirmed===true
    ?'此终端已结束。原会话不能恢复；需要继续工作时，请明确新建独立终端。':null;
}
export function terminalContext({machine,project,hostAdmin=false,dataWorkspace=false}){
  if(typeof machine!=='string'||!machine||machine==='auto')throw Error('先选择一台服务器，再打开终端。');
  if(project!==undefined&&project!==''&&(typeof project!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(project)))throw Error('项目名称无效。');
  if(project&&hostAdmin)throw Error('项目终端不能使用宿主机 ROOT 模式。');
  if(dataWorkspace&&(project||hostAdmin))throw Error('个人数据终端不能与项目或 ROOT 模式混用。');
  return {machine,hostAdmin:hostAdmin===true,...(project?{project}:{}),...(dataWorkspace?{dataWorkspace:true}:{})};
}

export function terminalLaunchContext({machine,project,role,entry='development'}){
  if(!['development','host','data'].includes(entry))throw Error('终端入口无效。');
  if(entry==='host'){
    if(role!=='admin')throw Error('宿主机 ROOT 运维仅管理员可用。');
    return terminalContext({machine,hostAdmin:true});
  }
  if(entry==='data')return terminalContext({machine,dataWorkspace:true});
  return terminalContext({machine,project,hostAdmin:false});
}

// Persist only development identities, never attachment credentials or output.
export function projectTerminalStorage(storage){
  const prefix='gpuq.project-terminals.v1:',uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const valid=value=>typeof value?.userId==='string'&&!!value.userId&&typeof value.machine==='string'&&!!value.machine&&value.machine!=='auto'&&typeof value.project==='string'&&/^[a-z][a-z0-9_-]{0,47}$/.test(value.project)&&!value.hostAdmin&&!value.dataWorkspace;
  const key=value=>prefix+encodeURIComponent(JSON.stringify([value.userId,value.machine,value.project]));
  function ids(name){try{const value=JSON.parse(storage?.getItem(name)||'null');return value?.protocol===1&&Array.isArray(value.ids)?[...new Set(value.ids.filter(id=>typeof id==='string'&&uuid.test(id)))]:[];}catch{return [];}}
  return {
    list(userId){
      const records=[];if(typeof userId!=='string'||!userId)return records;
      try{for(let index=0;index<storage?.length;index++){
        const name=storage.key(index);if(!name?.startsWith(prefix))continue;
        let scope;try{scope=JSON.parse(decodeURIComponent(name.slice(prefix.length)));}catch{continue;}
        if(!Array.isArray(scope)||scope.length!==3||scope[0]!==userId)continue;
        const value={userId:scope[0],machine:scope[1],project:scope[2]};
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
  let dialog,term,fit,session,timer,inputScheduled=false,idleDelay=80,busy=false,input=new Uint8Array(),offset=0,closing=false,lastSize='',generation=0,currentActor=null,currentWorkspace='',workspaceGeneration=0,openingGeneration=0,backoff=0,projectClosing=null;
  let rootOutput='',rootDecoder=new TextDecoder();
  const rootEntryActive=()=>store.principal?.role==='admin'&&!store.authPending&&!!document.querySelector('#page-admin:not([hidden]) #admin-maintenance-console');
  // This directory only contains session identities and public UI state.
  // The sole attached connection owns its token; detach erases it even if its
  // response is lost. Temporary stale/close connections release theirs too.
  const sessions=new Map(),projectModes=new Map();
  let savedStorage;try{savedStorage=globalThis.localStorage;}catch{ /* Private storage may be disabled. */ }
  const savedSessions=projectTerminalStorage(savedStorage);
  let restoredActor='',recoveryController=null,storageWarning=false;
  const paused=target=>!!target&&!target.hostAdmin&&!!maintenanceFor(store.data?.operationalMaintenance,target.machine);
  const identity=value=>JSON.stringify([value.userId,value.machine,value.project||'',value.hostAdmin===true,value.dataWorkspace===true]);
  const args=value=>({...terminalRequestContext(value),id:value.id,clientId:value.clientId,writerToken:value.writerToken});
  function remember(value){
    const {writerToken,writeUntil,authGeneration,...record}=value;sessions.set(value.id,{...record});
    if(savedSessions.remember(record)===false&&!storageWarning){storageWarning=true;toast('无法保存会话 ID，请复制后再刷新。');}
  }
  function forget(record){savedSessions.forget(record);sessions.delete(record.id);}
  function restoreDirectory(){
    const userId=store.principal?.userId,stamp=JSON.stringify([userId,store.authGeneration]);
    if(!userId||store.authPending||restoredActor===stamp)return;restoredActor=stamp;
    for(const record of savedSessions.list(userId))if(!sessions.has(record.id))sessions.set(record.id,{...record,hostAdmin:false,detached:true,connectionState:'unknown',recovered:true});
  }
  function announce(){restoreDirectory();document.dispatchEvent(new CustomEvent('gpuq-terminal-state',{detail:{sessions:[...sessions.values()].filter(value=>value.userId===store.principal?.userId).map(value=>({...value}))}}));}
  function cancelRecovery(){recoveryController?.abort();recoveryController=null;}
  async function verifyRecovered(machine,project){
    const userId=store.principal?.userId,auth=store.authGeneration,workspace=workspaceGeneration;
    if(!userId||store.authPending||!project||!store.data?.machines?.some(node=>node.id===machine))return;
    const records=[...sessions.values()].filter(record=>record.recovered&&record.userId===userId&&record.machine===machine&&record.project===project);
    if(!records.length)return;
    const controller=new AbortController();recoveryController=controller;
    const current=()=>!controller.signal.aborted&&userId===store.principal?.userId&&auth===store.authGeneration&&workspace===workspaceGeneration;
    try{for(const record of records){
      let result;try{result=await store.call('terminal.status',{...terminalRequestContext(record),id:record.id},{signal:controller.signal});}catch{if(!current())return;}
      if(!current())return;if(sessions.get(record.id)!==record)continue;
      const confirmed=result?.protocol==='terminal-session-status-v1'&&result.id===record.id&&result.evidence?.confirmed===true;
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
    if(request){const result=await call('terminal.detach',request);if(result?.detached!==true)throw Error('断开结果未确认。');}
  }
  async function detach(releaseWriter=true,invalidateOpening=true){
    if(invalidateOpening)openingGeneration++;
    const previous=session;clearTimeout(timer);inputScheduled=false;generation++;session=null;input=new Uint8Array();backoff=0;dialog?.close();
    if(previous&&releaseWriter)try{await release(previous);}catch{toast('断开未确认；终端仍保留，请稍后重连。');}
    else if(previous)delete previous.writerToken;
  }
  store.onAuthChange?.(async call=>{
    cancelRecovery();restoredActor='';
    const previous=session,request=previous?.writerToken?args(previous):null;currentActor=null;projectModes.clear();detach(false);announce();
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
  const entryOf=target=>target.dataWorkspace?'data':target.hostAdmin?'host':'development';
  function openRequest(target,mode,id){return {...terminalRequestContext(target),key:crypto.randomUUID(),clientId:crypto.randomUUID(),mode,...(mode==='reconnect'?{id}:{})};}
  function connection(result,target,request,startedAt){
    if(typeof result?.id!=='string'||!result.id||typeof result.writerToken!=='string'||!result.writerToken)throw Error('终端连接未确认，未发送输入。');
    if(request.mode==='reconnect'&&result.id!==request.id||result.clientId!==undefined&&result.clientId!==request.clientId||result.mode!==undefined&&result.mode!==request.mode||result.hostAdmin!==undefined&&result.hostAdmin!==target.hostAdmin)throw Error('终端返回身份不匹配，未发送输入。');
    return {...target,id:result.id,clientId:request.clientId,writerToken:result.writerToken,authGeneration:store.authGeneration,writeUntil:startedAt+30000,detached:false,connectionState:'connecting'};
  }
  function takeoverError(error){return /another active writer|Legacy terminal|active writer/.test(error.message);}
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
  async function closeEnded(record,signal){
      const userId=store.principal?.userId,auth=store.authGeneration;
      const result=await store.call('terminal.close',{...terminalRequestContext(record),id:record.id},{signal});
      signal?.throwIfAborted();
      if(userId!==store.principal?.userId||auth!==store.authGeneration)throw Error('登录账号已改变，未确认旧终端结果。');
      if(result?.closed!==true||result.id!==record.id||result.state!=='STOPPED'||result.metadataOnly!==true)throw Error('结束结果未确认，请查询原会话。');
      forget(record);if(session?.id===record.id)await detach(false);announce();
  }
  async function closeSession(record,{signal,allowTakeover=true}={}){
    signal?.throwIfAborted();
    if(record.userId!==store.principal?.userId)throw Error('不能结束另一账号的终端。');
    if(record.connectionState==='ended'&&!(session?.id===record.id&&session.writerToken&&Date.now()<session.writeUntil))return closeEnded(record,signal);
    let target=session?.id===record.id?session:null;
    if(target&&!usable(target))target=null;
    if(!target){
      if(paused(record))throw Error('维护期间不能重连已断开的开发终端，请管理员核对。');
      const userId=store.principal?.userId,auth=store.authGeneration,current=()=>!signal?.aborted&&userId===store.principal?.userId&&auth===store.authGeneration;
      const request=openRequest(record,'reconnect',record.id),startedAt=Date.now();
      const lifecycle={signal,
        accept:result=>{target=connection(result,record,request,startedAt);},
        onStale:async(result,call)=>{if(result?.writerToken)await release(connection(result,record,request,startedAt),call);}
      };
      try{
        if(allowTakeover)await requestAttachment(record,request,lifecycle,current);
        else try{await store.call('terminal.open',request,lifecycle);}catch(error){if(takeoverError(error))throw Error('这个终端正在别处使用，请在那里结束');throw error;}
      }catch(error){
        if(!current())throw error;
        if(error.code==='TERMINAL_STOPPED')return closeEnded(record,signal);
        if(!allowTakeover&&/not reachable|has ended/.test(error.message)){
          const result=await store.call('terminal.status',{...terminalRequestContext(record),id:record.id},{signal});
          if(!current())throw Error('登录或项目已改变，未结束旧终端。');
          if(terminalStoppedMessage(result,record.id))return closeEnded(record,signal);
        }
        throw error;
      }
      if(signal?.aborted){delete target?.writerToken;signal.throwIfAborted();}
      if(!current()){delete target?.writerToken;throw Error('登录账号已改变，未结束旧终端。');}
    }
    const attached=target===session;if(attached){closing=true;clearTimeout(timer);inputScheduled=false;syncMaintenance();}
    let confirmed=false;
    const removeCleanup=!attached?store.onAuthChange?.(call=>release(target,call)):null;
    try{
      signal?.throwIfAborted();
      const result=await store.call('terminal.close',args(target),{signal});
      signal?.throwIfAborted();
      if(result?.closed!==true){if(attached)stopInput(target,'结束结果未确认，请重新查询。',{expired:false});throw Error('结束结果未确认，请重新查询。');}
      confirmed=true;
      delete target.writerToken;forget(record);
      if(session?.id===record.id)await detach(false);announce();
    }catch(error){
      if(attached)stopInput(target,'结束结果未确认，请重新查询。');
      throw error;
    }finally{
      removeCleanup?.();
      if(!attached&&!confirmed&&attachmentCurrent(target))try{await release(target,(operation,fields)=>store.call(operation,fields,{signal}));}catch{if(!signal?.aborted)toast('断开未确认，请稍后重连检查。');}
      if(target!==session)delete target?.writerToken;
      if(attached){closing=false;syncMaintenance();}
    }
  }
  async function closeProject({machine,project,signal}){
    signal?.throwIfAborted();
    const key=JSON.stringify([store.principal?.userId,machine,project]);
    if(projectClosing){if(projectClosing.key===key)return projectClosing.promise;throw Error('另一项目正在结束终端，请稍后。');}
    const promise=(async()=>{
      const owner=store.principal?.userId,auth=store.authGeneration;
      if(!owner)throw Error('请先登录。');
      const targets=[...sessions.values()].filter(value=>value.userId===owner&&value.machine===machine&&value.project===project&&!value.hostAdmin&&!value.dataWorkspace);
      if(!targets.length)return true;
      if(!window.confirm(`结束 ${project} 的全部开发终端？正在执行的命令会停止，已保存的文件保留。`))return false;
      for(const target of targets){signal?.throwIfAborted();if(owner!==store.principal?.userId||auth!==store.authGeneration)throw Error('登录账号已改变，已停止结束旧终端。');await closeSession(target,{signal,allowTakeover:false});}
      signal?.throwIfAborted();
      return true;
    })();
    projectClosing={key,promise};try{return await promise;}finally{projectClosing=null;}
  }
  document.addEventListener('gpuq-project-terminals-close',event=>{const {detail}=event;detail.handled=true;closeProject(detail).then(detail.resolve,detail.reject);});
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
      if(!Number.isSafeInteger(result?.offset)||result.offset<0||typeof result.exited!=='boolean')throw Error('终端回执未确认。');
      lastSize=sizeKey;if(result.data){
        const output=Uint8Array.from(atob(result.data),char=>char.charCodeAt(0));term.write(output);
        if(target.hostAdmin){rootOutput=(rootOutput+rootDecoder.decode(output,{stream:true})).slice(-4096);if(rootQueueForbidden(rootOutput)){const note=document.querySelector('#terminal-root-identity-note');note.textContent=rootQueueHint;note.hidden=false;}}
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
    dialog.innerHTML='<div class="modal-head"><h2 id="terminal-title"></h2><div><button class="button quiet" id="terminal-collapse">收起</button><button class="button" id="terminal-interrupt">Ctrl+C</button> <button class="button" id="terminal-disconnect">断开</button> <button class="button danger" id="terminal-stop">结束终端</button></div></div><p id="terminal-maintenance-note" class="terminal-maintenance-note" role="status" hidden></p><p id="terminal-root-identity-note" class="host-native-note" role="status" hidden></p><div id="terminal-screen"></div><div class="terminal-recovery"><span id="terminal-connection-note" role="status" hidden></span><button class="button quiet" id="terminal-query" hidden>重新查询</button><button class="button" id="terminal-retry" hidden>重连</button><button class="button" id="terminal-new" hidden>新建终端</button></div><div class="terminal-footer"><p id="terminal-session-note" class="muted"></p>'+copyHelp('断开和结束','断开保留终端和已有命令；结束终端会停止其中的命令。输入未确认时不会自动重发，请重连后检查输出。','/guide/development')+'</div>';
    document.body.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();detach();});
    if(typeof ResizeObserver==='function')new ResizeObserver(()=>{if(dialog.open&&term)fit?.fit();}).observe(document.querySelector('#terminal-screen'));
  }
  document.addEventListener('gpuq-workspace-context',event=>{
    const {userId,machine,project}=event.detail,next=JSON.stringify([userId,machine,project||'']);
    if(currentActor!==userId||currentWorkspace!==next){cancelRecovery();currentActor=userId;currentWorkspace=next;workspaceGeneration++;detach();announce();verifyRecovered(machine,project);}
  });
  document.addEventListener('gpuq-route-leaving',cancelRecovery);
  window.addEventListener('pagehide',cancelRecovery);
  document.addEventListener('gpuq-data-workspace-context',()=>{openingGeneration++;if(session?.dataWorkspace)detach();});
  function revealMotion(){const reduce=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion:reduce)').matches:true;dialog.animate?.(reduce?[{opacity:0},{opacity:1}]:[{clipPath:'inset(100% 0 0 0)'},{clipPath:'inset(0)'}],{duration:reduce?150:320,easing:'cubic-bezier(.2,0,0,1)'});}
  async function openTerminal(button,knownTarget=null){
    button.disabled=true;let pendingOpen=null;
    try{
      const entry=button.id.startsWith('terminal-data-')?'data':button.id.startsWith('terminal-root-')?'host':knownTarget?entryOf(knownTarget):'development';
      const projectControl=document.querySelector('[name=workspace-project]');
      const selectedProject=projectControl?.selectedOptions?.[0]?.dataset?.project||projectControl?.value;
      const target=terminalLaunchContext({machine:knownTarget?.machine??document.querySelector(entry==='data'?'[name=dataset-machine]':entry==='host'?'[name=workspace-machine]':'[name=terminal-machine]')?.value,project:knownTarget?.project??selectedProject,role:store.principal?.role,entry});
      if(target.hostAdmin&&!rootEntryActive())return;
      if(paused(target))throw Error('维护中：不能新开或重连开发终端；已连接终端仍可断开或结束。');
      if(target.hostAdmin&&!window.confirm(`进入 ${target.machine} 的宿主机 ROOT 运维？可修改整机、影响他人任务，并能绕过 GPU 配额。`))return;
      const userId=store.principal?.userId,auth=store.authGeneration,workspace=workspaceGeneration;if(!userId)throw Error('请先登录。');
      if(knownTarget&&knownTarget.userId!==undefined&&knownTarget.userId!==userId)throw Error('不能连接另一账号的终端。');
      const reconnect=button.id.endsWith('-reconnect'),matching=[...sessions.values()].filter(value=>identity(value)===identity({...target,userId}));
      const id=reconnect?(knownTarget?.id||window.prompt('输入要重连的会话 ID。其他客户端仍在操作时不会自动接管。',matching.at(-1)?.id||'')?.trim()):null;
      if(reconnect&&!id)return;
      const known=id?sessions.get(id):null;if(known&&identity(known)!==identity({...target,userId}))throw Error('会话属于另一台服务器、项目或终端类型；请返回对应入口重连。');
      const request=openRequest(target,reconnect?'reconnect':'new',id),opening=++openingGeneration;
      const current=()=>opening===openingGeneration&&workspace===workspaceGeneration&&auth===store.authGeneration&&currentActor===userId&&(!target.hostAdmin||rootEntryActive());
      // Read actual project mode for the container label. No role/source-code
      // inference of capability and no environment/engine arguments on open.
      if(target.project){
        const key=identity({...target,userId});
        if(!projectModes.has(key)){
          const result=await store.call('projects.list',{machine:target.machine});if(!current())return;
          const info=result?.projects?.find(value=>value.project===target.project);
          if(!info||info.environmentMode!==undefined&&!['shared','isolated','oci'].includes(info.environmentMode))throw Error('项目环境未确认，请刷新项目列表。');
          projectModes.set(key,info.environmentMode||'shared');
        }
        target.environmentMode=projectModes.get(key);
      }
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
      ensureDialog();dialog.classList.toggle('host-terminal-dialog',target.hostAdmin);
      const label=target.hostAdmin?'ROOT 运维':target.dataWorkspace?'个人数据 /data2':target.environmentMode==='oci'?'容器终端 · 无 GPU':'个人开发';
      const title=document.querySelector('#terminal-title');title.textContent=target.machine+' · '+(target.project?target.project+' · ':'')+label+' · '+retained.id;
      const machineLabel=target.machine.length<=8?'<span class="server-id terminal-server-id" title="'+escapeUI(target.machine)+'">'+escapeUI(target.machine)+'</span>':serverIdHTML(target.machine,'terminal-server-id');
      title.innerHTML=machineLabel+'<span> · '+escapeUI((target.project?target.project+' · ':'')+label)+'</span><code class="terminal-session-id" title="'+escapeUI(retained.id)+'">'+escapeUI(retained.id)+'</code>';
      document.querySelector('#terminal-session-note').textContent=target.hostAdmin?'宿主机 ROOT · 可修改整机并绕过 GPU 配额。':target.dataWorkspace?'个人数据终端 · 无 GPU':target.environmentMode==='oci'?'容器终端 · 无 GPU':'个人开发终端 · 无 GPU';
      connectionNote();dialog.showModal();revealMotion();term?.dispose();document.querySelector('#terminal-screen').replaceChildren();
      rootOutput='';rootDecoder=new TextDecoder();const rootNote=document.querySelector('#terminal-root-identity-note');rootNote.hidden=true;rootNote.textContent='';
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
    const {id,userId}=event.detail||{},known=sessions.get(id);if(userId!==store.principal?.userId||known?.userId!==userId||known.hostAdmin&&store.principal?.role!=='admin')return;
    if(known.hostAdmin&&!rootEntryActive())return;
    if(session?.id===id){ensureDialog();if(!dialog.open){dialog.showModal();revealMotion();}fit?.fit();term?.focus();return;}
    openTerminal({id:'terminal-'+(known.dataWorkspace?'data-':known.hostAdmin?'root-':'')+'reconnect',disabled:false},known);
  });
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-gpu-shell]');if(!button)return;
    const job=store.data?.jobs?.find(job=>job.id===button.dataset.gpuShell);
    if(!job?.interactive||job.userId!==store.principal?.userId||job.state!=='RUNNING')return;
    openTerminal({id:'terminal-reconnect',disabled:false},{id:job.id,machine:job.machine,project:job.project,userId:job.userId});
  });
  document.addEventListener('gpuq-terminal-state-request',announce);
  document.addEventListener('gpuq-maintenance-state',syncMaintenance);
  document.addEventListener('gpuq-maintenance-root',event=>{
    const {machine,id,userId,mode}=event.detail||{};if(userId!==store.principal?.userId||!rootEntryActive()||!store.data?.machines?.some(item=>item.id===machine))return;
    const known=id?sessions.get(id):null;if(id&&(!known||!known.hostAdmin||known.machine!==machine||known.userId!==userId))return;
    openTerminal({id:id||mode==='reconnect'?'terminal-root-reconnect':'terminal-root-open',disabled:false},known||{machine,project:''});
  });
  document.addEventListener('gpuq-maintenance-retire',event=>{if(session?.hostAdmin&&event.detail?.userId===session.userId)detach();});
  document.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(['terminal-open','terminal-reconnect','terminal-root-open','terminal-root-reconnect','terminal-data-open','terminal-data-reconnect'].includes(button.id))await openTerminal(button);
    if(button.id==='terminal-collapse')dialog?.close();
    if(button.id==='terminal-interrupt'&&enqueue('\x03')){clearTimeout(timer);exchange();}
    if(button.id==='terminal-disconnect')await detach();
    if(button.id==='terminal-query'&&!backoff)await exchange(true);
    if(button.id==='terminal-retry'&&session)await openTerminal({id:'terminal-reconnect',disabled:false},session);
    if(button.id==='terminal-new'&&session)await openTerminal({id:'terminal-open',disabled:false},session);
    if(button.id==='terminal-stop'&&session){
      if(!window.confirm('结束这个终端？正在执行的命令会停止，已保存的文件保留。'))return;
      closing=true;clearTimeout(timer);inputScheduled=false;button.disabled=true;syncMaintenance();
      try{await closeSession(session);}catch(error){toast(error.message);closing=false;}finally{button.disabled=false;syncMaintenance();}
    }
    if(button.id==='project-terminal-stop'){
      const machine=document.querySelector('[name=workspace-machine]')?.value,project=document.querySelector('[name=workspace-project]')?.value;
      button.disabled=true;try{if(await endProjectTerminals({machine,project}))toast('项目开发终端已结束，可以生成训练版本。');}catch(error){toast(error.message);}finally{button.disabled=false;}
    }
  });
  window.addEventListener('resize',()=>{if(dialog?.open)fit?.fit();});
  announce();
}
