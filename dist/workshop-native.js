// Mount existing platform views in a modal, preserving their controllers and transfer logic.
export function createWorkshopNative({store,navigate,openProject,toast}){
 let active=null,opening=null,turn=0;
 function close(){turn++;if(active){active.dialog.close();active.finish();}}
 async function mount(request){
  close();const stamp=turn,type=request?.view;
  if(type==='admin'&&store.principal?.role!=='admin')throw Error('管理台需要管理员权限。');
  const page={project:'work',datasets:'datasets',job:'jobs',submit:'jobs',admin:'admin',community:'community',transfers:'transfers',resources:'resources'}[type];
  if(!page)throw Error('不支持此平台面板。');
  navigate(page);
  if(type==='project'){const opened=await openProject({...request.project,refresh:true,userId:store.principal?.userId,authGeneration:store.authGeneration});if(!opened)throw Error('项目暂未打开，请刷新或稍后再试。');}
  if(stamp!==turn)return {opened:false};
  if(type==='datasets'&&!request.dataset&&request.machine){const select=document.querySelector('[name=dataset-machine]');if(select){select.value=request.machine;select.dispatchEvent(new Event('change',{bubbles:true}));}}
  if(type==='datasets'&&request.dataset)document.dispatchEvent(new CustomEvent('gpuq-open-dataset',{detail:{userId:store.principal?.userId,machine:request.machine,dataset:request.dataset}}));
  if(type==='submit')document.querySelector('#jobs-new')?.click();
  if(type==='job')document.dispatchEvent(new CustomEvent('sg-open-job',{detail:{id:request.jobId}}));
  const node=document.querySelector(type==='project'?'#execution-host':type==='job'?'.jr-drawer.on':type==='submit'?'.jr-sheet.on':'#page-'+page);
  if(!node)throw Error('页面还未准备好，请稍后重试。');
  const marker=document.createComment('workshop native panel'),dialog=document.createElement('dialog');
  dialog.className='workshop-native-panel';dialog.setAttribute('aria-label',type==='project'?'项目终端与文件':'平台操作面板');node.before(marker);
  if(type!=='job'){
   const header=document.createElement('header'),title=document.createElement('strong'),button=document.createElement('button');
   header.className='workshop-native-heading';title.textContent={project:'项目终端与文件',submit:'新建训练任务',datasets:'数据集与文件',admin:'管理台',community:'团队协作',transfers:'传输',resources:'算力与存储'}[type];
   button.className='button';button.type='button';button.textContent='关闭';button.onclick=()=>dialog.close();header.append(title,button);dialog.append(header);
  }
  const body=document.createElement('div');body.className='workshop-native-body';body.append(node);dialog.append(body);document.body.append(dialog);let finished=false,visibility=null;
  const finish=()=>{if(finished)return;finished=true;visibility?.disconnect();if(type==='submit'&&node.classList.contains('on')){const cancel=node.querySelector('[data-sheet-close]');if(cancel)cancel.click();else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));}if(type==='job'&&node.classList.contains('on'))node.querySelector('.jr-x')?.click();marker.replaceWith(node);dialog.remove();if(active?.dialog===dialog)active=null;};
  active={dialog,finish,type};
  dialog.addEventListener('close',finish,{once:true});dialog.addEventListener('click',event=>{if(type==='job'&&event.target.closest('.jr-x'))dialog.close();});
  if(type==='job'||type==='submit'){visibility=new MutationObserver(()=>{if(!node.classList.contains('on'))dialog.close();});visibility.observe(node,{attributes:true,attributeFilter:['class']});}
  dialog.showModal();
  if(type==='project')node.querySelector(`[data-pt="${['term','files','settings'].includes(request.tab)?request.tab:'term'}"]`)?.click();
  return {opened:true};
 }
 function open(request){if(!opening)opening=mount(request).finally(()=>{opening=null;});return opening;}
 function route(event){if(!active)return;const next=event.detail?.next;if(next==='work'){close();return;}if(['resources','datasets','community','transfers','admin'].includes(next)&&active.type!==next)void open({view:next}).catch(error=>toast?.(error.message));}
 document.addEventListener('gpuq-route-entered',route);
 return {open,close,isOpen:()=>!!active,destroy(){close();document.removeEventListener('gpuq-route-entered',route);}};
}
