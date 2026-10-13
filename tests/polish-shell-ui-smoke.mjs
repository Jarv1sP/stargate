// Render real Portal assets, fonts, CSP and public guide on loopback. Account
// and node replies are synthetic. This never accesses production or executes
// a host command. --full-scan retains every width/height/zoom result.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {seedLegacy, password} from './maintenance-fixture.mjs';
import {openMaintenance} from './admin-maintenance-workflows.mjs';
import {guardedRoute} from './browser-route-guard.mjs';
import {layoutReadOperations,layoutReadReply} from './layout-read-fixtures.mjs';
import {inspectGeometry, scanGeometry, layoutZooms, layoutWidths, layoutHeights} from './layout-geometry.mjs';

const full = process.argv.includes('--full-scan');
const before = process.argv.includes('--before');
const selected = process.env.POLISH_CASES?.split(',');
const output = process.env.UI_SCREENSHOTS || '/tmp/stargate-polish-shell';
const reportPath = process.env.POLISH_GEOMETRY_REPORT || join(output, before ? 'geometry-before.json' : 'geometry-after.json');
const temporary = await mkdtemp(join(tmpdir(), 'stargate-polish-shell-'));
const errors = [], outside = [], results = [];
const inventory = process.env.POLISH_INVENTORY ? JSON.parse(await readFile(process.env.POLISH_INVENTORY, 'utf8')) :
  MACHINES.map((machine, index) => ({...machine, id: 'compute-layout-' + (index + 1) + '-long-id'}));
assert.ok(Array.isArray(inventory) && inventory.length === MACHINES.length);
const selectedMachine = inventory.reduce((longest, machine) => machine.id.length > longest.id.length ? machine : longest).id;
const names = new Map(MACHINES.map((machine, index) => [machine.id, inventory[index].id]));
const remap = value => Array.isArray(value) ? value.map(remap) : value && typeof value === 'object' ?
  Object.fromEntries(Object.entries(value).map(([key, child]) => [names.get(key) || key, remap(child)])) : names.get(value) || value;
const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const origin = 'http://127.0.0.1:' + port;
let server, service, browser;
const chapters = ['start', 'development', 'training', 'data', 'results', 'queue', 'troubleshooting'];
const shellSpec = {
  roots: ['#app-topbar', '#shell-context'],
  controls: 'button,select,summary,a[href]',
  leftEdges: [['#app-topbar .brand', '.page-heading', '#shell-context>label:first-child']],
  centers: [{parent: '#app-topbar .topbar-right', children: ':scope > *'},
    {parent: '#shell-context > label', children: ':scope > select'}],
  buttonRows: [{parent: '#app-topbar .topbar-right', children: ':scope > button,:scope > a,:scope > details > summary'}],
  popovers: ['.account-popover'],
  bottomReserve: [{content: '#main-content', controls: '#room-nav,#control-strip,#mobile-control'}],
};
const authSpec = id => ({
  roots: ['#' + id],
  leftEdges: [['#' + id + ' .modal-head', '#' + id + ' form > .field', '#' + id + ' .modal-actions']],
  centers: [{parent: '#' + id + ' .field-caption', children: ':scope > *'},
    {parent: '#' + id + ' .modal-head', children: ':scope > *'}],
  helpRows: ['#' + id + ' .field-caption'],
  helpContexts: ['#' + id + ' [data-copy-help]'],
  buttonRows: [{parent: '#' + id + ' .modal-actions'}],
  repeatedGaps: ['#' + id + ' .field-caption'],
  popovers: ['.copy-help-popup:popover-open'],
  scrollPanels: ['#' + id],
});
const maintenanceSpec = {
  ...shellSpec, roots: [...shellSpec.roots, '#maintenance-experience', '#operational-maintenance', '#admin-content'],
  controls: 'button,input:not([type=checkbox]),select,summary,a[href],.maintenance-select',
  leftEdges: [...shellSpec.leftEdges, ['.maintenance-console-heading', '.maintenance-console-rows', '.maintenance-recovery-bar'],
    ['.maintenance-hero .maintenance-eyebrow', '.maintenance-hero h2', '.maintenance-hero .maintenance-reason', '.maintenance-since']],
  centers: [{parent: '.maintenance-title-row', children: ':scope > *', wrap: true}],
  helpRows: ['.maintenance-reason-field .field-caption', '.maintenance-console-heading h2', '.maintenance-permissions h3'],
  helpContexts: ['.maintenance-permissions [data-maintenance-info]', '.maintenance-settings [data-maintenance-info]'],
  buttonRows: [{parent: '.maintenance-server-actions'}, {parent: '.maintenance-recovery-bar > div'}],
  repeatedPadding: ['.maintenance-server-row'],
  tableColumns: [{rows: '.maintenance-server-row', cells: ':scope > *'}],
  popovers: [...shellSpec.popovers, '.maintenance-info.is-open > .maintenance-info-body'],
};
const maintenanceSettingsSpec = {
  roots: ['#maintenance-settings-dialog'],
  controls: 'button,input,select',
  leftEdges: [['#maintenance-settings-dialog .modal-head', '#maintenance-settings-dialog form']],
  helpRows: ['#maintenance-settings-dialog .copy-caption', '#maintenance-settings-dialog .field-caption'],
  helpContexts: ['#maintenance-settings-dialog [data-copy-help]'],
  buttonRows: [{parent: '#maintenance-settings-dialog form>div:not(.maintenance-reason-field)'}],
  scrollPanels: ['#maintenance-settings-dialog'],
};
const guideSpec = {
  roots: ['body'],
  leftEdges: [['.guide-brand', '.guide-hero,.guide-layout', '.guide-footer>:first-child'],
    ['.guide-article>header', '.guide-prose', '.guide-pagination']],
  baselines: [{parent: '.guide-code-bar', children: ':scope>span,:scope>button', wrap: true}],
  buttonRows: [{parent: '.guide-code-bar', children: 'button'}],
  repeatedPadding: ['.guide-card'], repeatedGaps: ['.guide-card'],
  scrollPanels: [],
};

