import test from 'node:test';
import assert from 'node:assert/strict';
import {renderWorkshopFrame} from '../workshop-frame.mjs';
import {workshopResources, workshopJobs, workshopThemeCSS} from '../dist/workshop-runtime.js';

const nonce = 'workshop-test-nonce-123456';
const pkg = {kind:'plugin', name:'组件', html:'<div>hello</div>', css:'body{color:white}', script:'window.done=true'};
test('plugin frame is an opaque sandbox, with no network resource or form capability', () => {
  const {html, csp} = renderWorkshopFrame(pkg, {nonce, origin:'https://portal.example'});
  assert.match(csp, /sandbox allow-scripts(?:;|$)/);
  assert.doesNotMatch(csp, /allow-same-origin|unsafe-eval|script-src[^;]*unsafe-inline/);
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'"]) assert.ok(csp.includes(directive));
  assert.match(html, new RegExp(`<script nonce="${nonce}">`));
  assert.doesNotMatch(html, /<div>hello<\/div>/);
  assert.match(html, /event\.ports|channel\.port2/);
});
test('package text cannot close its bootstrap script, style or document tags', () => {
  const hostile = '</script><script src="https://evil.example"></script><base href="https://evil.example"><meta http-equiv="refresh" content="0;url=https://evil.example">';
  const {html} = renderWorkshopFrame({...pkg, html:hostile, css:'</style>'+hostile, script:hostile}, {nonce, origin:'https://portal.example'});
  assert.equal((html.match(/<script /g)||[]).length, 1);
  assert.equal((html.match(/<\/script>/g)||[]).length, 1);
  assert.doesNotMatch(html, /evil\.example/);
});
test('frame input requires a plugin, an exact portal origin and a valid nonce', () => {
  assert.throws(() => renderWorkshopFrame({...pkg, kind:'theme'}, {nonce, origin:'https://portal.example'}));
  for (const origin of ['https://portal.example/path', 'javascript:alert(1)', 'https://portal.example/']) assert.throws(() => renderWorkshopFrame(pkg, {nonce, origin}));
  assert.throws(() => renderWorkshopFrame(pkg, {nonce:'"><script>', origin:'https://portal.example'}));
});
const store = {principal:{userId:'me'},data:{machines:[{id:'gpu',model:'RTX',cards:2,hostname:'SECRET'}],gpuq:{checkedAt:'2026-10-13T00:00:00Z',stale:false,hosts:[{id:'gpu',reachable:true,gpus:[{index:0,model:'RTX',utilization:0,memoryUsedMiB:1,memoryTotalMiB:24,processes:[{command:'SECRET',owner:'other'}]}],gpuq:{jobs:[{command:'SECRET'}]}}]}},jobs:[{id:'mine',userId:'me',name:'训练',machine:'gpu',cards:1,state:'RUNNING',command:'SECRET',progress:{step:3,totalSteps:10,command:'SECRET'}},{id:'theirs',userId:'other',name:'SECRET'}]};
test('read projections reveal metrics and current user jobs, never commands or raw state', () => {
  const resources = workshopResources(store), jobs = workshopJobs(store);
  assert.equal(resources.machines[0].gpus[0].utilization, 0);
  assert.equal(resources.machines[0].gpus[0].temperatureC, null);
  assert.deepEqual(jobs.jobs.map(job=>job.id), ['mine']);
  assert.equal(jobs.jobs[0].progress.step, 3);
  assert.doesNotMatch(JSON.stringify({resources,jobs}), /SECRET|theirs|processes|hostname|userId/);
  const stale = structuredClone(store); stale.data.gpuq.stale=true;
  assert.deepEqual(workshopResources(stale).machines[0].gpus, []);
  assert.equal(workshopResources({data:{}}).stale, true);
  const unknown = structuredClone(store); unknown.data.gpuq.hosts=[];
  assert.equal(workshopResources(unknown).machines[0].reachable, null);
});
test('theme uses whitelisted color tokens and fixed layout values only', () => {
  const css = workshopThemeCSS({tokens:{'--bg':'#123456','--ink':'#ffffffff','--unknown':'#abc','--line':'red;}body{display:none'},width:'wide',density:'compact',columns:2});
  assert.match(css, /--bg:#123456/); assert.match(css,/--ink:#ffffffff/);
  assert.match(css, /--content:1600px/); assert.match(css, /repeat\(2,/);
  assert.doesNotMatch(css, /unknown|display:none|red;/);
  assert.doesNotMatch(css, /machine-grid|resource-detail/);
  assert.equal(workshopThemeCSS(null), '');
});
