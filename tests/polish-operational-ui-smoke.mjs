// Render the real Portal/CSP/fonts with disposable account and node replies.
// Geometry covers operational rooms; no production, shell, or GPU is used.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/machines.js';
import {guardedRoute} from './browser-route-guard.mjs';
import {layoutReadOperations,layoutReadReply} from './layout-read-fixtures.mjs';
import {layoutZooms,layoutWidths,layoutHeights} from './layout-geometry.mjs';
import {inspectOperationalGeometry,scanOperationalGeometry,revealOperationalTarget} from './operational-geometry.mjs';

const full=process.argv.includes('--full-scan'),before=process.argv.includes('--before');
const selected=process.env.POLISH_CASES?.split(',');
const output=process.env.UI_SCREENSHOTS||'/tmp/stargate-polish-operational';
const reportPath=process.env.POLISH_GEOMETRY_REPORT||join(output,before?'geometry-before.json':'geometry-after.json');
const inventory=process.env.POLISH_INVENTORY?JSON.parse(await readFile(process.env.POLISH_INVENTORY,'utf8')):
  MACHINES.map((row,index)=>({...row,id:'training-layout-'+(index+1)+'-long-id'}));
assert.equal(inventory.length,MACHINES.length);
const machine=inventory[0].id,release='a'.repeat(64),project='container-layout';
const temporary=await mkdtemp(join(tmpdir(),'operational-layout-'));
const password='Local-Operational-Layout-2026!',errors=[],outside=[],results=[];
let server,service,browser;
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+reservation.address().port;await new Promise(resolve=>reservation.close(resolve));

const controls='button,input:not([type=checkbox]):not([type=radio]),textarea,select,summary,a[href]';
const roomSpec={
  controls,largeTargets:'[data-control-section],.cstrip .cs-seg',
  bottomReserve:[{content:'#main-content',controls:'#control-strip,#mobile-control,#room-nav'}],
};
const fieldGaps=parent=>({parent,children:':scope>.field-caption>span,:scope>:is(input:not([type=checkbox]):not([type=radio]),select,textarea)',
  textBounds:'.field-caption>span',together:true,wrap:false});
