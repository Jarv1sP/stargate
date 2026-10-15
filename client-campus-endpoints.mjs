// Authenticated grants supply the current campus and LAN routes.
import {isIP} from 'node:net';
import {createCampusNativeAgent} from './client-campus-native.mjs';
import {networkFailureCategory,safeNetworkTarget,proxyEnvironmentDetected} from './client-network-errors.mjs';
export function privateLanOrigin(value){
  let u;try{u=new URL(value);}catch{return false;}
  if(u.protocol!=='https:'||u.origin!==value||u.username||u.password||u.search||u.hash||u.pathname!=='/'||isIP(u.hostname)!==4)return false;
  const [a,b]=u.hostname.split('.').map(Number);
  return a===10||a===172&&b>=16&&b<=31||a===192&&b===168;
}
export function approvedCampusEndpoints(grant,routes=grant.routes){
  if(routes===undefined)return [{id:'primary',kind:'campus-direct',endpoint:grant.endpoint}];
  const seen=new Set(),usable=(Array.isArray(routes)?routes:[]).filter(r=>{
    if(!r||typeof r.id!=='string'||r.kind!=='campus-direct'||!validOrigin(r.endpoint)||r.id==='node-lan'&&!privateLanOrigin(r.endpoint)||r.id==='primary'&&r.endpoint!==grant.endpoint||seen.has(r.id))return false;
    seen.add(r.id);return true;
  });
  if(!usable.some(r=>r.endpoint===grant.endpoint))usable.push({id:'primary',kind:'campus-direct',endpoint:grant.endpoint});
  const lan=usable.find(r=>r.id==='node-lan');
  return [...(lan?[lan]:[]),...usable.filter(r=>r!==lan)].map(r=>Object.freeze({...r}));
}
function validOrigin(value){try{const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash;}catch{return false;}}
export const campusConnectionFailure=error=>['DNS_FAILED','TCP_TIMEOUT','TCP_REFUSED','PHYSICAL_CONNECT_FAILED','ACK_UNCONFIRMED','RESPONSE_INTERRUPTED','SESSION_STOPPED','CONNECTION_FAILED','CONNECTION_REFUSED','NETWORK_UNREACHABLE','TIMEOUT','ETIMEDOUT','ECONNRESET','EPIPE','ECONNREFUSED'].includes(error?.code);
// Use only when the caller has already decided its result. A bounded helper
// shutdown failure cannot undo a verified receipt or replace the original
// business error. In-flight request/ACK cleanup remains strict in the agent.
export async function finishCampusOperation(close,{warn=code=>process.stderr.write(`Warning: campus helper shutdown was not confirmed (${code}); original operation result unchanged.\n`)}={}){
  try{await close();}
  catch(error){
    const code=['NATIVE_EXIT_UNCONFIRMED','NATIVE_START_EXIT_UNCONFIRMED','NATIVE_CLEANUP_UNCONFIRMED'].includes(error?.code)?error.code:'NATIVE_CLEANUP_UNCONFIRMED';
    try{warn(code);}catch{/* A closed warning sink must not change the result. */}
  }
}
const ENDPOINT_CODES=new Set(['PHYSICAL_CONNECT_FAILED','ACK_UNCONFIRMED','RESPONSE_INTERRUPTED','SESSION_STOPPED','CONNECTION_FAILED','CONNECTION_REFUSED','NETWORK_UNREACHABLE','TIMEOUT','ETIMEDOUT','ECONNRESET','EPIPE','ECONNREFUSED','TLS_CHAIN_OR_NAME','TLS_PIN_CHANGED','TLS_UNTRUSTED','HANDSHAKE_EOF','HANDSHAKE_TIMEOUT','HANDSHAKE_FAILED','NETWORK_CHANGED','HTTP_REJECTED','NATIVE_EXITED','NATIVE_START_FAILED','CAMPUS_CAPABILITIES_INVALID']);
const endpointFailure=error=>{
  const category=networkFailureCategory(error);
  return ENDPOINT_CODES.has(error?.code)?error.code:category;
};
export async function probeCampusEndpoint(grant,endpoint,{nativeOptions={},agentFactory=createCampusNativeAgent,signal}={}){
  const timeoutMs=endpoint.id==='node-lan'?1000:2500;
  const agent=agentFactory(grant.certificateSha256,{...nativeOptions,timeoutMs:timeoutMs+100});
  const abort=()=>{void agent.destroy().catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  try{
    if(signal?.aborted)throw Object.assign(Error('Endpoint probe canceled'),{code:'ABORT_ERR'});
    const {value}=await agent.request({op:'probe',endpoint:grant.endpoint,certificateSha256:grant.certificateSha256,
      ...(endpoint.endpoint!==grant.endpoint?{dialEndpoint:endpoint.endpoint}:{}),probeTimeoutMs:timeoutMs,offset:0});
    return value.result;
  }finally{signal?.removeEventListener('abort',abort);await finishCampusOperation(()=>agent.destroy());}
}
export async function chooseCampusEndpoint(grant,endpoints,{probe=probeCampusEndpoint,exclude,retryExcluded=false,parallel=false}={}){
  // A campus-only client may not reach the LAN alias. A closed connection
  // does not revoke its approved endpoint: try the other alias first, then
  // re-probe the original identity before constructing a fresh connection.
  const candidates=endpoints.filter(endpoint=>endpoint.endpoint!==exclude);
  if(retryExcluded)candidates.push(...endpoints.filter(endpoint=>endpoint.endpoint===exclude));
  const failures=new Map();
  const observe=async(endpoint,signal)=>{
    const id=['primary','node-lan'].includes(endpoint.id)?endpoint.id:'endpoint';
    try{await probe(grant,endpoint,{signal});
      return endpoint;}
    catch(error){if(!failures.has(id))failures.set(id,{code:endpointFailure(error),category:networkFailureCategory(error),target:safeNetworkTarget(endpoint.endpoint),...(Number.isInteger(error.status)&&error.status>=100&&error.status<=599?{status:error.status}:{})});throw error;}
  };
  if(parallel&&candidates.length>1){
    const controllers=candidates.map(()=>new AbortController());
    try{return await Promise.any(candidates.map((endpoint,index)=>observe(endpoint,controllers[index].signal)));}
    catch{/* Both endpoints failed; retain their individual safe reasons below. */}
    finally{for(const controller of controllers)controller.abort();}
  }else{
    for(const endpoint of candidates){try{return await observe(endpoint);}catch{/* Try only the next approved endpoint. */}}
  }
  // A temporary probe/capability failure does not refuse a real request.
  // A known certificate failure stays an authentication failure.
  const waiting=candidates.filter(endpoint=>!['TLS_CHAIN_OR_NAME','TLS_PIN_CHANGED','TLS_UNTRUSTED','CERTIFICATE_MISMATCH','TLS_FAILED','TLS_PIN','TLS_HANDSHAKE'].includes(failures.get(['primary','node-lan'].includes(endpoint.id)?endpoint.id:'endpoint')?.code));
  if(waiting.length)return waiting[0];
  const endpointErrors=candidates.map(endpoint=>['primary','node-lan'].includes(endpoint.id)?endpoint.id:'endpoint').filter((id,index,ids)=>failures.has(id)&&ids.indexOf(id)===index).map(id=>({id,...failures.get(id)}));
  throw Object.assign(Error(`No approved LAN or campus endpoint passed pinned TLS and capabilities (${endpointErrors.map(({id,code,category,target,status})=>`${id}: ${code}${category!==code&&category!=='PROBE_FAILED'?' ['+category+']':''}${status?' HTTP '+status:''} (${target})`).join('; ')}); original UUID and offsets preserved.${proxyEnvironmentDetected()?' PROXY_IN_PATH (proxy environment detected; interception unconfirmed).':''}`),{code:'CAMPUS_ENDPOINT_UNAVAILABLE',endpointErrors});
}