const scenes = [
  ...['login', 'login-error', 'login-loading', 'login-maintenance', 'register', 'register-error', 'register-maintenance', 'register-help']
    .map(name => ({room: 'auth', name, spec: authSpec(name.startsWith('register') ? 'register-dialog' : 'login-dialog')})),
  ...['member', 'admin'].flatMap(role => [
    ...['normal', 'loading', 'error', 'unknown'].map(state => ({room: 'shell', name: role + '-' + state, role, state, spec: shellSpec})),
    {room: 'account', name: role + '-menu', role, view: 'menu', spec: shellSpec},
    {room: 'account', name: role + '-profile', role, view: 'profile', spec: authSpec('profile-dialog')},
    {room: 'account', name: role + '-profile-error', role, view: 'profile-error', spec: authSpec('profile-dialog')},
    ...['normal', 'empty', 'loading', 'error', 'unknown', 'detail'].map(state => ({room: 'maintenance-history', name: role + '-' + state, role, state,
      spec: {...shellSpec, roots: [...shellSpec.roots, '#page-maintenance'], controls: undefined,
        helpRows: ['.maintenance-toolbar .copy-caption'], repeatedPadding: ['.maintenance-row'],
        repeatedRowHeights: ['.maintenance-row']}})),
  ]),
  {room: 'maintenance', name: 'member-global', role: 'member', maintained: true, spec: maintenanceSpec},
  ...['normal', 'unknown', 'start', 'checks', 'recovery', 'settings'].map(view => ({room: 'maintenance', name: 'admin-' + view,
    role: 'admin', maintained: true, view,
    spec: ['start', 'checks', 'recovery'].includes(view) ? {...authSpec('maintenance-console-dialog'), leftEdges: [],
      helpRows: ['.maintenance-reason-field .field-caption'], repeatedGaps: [], unbrokenTitles: ['#maintenance-dialog-title']} : maintenanceSpec})),
  ...['overview', ...chapters].map(view => ({room: 'guide', name: view, view, spec: guideSpec})),
  {room: 'guide', name: 'reduced-motion', view: 'training', reduced: true, spec: guideSpec},
  {room: 'guide', name: 'copy-error', view: 'training', copyError: true, spec: guideSpec},
  {room: 'auth', name: 'login-reduced', reduced: true, spec: authSpec('login-dialog')},
  {room: 'auth', name: 'register-reduced', reduced: true, spec: authSpec('register-dialog')},
  {room: 'account', name: 'member-profile-reduced', role: 'member', view: 'profile', reduced: true, spec: authSpec('profile-dialog')},
  {room: 'shell', name: 'member-shell-reduced', role: 'member', reduced: true, spec: shellSpec},
  {room: 'maintenance-history', name: 'member-history-reduced', role: 'member', state: 'normal', reduced: true,
    spec: {...shellSpec, roots: [...shellSpec.roots, '#page-maintenance'], controls: undefined}},
  {room: 'maintenance', name: 'member-global-reduced', role: 'member', maintained: true, reduced: true, spec: maintenanceSpec},
];

