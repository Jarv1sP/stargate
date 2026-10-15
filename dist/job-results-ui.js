const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const resultReminder='请及时将结果下载到自己的电脑；平台不会自动备份或删除。';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function ownResultJob(store,job){return store.production===true&&store.principal?.enabled!==false&&!!store.principal?.userId&&job?.source!=='native'&&typeof job.id==='string'&&typeof job.machine==='string'&&uuid.test(job.id)&&id.test(job.machine);}
export function deletableResultJob(store,job){return store.production===true&&store.principal?.enabled!==false&&!!store.principal?.userId&&uuid.test(job?.id||'');}
const pendingDeletes=new WeakMap();
export async function deleteJobOutputs(store,job,{path='.',recursive=true,current=()=>true}={}){
 if(!deletableResultJob(store,job))throw Error('请先登录并选择任务输出。');
 const actor=store.principal.userId;let requests=pendingDeletes.get(store);if(!requests){requests=new Map();pendingDeletes.set(store,requests);}
 const target=JSON.stringify([actor,job.id,path,recursive]),request=requests.get(target)||{jobId:job.id,path,recursive,key:crypto.randomUUID()};requests.set(target,request);
 const check=()=>{if(!current()||store.principal?.userId!==actor||!deletableResultJob(store,job))throw Error('任务或账号已改变，请重新选择输出。');};
 check();const result=await store.call('outputs.delete',{...request,dryRun:false});if(result?.state==='TRASHED')requests.delete(target);return {...result,key:request.key};
}
export function resultFilePath(directory,name){
 const valid=value=>typeof value==='string'&&value&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[\\\x00-\x1f\x7f]/.test(part));
 if(!valid(name)||name.includes('/')||directory!=='.'&&!valid(directory))throw Error('请使用输出目录内的相对路径，不要包含 .. 或绝对路径。');
 return directory==='.'?name:directory+'/'+name;
}
export function resultPullCommand(job,path){
 resultFilePath('.',path.split('/').at(-1));for(const part of path.split('/'))resultFilePath('.',part);
 const quote=value=>/^[A-Za-z0-9_./-]+$/.test(value)?value:"'"+value.replaceAll("'","'\"'\"'")+"'";
 return 'gpuctl pull '+quote(path.startsWith('-')?'./'+path:path)+' LOCAL_FILE --machine '+quote(job.machine)+(job.project?' --project '+quote(job.project):'')+' --job '+job.id;
}
export function resultFilesHTML(entries,directory,{deletable=false}={}){
 if(!Array.isArray(entries)||entries.length>1000)throw Error('没有收到目录，或目录超过 1000 项；请刷新后重试。');
 const size=value=>Number.isSafeInteger(value)&&value>=0?(value>=1024**2?(value/1024**2).toFixed(1)+' MiB':value>=1024?(value/1024).toFixed(1)+' KiB':value+' B'):'未知';
 const rows=entries.filter(row=>['file','directory'].includes(row?.type)).map(row=>{
  const path=resultFilePath(directory,row.name),folder=row.type==='directory';
  const item=`<button type="button" class="job-result-file" data-result-path="${esc(path)}" data-result-type="${folder?'directory':'file'}" title="${esc(row.name)}"><span aria-hidden="true">${folder?'▱':'□'}</span><span>${esc(row.name)}</span><span class="mono">${folder?'':size(row.size)}</span></button>`;
  return deletable?`<div class="job-result-entry">${item}<button class="button danger quiet" type="button" data-result-delete="${esc(path)}" data-delete-recursive="${folder}" aria-label="删除 ${esc(row.name)}">删除</button></div>`:item;
 });
 if(directory!=='.'){const parent=directory.includes('/')?directory.slice(0,directory.lastIndexOf('/')):'.';rows.unshift(`<button type="button" class="job-result-file" data-result-path="${esc(parent)}" data-result-type="directory"><span aria-hidden="true">↑</span><span>上一级</span><span></span></button>`);}
 return rows.join('');
}
export function createJobResultAccess({store,changed=()=>{}}){
 // Logged-in team members can read outputs from running and finished tasks.
 const allowed=job=>ownResultJob(store,job);
 const accept=job=>allowed(job),check=async job=>allowed(job),sync=()=>paint();
 function markup(job){if(!ownResultJob(store,job))return '';return `<span data-job-result-slot="${esc(job.id)}" ${allowed(job)?'':'hidden'}>${allowed(job)?`<button class="button quiet" type="button" data-job-pull="${esc(job.id)}" title="${resultReminder}">拉取结果</button>`:''}</span>`;}
 function paint(root=globalThis.document){
  for(const slot of root?.querySelectorAll?.('[data-job-result-slot]')||[]){const job=(store.jobs||[]).find(row=>row.id===slot.dataset.jobResultSlot),show=allowed(job);slot.hidden=!show;if(show&&!slot.firstElementChild){const button=slot.ownerDocument.createElement('button');button.className='button quiet';button.type='button';button.dataset.jobPull=job.id;button.title=resultReminder;button.textContent='拉取结果';slot.append(button);}else if(!show)slot.replaceChildren();}
 }
 function clear(){paint();changed();}
 const unsubscribe=store.onAuthChange?.(clear);
 return {allowed,accept,check,sync,markup,paint,clear,destroy(){clear();unsubscribe?.();}};
}