const workSpec={...roomSpec,roots:['#page-work','#control-strip'],
  wideRows:[{minimumWidth:1100,parent:'#self-summary',children:':scope>div'}],
  leftEdges:[['.wb-focal .job-top','.wb-focal .subline','.wb-focal .wb-progress-hero','.wb-focal .wb-progress-line'],
    ['.workspace-context-heading','#project-create']],
  centers:[{parent:'.terminal-heading',children:'h3,.ui-info',wrap:true},
    {parent:'.wb-publish-control',children:':scope>*'},
    {parent:'.wb-ledger-head',children:':scope>*',wrap:true}],
  buttonRows:[{parent:'.terminal-controls'},{parent:'.wb-job-quick'},{parent:'.job-acts',wrap:true}],
  sameRowControls:[{parent:'.terminal-controls',children:':scope>button'},
    {parent:'#workspace-files .file-location-grid,#workspace-files .output-run-fields',children:'input,select'}],
  unbrokenValues:['#self-summary strong','.wb-metrics strong'],
  siblingGap:[{parent:'#project-create-form',children:':scope>label,:scope>fieldset,:scope>button'},
    {parent:'#project-create-form>label,#project-create-form>fieldset',
      children:':scope>.field-caption>span,:scope>:is(input,select),:scope>legend>span,:scope>.project-environment-segments',
      textBounds:'.field-caption>span,legend>span',wrap:false,together:true},
    {parent:'#workspace-files',children:':scope>.file-location-grid,:scope>.output-run-fields,:scope>.file-actions,:scope>pre'},
    fieldGaps('#workspace-files label')],
  baselines:[{parent:'.wb-job-heading',children:'.st,.wb-job-name',wrap:true}],
  textContainment:['.project-environment-choice>span','.cs-count-link>.st',
    '.wb-progress-number','.wb-progress-meta>span','.wb-metrics strong','#self-summary>div'],
  repeatedPadding:['.wb-job-compact'],repeatedGaps:['.terminal-controls'],
};
const computeSpec={...roomSpec,roots:['#page-resources','#control-strip'],
  largeTargets:roomSpec.largeTargets+',.resource-portrait .resource-select,.resource-tower',
  centers:[{parent:'.resource-hardware-caption',children:':scope>*',wrap:true},
    {parent:'.resource-mini .resource-select',children:':scope>*'}],
  tableColumns:[{rows:'.resource-process-table tr',cells:'th,td'}],
  numericCells:['.resource-process-table :is(th,td):is(:nth-child(1),:nth-child(2),:nth-last-child(2))'],
  textContainment:['.resource-bay-label','.resource-portrait-utils b','.resource-portrait-utils>span'],
  buttonRows:[{parent:'.resource-detail-head'}],
  sameRowControls:[{parent:'.resource-detail-head',children:'button'}],
  unbrokenValues:['.resource-portrait-utils b'],
  tokenGap:[{parent:'.resource-portrait-utils>span',left:'small',right:'b',minimum:6}],
};
const controlSpec={...roomSpec,roots:['#mission-control'],
  scrollGroups:['#mission-control .mc-body'],
  centers:[{parent:'.mc-footer-command',children:':scope>span,:scope>.ui-info'},
    {parent:'.mc-attention-heading',children:':scope>*',wrap:true}],
  buttonRows:[{parent:'.mc-row-actions'}],repeatedPadding:['.mc-attention-item'],
  sameRowControls:[{parent:'.mc-row-actions',children:'button'}],
  unbrokenValues:['.mc-meter-value'],
  textContainment:['.mc-meter-value','.mc-meter-label'],
  siblingGap:[{parent:'.mc-natural',children:':scope>*'},fieldGaps('.mc-natural-version'),
    {parent:'.mc-natural-fields>div',children:':scope>dt,:scope>dd',textBounds:'dt',wrap:false,together:true},
    {parent:'.mc-cols>.mc-col',children:':scope>.mc-row'}],
  scrollPanels:['#mission-control','.mc-body'],
};
const dialogSpec=(selector,scroll)=>({controls,roots:[selector],scrollPanels:selector==='#job-mission'?[selector]:[selector,scroll],scrollGroups:[scroll],
  nativeHelpRows:[selector+' #train-form label:has(.ui-info)'],
  labelledHelp:[{buttons:selector+' #train-form .ui-info:has(#training-target-note)>summary,'+selector+' #training-candidates-field .ui-info>summary',
    rows:'.field-caption',labels:':scope>span'}],
  textContainment:selector==='#job-mission'?['.r5-mission-percentage','.r5-mission-time strong','.r5-mission-metrics strong']:[],
  centers:[{parent:selector+' .sheet-header',children:':scope>*',wrap:true},
    {parent:selector+' #train-form .field-caption',children:':scope>span,:scope>.ui-info>summary'}],
  buttonRows:[{parent:selector+' .sheet-footer',children:'button'}],
  sameRowControls:[{parent:selector+' #train-form .train-grid',children:'input,select,button'},
    {parent:selector+' #train-form .sheet-scroll',children:':scope>label>:is(input,select,textarea)'},
    {parent:selector+' .sheet-footer',children:'button'}],
  siblingGap:[{parent:selector+' .sheet-scroll',children:':scope>.train-grid>label,:scope>label,:scope>.priority-choice>label'},
    fieldGaps(selector+' label:has(>.field-caption)')],
});
const settingsSpec={...dialogSpec('#work-submit-panel','#work-submit-panel .sheet-scroll'),
  sameRowControls:[{parent:'#work-submit-panel .train-grid',children:'input,select'}],
  siblingGap:[{parent:'#work-submit-panel .sheet-scroll',children:':scope>label,:scope>.train-grid>label'},
    fieldGaps('#work-submit-panel label:has(>.field-caption)')],
};
const notesSpec={...dialogSpec('.job-log-dialog','.job-log-dialog .sheet-scroll'),
  siblingGap:[{parent:'.job-notes #drawer-task-note-form',children:':scope>.note-field,:scope>.chat-compose-footer'},
    fieldGaps('.job-notes .note-field')],
};
const outputSpec={...dialogSpec('.job-log-dialog','.job-log-dialog .sheet-scroll'),
  sameRowControls:[{parent:'#workspace-files .file-location-grid,#workspace-files .output-run-fields',children:'input,select'}],
  siblingGap:[{parent:'#workspace-files',children:':scope>.file-location-grid,:scope>.output-run-fields,:scope>.file-actions,:scope>pre'},
    fieldGaps('#workspace-files label')],
};
const scenes=[
  ...['member','admin'].flatMap(role=>[
    ...['confirmed','unconfirmed'].map(completion=>({role,room:'work',state:'normal',completion,
      name:role+'-work-result-'+completion,spec:workSpec})),
    ...['work','compute','control'].flatMap(room=>['normal','empty','loading','error','unknown','maintenance'].map(state=>({role,room,state,name:role+'-'+room+'-'+state,
      spec:room==='work'?workSpec:room==='compute'?computeSpec:controlSpec}))),
    ...['work','control'].map(room=>({role,room,state:'counts',name:role+'-'+room+'-all-counts',spec:room==='work'?workSpec:controlSpec})),
    ...['work','fullscreen'].map(room=>({role,room,state:'complete-report',name:role+'-'+room+'-complete-report',
      spec:room==='work'?workSpec:dialogSpec('#job-mission','.r5-mission-body')})),
    {role,room:'compute',state:'normal',expanded:true,name:role+'-compute-processes',spec:computeSpec},
    ...['normal','error','unknown'].map(state=>({role,room:'fullscreen',state,name:role+'-fullscreen-'+state,spec:dialogSpec('#job-mission','.r5-mission-body')})),
    {role,room:'submit',state:'normal',name:role+'-submit',spec:dialogSpec('#work-submit','#work-submit .sheet-scroll')},
    {role,room:'submit',state:'normal',wrappedLabels:true,name:role+'-submit-wrapped-labels',spec:dialogSpec('#work-submit','#work-submit .sheet-scroll')},
    {role,room:'submit',state:'normal',automatic:true,name:role+'-submit-automatic',
      spec:{...dialogSpec('#work-submit','#work-submit .sheet-scroll'),focusedTargets:['#train-form [name=training-candidates]']}},
    {role,room:'submit',state:'normal',automatic:true,wrappedTargets:true,name:role+'-submit-automatic-wrapped',spec:dialogSpec('#work-submit','#work-submit .sheet-scroll')},
    {role,room:'submit',state:'normal',automatic:true,help:'#work-submit .ui-info:has(#training-target-note)>summary',name:role+'-submit-target-help',
      spec:{...dialogSpec('#work-submit','#work-submit .sheet-scroll'),focusedTargets:['#work-submit .ui-info:has(#training-target-note)>summary'],viewportPanels:['.ui-info[open] .ui-info-content'],textContainment:['.ui-info[open] .ui-info-content']}},
    {role,room:'submit',state:'normal',automatic:true,help:'#training-candidates-field .ui-info>summary',name:role+'-submit-candidates-help',
      spec:{...dialogSpec('#work-submit','#work-submit .sheet-scroll'),focusedTargets:['#training-candidates-field .ui-info>summary'],viewportPanels:['.ui-info[open] .ui-info-content'],textContainment:['.ui-info[open] .ui-info-content']}},
    ...['scheduling','elastic','placement'].map(setting=>({role,room:'submit',state:'normal',setting,name:role+'-submit-'+setting,spec:settingsSpec})),
    {role,room:'control',state:'normal',natural:true,name:role+'-control-training-form',spec:controlSpec},
    {role,room:'fullscreen',state:'normal',notes:true,name:role+'-fullscreen-notes',spec:notesSpec},
    {role,room:'fullscreen',state:'normal',output:true,name:role+'-fullscreen-output',spec:outputSpec},
    {role,room:'work',state:'normal',files:true,name:role+'-work-files',spec:{...workSpec,focusedTargets:['#workspace-files .file-location-grid']}},
    {role,room:'project',state:'normal',name:role+'-project',spec:workSpec},
    ...[['project-environment','#project-create .project-environment-choice>legend>span'],['project-action','#project-create-form [type=submit]']].map(([name,selector])=>({role,room:'project',state:'normal',name:role+'-'+name,
      spec:{...workSpec,focusedTargets:[selector]}})),
    {role,room:'project',state:'normal',headingHelp:true,help:'.workspace-context-heading .field-caption>.ui-info>summary',name:role+'-project-summary-help',
      spec:{...workSpec,focusedTargets:['.workspace-context-heading .field-caption>.ui-info>summary'],
        viewportPanels:['.ui-info[open] .ui-info-content'],textContainment:['.ui-info[open] .ui-info-content'],scrollPanels:['.ui-info[open] .ui-info-content']}},
    {role,room:'submit',state:'normal',name:role+'-submit-bottom',spec:{...dialogSpec('#work-submit','#work-submit .sheet-scroll'),focusedTargets:['#train-form [name=command]']}},
    ...['normal','error','ended'].map(state=>({role,room:'terminal',state,name:role+'-terminal-'+state,
      spec:{controls,roots:['.terminal-dialog'],scrollPanels:['.terminal-dialog','#terminal-screen .xterm-viewport'],
        nonvisualInputs:['#terminal-screen .xterm .xterm-helper-textarea'],
        viewportContainment:[{parent:'#terminal-screen',child:'#terminal-screen .xterm-screen,#terminal-screen .xterm-viewport'}],
        centers:[{parent:'.terminal-footer',children:':scope>*',wrap:true}],buttonRows:[{parent:'.terminal-dialog .modal-head>div'}]}})),
    ...[1.25,1.5].map(zoom=>({role,room:'work',state:'normal',zoom,toast:true,
      name:role+'-toast-'+zoom,spec:{...workSpec,textContainment:[...workSpec.textContainment,'#toast']}})),
    ...[['work','.wb-report-label .ui-info>summary'],['control','.mc-footer-command .ui-info>summary'],
      ['project','.ui-info:has(#environment-mode-note)>summary']].map(([room,help])=>({role,room,help,state:'normal',
        name:role+'-'+room+'-help',spec:{...(room==='control'?controlSpec:workSpec),
          viewportPanels:['.ui-info[open] .ui-info-content'],textContainment:['.ui-info[open] .ui-info-content']}})),
  ]),
  ...['work','control','compute'].map(room=>({role:'member',room,state:'normal',name:'member-'+room+'-reduced',reduced:true,
    spec:room==='work'?workSpec:room==='compute'?computeSpec:controlSpec})),
];