try {
  const bootstrap = join(temporary, 'bootstrap'), statusPath = join(temporary, 'status');
  await writeFile(bootstrap, JSON.stringify({username: 'admin', password}), {mode: 0o600});
  await writeFile(statusPath, JSON.stringify({version: 1, checkedAt: new Date().toISOString(), hosts: MACHINES.map(machine => ({id: machine.id,
    checkedAt: new Date().toISOString(), reachable: true, hostCommand: {version: 1, available: true}, gpus: [], gpuq: {connected: true, jobs: []}}))}));
  ({server, service} = await createPortalServer({database: join(temporary, 'db'), bootstrap, statusPath, origin, secure: false,
    bridge: async (_, operation) => {throw Error('Geometry fixture must not execute a node operation: ' + operation);}}));
  clearInterval(service.executionTimer); await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const admin = await service.login('admin', password);
  const member = (await service.invoke(admin.token, 'users.create', {username: 'layout-member', name: '很长的账户显示姓名用于验证窄窗口与控制按钮', password})).result;
  await service.invoke(admin.token, 'policy.full', {userId: member.id, policyVersion: 0});
  service.store.users.find(user => user.username === 'admin').name = '很长的管理员显示姓名用于验证窄窗口';
  const history = ['PENDING', 'SUCCEEDED', 'UNKNOWN'].map((state, index) => seedLegacy(service, member, {state, title: '维护记录 · ' + (index + 1)}));
  const principals = {admin: admin.principal, member: {username: member.username, role: 'member', userId: member.id}};
  browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});

  // Prove the reusable helper rejects known geometry defects, rather than
  // merely reflecting the component's implementation.
  const probe = await browser.newPage({viewport: {width: 320, height: 700}});
  await probe.setContent('<main><h2>Title</h2><button style="height:20px">short</button><label style="display:block;margin-left:8px">Label</label><div style="width:500px">overflow</div></main>');
  const invalid = await inspectGeometry(probe, {leftEdges: [['h2', 'label']]});
  assert.ok(['touch-height', 'left-edge', 'horizontal-scroll'].every(rule => invalid.failures.some(failure => failure.rule === rule)));
  await probe.setContent('<main><div style="overflow:hidden;width:30px"><input style="width:100px" /></div>' +
    '<button data-copy-help>help</button><table><tr><td class="number">12</td></tr></table>' +
    '<div class="line" style="display:flex;align-items:center"><span style="font-size:12px">Small</span><span style="font-size:24px">Large</span></div>' +
    '<div class="panel" style="height:20px;overflow:hidden"><p>line</p><p>line</p></div></main>');
  const clipped = await inspectGeometry(probe, {helpContexts: ['[data-copy-help]'], numericCells: ['.number'],
    baselines: [{parent: '.line', children: 'span'}], scrollPanels: ['.panel']});
  assert.ok(['container-clipping', 'orphan-help', 'numeric-alignment', 'text-baseline', 'unreachable-panel-content']
    .every(rule => clipped.failures.some(failure => failure.rule === rule)), JSON.stringify(clipped.failures));
  await probe.setContent('<h2 style="width:32px;font-size:16px;word-break:break-all">恢复前检查</h2>');
  const broken = await inspectGeometry(probe, {unbrokenTitles: ['h2']});
  assert.ok(broken.failures.some(failure => failure.rule === 'title-word-wrap'), 'detect a title split inside a word');
  await probe.close();

  for (const scene of scenes.filter(scene => !selected || selected.includes(scene.name) || selected.includes(scene.room))) {
    for (const zoom of full ? layoutZooms : [1]) {
      const context = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: zoom,
        reducedMotion: scene.reduced ? 'reduce' : 'no-preference'});
      const page = await context.newPage();
      const principal = principals[scene.role];
      const state = principal ? remap(service.state(principal)) : null;
      if (state) {
        state.machines = structuredClone(inventory); state.jobs = [];
        state.gpuq.stale = false;
        if (scene.maintained) state.operationalMaintenance = {version: 1, revision: 9, global: {
          reason: '存储维护与节点检查；已有训练继续运行', since: new Date(Date.now() - 3600000).toISOString()}, machines: {}};
        if (scene.state === 'unknown' || scene.view === 'unknown') {
          state.gpuq.stale = true; state.gpuq.checkedAt = null;
          for (const host of state.gpuq.hosts) {host.reachable = null; host.checkedAt = null; host.gpuq.connected = false;}
        }
      }
      const gates = []; let logged = false;
      const json = async (route, result, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(result)});
      const pause = () => new Promise(resolve => gates.push(resolve));
      page.on('pageerror', error => errors.push({scene: scene.name, error: error.message}));
      await context.route('**/*', guardedRoute(async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin && !['data:', 'blob:'].includes(url.protocol)) {outside.push(url.href); await route.abort(); return;}
        if (url.pathname === '/machines.js') {await route.fulfill({contentType: 'text/javascript', body: 'export const MACHINES=' + JSON.stringify(inventory) + ';'}); return;}
        if (url.pathname === '/' && scene.name.endsWith('maintenance')) {
          const response = await route.fetch(); let body = await response.text();
          body = body.replaceAll('<p class="auth-maintenance" data-public-maintenance hidden role="status"></p>',
            '<p class="auth-maintenance" data-public-maintenance role="status">平台维护中，暂时停止新操作</p>');
          await route.fulfill({response, body}); return;
        }
        if (url.pathname === '/api/login') {
          if (scene.name === 'login-loading') await pause();
          if (!principal) {await json(route, {error: '用户名或密码错误，请核对后重试'}, 401); return;}
          logged = true; await json(route, {principal, state}); return;
        }
        if (url.pathname === '/api/register') {await json(route, {error: '注册码未确认，请联系管理员'}, 400); return;}
        if (url.pathname === '/api/call') {
          const {operation, args} = route.request().postDataJSON();
          if (operation === 'state') {
            if (logged && scene.state === 'loading' && scene.room === 'shell') await pause();
            if (scene.state === 'error' && scene.room === 'shell') {await json(route, {error: '状态暂时无法获取'}, 503); return;}
            await json(route, {state}); return;
          }
          if (operation === 'profile.update') {assert.equal(scene.view, 'profile-error'); await json(route, {error: '姓名保存未确认，请稍后重试'}, 503); return;}
          let result;
          if (operation === 'maintenance.list') {
            if (scene.state === 'loading') await pause();
            if (scene.state === 'error') {await json(route, {error: '历史记录暂时无法获取'}, 503); return;}
            result = {items: scene.state === 'empty' ? [] : history.map((row, index) => ({id: row.id,
              title: '维护记录 · ' + (index + 1), machine: inventory[0].id, state: scene.state === 'unknown' ? 'UNKNOWN' : ['PENDING', 'SUCCEEDED', 'UNKNOWN'][index]}))};
          } else if (operation === 'maintenance.get') result = {id: args.id, title: '维护记录 · 1', machine: inventory[0].id,
            owner: {username: member.username}, state: 'UNKNOWN', reason: '历史维护记录', cwd: '/workspace', timeoutSec: 300,
            scriptSha256: 'a'.repeat(64), script: 'printf "read-only historical output"\n'.repeat(30)};
          else if (operation === 'maintenance.status') result = state.operationalMaintenance;
          else if (operation === 'workshop.mine') {assert.equal(logged,true);assert.ok(principal);assert.deepEqual(args,{});result={installed:[]};}
          else if (operation === 'projects.list') result = {projects: []};
          else if (operation === 'projects.quota') result = {usedBytes: 0, quotaBytes: 1024 ** 3};
          else if (operation === 'datasets.list') result = {datasets: []};
          else if (operation === 'datasets.overview') result={protocol:0};
          else if (operation === 'datasets.catalog') result = {machine: args.machine, machines: inventory.map(row => ({machine: row.id, state: 'ok'})), datasets: []};
          else if (operation === 'datasets.capacity') result = {machine: args.machine, available: false};
          else if (operation === 'transfers.capabilities') result = {enabled: false};
          else if (operation === 'transfers.list') {
            assert.deepEqual(args, args.limit === undefined ? {cursor: 0} : {cursor: 0, limit: 50},
              'the empty fixture permits only initial owner-scoped reads, not identity overrides or pagination');
            result = {transfers: [], nextCursor: null};
          }
          else if (operation === 'notifications.list') result = {items: []};
          else if (operation === 'logout') result = {loggedOut: true};
          else if (layoutReadOperations.has(operation)) result = layoutReadReply(operation,args,{principal,state});
          else throw Error('Unexpected geometry fixture API: ' + operation);
          await json(route, {result, state}); return;
        }
        await route.continue();
      }));
      try {
        if (scene.room === 'guide') {
          await page.goto(origin + '/guide' + (scene.view === 'overview' ? '' : '/' + scene.view));
          assert.equal(await page.locator('h1').count(), 1);
          if (scene.copyError) {await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {value: {writeText: async () => {throw Error('fixture clipboard denied');}}}));
            await page.locator('.copy-code').first().click(); await page.getByText('已选中，请复制', {exact: true}).first().waitFor();}
        } else {
          await page.goto(origin); await page.locator('#login-dialog').waitFor({state: 'visible'});
          if (scene.role) {
            await page.locator('#login-form [name=username]').fill(principal.username);
            await page.locator('#login-form [name=password]').fill(password);
            await page.locator('#login-form [type=submit]').click(); await page.locator('#login-dialog').waitFor({state: 'hidden'});
            if (scene.room !== 'maintenance-history') {
              await page.locator('[name=workspace-machine]').selectOption(selectedMachine);
              await page.waitForFunction(id => document.querySelector('#context-machine')?.value === id, selectedMachine);
            }
            if (scene.room === 'maintenance-history') {await page.goto(origin + '/#maintenance'); await page.locator('#maintenance-list').waitFor({state: 'attached'});
              if (!['empty', 'loading', 'error'].includes(scene.state)) await page.locator('#maintenance-list .maintenance-row').first().waitFor();
              if (scene.state === 'error') await page.locator('#maintenance-list-error').filter({hasText: '无法获取'}).waitFor();
              if (scene.state === 'detail') {await page.locator('.maintenance-row').first().click(); await page.locator('#maintenance-detail pre').waitFor();}}
            if (scene.view === 'menu' || scene.view?.startsWith('profile')) {
              await page.locator('#account-menu-toggle').click();
              if (scene.view.startsWith('profile')) {await page.locator('#edit-profile').click(); await page.locator('#profile-dialog').waitFor();
                if (scene.view === 'profile-error') {await page.locator('#profile-form [type=submit]').click(); await page.locator('#profile-error').filter({hasText: '未确认'}).waitFor();}}
            }
            if (scene.room === 'shell' && ['loading', 'error'].includes(scene.state)) {
              await page.locator('#refresh-state').click(); await page.locator('#sync-label').filter({hasText: scene.state === 'loading' ? '同步' : '失败'}).waitFor();}
            if (scene.maintained) {
              await page.locator('#operational-maintenance .maintenance-banner').waitFor();
              if (scene.role === 'admin') await openMaintenance(page);
              if (scene.view === 'start') await page.locator('[data-maintenance-start="all"]').click();
              if (scene.view === 'checks') await page.locator('[data-maintenance-check]').first().click();
              if (scene.view === 'recovery') {await page.locator('[data-recovery-select]').first().check(); await page.locator('[data-maintenance-stage]').click();}
              if (scene.view === 'settings') {
                // Retain every original background rule before the native
                // modal makes that background unavailable for interaction.
                const background = await scanGeometry(page, scene.spec, {zoom, widths: full ? layoutWidths : [320, 390, 1440], heights: full ? layoutHeights : [900]});
                results.push({room: scene.room, scene: scene.name + '-before-open', zoom, measurements: background});
                await page.locator('[data-maintenance-settings]').click();
              }
            }
          } else if (scene.name.startsWith('register')) {
            await page.locator('#open-register').click(); await page.locator('#register-dialog').waitFor();
            if (scene.name === 'register-error') {
              for (const [name, value] of [['invite', 'fixture'], ['username', 'new-member'], ['password', password], ['confirm', password]])
                await page.locator('#register-form [name="' + name + '"]').fill(value);
              await page.locator('#register-form [type=submit]').click(); await page.locator('#register-error').filter({hasText: '未确认'}).waitFor();
            }
            if (scene.name === 'register-help') await page.locator('#register-dialog [data-copy-help]').first().click();
          } else if (['login-error', 'login-loading'].includes(scene.name)) {
            await page.locator('#login-form [name=username]').fill('invalid'); await page.locator('#login-form [name=password]').fill(password);
            await page.locator('#login-form [type=submit]').click();
            if (scene.name === 'login-error') await page.locator('#login-error').filter({hasText: '错误'}).waitFor();
          }
        }
        await page.evaluate(() => document.fonts.ready);
        if (!before && scene.room !== 'guide') {
          assert.equal(await page.locator('a.guide-link[href="/guide"]').count(), 1, 'one guide entry is moved between auth and shell');
          assert.equal(await page.locator('a.guide-link svg').count(), 1, 'one external-link icon');
          assert.ok(['none', 'normal'].includes(await page.locator('a.guide-link').evaluate(node => getComputedStyle(node, '::after').content)), 'no duplicate generated arrow');
          assert.equal(await page.locator('#refresh-state .sync-mark svg').count(), 1, 'refresh has its own circular-arrow icon');
          assert.equal(await page.locator('#refresh-state').getAttribute('aria-label'), '刷新已确认的状态');
          assert.equal(await page.locator('a.guide-link').getAttribute('aria-label'), '使用指南');
        }
        if (!before && scene.view === 'checks') {
          assert.equal(await page.locator('#maintenance-dialog-title').textContent(), '恢复前检查');
          assert.equal(await page.locator('.maintenance-object-title>.server-id').textContent(), inventory[0].id);
        }
        const directory = join(output, scene.room, before ? 'before' : 'after'); await mkdir(directory, {recursive: true});
        if (zoom === 1) for (const width of [1440, 390, 320]) {
          await page.setViewportSize({width, height: width < 760 ? 900 : 1000});
          if (!before && scene.room !== 'guide') assert.ok(['none', 'normal'].includes(
            await page.locator('a.guide-link').evaluate(node => getComputedStyle(node, '::after').content)),
            'no duplicate guide arrow at ' + width + 'px');
          await page.evaluate(() => {for (const animation of document.getAnimations()) if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();});
          await page.screenshot({path: join(directory, scene.name + '-' + width + '.png'), fullPage: scene.room === 'guide'});
        }
        const measurements = await scanGeometry(page, scene.view === 'settings' ? maintenanceSettingsSpec : scene.spec, {zoom, widths: full ? layoutWidths : [320, 390, 1440], heights: full ? layoutHeights : [900]});
        results.push({room: scene.room, scene: scene.name, zoom, measurements});
        await writeFile(reportPath, JSON.stringify({partial: true, before, full, scenes: results}, null, 2));
        console.log(scene.room + '/' + scene.name + ' zoom=' + zoom + ': ' + measurements.filter(row => row.pass).length + '/' + measurements.length);
      } finally {
        gates.splice(0).forEach(resolve => resolve());
        await context.unrouteAll({behavior: 'wait'}); await context.close();
      }
    }
  }
  const violations = results.flatMap(scene => scene.measurements.filter(row => !row.pass).map(row => ({scene: scene.scene, room: scene.room, ...row})));
  const report = {before, full, widths: full ? layoutWidths : [320, 390, 1440], heights: full ? layoutHeights : [900],
    zooms: full ? layoutZooms : [1], scenes: results, violations, pageErrors: errors, outside};
  await mkdir(output, {recursive: true}); await writeFile(reportPath, JSON.stringify(report, null, 2));
  assert.deepEqual(outside, [], 'no external requests'); assert.deepEqual(errors, [], 'no browser exceptions');
  if (!before) assert.equal(violations.length, 0, violations.length + ' geometry failures; see geometry-after.json');
  console.log('POLISH shell/auth/guide/maintenance: ' + (before ? 'baseline recorded' : 'PASS'));
} finally {
  await browser?.close(); server?.closeAllConnections?.();
  if (server) await new Promise(resolve => server.close(resolve)); if (service && !service.closing) service.close(); await rm(temporary, {recursive: true, force: true});
}
