import {createCampusNativeAgent,resolveCampusNativeRuntime} from './client-campus-native.mjs';

const MAX_REQUEST=1024**2,MAX_RESPONSE=64*1024**2;
const rejected=code=>Object.assign(Error(`Platform Windows control transport stopped (${code}); keep the original operation identity`),{code});
const apiPaths=new Set(['/api/login','/api/logout','/api/register','/api/call']);
// Call only after the command has decided its business result. Shutdown can
// neither revoke a complete server receipt nor replace an original error.
// Request/abort cleanup below remains strict while the outcome is undecided.
export async function finishPlatformControlTransport(transport,{warn=code=>process.stderr.write(`Warning: platform control helper shutdown was not confirmed (${code}); original command result and exit status unchanged.\n`)}={}){
  try{await transport.close();}
  catch(error){
    const code=typeof error?.code==='string'&&/^[A-Z_0-9]{1,64}$/.test(error.code)?error.code:'CONTROL_CLEANUP_UNCONFIRMED';
    try{warn(code);}catch{/* A closed warning sink must not replace the result. */}
  }
}
// No credentials in process arguments/environment, proxy fallback, redirects,
// file relay or automatic mutation retries. apiPost remains the retry owner.
export function createWindowsControlFetch(base,{agentFactory=()=>createCampusNativeAgent(undefined,{control:true})}={}){
  const fixed=new URL(base);
  if(fixed.username||fixed.password||fixed.pathname!=='/'||fixed.search||fixed.hash)throw rejected('INVALID_CONTROL_ORIGIN');
  const origin=fixed.origin;
  if(fixed.protocol!=='https:'||fixed.port&&fixed.port!=='443')throw rejected('INVALID_CONTROL_ORIGIN');
  let agent,closed=false;const cleanups=new Set();
  const cleanupActive=active=>{const promise=Promise.resolve().then(()=>active.destroy());cleanups.add(promise);promise.then(()=>cleanups.delete(promise),()=>{closed=true;});return promise;};
  const fetchImpl=async(target,options={})=>{
    if(closed)throw rejected('CONTROL_CLOSED');
    const u=new URL(target),headers=new Headers(options.headers),authorization=headers.get('authorization')||'';
    if(u.origin!==origin||!apiPaths.has(u.pathname)||u.search||u.hash||u.username||u.password||options.method!=='POST'||options.redirect!=='error'||headers.get('content-type')!=='application/json')throw rejected('INVALID_CONTROL_REQUEST');
    if(authorization&&!/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(authorization))throw rejected('INVALID_CONTROL_TOKEN');
    if(typeof options.body!=='string')throw rejected('INVALID_CONTROL_REQUEST');
    const bytes=Buffer.from(options.body);if(bytes.length>MAX_REQUEST)throw rejected('CONTROL_REQUEST_TOO_LARGE');
    if(options.signal?.aborted)throw options.signal.reason;
    agent??=agentFactory();
    const active=agent;
    let abortCleanup;
    const abort=()=>{agent=undefined;abortCleanup=cleanupActive(active);abortCleanup.catch(()=>{});};
    options.signal?.addEventListener('abort',abort,{once:true});
    let response;
    try{response=await active.request({op:'control',control:{origin,path:u.pathname,...(authorization?{token:authorization.slice(7)}:{})}},bytes);}
    catch(error){agent=undefined;try{await cleanupActive(active);}catch{closed=true;error.cleanupUnconfirmed=true;}throw error;}
    finally{options.signal?.removeEventListener('abort',abort);if(abortCleanup)try{await abortCleanup;}catch{closed=true;throw Object.assign(rejected('CONTROL_CLEANUP_UNCONFIRMED'),{cleanupUnconfirmed:true,writeMayHaveReachedPeer:true});}}
    const {value,raw}=response;
    if(options.signal?.aborted)throw options.signal.reason;
    if(!Number.isInteger(value.status)||value.status<100||value.status>599||!Buffer.isBuffer(raw)||raw.length>MAX_RESPONSE){agent=undefined;await cleanupActive(active);throw rejected('INVALID_CONTROL_RESPONSE');}
    return {status:value.status,ok:value.status>=200&&value.status<300,json:async()=>JSON.parse(raw.toString('utf8'))};
  };
  return {fetchImpl,async close(){closed=true;const previous=agent;agent=undefined;if(previous)await cleanupActive(previous);await Promise.all([...cleanups]);}};
}
export async function defaultPlatformControlTransport(base,{resolveRuntime=()=>resolveCampusNativeRuntime(),create=createWindowsControlFetch}={}){
  const runtime=await resolveRuntime();
  const target=new URL(base);
  // The CLI already permits an explicit local development server. Literal
  // loopback cannot use a physical-interface socket or the fixed public API.
  if(target.hostname==='127.0.0.1'&&['http:','https:'].includes(target.protocol)&&!target.username&&!target.password&&target.pathname==='/'&&!target.search&&!target.hash)
    return {fetchImpl:fetch,close:async()=>{}};
  // Ordinary Linux/macOS keep their current network; only Windows/WSL use the
  // Windows process. Detection errors never fall back to a WSL public socket.
  return runtime.platform==='windows'?create(base):{fetchImpl:fetch,close:async()=>{}};
}
