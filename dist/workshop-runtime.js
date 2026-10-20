import {THEME_TOKENS} from './workshop-package.js';

const permissions = new Set(['resources.read', 'jobs.read', 'jobs.cancel', 'ui.navigate']);
const pages = new Set(['work', 'jobs', 'resources', 'datasets', 'community', 'workshop']);
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELED']);
const text = (value, length = 160) => typeof value === 'string' ? value.slice(0, length) : '';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function workshopResources(store) {
  const snapshot = store.data?.gpuq, fresh = snapshot?.stale === false;
  return {
    checkedAt: text(snapshot?.checkedAt) || null, stale: !fresh,
    machines: (store.data?.machines || []).slice(0, 64).map(machine => {
      const host = snapshot?.hosts?.find(host => host.id === machine.id);
      return {id: text(machine.id), model: text(machine.model), cards: number(machine.cards), reachable: typeof host?.reachable === 'boolean' ? host.reachable : null,
        gpus: fresh && host?.reachable === true ? (host.gpus || []).slice(0, 64).map(gpu => ({
          index: number(gpu.index), model: text(gpu.model), utilization: number(gpu.utilization),
          memoryUsedMiB: number(gpu.memoryUsedMiB), memoryTotalMiB: number(gpu.memoryTotalMiB),
          temperatureC: number(gpu.temperatureC), powerDrawW: number(gpu.powerDrawW), powerLimitW: number(gpu.powerLimitW)
        })) : []};
    })
  };
}

export function workshopJobs(store) {
  return {jobs: (store.jobs || []).filter(job => job.userId === store.principal?.userId).slice(0, 200).map(job => ({
    id: text(job.id), name: text(job.name), state: text(job.state, 32), machine: text(job.machine), cards: number(job.cards),
    progress: job.progress ? Object.fromEntries(['current', 'total', 'epoch', 'totalEpochs', 'step', 'totalSteps', 'percent'].map(key => [key, number(job.progress[key])])) : null
  }))};
}

export function workshopThemeCSS(theme) {
  if (!theme) return '';
  const tokens = Object.entries(theme.tokens || {}).filter(([key, value]) => THEME_TOKENS.includes(key) && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value));
  const content = theme.width === 'wide' ? '1600px' : '1280px';
  const gap = theme.density === 'compact' ? '16px' : '24px';
  return `body.sb[data-workshop-theme]{${tokens.map(([key, value]) => `${key}:${value}`).join(';')};--content:${content};--workshop-gap:${gap}}
body.sb[data-workshop-theme] #workshop-widgets{gap:var(--workshop-gap)}
@media(min-width:1000px){body.sb[data-workshop-theme] #workshop-widgets{grid-template-columns:repeat(${theme.columns === 2 ? 2 : 1},minmax(0,1fr))}}
${theme.density === 'compact' ? 'body.sb[data-workshop-theme] .page-heading{padding-block:24px 20px}body.sb[data-workshop-theme] #workshop-widgets>.workshop-widget{padding:12px}' : ''}`;
}

