import {dataWorkspaceHTML,dataWorkspaceUI} from './data-workspace.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function datasetsUI(store,toast){
  const section=document.querySelector('#page-datasets');
  let identity='',generation=0,loaded='',workspace,busy=false;
  const query=s=>section.querySelector(s);
  const actor=()=>store.principal?.userId;
  const machines=()=>{
    const user=store.users.find(u=>u.id===actor());
    return user?.enabled?(store.data?.machines||[]).filter(m=>user.limits?.[m.id]>0):[];
  };
  const machine=()=>query('[name=dataset-machine]').value;
  const remember=()=>sessionStorage.setItem('data-copy:'+actor()+':'+machine(),query('[name=copy-key]').value);
  const restore=()=>{query('[name=copy-key]').value=sessionStorage.getItem('data-copy:'+actor()+':'+machine())||'';};
  async function roots(){
    const expected=generation,target=machine();if(!target)return;
    query('#data-roots').textContent='读取目录配置…';
    try{
      const result=await store.call('data.roots',{machine:target});
      if(expected!==generation||target!==machine())return;
      query('#data-roots').innerHTML=[...(result.directories||[]),result.personal].filter(Boolean)
        .map(row=>'<li><code>'+esc(row.path)+'</code> · '+(row.readOnly?'共享只读':'个人可写')+'</li>').join('');
    }catch(error){if(expected===generation)query('#data-roots').textContent=error.message;}
  }
  async function copy(action){
    if(busy||!machine())return;
    const expected=generation,target=machine();busy=true;controls();
    try{
      let key=query('[name=copy-key]').value.trim();
      if(action==='start'&&!key){key=crypto.randomUUID();query('[name=copy-key]').value=key;remember();}
      const args={machine:target,key,...(action==='start'?{from:query('[name=copy-from]').value,
        scope:query('[name=copy-scope]').value.trim(),path:query('[name=copy-source]').value.trim(),
        destination:query('[name=copy-destination]').value.trim()}:{})};
      const result=await store.call('data.copy.'+action,args);
      if(expected!==generation)return;
      query('#data-copy-status').textContent=result.state+' · '+key;
    }catch(error){if(expected===generation){query('#data-copy-status').textContent=error.message;toast(error.message);}}
    finally{if(expected===generation){busy=false;controls();}}
  }
  function controls(){
    workspace?.controls();
    for(const button of section.querySelectorAll('[data-copy-action]'))button.disabled=busy||!machine();
  }
  return ()=>{
    const next=JSON.stringify([actor(),store.authGeneration]);
    if(identity!==next||!query('[name=dataset-machine]')){
      identity=next;generation++;loaded='';busy=false;workspace?.reset();
      section.innerHTML=`<header><h2>数据与文件</h2><p>本机目录直接读；上传和跨机复制独立运行。</p></header>
        <label class="field">服务器<select name="dataset-machine"></select></label>
        <ul id="data-roots"></ul>
        ${dataWorkspaceHTML()}
        <section class="data-workspace-card"><h3>从另一台服务器复制目录</h3>
        <form id="data-copy-form"><div class="data-workspace-fields">
          <label class="field">来源服务器<select name="copy-from"></select></label>
          <label class="field">来源根目录<input name="copy-scope" value="mine" required></label>
          <label class="field">来源相对目录<input name="copy-source" required></label>
          <label class="field">目标 /data/mine 下的目录<input name="copy-destination" required></label>
        </div><button class="button" type="submit" data-copy-action="start">开始复制</button></form>
        <label class="field">传输编号（新传输请留空）<input name="copy-key"></label>
        <div class="file-actions"><button class="button" data-copy-action="status">查询</button>
          <button class="button" data-copy-action="resume">续传</button>
          <button class="button" data-copy-action="cancel">暂停</button></div>
        <p id="data-copy-status" role="status">复制到当前选定的目标服务器；不删除源文件。</p></section>`;
      workspace ||= dataWorkspaceUI(store,section,toast);
      query('#data-copy-form').addEventListener('submit',event=>{event.preventDefault();void copy('start');});
      section.onclick=event=>{const action=event.target.closest('[data-copy-action]')?.dataset.copyAction;if(action&&action!=='start')void copy(action);};
      query('[name=copy-key]').addEventListener('change',remember);
      query('[name=dataset-machine]').addEventListener('change',()=>{
        generation++;busy=false;workspace.reset();restore();void roots();controls();
        document.dispatchEvent(new CustomEvent('gpuq-data-workspace-context'));
      });
    }
    const available=machines(),ids=available.map(m=>m.id).join(',');
    if(loaded!==ids){
      const previous=machine();loaded=ids;
      const options=available.map(m=>'<option value="'+esc(m.id)+'">'+esc(m.id)+'</option>').join('')||'<option value="">没有已授权服务器</option>';
      query('[name=dataset-machine]').innerHTML=options;query('[name=copy-from]').innerHTML=options;
      if(available.some(m=>m.id===previous))query('[name=dataset-machine]').value=previous;
      generation++;restore();void roots();
    }
    controls();
  };
}
