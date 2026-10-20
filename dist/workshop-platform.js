// The workshop reuses existing Portal operations; no credentials enter the frame.
export const PLATFORM_READS=new Set(['projects.list','projects.status','projects.quota','projects.catalog','projects.retire.list','datasets.list','storage.snapshot','files.list','jobs.logs','jobs.watch','jobs.completion','jobs.diagnostics','community.notes.list']);
export const PLATFORM_WRITES=new Set(['projects.create','projects.retire','projects.retire.restore','projects.label.set','projects.group.set','projects.archive','projects.unarchive','jobs.submit','jobs.priority','tasks.display.set','datasets.delete','outputs.delete','community.notes.create']);
const jobFields=['id','nodeJobId','source','name','description','state','machine','cards','project','ownerId','userId','username','submitter','argv','createdAt','startedAt','finishedAt','exitCode','reason','updatedAt','latestAttempt','progress','priority','schedulerPriority','assignedIndices','after','queueReason','error','failure','cancelRequested','interactive','notifications'];
export function platformSnapshot(store,resources){
 const member=store.users?.find(user=>user.id===store.principal?.userId);
 return {principal:{userId:store.principal?.userId,username:store.principal?.username,name:member?.name||store.principal?.username,role:store.principal?.role},resources,
  users:(store.users||[]).map(user=>({id:user.id,name:user.name,username:user.username,role:user.role})),
  jobs:(store.jobs||[]).map(job=>Object.fromEntries(jobFields.filter(key=>job[key]!==undefined).map(key=>[key,job[key]])))};
}
export async function platformCall(store,method,request,resources){
 const operation=request?.operation,args=request?.args||{};
 if(method==='platform.read'&&operation==='state'){if(request.refresh)await store.refresh();return platformSnapshot(store,resources());}
 const allowed=method==='platform.read'?PLATFORM_READS:PLATFORM_WRITES;
 if(!allowed.has(operation))throw Error('此操作未向工坊开放，请使用平台原生面板。');
 return store.call(operation,args);
}
