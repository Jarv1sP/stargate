// A package runs only inside an opaque-origin iframe. This document never
// receives the portal session, store, or a general-purpose API capability.
function bootstrap(payload, portalOrigin, nonce) {
  const pkg = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0))));
  const channel = new MessageChannel(), pending = new Map();
  let sequence = 0;
  channel.port1.onmessage = ({data}) => {
    if (data?.type === 'update') {
      window.dispatchEvent(new Event('stargate:update'));
      return;
    }
    if (data?.type !== 'response') return;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
  if(pkg.presentation==='interface')window.addEventListener('keydown',event=>{
    if(event.isTrusted&&!event.repeat&&event.ctrlKey&&event.altKey&&!event.shiftKey&&!event.metaKey&&event.code==='Digit0'){
      event.preventDefault();event.stopImmediatePropagation();channel.port1.postMessage({type:'exit-interface'});
    }
  },true);
  Object.defineProperty(window, 'stargate', {value: Object.freeze({
    call(method, args = {}) {
      if (pending.size >= 16) return Promise.reject(new Error('等待中的请求过多。'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('请求未确认；请在主页面核对，不会自动重试。')); }, 60000);
        pending.set(id, {resolve, reject, timer});
        try { channel.port1.postMessage({type: 'call', id, method, args}); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    }
  })});
  const fail = event => channel.port1.postMessage({type: 'error', message: String(event.message || event.reason?.message || '组件运行失败。').slice(0, 200)});
  window.addEventListener('error', fail);
  window.addEventListener('unhandledrejection', fail);
  const style = document.createElement('style');
  style.textContent = pkg.css;
  document.head.append(style);
  document.getElementById('workshop-root').innerHTML = pkg.html;
  parent.postMessage({type: 'stargate:workshop:ready', protocol: 1}, portalOrigin, [channel.port2]);
  const script = document.createElement('script');
  script.nonce = nonce;
  script.textContent = pkg.script;
  document.body.append(script);
}

export function renderWorkshopFrame(pkg, {nonce, origin}) {
  if (pkg.kind !== 'plugin') throw new Error('只有插件可以打开运行页面。');
  if (!/^[A-Za-z0-9+/_=-]{16,128}$/.test(nonce)) throw new Error('Invalid frame nonce');
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('Invalid portal origin');
  const payload = Buffer.from(JSON.stringify({html: pkg.html, css: pkg.css, script: pkg.script,presentation:pkg.presentation})).toString('base64');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`;
  const script = `(${bootstrap.toString()})(${JSON.stringify(payload)},${JSON.stringify(origin)},${JSON.stringify(nonce)});`;
  return {csp, html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>STARGATE 工坊组件</title><style>html{color-scheme:dark}body{margin:0;padding:16px;background:#111215;color:#f2f2ef;font:14px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}*{box-sizing:border-box}button,input,select{font:inherit;min-height:44px}button{cursor:pointer}a{color:inherit}</style></head><body><div id="workshop-root"></div><script nonce="${nonce}">${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`};
}
