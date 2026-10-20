/* Original console landing structure; data comes only from the current platform. */
window.CeakeHome = (() => {
  function isoIll() {
    const P = (x, y, z) => [100 + (x - y) * .866, 36 + (x + y) * .5 - z];
    const pt = a => a.map(v => v.toFixed(1)).join(',');
    const poly = (pts, fill, extra = '') => `<polygon points="${pts.map(pt).join(' ')}" fill="${fill}" stroke="#cfdcf6" stroke-width=".6" stroke-linejoin="round" ${extra}/>`;
    const box = (x, y, z, w, d, h, c = ['#f5f9ff', '#dde8fb', '#e9f1fe']) =>
      poly([P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)], c[0]) +
      poly([P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)], c[1]) +
      poly([P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)], c[2]);
    const slots = (x, y, z, w, d, h) => [0.3, 0.5, 0.7].map(f => { const a = P(x + 3, y + d, z + h * f), b = P(x + w - 3, y + d, z + h * f); return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#cfdcf6" stroke-width=".8"/>`; }).join('');
    const bot = u => P(8 + 80 * u, 72, 8), top = u => P(8 + 80 * u, 60, 40);
    const B = (u, v) => { const a = bot(u), b = top(u); return [a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v]; };
    const wave = []; for (let i = 0; i <= 24; i++) { const u = .06 + .62 * i / 24; wave.push(B(u, .12 + .42 * Math.pow(Math.sin(i / 24 * Math.PI * 1.6 + .3), 2) * (0.55 + 0.45 * i / 24))); }
    const area = [B(.06, .04), ...wave, B(.68, .04)];
    const ticks = [.74, .78, .82, .86].map((u, i) => { const a = B(u, .06), b = B(u, .2 + .1 * ((i * 7) % 3)); return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#8fb3f5" stroke-width="1.2"/>`; }).join('');
    const tl = P(8, 60, 40), tr = P(88, 60, 40);
    return `<svg class="dash-ill" viewBox="0 0 200 150"><defs><linearGradient id="ilg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f7ff0"/><stop offset="1" stop-color="#b9d2fb"/></linearGradient></defs>
      <g opacity=".92">${box(0, 0, 0, 112, 100, 2, ['#f3f7fe', '#e2ebfb', '#eaf1fd'])}
      ${box(16, 6, 2, 20, 20, 34)}${slots(16, 6, 2, 20, 20, 34)}${box(54, -6, 2, 22, 22, 50)}${slots(54, -6, 2, 22, 22, 50)}
      ${box(4, 62, 2, 88, 18, 5, ['#ffffff', '#e4edfc', '#eef4fe'])}
      ${poly([bot(0), bot(1), top(1), top(0)], '#fbfdff')}
      ${poly(area, 'url(#ilg)', 'stroke="none"')}${ticks}
      <line x1="${tl[0]}" y1="${tl[1]}" x2="${tr[0]}" y2="${tr[1]}" stroke="#5b8ff2" stroke-width="3.2" stroke-linecap="round"/>
      ${box(-14, 84, 2, 10, 8, 4)}<ellipse cx="${P(-4, 106, 2)[0]}" cy="${P(-4, 106, 2)[1]}" rx="7" ry="3.6" fill="#e3ecfb"/></g></svg>`;
  }

  function side(open,I){
    const groups=[['容器',[['工作负载','projects'],['服务','notebooks'],['配置','projects']]],['镜像仓库',[['镜像列表','images']]],['应用商店',[['应用模板','overview']]],['系统',[['用户管理','admin'],['操作日志','admin']]]];
    return `<aside class="cside"><a class="cs-it act" data-route="console-home">主页</a>${groups.map(([name,items])=>`<div class="cs-it cs-grp" data-action="console-toggle" data-group-name="${name}">${name}<span class="chev">${open.get(name)?I.up:I.down}</span></div>${open.get(name)?items.map(([label,route])=>`<a class="cs-sub" ${route==='admin'?'data-action="native-page" data-view="admin"':`data-route="${route}"`}>${label}</a>`).join(''):''}`).join('')}</aside>`;
  }
  function render(state,esc,I){
    const machines=state.resources.machines,jobs=state.jobs,gpus=machines.flatMap(m=>m.gpus),knownCards=machines.every(m=>Number.isFinite(m.cards)),cards=knownCards?machines.reduce((n,m)=>n+m.cards,0):'未知';
    const allObserved=machines.length&&machines.every(m=>m.reachable===true&&m.gpus.length===m.cards);
    const knownUtil=allObserved&&gpus.length&&gpus.every(g=>Number.isFinite(g.utilization)),util=knownUtil?(gpus.reduce((n,g)=>n+g.utilization,0)/gpus.length).toFixed(1)+'%':'未知';
    const knownMem=allObserved&&gpus.length&&gpus.every(g=>Number.isFinite(g.memoryUsedMiB)&&Number.isFinite(g.memoryTotalMiB));
    const used=knownMem?(gpus.reduce((n,g)=>n+g.memoryUsedMiB,0)/1024).toFixed(1)+' GiB':'未知',total=knownMem?(gpus.reduce((n,g)=>n+g.memoryTotalMiB,0)/1024).toFixed(1)+' GiB':'未知';
    return `<div class="card dash"><h3 class="pg-title">概览</h3><div class="dash-row"><div class="dash-info"><h4>集群信息</h4><div class="dash-kv"><div><span>平台</span><b>STARGATE</b></div><div><span>当前账号</span><b>${esc(state.principal.name||state.principal.username)}</b></div><div><span>运行环境</span><b>OCI 容器</b></div><div><span>监控状态</span><b>${state.resources.stale?'待更新':'当前快照'}</b></div></div>${isoIll()}</div><div class="dash-res"><h4>集群资源</h4><div class="tiles">${[['t1',machines.length,'节点'],['t2',cards,'GPU'],['t3',jobs.filter(j=>j.state==='RUNNING').length,'运行中任务'],['t4',jobs.filter(j=>['PENDING','QUEUED'].includes(j.state)).length,'排队任务']].map(([cls,value,label])=>`<div class="tile ${cls}"><i class="dec a"></i><i class="dec b"></i><b>${value}</b><span>${label}</span></div>`).join('')}</div></div></div><div class="mon"><div class="mon-hd"><h4>资源监控</h4><button class="btn btn-line" data-action="resource-native">实时监控</button></div><div class="mon-th"><span>资源</span><span>使用量</span><span class="mon-tl" title="当前工坊接口仅提供监控快照，不提供历史曲线"><i>当前快照</i></span></div>${[['GPU',knownCards?'总量'+cards+'卡':'总量未知',util],['显存','总量'+total,used],['文件系统','总量未知','未知'],['网络传输','','未知']].map(([name,hint,value])=>`<div class="mon-row"><div class="mon-n"><b>${name}</b><span>${hint}</span></div><div class="mon-v">${value}</div><div class="mon-c"><span class="mute" title="历史曲线未提供">—</span></div></div>`).join('')}</div></div>`;
  }
  return {side,render};
})();
