/* 通用界面组件 */
window.ACT = window.ACT || {}; // data-act 事件注册表
window.UI = (function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const sv = (d, vb = '0 0 24 24', extra = '') => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const I = {
    home: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 2 11.5h3V21h5.5v-6h3v6H19v-9.5h3z"/></svg>`,
    doc: sv('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
    bell: sv('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
    help: sv('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.7"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
    user: sv('<circle cx="12" cy="9" r="3.5"/><path d="M5.5 19c1.2-3 3.6-4.5 6.5-4.5s5.3 1.5 6.5 4.5"/>'),
    down: sv('<path d="m6 9 6 6 6-6"/>'),
    up: sv('<path d="m6 15 6-6 6 6"/>'),
    right: sv('<path d="m9 6 6 6-6 6"/>'),
    left: sv('<path d="m15 6-6 6 6 6"/>'),
    search: sv('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>'),
    close: sv('<path d="M6 6l12 12M18 6 6 18"/>'),
    refresh: sv('<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4v4h-4"/>'),
    gear: sv('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>'),
    edit: sv('<path d="M4 20h4l10-10-4-4L4 16z"/><path d="m13 7 4 4"/>'),
    plusCircle: sv('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
    eyeOff: sv('<path d="M3 10c2.5 3 5.5 4.5 9 4.5s6.5-1.5 9-4.5"/><path d="m6 13-1.5 2M10 14.3 9.5 17M14 14.3l.5 2.7M18 13l1.5 2"/>'),
    eye: sv('<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.8"/>'),
    info: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 10.5v6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.3" r="1.3" fill="#fff"/></svg>`,
    play: sv('<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5z"/>'),
    stopC: sv('<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx=".5" fill="currentColor" stroke="none"/>'),
    xFill: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m8.5 8.5 7 7m0-7-7 7" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>`,
    okFill: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m7.5 12.5 3 3 6-6.5" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    warnFill: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 7v6.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.3" fill="#fff"/></svg>`,
    question: sv('<circle cx="12" cy="12" r="9"/><path d="M9.7 9.6a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.4v.5"/><circle cx="12" cy="16.6" r=".5" fill="currentColor"/>'),
    clock: sv('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    loading: sv('<path d="M12 3a9 9 0 1 0 9 9" />', '0 0 24 24', 'class="spin"'),
    cpu: sv('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>'),
    mem: sv('<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 10v4M11 10v4M15 10v4M7 17v2M12 17v2M17 17v2"/>'),
    gpu: sv('<rect x="3" y="6" width="18" height="12" rx="1.5"/><circle cx="14" cy="12" r="2.6"/><path d="M6.5 10h3M6.5 14h3"/>'),
    /* 侧栏图标 */
    m_grid: sv('<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>'),
    m_data: sv('<circle cx="12" cy="12" r="9"/><path d="M7.5 10h9l-2.5-2.5M16.5 14h-9l2.5 2.5"/>'),
    m_dev: sv('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m10.5 9-3 3 3 3M13.5 9l3 3-3 3"/>'),
    m_llm: sv('<circle cx="12" cy="12" r="9"/><path d="m12 6.5 5 2.8v5.4L12 17.5l-5-2.8V9.3z"/><path d="M7 9.3l5 2.8 5-2.8M12 12.1v5.4"/>'),
    m_train: sv('<circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="8.5" r="2"/><path d="M7 7.5v9M17 10.5c0 4-10 2-10 6"/>'),
    m_model: sv('<circle cx="8" cy="15.5" r="3.6"/><circle cx="16" cy="15.5" r="3.6"/><circle cx="12" cy="8" r="3.6"/>'),
    m_service: sv('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M8.5 15.5l7-7"/>'),
    m_market: sv('<circle cx="12" cy="5" r="2"/><circle cx="5.5" cy="18" r="2"/><circle cx="18.5" cy="18" r="2"/><path d="m11 6.8-4.5 9.4M13 6.8l4.5 9.4M7.5 18h9"/>'),
    m_res: sv('<circle cx="12" cy="12" r="9"/><path d="M9.3 9.5a2.8 2.8 0 1 1 3.6 2.7c-.6.2-.9.7-.9 1.3M12 16.4v.2"/>'),
    m_global: sv('<circle cx="12" cy="12" r="3"/><path d="M12 3.5l1.6 2.3 2.8-.5.7 2.7 2.6 1.1-.9 2.7 1.7 2.2-2.2 1.7.4 2.8-2.8.4-1.1 2.6-2.6-1-2.4 1.5-1.4-2.4-2.8-.2.1-2.8L3.5 13l1.4-2.4-1.2-2.6 2.7-.9.4-2.8 2.8.4z"/>'),
  };

  /* 状态标签 */
  const ST = {
    running: ['运行中', 'ok', 'play'], pending: ['资源准备中', 'info', 'loading'], stopped: ['已停止', 'mute', 'stopC'],
    idle: ['未运行', 'mute', 'question'], queued: ['排队中', 'info', 'clock'], failed: ['失败', 'err', 'xFill'], success: ['成功', 'ok', 'okFill'],
    unused: ['未使用', 'info', 'clock'], inuse: ['进行中', 'ok', 'play'],
  };
  const status = k => { const s = ST[k] || [k, 'mute', 'question']; return `<span class="st st-${s[1]}">${I[s[2]]}${s[0]}</span>`; };

  /* 消息提示 */
  function toast(msg, type = 'success') {
    let box = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.innerHTML = (type === 'error' ? I.xFill : type === 'warning' ? I.warnFill : type === 'info' ? I.info : I.okFill) + `<span>${esc(msg)}</span>`;
    box.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3000);
  }

  /* 对话框 */
  function dialog({ title, width = 600, body, okText = '确定', cancelText = '取消', onOk, footer = true, cls = '' }) {
    const wrap = document.createElement('div');
    wrap.className = 'mask';
    wrap.innerHTML = `<div class="dialog ${cls}" style="width:${width}px">
      <div class="dlg-hd"><span>${esc(title)}</span><button class="dlg-x" data-x>${I.close}</button></div>
      <div class="dlg-bd">${body}</div>
      ${footer ? `<div class="dlg-ft"><button class="btn" data-x>${cancelText}</button><button class="btn btn-primary" data-ok>${okText}</button></div>` : ''}
    </div>`;
    document.getElementById('layers').appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('click', e => {
      if (e.target.closest('[data-x]')) close();
      else if (e.target.closest('[data-ok]')) { if (!onOk || onOk(wrap.querySelector('.dialog')) !== false) close(); }
    });
    const first = wrap.querySelector('input:not([disabled]):not([type=radio]),textarea');
    if (first) setTimeout(() => first.focus(), 30);
    return { el: wrap.querySelector('.dialog'), close };
  }
  function confirm(msg, onOk, title = '提示') {
    dialog({ title, width: 420, cls: 'dlg-confirm', body: `<div class="confirm-body">${I.warnFill}<span>${esc(msg)}</span></div>`, onOk: () => { onOk(); } });
  }

  /* 下拉菜单（更多▾ 等） */
  let ddEl = null;
  function closeDD() { if (ddEl) { ddEl.remove(); ddEl = null; } }
  function dropdown(anchor, items, onPick) {
    closeDD();
    const r = anchor.getBoundingClientRect();
    ddEl = document.createElement('div');
    ddEl.className = 'dd';
    ddEl.innerHTML = items.map((it, i) => it.html ? it.html : `<div class="dd-it ${it.disabled ? 'dis' : ''} ${it.danger ? 'danger' : ''}" data-i="${i}">${esc(it.label)}</div>`).join('');
    document.body.appendChild(ddEl);
    const w = ddEl.offsetWidth;
    ddEl.style.top = (r.bottom + 6) + 'px';
    ddEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    ddEl.addEventListener('click', e => {
      const it = e.target.closest('.dd-it'); if (!it || it.classList.contains('dis')) return;
      const item = items[+it.dataset.i]; closeDD(); onPick && onPick(item);
    });
    setTimeout(() => document.addEventListener('click', function h(e) { if (ddEl && !ddEl.contains(e.target)) { closeDD(); } document.removeEventListener('click', h); }), 0);
    return ddEl;
  }

  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
  const empty = (cols, text = '暂无数据') => `<tr class="empty"><td colspan="${cols}"><div class="empty-box">${text}</div></td></tr>`;
  function pager(total) {
    return `<div class="pager"><span>共 ${total} 条</span><button class="pg-arrow" disabled>${I.left}</button><span class="pg-num">1</span><button class="pg-arrow" disabled>${I.right}</button>
      <select class="pg-size">${opt(10, '10条/页')}${opt(20, '20条/页')}${opt(50, '50条/页')}</select>
      <span>前往</span><input class="pg-go" value=""><span>页</span></div>`;
  }
  function formVal(el) {
    const o = {};
    el.querySelectorAll('[name]').forEach(f => {
      if (f.type === 'radio') { if (f.checked) o[f.name] = f.value; }
      else if (f.type === 'checkbox') o[f.name] = f.checked;
      else o[f.name] = f.value.trim();
    });
    return o;
  }
  function fieldErr(dlg, name, msg) {
    const f = dlg.querySelector(`[name="${name}"]`); if (!f) return;
    const item = f.closest('.fi'); item.classList.add('has-err');
    let e = item.querySelector('.fi-err'); if (!e) { e = document.createElement('div'); e.className = 'fi-err'; item.querySelector('.fi-ctl').appendChild(e); }
    e.textContent = msg;
  }
  function clearErr(dlg) { dlg.querySelectorAll('.has-err').forEach(x => x.classList.remove('has-err')); dlg.querySelectorAll('.fi-err').forEach(x => x.remove()); }

  return { esc, I, status, toast, dialog, confirm, dropdown, closeDD, opt, empty, pager, formVal, fieldErr, clearErr };
})();