async function fieldHelpTargets(page,root){
  const targets=page.locator(root+' :is(.field-caption>.ui-info>summary,legend>.ui-info>summary)');
  const indices=await targets.evaluateAll(nodes=>nodes.flatMap((node,index)=>{
    if(node.closest('[hidden],[inert]')||getComputedStyle(node).visibility==='hidden')return [];
    for(let parent=node.parentElement;parent;parent=parent.parentElement)
      if(parent.matches('details:not([open])')&&!parent.querySelector(':scope>summary')?.contains(node))return [];
    const box=node.getBoundingClientRect();return box.width&&box.height?[index]:[];
  }));
  // Reach every rendered explanation by normal scrolling. A box inside the
  // viewport can still be behind fixed navigation; that is not a visible hit
  // target. Keep all three hit points and the full target-size assertion.
  const positions=await page.evaluateHandle(selector=>{
    const nodes=[document.scrollingElement];
    for(const node of document.querySelectorAll(selector))for(let parent=node.parentElement;parent;parent=parent.parentElement)nodes.push(parent);
    return [...new Set(nodes)].map(node=>({node,top:node.scrollTop,left:node.scrollLeft}));
  },root+' :is(.field-caption>.ui-info>summary,legend>.ui-info>summary)');
  const rows=[];
  try{
    for(const index of indices){
      const target=targets.nth(index);
      await target.evaluate(node=>node.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      rows.push(await target.evaluate(node=>{
        const box=node.getBoundingClientRect(),hits=[box.top+2,box.top+box.height/2,box.bottom-2].map(y=>document.elementFromPoint(box.left+box.width/2,y));
        return {label:node.getAttribute('aria-label'),top:box.top,bottom:box.bottom,height:box.height,expected:innerWidth<760?44:32,
          hit:hits.every(hit=>node.contains(hit)),targets:hits.map(hit=>hit?.id||hit?.tagName+'.'+hit?.className)};
      }));
    }
  }finally{
    await positions.evaluate(rows=>{for(const {node,top,left} of rows){node.scrollTop=top;node.scrollLeft=left;}});
    await positions.dispose();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  }
  return rows;
}

async function checkGeometryRegressions(){
  const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
  const markup=(footerTop,fontSize=13)=>`<style>body{margin:0;font-family:sans-serif}main{position:relative;width:300px}button{width:100px;height:40px;font-size:${fontSize}px}.scroll{height:100px;overflow:auto;position:relative}.scroll button{position:absolute;top:120px;left:0}footer{position:absolute;top:${footerTop}px}</style><main><div class="scroll"><button>Scrolled action</button></div><footer><button>Fixed action</button></footer></main>`;
  const spec={roots:['main'],controls:'button',scrollGroups:['.scroll']};
  try{
    await page.setContent(markup(120));
    assert.equal((await inspectOperationalGeometry(page,spec)).pass,true,'a fully scroll-clipped action does not overlap the visible footer');
    await page.locator('.scroll').evaluate(node=>node.scrollTop=60);
    await page.locator('footer').evaluate(node=>node.style.top='70px');
    assert.ok((await inspectOperationalGeometry(page,spec)).failures.some(row=>row.rule==='visible-overlap'),'partly visible scrolling actions cannot be covered by footer controls');
    await page.setContent(markup(120,10));
    assert.ok((await inspectOperationalGeometry(page,spec)).failures.some(row=>row.rule==='minimum-type'),'readable text below 11px still fails');
    await page.setViewportSize({width:320,height:700});await page.setContent(markup(120));
    assert.ok((await inspectOperationalGeometry(page,spec)).failures.some(row=>row.rule==='touch-height'),'40px controls still fail the phone touch-height rule');
    const terminalSpec={roots:['#terminal-screen'],scrollPanels:['.xterm-viewport'],
      viewportContainment:[{parent:'#terminal-screen',child:'.xterm-screen,.xterm-viewport'}]};
    await page.setContent('<style>#terminal-screen{position:relative;width:200px;height:100px;overflow:hidden}.xterm-viewport{position:absolute;inset:0;overflow:auto}.xterm-scroll-area{height:300px}.xterm-screen{position:absolute;inset:0;height:100px;pointer-events:none}</style><div id="terminal-screen"><div class="xterm-viewport"><div class="xterm-scroll-area"></div></div><div class="xterm-screen"></div></div>');
    assert.equal((await inspectOperationalGeometry(page,terminalSpec)).pass,true,'terminal scrollback is reachable in the actual scrolling viewport');
    await page.locator('.xterm-viewport').evaluate(node=>node.style.overflow='hidden');
    assert.ok((await inspectOperationalGeometry(page,terminalSpec)).failures.some(row=>row.rule==='unreachable-panel-content'),'hiding terminal scrollback still fails');
    await page.locator('.xterm-viewport').evaluate(node=>node.style.overflow='auto');
    await page.locator('.xterm-screen').evaluate(node=>node.style.height='140px');
    assert.ok((await inspectOperationalGeometry(page,terminalSpec)).failures.some(row=>row.rule==='viewport-content-clipping'),'visible terminal rows outside the viewport still fail');
    await page.setContent('<style>#terminal-screen{height:100px}.xterm-helper-textarea{position:absolute;opacity:0;height:20px}</style><div id="terminal-screen"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></div>');
    const engineSpec={roots:['#terminal-screen'],nonvisualInputs:['#terminal-screen .xterm .xterm-helper-textarea']};
    assert.equal((await inspectOperationalGeometry(page,engineSpec)).pass,true,'a transparent keyboard bridge is not a visible touch target');
    await page.locator('.xterm-helper-textarea').evaluate(node=>node.style.opacity='1');
    assert.ok((await inspectOperationalGeometry(page,engineSpec)).failures.some(row=>row.rule==='visible-engine-input'),'an engine input exposed as a visible control still fails');
    await page.setContent('<style>.caption{display:flex;align-items:center}.label{font:15px/24px sans-serif}.ui-info>summary{display:flex;width:44px;height:44px;margin-bottom:14px}</style><div class="caption"><span class="label">Training version</span><details class="ui-info"><summary>Info</summary></details></div>');
    const captionSpec={roots:['.caption'],nativeHelpRows:['.caption'],centers:[{parent:'.caption',children:':scope>span,:scope>.ui-info>summary'}]};
    assert.ok((await inspectOperationalGeometry(page,captionSpec)).failures.some(row=>row.rule==='inline-center'),'a disclosure margin that displaces the icon from its label is detected');
    await page.locator('.ui-info>summary').evaluate(node=>node.style.margin='0');
    assert.equal((await inspectOperationalGeometry(page,captionSpec)).pass,true,'the icon shares its label center without inherited disclosure margins');
    await page.locator('.ui-info').evaluate(node=>node.style.marginLeft='30px');
    assert.ok((await inspectOperationalGeometry(page,captionSpec)).failures.some(row=>row.rule==='help-label-gap'),'an explanation detached from its label still fails');
    await page.setViewportSize({width:1440,height:900});
    await page.setContent('<div class="readings" style="display:grid;grid-template-columns:1fr;width:300px"><div>Quota</div><div>Training</div><div>Servers</div></div>');
    const readingsSpec={roots:['.readings'],wideRows:[{minimumWidth:1100,parent:'.readings',children:':scope>div'}]};
    assert.ok((await inspectOperationalGeometry(page,readingsSpec)).failures.some(row=>row.rule==='wide-row-wrap'),'desktop summary readings cannot unexpectedly become a tall single column');
    await page.locator('.readings').evaluate(node=>node.style.gridTemplateColumns='repeat(3,1fr)');
    assert.equal((await inspectOperationalGeometry(page,readingsSpec)).pass,true,'desktop summary readings share one row');
    await page.setViewportSize({width:320,height:700});
    await page.setContent('<div class="popup" style="position:fixed;left:280px;top:680px;width:100px;height:100px">Full explanation</div>');
    const popupSpec={roots:['body'],controls:'button',viewportPanels:['.popup']};
    assert.ok((await inspectOperationalGeometry(page,popupSpec)).failures.some(row=>row.rule==='popup-clipping'),'a popup outside the viewport still fails');
    await page.locator('.popup').evaluate(node=>{node.style.left='16px';node.style.top='16px';});
    assert.equal((await inspectOperationalGeometry(page,popupSpec)).pass,true,'a fully reachable popup passes');
    await page.setContent('<button id="action" style="position:absolute;left:20px;top:20px;width:100px;height:44px">Create project</button><div id="cover" style="position:fixed;left:20px;top:20px;width:100px;height:44px"></div>');
    const targetSpec={roots:['body'],controls:'button',focusedTargets:['#action']};
    assert.ok((await inspectOperationalGeometry(page,targetSpec)).failures.some(row=>row.rule==='focused-target-covered'),'a focused action covered by another element still fails');
    await page.locator('#cover').evaluate(node=>node.remove());
    assert.equal((await inspectOperationalGeometry(page,targetSpec)).pass,true,'a reachable focused action passes');
    await page.setViewportSize({width:1440,height:900});
    const defaultSpec={roots:['body'],controls:'input,select,button'};
    await page.setContent('<style>.control-row{display:flex;gap:16px}input{box-sizing:border-box;width:100px;height:40px}#second{transform:translateY(6px)}</style><div class="control-row"><input id="first"><input id="second"></div>');
    assert.equal((await inspectOperationalGeometry(page,defaultSpec)).pass,true,'same-row checks are disabled for existing specifications');
    const alignedSpec={...defaultSpec,sameRowControls:[{parent:'.control-row'}]};
    const displaced=await inspectOperationalGeometry(page,alignedSpec);
    assert.ok(displaced.failures.some(row=>row.rule==='same-row-controls'&&Math.max(...row.values)-Math.min(...row.values)===6),'a six-pixel input offset fails the optional shared row rule');
    await page.locator('#second').evaluate(node=>node.style.transform='none');
    assert.equal((await inspectOperationalGeometry(page,alignedSpec)).pass,true,'aligned input tops pass the same-row rule');
    await page.setContent('<style>.control-row{display:flex;gap:16px}label{display:flex;flex-direction:column;width:100px}label span{height:16px}#long-caption{height:64px}input{box-sizing:border-box;height:40px;width:100px}</style><div class="control-row"><label><span>Cards</span><input></label><label><span id="long-caption">Wrapped caption</span><input></label></div>');
    assert.ok((await inspectOperationalGeometry(page,alignedSpec)).failures.some(row=>row.rule==='same-row-controls'&&Math.max(...row.values)-Math.min(...row.values)===48),'field wrappers preserve the visual row even when controls no longer overlap vertically');
    await page.locator('label span').first().evaluate(node=>node.style.height='64px');
    assert.equal((await inspectOperationalGeometry(page,alignedSpec)).pass,true,'shared caption tracks align controls after arbitrary wrapping');
    await page.setContent('<style>.reading{display:flex;align-items:baseline;flex-wrap:wrap;width:60px;gap:7px;font:28px/1.1 sans-serif}.reading small{font-size:11px}</style><div class="reading"><span>10 /</span><span>30</span><small>张</small></div>');
    assert.equal((await inspectOperationalGeometry(page,defaultSpec)).pass,true,'numeric wrapping checks are disabled for existing specifications');
    const valuesSpec={...defaultSpec,unbrokenValues:['.reading']};
    assert.ok((await inspectOperationalGeometry(page,valuesSpec)).failures.some(row=>row.rule==='value-word-wrap'),'a number and unit on separate lines fail the optional value rule');
    await page.locator('.reading').evaluate(node=>node.style.width='180px');
    assert.equal((await inspectOperationalGeometry(page,valuesSpec)).pass,true,'different-size numeric and unit fonts on one baseline pass');
    await page.setContent('<style>.tokens{display:flex;gap:2px;font:11px/1.4 monospace}.tokens small{font-size:11px}</style><div class="tokens"><small>01</small><b>93%</b></div>');
    assert.equal((await inspectOperationalGeometry(page,defaultSpec)).pass,true,'token separation checks are disabled for existing specifications');
    const gapSpec={...defaultSpec,tokenGap:[{parent:'.tokens',left:'small',right:'b',minimum:6}]};
    assert.ok((await inspectOperationalGeometry(page,gapSpec)).failures.some(row=>row.rule==='token-gap'&&row.gap===2),'a two-pixel serial/value gap fails the optional token rule');
    await page.locator('.tokens').evaluate(node=>node.style.gap='8px');
    assert.equal((await inspectOperationalGeometry(page,gapSpec)).pass,true,'an eight-pixel serial/value gap passes');
    await page.setContent('<style>.fields{display:grid;gap:24px}.fields>div{height:40px}.fields>div:last-child{margin-top:10px}</style><div class="fields"><div>One</div><div>Two</div><div>Three</div></div>');
    assert.equal((await inspectOperationalGeometry(page,defaultSpec)).pass,true,'sibling gap checks are disabled for existing specifications');
    const siblingSpec={...defaultSpec,siblingGap:[{parent:'.fields'}]};
    assert.ok((await inspectOperationalGeometry(page,siblingSpec)).failures.some(row=>row.rule==='sibling-gap'),'unequal consecutive field gaps fail');
    await page.locator('.fields>div').last().evaluate(node=>node.style.marginTop='0');
    assert.equal((await inspectOperationalGeometry(page,siblingSpec)).pass,true,'equal field gaps pass');
    await page.setContent('<style>.field{display:grid;gap:12px}.caption{display:flex;align-items:center;gap:8px;font:16px/24px sans-serif}.info{height:44px;width:44px}input{width:100px;height:40px;box-sizing:border-box}</style><div class="field"><div class="caption"><span>Plain</span></div><input></div><div class="field"><div class="caption"><span>Help</span><div class="info"></div></div><input></div>');
    const fieldGapSpec={...defaultSpec,siblingGap:[{parent:'.field',children:'.caption>span,input',textBounds:'.caption>span',together:true,wrap:false}]};
    assert.ok((await inspectOperationalGeometry(page,fieldGapSpec)).failures.some(row=>row.rule==='sibling-gap'),'a tall help target changes the visual caption-to-control gap');
    await page.locator('.info').evaluate(node=>node.style.marginBlock='-10px');
    assert.equal((await inspectOperationalGeometry(page,fieldGapSpec)).pass,true,'a full-size target with negative margins keeps the caption gap');
  }finally{await context.close();}
}

try{
  await mkdir(output,{recursive:true});
  const bootstrap=join(temporary,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  ({server,service}=await createPortalServer({database:join(temporary,'db'),bootstrap,origin,secure:false,
    bridge:async()=>{throw Error('A layout fixture must not execute a node operation');}}));
  clearInterval(service.executionTimer);clearInterval(service.transferTimer);
  await new Promise(resolve=>server.listen(new URL(origin).port,'127.0.0.1',resolve));
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'operations-layout',name:'几何检查的很长成员姓名',password})).result;
  await service.invoke(admin.token,'policy.full',{userId:member.id,policyVersion:0});
  const principals={admin:admin.principal,member:{userId:member.id,username:member.username,role:'member'}};
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  await checkGeometryRegressions();
  for(const scene of scenes.filter(row=>!selected||selected.includes(row.name)||selected.includes(row.room))){
    for(const zoom of scene.zoom?[scene.zoom]:full?layoutZooms:[1]){
      const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:zoom,reducedMotion:scene.reduced?'reduce':'no-preference'});
      const page=await context.newPage(),principal=principals[scene.role],state=structuredClone(service.state(principal));
      state.machines=structuredClone(inventory);state.executionEnabled=true;
      for(const user of state.users){user.limits=Object.fromEntries(inventory.map(row=>[row.id,row.cards]));user.total=30;}
      const checkedAt=new Date().toISOString();
      state.gpuq={checkedAt,stale:scene.state==='unknown',hosts:inventory.map((row,index)=>({id:row.id,checkedAt,reachable:scene.state==='error'&&index===0?false:true,
        gpus:Array.from({length:row.cards},(_,gpu)=>({index:gpu,model:row.model,memoryTotalMiB:32768,memoryUsedMiB:gpu<2?16384:0,utilization:gpu<2?93:0,temperatureC:45,
          processesAvailable:true,processes:gpu===0?[{pid:1234,memoryUsedMiB:16384,task:{id:'fixture-running',name:'长任务名称用于检查行高与表格边缘',state:'RUNNING',submitter:{name:member.name}}}]:[]})),
        gpuq:{connected:true,health:'ok',observeOnly:false,schedulableIndices:[0],jobs:[],capabilities:['console-placement-v1','console-sharing-v1','console-hami-v1']}}))};
      const job=(id,status)=>({id,userId:principal.userId,username:principal.username,machine,project,release,name:'训练任务名称 · '+id,cards:2,state:status,priority:'normal',createdAt:Date.now()/1000-3600,
        spec:{id,argv:['python','train.py']},latestAttempt:{id:'attempt-'+id,...(status==='FAILED'?{finishedAt:Date.now()/1000-60,exitCode:1}:{})},
        ...(status==='RUNNING'?{startedAt:Date.now()/1000-3600,assignedIndices:[0,1],progress:{reported:true,stale:false,snapshot:{epochsCompleted:scene.state==='complete-report'?40:12,epochsTotal:40,updatedAt:Date.now()/1000,etaSeconds:900,metrics:{loss:.438,val_acc:.716,lr:.0003}}}}:{}),
        ...(status==='FAILED'?{error:'保存训练结果时出现错误，请查看日志与诊断。'}:{})});
      state.jobs=scene.state==='empty'?[]:scene.state==='error'?[job('fixture-failed','FAILED')]:scene.state==='unknown'?[job('fixture-unknown','UNKNOWN')]:
        [job('fixture-running','RUNNING'),job('fixture-queued','PENDING'),job('fixture-failed','FAILED')];
      if(scene.output)for(const [index,row] of state.jobs.entries()){row.id='00000000-0000-4000-8000-'+String(index+1).padStart(12,'0');row.spec.id=row.id;}
      if(scene.state==='counts')state.jobs.push(job('fixture-start','STARTING'),job('fixture-data','PREPARING_DATA'),
        {...job('fixture-cancel','RUNNING'),cancelRequested:true},job('fixture-unknown','UNKNOWN'));
      const resultId='10000000-0000-4000-8000-000000000001';
      if(scene.completion){
        const completed=job(resultId,'SUCCEEDED'),now=Math.floor(Date.now()/1000);
        completed.nodeJobId='J0123456789ab';completed.spec={...completed.spec,userId:principal.userId,machine,project,release};
        completed.latestAttempt={id:'A'+'b'.repeat(32),ordinal:1,state:'EXITED_SUCCESS',exitCode:0,failureReason:null,startedAt:now-900,finishedAt:now-300};
        state.jobs.push(completed);
      }
      state.operationalMaintenance={version:1,revision:1,global:scene.state==='maintenance'?{reason:'存储检查；已有训练继续运行',since:checkedAt}:null,machines:{}};
      let logged=false,terminalCalls=0;const gates=[];
      let completionReceived;const completionRead=new Promise(resolve=>completionReceived=resolve);
      page.on('pageerror',error=>errors.push({scene:scene.name,message:error.message}));
      await page.addInitScript(()=>{globalThis.operationalCSP=[];document.addEventListener('securitypolicyviolation',event=>operationalCSP.push(event.violatedDirective));});
      const reply=(route,result,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(result)});
      await context.route('**/*',guardedRoute(async route=>{
        const url=new URL(route.request().url());
        if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){outside.push(url.href);await route.abort();return;}
        if(url.pathname==='/machines.js'){await route.fulfill({contentType:'text/javascript',body:'export const MACHINES='+JSON.stringify(inventory)+';'});return;}
        if(url.pathname==='/api/login'){logged=true;await reply(route,{principal,state});return;}
        if(url.pathname==='/api/call'){
          const {operation,args}=route.request().postDataJSON();let result;
          if(operation==='state'){if(logged&&scene.state==='loading')await new Promise(resolve=>gates.push(resolve));await reply(route,{state});return;}
          if(operation==='workshop.mine'){assert.equal(logged,true);assert.deepEqual(args,{});await reply(route,{result:{installed:[]}});return;}
          if(operation==='projects.list')result={environmentModes:['shared','isolated','oci'],projects:scene.state==='empty'?[]:[{project,state:'READY',environmentMode:'oci',latestReadyRelease:release,releases:[{release,state:'READY'}]}]};
          else if(operation==='projects.status')result={project,state:'READY',environmentMode:'oci',latestReadyRelease:release,releases:[{release,state:'READY'}]};
          else if(operation==='projects.quota')result={usedBytes:0,quotaBytes:1024**3};
          else if(operation==='maintenance.status')result=state.operationalMaintenance;
          else if(operation==='datasets.overview')result={protocol:0};
          else if(['datasets.list','datasets.catalog'].includes(operation))result={machine:args.machine,datasets:scene.natural?[{dataset:'fixture-data',versions:[{version:release,state:'READY'}]}]:[],machines:inventory.map(row=>({machine:row.id,state:'ok'}))};
          else if(operation==='datasets.capacity')result={available:false};
          else if(['notifications.list','transfers.list'].includes(operation))result={items:[]};
          else if(operation==='transfers.capabilities')result={enabled:false};
          else if(operation==='terminal.open')result={id:args.key,clientId:args.clientId,writerToken:randomUUID(),mode:args.mode};
          else if(operation==='terminal.exchange'){
            if(++terminalCalls>1&&scene.state==='error'){await reply(route,{error:'输入结果未确认，请重连。'},503);return;}
            result={offset:12,data:terminalCalls===1?Buffer.from('Local xterm.\r\n').toString('base64'):'',exited:scene.state==='ended',exitCode:scene.state==='ended'?17:null};
          }else if(operation==='terminal.detach')result={detached:true};
          else if(operation==='jobs.logs')result={text:'Local training log.'};
          else if(layoutReadOperations.has(operation))result=layoutReadReply(operation,args,{principal,state,completion:scene.completion});
          else if(operation==='community.info')result={enabled:true,capabilities:['task-notes-v1']};
          else if(operation==='community.notes.list')result={notes:[],nextCursor:null};
          else if(operation==='files.list')result={entries:[]};
          else throw Error('Unexpected layout fixture API: '+operation);
          await reply(route,{result,state});if(operation==='jobs.completion'&&args.jobId===resultId)completionReceived(result);return;
        }
        await route.continue();
      }));
      try{
        await page.goto(origin);await page.locator('#login-form [name=username]').fill(principal.username);await page.locator('#login-form [name=password]').fill(password);
        await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
        await page.locator('[name=workspace-machine]').selectOption(machine);await page.waitForFunction(()=>!document.querySelector('[name=workspace-machine]').disabled);
        if(scene.state!=='empty'){await page.locator('[name=workspace-project]').selectOption(project);await page.waitForFunction(()=>!document.querySelector('[name=workspace-project]').disabled);}
        if(scene.completion){
          const receipt=await completionRead;assert.equal(receipt.protocol,'job-completion-v1');assert.equal(receipt.jobId,resultId);assert.equal(receipt.userId,principal.userId);
          const pull=page.locator('[data-job-pull="'+resultId+'"]');
          if(scene.completion==='confirmed'){assert.equal(receipt.completed,true);assert.equal(receipt.state,'SUCCEEDED');await pull.waitFor({state:'attached'});await page.locator('.wb-ended>summary').click();await pull.waitFor({state:'visible'});}
          else{assert.equal(receipt.completed,false);assert.equal(receipt.state,'UNCONFIRMED');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await pull.count(),0,'unconfirmed native completion cannot expose pull');}
        }
        if(scene.state==='loading')await page.locator('#refresh-state').click();
        if(scene.room==='compute'){
          await page.locator('[data-nav=resources]').click();await page.locator('.resource-fleet').waitFor();
          if(!before)for(const row of await page.locator('.resource-chassis-scroll').evaluateAll(nodes=>nodes.map(node=>({
            bays:[...node.querySelectorAll('.resource-bay-label')].map(label=>label.textContent),
            indices:[...node.querySelectorAll('.resource-portrait-utils small')].map(label=>label.textContent),
          }))))assert.deepEqual(row.indices,row.bays,'utilization serials match the actual chassis slot labels');
        }
        if(scene.expanded)await page.locator('#machine-grid .resource-process-list>summary').click();
        if(scene.state==='counts')await page.evaluate(({userId,machine,project})=>{
          document.dispatchEvent(new CustomEvent('gpuq-terminal-state',{detail:{sessions:[{id:'layout-known-session',userId,machine,project,connectionState:'connected',environmentMode:'oci'}]}}));
          document.dispatchEvent(new CustomEvent('gpuq-data-activities',{detail:{userId,complete:true,items:[{id:'layout-known-upload',userId,machine,kind:'upload',name:'几何检查数据任务',state:'UPLOADING'}]}}));
          const root=document.querySelector('#control-strip');
          for(const type of ['st-run','st-start','st-queue','st-prep','st-cancel','st-unk']){
            const count=root.querySelector('.cs-count-link>.'+type);if(!count||!count.getAttribute('aria-label'))throw Error('A confirmed activity count disappeared: '+type);
          }
        },{userId:principal.userId,machine,project});
        if(scene.room==='control'){
          await page.keyboard.press('Control+k');await page.locator('#mission-control').waitFor({state:'visible'});
          if(scene.natural){await page.locator('#control-command').fill(machine+' 两张卡 跑 python train.py 用 fixture-data');await page.locator('[data-command-id="parse-training"]').click();await page.locator('#control-data-version option').filter({hasText:'已就绪'}).waitFor({state:'attached'});}
        }
        if(scene.room==='fullscreen'){
          await page.locator('.wb-focal [data-job-mission]').click();await page.locator('#job-mission').waitFor({state:'visible'});
          if(scene.notes){await page.locator('#job-mission [data-job-logs]').click();await page.locator('.job-log-dialog [data-job-tab=notes]').click();await page.locator('#drawer-task-note-form').waitFor({state:'visible'});}
          if(scene.output){await page.locator('#job-mission [data-job-output]').click();await page.locator('#job-output-view #workspace-result').filter({hasText:'目录为空'}).waitFor();}
        }
        if(scene.room==='submit'){
          await page.locator('#open-submit').click();await page.locator('#work-submit').waitFor({state:'visible'});
          if(scene.automatic){
            await page.locator('[name=training-target]').selectOption('auto');
            await page.locator('[name=training-candidates]').fill(inventory.map(row=>row.id).join(', '));
            assert.equal(await page.locator('[name=workspace-machine]').inputValue(),machine,'automatic training preserves the development server');
            assert.equal(await page.locator('[name=workspace-project]').inputValue(),project,'automatic training preserves the development project');
            assert.equal(await page.locator('[name=release]').inputValue(),release,'automatic training preserves the fixed release');
            assert.equal(await page.locator('#training-candidates-field').evaluate(node=>node.hidden),false,'automatic selection exposes the candidate field');
            await page.locator('[name=training-candidates]').evaluate(node=>node.blur());
            await page.mouse.move(1,1);
          }
          if(scene.wrappedTargets)for(const [name,value] of [['training-target','本次训练自动选择服务器的位置'],['training-candidates','本次训练可以使用的候选服务器完整名称（可选）']]){
            await page.locator('[name='+name+']').evaluate((control,value)=>{
              const label=control.closest('label'),text=label.querySelector('.field-caption>span')||[...label.childNodes].find(node=>node.nodeType===Node.TEXT_NODE);
              text.textContent=value;
            },value);
          }
          if(scene.wrappedLabels)await page.locator('#train-form .train-grid:has([name=cards])').evaluate(grid=>{
            for(const [name,value] of [['memory','每张显卡的最低可用显存容量下限（GiB）'],['name','本次训练任务的完整名称']]){
              const label=grid.querySelector('[name='+name+']').closest('label'),text=label.querySelector('.field-caption>span')||[...label.childNodes].find(node=>node.nodeType===Node.TEXT_NODE);
              text.textContent=value;
            }
          });
          if(scene.setting){await page.locator('.training-advanced>details>summary').nth({scheduling:0,elastic:1,placement:2}[scene.setting]).click();await page.locator('#work-submit-panel').waitFor({state:'visible'});}
          if(!before&&!scene.setting){
            assert.equal(await page.locator('#train-form label>.ui-info').count(),0,'field explanations belong to their label row, including training-version help');
            for(const name of ['task-description','priority','release','command','datasets']){
              const label=page.locator('#train-form label').filter({has:page.locator('[name='+name+']')});
              assert.equal(await label.locator(':scope>.field-caption .ui-info>summary').count(),1,'labelled '+name+' explanation is retained');
            }
            for(const name of ['training-target','training-candidates']){
              const label=page.locator('#train-form label').filter({has:page.locator('[name='+name+']')});
              assert.equal(await label.locator(':scope>.field-caption .ui-info>summary').count(),1,'automatic-selection '+name+' explanation stays on the label row');
            }
          }
        }
        if(scene.room==='project'){
          await page.locator('#project-create>summary').click();await page.locator('[name=new-project]').fill('container-layout');
          const mode=page.locator('#project-create-form [name=environment-mode]'),description=page.locator('#project-create .project-environment-choice>legend>span');
          assert.equal(await mode.count(),1,'new projects retain one fixed environment field');
          assert.equal(await mode.inputValue(),'oci','new projects use the confirmed personal-container mode');
          assert.equal(await mode.evaluate(node=>node.hidden&&node.getAttribute('aria-hidden')==='true'&&node.tabIndex===-1),true,'the fixed mode is not an interactive environment choice');
          assert.equal(await mode.isHidden(),true,'the fixed mode remains hidden in the real browser');
          assert.equal(await page.locator('#project-create-form [name=environment-choice]').count(),0,'obsolete environment choices are absent');
          assert.equal(await description.count(),1,'the personal-container explanation is retained');
          assert.equal(await description.textContent(),'个人容器','the visible environment explanation matches the fixed mode');
          assert.equal(await description.isVisible(),true,'members and administrators can see the personal-container explanation');
        }
        if(scene.files)await page.locator('#workspace-files>summary').click();
        if(scene.room==='terminal'){await page.locator('#terminal-open').click();await page.locator('.terminal-dialog').waitFor({state:'visible'});if(scene.state==='error')await page.locator('#terminal-connection-note').filter({hasText:'未确认'}).waitFor();if(scene.state==='ended')await page.locator('#terminal-connection-note').filter({hasText:'终端已结束'}).waitFor();}
        if(scene.help)await page.locator(scene.help).click();
        await page.evaluate(()=>document.fonts.ready);
        const toastMessage='服务器暂时没有确认这次操作；请保留原任务编号，重新查询后再决定下一步。错误详情：'+
          'unconfirmed-'.repeat(8)+'<完整错误信息保留到这一句>';
        if(scene.toast)await page.locator('#toast').evaluate((node,message)=>{node.textContent=message;node.classList.add('visible');},toastMessage);
        const caseRows=[];
        for(const width of [1440,390,320]){
          await page.setViewportSize({width:Math.floor(width/zoom),height:Math.floor((width<760?844:900)/zoom)});
          await page.evaluate(async()=>{for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime))animation.finish();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
          if(scene.spec.focusedTargets?.length)await revealOperationalTarget(page,scene.spec.focusedTargets[0]);
          const measurement=await inspectOperationalGeometry(page,scene.spec);caseRows.push({physicalWidth:width,physicalHeight:width<760?844:900,zoom,...measurement});
          if(!before){
            assert.deepEqual(await page.locator('#control-training-preview[hidden],#work-submit [hidden],#work-submit-panel [hidden],#project-create-form [hidden],#workspace-files [hidden],.job-notes [hidden]').evaluateAll(nodes=>nodes.filter(node=>getComputedStyle(node).display!=='none').map(node=>node.id||node.tagName)),[],'field layout must respect existing hidden conditions');
            // An explanation overlays later fields. Check its own full target
            // while open, then dismiss/reopen it through the normal trigger
            // around the unchanged probe for all other explanation targets.
            const expandedHelp=(scene.room==='submit'||scene.headingHelp)&&scene.help?page.locator(scene.help):null;
            if(expandedHelp){
              const activeTarget=await expandedHelp.evaluate(node=>{
                const box=node.getBoundingClientRect();
                return {open:node.parentElement.open,height:box.height,expected:innerWidth<760?44:32,
                  hit:[box.top+2,box.top+box.height/2,box.bottom-2].every(y=>node.contains(document.elementFromPoint(box.left+box.width/2,y)))};
              });
              assert.ok(activeTarget.open&&activeTarget.hit&&Math.abs(activeTarget.height-activeTarget.expected)<=1,'the expanded explanation retains its full clickable trigger: '+JSON.stringify(activeTarget));
              await expandedHelp.click();
              assert.equal(await expandedHelp.evaluate(node=>node.parentElement.open),false,'dismiss the explanation before interacting with fields beneath it');
            }
            const activeFieldRoot=scene.room==='submit'?(scene.setting?'#work-submit-panel':'#work-submit'):scene.room==='project'?'#project-create-form':null;
            const hitAreas=activeFieldRoot?await fieldHelpTargets(page,activeFieldRoot):[];
            assert.ok(hitAreas.every(row=>Math.abs(row.height-row.expected)<=1&&row.hit),'the full disclosure target remains clickable beyond its compact caption line: '+JSON.stringify({scene:scene.name,width,zoom,hitAreas}));
            if(expandedHelp){
              await expandedHelp.click();
              assert.equal(await expandedHelp.evaluate(node=>node.parentElement.open),true,'restore the expanded explanation for the screenshot and dense scan');
            }
            if(scene.headingHelp){
              const scrolling=await page.locator('.workspace-context-heading .ui-info-content').evaluate(async node=>{
                const previous=node.scrollTop;node.scrollTop=node.scrollHeight;
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                const result={top:node.scrollTop,maximum:node.scrollHeight-node.clientHeight};
                node.scrollTop=previous;return result;
              });
              assert.ok(Math.abs(scrolling.top-scrolling.maximum)<=1,'all project explanation text remains reachable by scrolling: '+JSON.stringify(scrolling));
            }
          }
          if(process.env.POLISH_DOM_REPORT){
            const geometry=await page.evaluate(selector=>{
              const rect=node=>{const box=node.getBoundingClientRect();return Object.fromEntries(['left','top','right','bottom','width','height'].map(key=>[key,box[key]]));};
              return [...document.querySelectorAll(selector)].filter(node=>node.getClientRects().length&&!node.closest('[hidden],details:not([open]) .ui-info-content')).map(node=>{
                const box=rect(node),x=(box.left+box.right)/2,y=(box.top+box.bottom)/2,hit=document.elementFromPoint(x,y);
                return {element:node.id||node.tagName+'.'+node.className,name:node.getAttribute('name'),rect:box,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,
                  padding:getComputedStyle(node).padding,overflow:getComputedStyle(node).overflow,font:getComputedStyle(node).fontSize,
                  clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,minWidth:getComputedStyle(node).minWidth,maxWidth:getComputedStyle(node).maxWidth,
                  margin:getComputedStyle(node).margin,width:getComputedStyle(node).width,
                  hit:hit?.id||hit?.tagName+'.'+hit?.className,hitSelf:!!hit&&(node===hit||node.contains(hit)),parent:node.parentElement?.id||node.parentElement?.className};
              });
            },'html,body,#toast,#work-submit .sheet-scroll,#work-submit .sheet-footer,#work-submit input,#work-submit select,#work-submit textarea,#work-submit button,#mission-control .mc-body,#mission-control .mc-footer,#mission-control .mc-row-name,#mission-control .mc-footer .ui-info>summary,#terminal-screen,#terminal-screen .xterm,#terminal-screen .xterm-viewport,#terminal-screen .xterm-screen,.terminal-dialog .modal-head,.terminal-footer');
            await writeFile(join(output,scene.name+'-'+width+'-dom.json'),JSON.stringify(geometry,null,2));
            if(scene.toast)await writeFile(join(output,scene.name+'-'+width+'-overflow.json'),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('*')].filter(node=>{
              const box=node.getBoundingClientRect();return box.width&&box.right>innerWidth+1||node.clientWidth&&node.scrollWidth>node.clientWidth+1;
            }).map(node=>{const box=node.getBoundingClientRect(),style=getComputedStyle(node);return {tag:node.tagName,id:node.id,class:String(node.className),left:box.left,right:box.right,top:box.top,width:box.width,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,overflow:style.overflow,clip:style.clip,clipPath:style.clipPath,visibility:style.visibility,closedAncestor:node.closest('details:not([open])')?.className};})),null,2));
          }
          if(zoom===1||scene.toast)await page.screenshot({path:join(output,scene.name+'-'+width+'.png'),animations:'disabled'});
          if(!before&&scene.room==='project'){
            const actions=await page.locator('#project-create-form [type=submit],#project-publish').evaluateAll(nodes=>nodes.map(node=>{
              const box=node.getBoundingClientRect();return {id:node.id||'create-project',left:box.left,right:box.right,width:box.width};
            }));
            assert.equal(actions.length,2,'both project actions remain available');
            assert.ok(Math.abs(actions[0].left-actions[1].left)<=1&&Math.abs(actions[0].right-actions[1].right)<=1,
              'create and publish share both edges at every tested width: '+JSON.stringify({scene:scene.name,width,zoom,actions}));
            assert.equal(await page.locator('.wb-publish-control>.ui-info').count(),0,'publication help does not consume action width');
            assert.equal(await page.locator('.workspace-context-heading .field-caption>.ui-info>summary').count(),1,
              'project and publication share the existing title-row explanation');
            assert.match(await page.locator('.workspace-context-heading .ui-info-content').textContent(),
              /先完成上传并结束开发终端，再保存代码与环境版本。/,'the original publication explanation remains accessible');
          }

        }
        if(scene.toast)for(let cssWidth=213;cssWidth<=256;cssWidth++){
          await page.setViewportSize({width:cssWidth,height:Math.floor(700/zoom)});
          const measurement=await inspectOperationalGeometry(page,scene.spec);
          const text=await page.locator('#toast').evaluate(node=>({text:node.textContent,
            fontSize:parseFloat(getComputedStyle(node).fontSize),height:node.clientHeight,scrollHeight:node.scrollHeight,
            lines:(()=>{const range=document.createRange();range.selectNodeContents(node);return range.getClientRects().length;})()}));
          assert.equal(text.text,toastMessage,'long error text must remain complete');
          assert.ok(text.fontSize>=11,'error text stays readable');
          if(!before){assert.ok(text.lines>1,'long errors wrap');assert.ok(text.scrollHeight<=text.height+1,'long error text remains reachable');}
          caseRows.push({cssWidth,physicalWidth:cssWidth*zoom,physicalHeight:700,zoom,toast:true,...measurement});
        }
        if(full)caseRows.push(...await scanOperationalGeometry(page,scene.spec,{widths:layoutWidths,heights:layoutHeights,zoom}));
        assert.deepEqual(await page.evaluate(()=>operationalCSP),[],'same-origin resources obey Portal CSP');
        results.push({scene:scene.name,room:scene.room,role:scene.role,zoom,rows:caseRows});
        await writeFile(reportPath,JSON.stringify({before,results,errors,outside},null,2));
        console.log(JSON.stringify({scene:scene.name,zoom,measurements:caseRows.length,failed:caseRows.filter(row=>!row.pass).length}));
      }finally{for(const release of gates)release();await context.unrouteAll({behavior:'wait'});await context.close();}
    }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  const failed=results.flatMap(result=>result.rows.filter(row=>!row.pass).map(row=>({scene:result.scene,zoom:result.zoom,...row})));
  if(!before)assert.deepEqual(failed,[],'all rendered layout relationships pass');
  console.log(JSON.stringify({status:failed.length?'BASELINE-DEFECTS':'PASS',scenes:results.length,measurements:results.reduce((sum,row)=>sum+row.rows.length,0),failed:failed.length,reportPath}));
}finally{
  await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(service&&!service.closing)service.close();await rm(temporary,{recursive:true,force:true});
}
