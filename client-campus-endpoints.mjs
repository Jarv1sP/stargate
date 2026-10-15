// Authenticated grants supply the current campus and LAN routes.
import {isIP,connect} from 'node:net';
import {createCampusNativeAgent} from './client-campus-native.mjs';
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
export async function tcpCampusReachable(grant,{agentFactory=createCampusNativeAgent,platform=process.platform}={}){
  const endpoints=approvedCampusEndpoints(grant);
  if(endpoints.length>1)return (await Promise.all(endpoints.map(({endpoint})=>tcpCampusReachable({...grant,endpoint,routes:undefined},{agentFactory,platform})))).some(Boolean);
  if(!['linux','win32'].includes(platform))return new Promise(resolve=>{
    const endpoint=new URL(grant.endpoint),socket=connect({host:endpoint.hostname,port:Number(endpoint.port||443),signal:AbortSignal.timeout(1500)});
    const finish=reachable=>{socket.destroy();resolve(reachable);};
    socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));
  });
  const agent=agentFactory(grant.certificateSha256,{timeoutMs:2000});
  try{await agent.request({op:'probe',endpoint:grant.endpoint,certificateSha256:grant.certificateSha256,probeTimeoutMs:1500,tcpOnly:true});return true;}
  catch{return false;}
  finally{await finishCampusOperation(()=>agent.destroy(),{warn:()=>{}});}
}
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