export function createWorkshopRuntime({store, root, navigate, toast, exitInterface}) {
  const document = root.ownerDocument, window = document.defaultView;
  const disabled = new URLSearchParams(window.location.search).get('workshop') === 'off';
  const frames = new Map();
  let installed = [], preview = null, destroyed = false, confirmation = null, stamp = identity();
  const themeStyle = document.createElement('style');
  themeStyle.nonce = document.querySelector('meta[name="gpuq-style-nonce"]')?.content || '';
  themeStyle.dataset.workshopTheme = '';
  document.head.append(themeStyle);

  function identity() { return `${store.principal?.userId || ''}:${store.authGeneration || 0}`; }
  function current(instance) { return !destroyed && !disabled && !instance.stopped && !!store.principal && instance.stamp === identity() && frames.get(instance.key) === instance; }
  let interfaceShell=null,previousInert=false;
  function restoreShell(){if(interfaceShell){interfaceShell.inert=previousInert;interfaceShell=null;}document.body.classList.remove('workshop-interface-active');}
  function close(instance) {
    clearTimeout(instance.timer);
    instance.port?.close();
    instance.card.remove();
    if(instance.wholeInterface)restoreShell();
    frames.delete(instance.key);
    if (confirmation?.instance === instance) confirmation.finish(false);
  }
  function clear() {
    for (const instance of [...frames.values()]) close(instance);
    installed = []; preview = null; themeStyle.textContent = ''; document.body.removeAttribute('data-workshop-theme');
    document.body.removeAttribute('data-workshop-layout');window.dispatchEvent(new CustomEvent('stargate:theme-change',{detail:{layout:'default'}}));
  }
  function account() {
    if (stamp !== identity()) { clear(); stamp = identity(); }
    return !!store.principal && !destroyed && !disabled;
  }
  function applyTheme() {
    const pkg = preview || installed.find(entry => entry.package.kind === 'theme')?.package;
    themeStyle.textContent = account() ? workshopThemeCSS(pkg?.theme) : '';
    document.body.toggleAttribute('data-workshop-theme', !!themeStyle.textContent);
    const layout=themeStyle.textContent?pkg?.theme?.layout||'default':'default';
    if(document.body.dataset.workshopLayout!==layout){document.body.dataset.workshopLayout=layout;window.dispatchEvent(new CustomEvent('stargate:theme-change',{detail:{layout}}));}
  }
  function fail(instance, message) {
    instance.status.textContent = text(message, 200) || '组件运行失败；可以停用或重新安装。';
    instance.status.hidden = false;
  }
  function confirmCancel(instance, job) {
    if (confirmation) throw new Error('请先处理主页面上已有的确认。');
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'modal workshop-confirm';
      const title = document.createElement('h2');
      title.textContent = '工坊插件请求取消训练';
      const message = document.createElement('p');
      message.textContent = `「${instance.name}」要取消你的任务「${job.name || job.id}」。此操作会停止训练。`;
      const actions = document.createElement('div'); actions.className = 'modal-actions';
      const cancel = document.createElement('button'); cancel.className = 'button'; cancel.textContent = '不取消';
      const accept = document.createElement('button'); accept.className = 'button danger'; accept.textContent = '确认取消训练';
      const finish = result => { if (confirmation?.dialog !== dialog) return; clearTimeout(timer); confirmation = null; dialog.close(); dialog.remove(); resolve(result); };
      const timer = setTimeout(() => finish(false), 45000);
      confirmation = {dialog, finish, instance};
      cancel.addEventListener('click', () => finish(false));
      accept.addEventListener('click', event => { if (event.isTrusted) finish(true); });
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      actions.append(cancel, accept); dialog.append(title, message, actions); document.body.append(dialog); dialog.showModal(); cancel.focus();
    });
  }
  async function call(instance, method, args) {
    if (!current(instance)) throw new Error('组件已停用或账号已改变。');
    if (!permissions.has(method) || !instance.permissions.has(method)) throw new Error('安装时未授予此权限。');
    if (method === 'resources.read') return workshopResources(store);
    if (method === 'jobs.read') return workshopJobs(store);
    if (method === 'ui.navigate') {
      if (!pages.has(args?.page)) throw new Error('不支持此页面。');
      navigate(args.page);
      return {page: args.page};
    }
    const currentJob = () => store.jobs.find(job => job.id === args?.jobId);
    const job = currentJob();
    if (!job || terminal.has(job.state)) throw new Error('只能取消现有的未结束任务。');
    if (instance.canceling) throw new Error('已有取消请求待确认。');
    instance.canceling = true;
    try {
      if (!await confirmCancel(instance, job)) throw new Error('未确认取消；未发出操作。');
      const latest = currentJob();
      if (!current(instance) || !latest || terminal.has(latest.state)) throw new Error('任务或账号已改变，未发出操作。');
      await store.call('jobs.cancel', {jobId: latest.id});
      if (!current(instance)) throw new Error('账号已改变，请在原账号核对任务。');
      const updated = currentJob();
      toast?.('取消请求已提交，请以任务状态为准。');
      return {jobId: latest.id, state: text(updated?.state, 32), cancelRequested: updated?.cancelRequested === true};
    } finally { instance.canceling = false; }
  }
  function connect(event) {
    if (event.data?.type !== 'stargate:workshop:ready' || event.data.protocol !== 1) return;
    const instance = [...frames.values()].find(instance => event.source === instance.frame.contentWindow);
    if (!instance || !current(instance) || instance.port || event.ports.length !== 1) { for (const port of event.ports) port.close(); return; }
    instance.port = event.ports[0]; clearTimeout(instance.timer); instance.status.hidden = true;
    instance.port.onmessage = async ({data}) => {
      if (!current(instance)) return;
      if (data?.type === 'error') { fail(instance, data.message); return; }
      if (data?.type !== 'call' || !Number.isSafeInteger(data.id) || data.id <= instance.lastId) return;
      instance.lastId = data.id;
      try {
        const result = await call(instance, data.method, data.args);
        if (current(instance)) instance.port.postMessage({type: 'response', id: data.id, result});
      } catch (error) {
        if (current(instance)) instance.port.postMessage({type: 'response', id: data.id, error: text(error.message, 200) || '操作失败。'});
      }
    };
    instance.port.start();
  }
  function mount(entry) {
    const wholeInterface=entry.package.presentation==='interface';
    const card = document.createElement('section'); card.className = 'workshop-widget'+(wholeInterface?' workshop-interface':'');
    const heading = document.createElement('h3'); heading.textContent = entry.package.name;
    const status = document.createElement('p'); status.className = 'form-error'; status.setAttribute('role', 'status'); status.textContent = '正在加载组件…';
    const frame = document.createElement('iframe');
    frame.title = entry.package.name; frame.sandbox = 'allow-scripts'; frame.referrerPolicy = 'no-referrer';
    frame.src = `/workshop/frame/${encodeURIComponent(entry.item.id)}/${encodeURIComponent(entry.item.version)}`;
    const instance = {key: `${entry.item.id}:${entry.item.version}`, wholeInterface, name: entry.package.name, stamp, card, status, frame, permissions: new Set(entry.package.permissions || []), port: null, lastId: 0};
    instance.timer = setTimeout(() => { if (current(instance) && !instance.port) fail(instance, '组件未能连接。请检查登录状态或重新安装。'); }, 10000);
    let loaded = false;
    frame.addEventListener('load', () => {
      if (loaded) { instance.stopped = true; instance.port?.close(); instance.port = null; if (confirmation?.instance === instance) confirmation.finish(false); fail(instance, '组件已离开运行页面；请停用后重新启用。'); }
      loaded = true;
    });
    frames.set(instance.key, instance); card.append(heading, status, frame);
    if(wholeInterface){
      const actions=document.createElement('div');actions.className='workshop-interface-actions';
      const exit=document.createElement('button');exit.type='button';exit.className='button';exit.textContent='恢复平台界面';
      exit.onclick=async()=>{exit.disabled=true;try{await exitInterface?.(entry.item.id);}catch(error){fail(instance,error.message);}finally{exit.disabled=false;}};
      const recovery=document.createElement('a');const url=new URL(window.location.href);url.searchParams.set('workshop','off');url.hash='workshop';recovery.href=url.href;recovery.textContent='安全打开平台';
      actions.append(exit,recovery);card.append(actions);document.body.append(card);
      interfaceShell=document.querySelector('.shell');if(interfaceShell){previousInert=interfaceShell.inert;interfaceShell.inert=true;}
      document.body.classList.add('workshop-interface-active');
    }else root.append(card);
  }
  window.addEventListener('message', connect);
  const unsubscribe = store.onAuthChange?.(() => { clear(); stamp = identity(); });
  return {
    setInstalled(entries) {
      if (!account()) { clear(); return; }
      installed = entries.map(entry => structuredClone(entry));
      const plugins = installed.filter(entry => entry.package.kind === 'plugin');
      const wanted = new Set(plugins.map(entry => `${entry.item.id}:${entry.item.version}`));
      for (const instance of [...frames.values()]) if (!wanted.has(instance.key)) close(instance);
      for (const entry of plugins) if (!frames.has(`${entry.item.id}:${entry.item.version}`)) mount(entry);
      applyTheme();
    },
    update() { if (!account()) { clear(); return; } for (const instance of frames.values()) instance.port?.postMessage({type: 'update'}); },
    previewTheme(pkg) { if (!account()) return; preview = pkg; applyTheme(); },
    destroy() { clear(); destroyed = true; themeStyle.remove(); unsubscribe?.(); window.removeEventListener('message', connect); }
  };
}
