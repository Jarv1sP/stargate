import {taskIdentity,nativeTaskDisplay} from './dist/task-metadata.js';

// Native-only labels describe the task; they do not authorize task controls.
export function nativeTaskPresentation(value){
  const display=nativeTaskDisplay(value);
  return display?{name:display.name,description:display.description}:null;
}

// One current OCI execution specification; display labels are separate.
export const nativeJobSpec=job=>job.spec;

export function nativeJobRequest(service,job,extra={}){
  const request={job:nativeJobSpec(job),...extra},host=service.gpuq?.hosts.find(h=>h.id===job.machine);
  if(service.gpuq?.stale===false&&host?.reachable===true&&host.gpuq?.connected===true&&Array.isArray(host.gpuq.capabilities)&&host.gpuq.capabilities.includes('console-task-display-v1'))
    // Send the submitted labels; later display edits remain on the node.
    request.metadata=taskIdentity({...job,nativeTaskDisplay:undefined},service.store.users);
  return request;
}
