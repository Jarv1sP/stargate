import {gpuCardUsage} from './gpu-allocation.js';
const readOperation=operation=>operation==='state'||operation==='storage.snapshot'||/\.(?:get|list|status|plan|capabilities|overview|catalog|quota|info|logs|watch|completion|diagnostics|routes)$/.test(operation);
export class DemoClient{
  constructor(){this.authGeneration=0;this.authPending=0;this.authTail=Promise.resolve();this.inflight=new Set();this.authListeners=new Set();this.sessionToken=null;this.requestTimeoutMs=45000;}
  static async create(){const client=new DemoClient();client.remote=globalThis.GPUQ_LOCAL_API===true;client.production=globalThis.GPUQ_PRODUCTION===true;if(!client.remote){const {DemoService,DEMO_ADMIN}=await import('./service.js');client.service=await DemoService.create();await client.login(DEMO_ADMIN.username,DEMO_ADMIN.password);}else if(client.production&&globalThis.GPUQ_HAS_SESSION!==false){try{await client.refresh();}catch(e){if(e.status!==401)throw e;}}return client;}
  stale(message='登录状态已改变，已忽略旧请求。'){const error=Error(message);error.code='STALE_SESSION';return error;}
  async transport(path,body,token=null,{signal}={}){
    signal?.throwIfAborted();
    const controller=new AbortController();let timer,onAbort;
    const cancelled=signal?new Promise((_,reject)=>{onAbort=()=>{controller.abort(signal.reason);reject(signal.reason);};signal.addEventListener('abort',onAbort,{once:true});}):new Promise(()=>{});
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();const error=Error('请求超时；远端操作可能仍在完成，请刷新确认。');error.code='REQUEST_TIMEOUT';reject(error);},this.requestTimeoutMs);});
    try{return await Promise.race([(async()=>{
      const response=await fetch(`/api/${path}`,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
      let data;
      try{data=await response.json();}
      catch(cause){
        if(controller.signal.aborted)throw cause;
        throw Object.assign(Error([502,503,504].includes(response.status)?'服务暂时不可用，稍后重试':'服务响应无法确认，请稍后重试。'),{status:response.status});
      }
      if(!response.ok){const e=Error(typeof data?.error==='string'?data.error:[502,503,504].includes(response.status)?'服务暂时不可用，稍后重试':'请求失败');e.status=response.status;if(/^[A-Z][A-Z0-9_]{1,63}$/.test(data?.code||''))e.code=data.code;const retryAfter=response.headers?.get('Retry-After');if(retryAfter&&/^\d+$/.test(retryAfter))e.retryAfterMs=Number(retryAfter)*1000;if([409,503].includes(response.status)&&e.code==='SUBMISSION_REJECTED')e.storage=data.storage;throw e;}
      return data;
    })(),timeout,cancelled]);}finally{clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
  }
  track(promise){this.inflight.add(promise);promise.then(()=>this.inflight.delete(promise),()=>this.inflight.delete(promise));return promise;}
  async invoke(operation,args,token,options={}){
    if(!this.remote)return this.service.invoke(token,operation,args);
    const generation=this.authGeneration,request=structuredClone(args);
    for(let attempt=0;;attempt++){
      try{return await this.transport('call',{operation,args:request},token,options);}
      catch(error){
        if(attempt||!readOperation(operation)||[401,403].includes(error.status)||
          !(error instanceof TypeError||error.code==='REQUEST_TIMEOUT'||[429,502,503,504].includes(error.status)||error.status===400&&/RPC_BUSY|CACHE_BUSY|lock.*busy|锁.*忙|锁.*占用/i.test(error.message))||
          options.signal?.aborted||generation!==this.authGeneration)throw error;
        if(error.retryAfterMs)await new Promise((resolve,reject)=>{
          const clean=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);},finish=()=>{clean();resolve();},abort=()=>{clean();reject(options.signal.reason);},timer=setTimeout(finish,Math.min(error.retryAfterMs,this.requestTimeoutMs));
          options.signal?.addEventListener('abort',abort,{once:true});
        });
        options.signal?.throwIfAborted();if(generation!==this.authGeneration)throw this.stale();
      }
    }
  }
  onAuthChange(listener){this.authListeners.add(listener);return()=>this.authListeners.delete(listener);}
  maintenanceObservation(unknown){if(this.maintenanceStatusUnknown===unknown)return;this.maintenanceStatusUnknown=unknown;globalThis.document?.dispatchEvent(new Event('gpuq-maintenance-observation'));}
  changeAuth(action){
    const generation=++this.authGeneration,token=this.token;

    if(!this.authPending){this.sessionToken=token;for(const listener of this.authListeners)this.track(Promise.resolve().then(()=>listener((operation,args)=>this.invoke(operation,args,token))).catch(()=>{}));}
    this.authPending++;this.token=null;this.principal=null;this.data=null;this.maintenanceStatusUnknown=false;
    // Only identity changes are queued. Drain old requests (including bounded
    // terminal cleanup) before a new cookie can be installed or cleared.
    const pending=this.authTail.catch(()=>{}).then(async()=>{await Promise.allSettled([...this.inflight]);return action(generation);});
    this.authTail=pending;return pending.finally(()=>{this.authPending--;});
  }
  login(username,password){return this.changeAuth(async generation=>{
    let data;try{data=this.remote?await this.transport('login',{username,password,...(this.production?{client:'browser'}:{})}):await this.service.login(username,password);}catch(error){if(generation!==this.authGeneration)throw this.stale();throw error;}
    this.sessionToken=data.token;
    if(generation!==this.authGeneration)throw this.stale();
    this.token=data.token;this.principal=data.principal;this.data=data.state;return data.principal;
  });}
  async register(username,password,invite,name){if(!this.production)throw Error('邀请码注册仅在正式后台开放。');if(this.authPending)throw this.stale();const generation=this.authGeneration;return this.track((async()=>{try{const result=await this.transport('register',{username,password,invite,...(name?{name}:{})});if(generation!==this.authGeneration)throw this.stale();return result;}catch(error){if(generation!==this.authGeneration)throw this.stale();throw error;}})());}
  async call(operation,args={},options={}){
    options.signal?.throwIfAborted();
    if(operation==='logout')return this.logout();
    if(this.authPending)throw this.stale('正在切换登录账号，请稍后重试。');
    const generation=this.authGeneration,token=this.token;
    return this.track((async()=>{
      let data;try{data=await this.invoke(operation,args,token,{signal:options.signal});}catch(error){if(generation!==this.authGeneration)throw this.stale(operation==='terminal.open'?'登录状态已改变，终端创建结果未确认；请原账号重新连接检查，服务端仍按期限回收。':undefined);if(['state','maintenance.status'].includes(operation))this.maintenanceObservation(true);throw error;}
      if(generation!==this.authGeneration){
        if(options.onStale)try{await options.onStale(data.result,(operation,args)=>this.invoke(operation,args,token));}catch{throw this.stale('登录状态已改变；旧终端关闭未确认，请原账号重新登录后结束该终端，服务端仍按期限回收。');}
        throw this.stale();
      }
      options.signal?.throwIfAborted();
      if(data.state)this.data=data.state;if(data.principal)this.principal=data.principal;
      if(data.state?.operationalMaintenance!==undefined||operation==='maintenance.status')this.maintenanceObservation(!(operation==='maintenance.status'?data.result:this.data.operationalMaintenance));
      // Register resources synchronously inside the generation fence, before
      // callers resume and an identity transition can start.
      options.accept?.(data.result);return data.result;
    })());
  }
  logout(){return this.changeAuth(async generation=>{try{return (await this.invoke('logout',{},this.sessionToken)).result;}catch(error){if(generation!==this.authGeneration)throw this.stale();throw error;}finally{this.sessionToken=null;}});}
  async refresh(){await this.call('state');}
  get users(){return this.data?.users||[];}
  get jobs(){return this.data?.jobs||[];}
  get(id){const user=this.users.find(u=>u.id===id);if(!user)throw Error('找不到用户。');return structuredClone(user);}
  usage(id,machine){return gpuCardUsage(this.jobs,id,machine);}
  setRole(id,role){return this.call('users.role',{userId:id,role});}
  reset(id,password){return this.call('users.reset',{userId:id,password});}
  save(id,policy){return this.call('policy.save',{...policy,userId:id});}
  setEnabled(id,enabled){return this.call('users.enabled',{userId:id,enabled});}
}
