// Minimal HTTP client for the gray runner. It never retries by itself: a lost
// write response is "unknown", and the runner decides (at most one whole-step
// retry, only for infrastructure failures).
export class InfraError extends Error{
  constructor(message,detail={}){super(message);this.name='InfraError';Object.assign(this,detail);}
}
export class ApiError extends Error{
  constructor(operation,status,body){
    super(`${operation} → HTTP ${status}: ${typeof body?.error==='string'?body.error.slice(0,200):'no error text'}`);
    this.name='ApiError';this.operation=operation;this.status=status;this.code=body?.code;this.body=body;
  }
}
const INFRA_STATUS=new Set([502,503,504]);

export class PortalClient{
  constructor(base,{recordOperation=()=>{},timeoutMs=45000}={}){
    this.base=new URL(base);this.recordOperation=recordOperation;this.timeoutMs=timeoutMs;
  }
  get origin(){return this.base.origin;}
  async raw(path,{method='POST',body,token,cookie,origin,headers={}}={}){
    let response;
    try{
      response=await fetch(new URL(path,this.base),{method,redirect:'manual',signal:AbortSignal.timeout(this.timeoutMs),
        headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{}),
          ...(cookie?{Cookie:cookie}:{}),Origin:origin||this.origin,...headers},
        ...(body!==undefined?{body:JSON.stringify(body)}:{})});
    }catch(error){throw new InfraError(`${method} ${path}: ${error.message}`,{cause:error});}
    const text=await response.text();let data=null;
    try{data=text?JSON.parse(text):null;}catch{data=null;}
    return {status:response.status,headers:response.headers,body:data,text};
  }
  // Returns the full response body on 200. Infra statuses raise InfraError;
  // every other status raises ApiError so steps can assert on it.
  // recordOperation(name,'ok'|'refused'|'error'): coverage counts only 'ok'.
  async call(token,operation,args={},{cookie,origin}={}){
    let response;
    try{response=await this.raw('/api/call',{body:{operation,args},token,cookie,origin});}
    catch(error){this.recordOperation(operation,'error');throw error;}
    if(response.status===200){this.recordOperation(operation,'ok');return response.body;}
    if(INFRA_STATUS.has(response.status)&&!response.body?.code){this.recordOperation(operation,'error');throw new InfraError(`${operation} → HTTP ${response.status}`,{status:response.status});}
    this.recordOperation(operation,'refused');
    throw new ApiError(operation,response.status,response.body);
  }
  // Expect a refusal; returns the ApiError. A 200 is an assertion failure.
  async refused(token,operation,args={},options={}){
    try{await this.call(token,operation,args,options);}
    catch(error){if(error instanceof ApiError)return error;throw error;}
    throw Object.assign(Error(`${operation} unexpectedly succeeded`),{assertion:true});
  }
  async register(args){
    const response=await this.raw('/api/register',{body:args});
    this.recordOperation('register',response.status===200?'ok':INFRA_STATUS.has(response.status)?'error':'refused');
    if(response.status===200)return response.body;
    if(INFRA_STATUS.has(response.status))throw new InfraError(`register → HTTP ${response.status}`);
    throw new ApiError('register',response.status,response.body);
  }
  async login(username,password,{browser=false}={}){
    const response=await this.raw('/api/login',{body:{username,password,...(browser?{client:'browser'}:{})},...(browser?{origin:this.origin}:{})});
    this.recordOperation('login',response.status===200?'ok':INFRA_STATUS.has(response.status)?'error':'refused');
    if(response.status!==200){
      if(INFRA_STATUS.has(response.status))throw new InfraError(`login → HTTP ${response.status}`);
      throw new ApiError('login',response.status,response.body);
    }
    return {...response.body,setCookie:response.headers.getSetCookie?.()||[]};
  }
}
