import {taskIdentity,nativeTaskDisplay} from './dist/task-metadata.js';

// A trusted native-only record has no Portal ownership association. Its fenced
// labels may inform an administrator's presentation, but NEVER identify an
// account or authorize task controls. Return only bounded name/description.
export function nativeTaskPresentation(value){
  const username=value?.submitter?.username;
  if(typeof username!=='string'||!username.isWellFormed()||!username.trim()||[...username].length>24||Buffer.byteLength(username)>96||/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(username))return null;
  const display=nativeTaskDisplay(value,username);
  return display?{name:display.name,description:display.description}:null;
}

// One envelope for reconciliation/priority. Execution spec and digest never
// include mutable display labels. Old nodes receive their EXACT old request.
export const nativeJobSpec=job=>job.dataPreparationHold?.spec||job.spec;

export function nativeJobRequest(service,job,extra={}){
  const request={job:nativeJobSpec(job),...extra},host=service.gpuq?.hosts.find(h=>h.id===job.machine);
  if(service.gpuq?.stale===false&&host?.reachable===true&&host.gpuq?.connected===true&&Array.isArray(host.gpuq.capabilities)&&host.gpuq.capabilities.includes('console-task-display-v1'))
    // Backfill carries the original Portal labels, not a renamed native label
    // cached for presentation. The node preserves existing identity-fenced edits.
    request.metadata=taskIdentity({...job,nativeTaskDisplay:undefined},service.store.users);
  return request;
}
