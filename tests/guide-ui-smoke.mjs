// Loopback-only acceptance of the public guide. No real account, node, SSH,
// training, download or external API is contacted. Screenshots are test output.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {createServer} from '../server.mjs';
import {createPortalServer} from '../portal-server.mjs';
import {DEMO_ADMIN,DEMO_MEMBER_PASSWORD} from '../dist/service.js';

// Keep these expectations independent of the renderer's chapter registry.
const chapters=[
  ['start','首次使用'],['development','项目开发'],['training','提交训练'],
  ['data','数据集'],['results','日志与结果'],['queue','排队与协作'],
  ['troubleshooting','常见问题'],
];
const chapterPaths=chapters.map(([id])=>'/guide/'+id);
const deniedPaths=['/guide/admin','/guide/admin/','/ADMIN_README.md'];
const screenshots=process.env.UI_SCREENSHOTS||'/tmp/gpuq-guide-ui';
const folder=await mkdtemp(join(tmpdir(),'gpuq-guide-'));
const pageErrors=[],blocked=[],unexpectedHTTP=[],bridgeCalls=[],entryErrors=[];
let server,portal,browser;

async function reservePort(){
  const temporary=net.createServer();
  await new Promise(resolve=>temporary.listen(0,'127.0.0.1',resolve));
  const port=temporary.address().port;
  await new Promise(resolve=>temporary.close(resolve));
  return port;
}
async function closeServer(value){
  if(!value)return;
  value.closeAllConnections?.();
  await new Promise(resolve=>value.close(resolve));
}
try{
  await mkdir(screenshots,{recursive:true});
  server=await createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});

  async function context(options={}){
    const result=await browser.newContext({viewport:{width:1440,height:1050},...options});
    await result.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();
      blocked.push(url.href);return route.abort('blockedbyclient');
    });
    result.on('page',page=>{
      page.on('pageerror',error=>pageErrors.push(error.message));
      page.on('response',response=>{
        const path=new URL(response.url()).pathname;
        if(response.status()>=400&&!deniedPaths.includes(path)&&path!=='/favicon.ico')
          unexpectedHTTP.push({path,status:response.status()});
      });
    });
    return result;
  }
  async function capture(page,name){
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:join(screenshots,name),fullPage:true});
  }
  async function noAdminLinks(page){
    const links=await page.locator('a[href]').evaluateAll(items=>items.map(item=>item.getAttribute('href')));
    assert.ok(links.every(href=>!/(?:\/guide\/admin(?:[/?#]|$)|ADMIN_README)/i.test(href)),JSON.stringify(links));
  }
  async function noPageOverflow(page,label){
    // Navigation backgrounds transition for 140 ms. The chapter number changes
    // immediately, so measure the settled colors rather than an intermediate
    // frame whose foreground and background belong to different nav states.
    await page.evaluate(async()=>{
      for(;;){
        const animations=document.getAnimations().filter(animation=>
          animation.playState!=='finished'&&animation.effect?.getComputedTiming().iterations!==Infinity);
        if(!animations.length)return;
        await Promise.all(animations.map(animation=>animation.finished.catch(error=>{
          if(error.name!=='AbortError')throw error;
        })));
      }
    });
    const size=await page.evaluate(()=>({viewport:innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
    assert.ok(size.html<=size.viewport+1&&size.body<=size.viewport+1,`${label}: ${JSON.stringify(size)}`);
    const contrast=await page.evaluate(()=>{
      const rgba=value=>{const v=value.match(/[\d.]+/g)?.map(Number);return v?.length>=3?[...v.slice(0,3),v[3]??1]:[255,255,255,1];};
      const over=(fg,bg)=>fg.slice(0,3).map((c,i)=>c*fg[3]+bg[i]*(1-fg[3]));
      const lum=rgb=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      return [...document.querySelectorAll('.guide-lead,.guide-card p,.guide-number,.guide-footer,.guide-brand small,.guide-section-heading>span')].filter(el=>el.getClientRects().length).flatMap(el=>{
        const parents=[];for(let n=el;n;n=n.parentElement)parents.unshift(n);
        const bg=parents.reduce((color,n)=>over(rgba(getComputedStyle(n).backgroundColor),color),[255,255,255]);
        const a=lum(over(rgba(getComputedStyle(el).color),bg)),b=lum(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        return ratio>=4.5?[]:[{className:el.className,ratio,text:el.textContent.trim().slice(0,40)}];
      });
    });
    assert.deepEqual(contrast,[],`${label}: guide helper text retains AA contrast`);
  }
  async function chapter(page,index,{scripts=true}={}){
    await page.waitForLoadState('domcontentloaded');
    const [id,title]=chapters[index];
    assert.equal(new URL(page.url()).pathname,'/guide/'+id);
    assert.equal(await page.locator('h1').count(),1);
    assert.equal(await page.locator('h1').textContent(),title);
    const nav=page.getByRole('navigation',{name:'指南章节'});
    assert.deepEqual(await nav.locator('a').evaluateAll(items=>items.map(item=>item.getAttribute('href'))),chapterPaths);
    assert.equal(await nav.locator('[aria-current=page]').count(),1);
    assert.equal(await nav.locator('[aria-current=page]').getAttribute('href'),'/guide/'+id);
    assert.ok((await page.locator('.guide-prose').innerText()).length>100,`${id} must have real content`);
    const sections=await page.locator('.guide-prose h2').evaluateAll(nodes=>nodes.map(node=>node.id));
    assert.deepEqual(await page.locator('.guide-toc a').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href'))),sections.map(value=>'#'+value));
    assert.equal(new Set(sections).size,sections.length);
    assert.equal(await page.locator('.guide-code-bar>span').evaluateAll(nodes=>nodes.every(node=>['本机终端','项目开发终端','数据终端'].includes(node.textContent))),true,'actual guide blocks state where their commands run');
    assert.equal(await page.locator('.guide-code .copy-code:visible').count(),scripts?await page.locator('.guide-code').count():0);
    const adjacent=page.getByRole('navigation',{name:'相邻章节'}).locator('a');
    assert.deepEqual(await adjacent.evaluateAll(items=>items.map(item=>item.getAttribute('href'))),
      [chapterPaths[index-1],chapterPaths[index+1]].filter(Boolean));
    assert.equal(await page.locator('.guide-return').getAttribute('href'),'/');
    await noAdminLinks(page);
    const budget=await page.evaluate(()=>[...document.querySelectorAll('.guide-prose p')].filter(node=>{
      if(node.closest('details:not([open])'))return false;
      const rect=node.getBoundingClientRect();return rect.bottom>0&&rect.top<innerHeight;
    }).reduce((lines,node)=>lines+Math.ceil(node.getBoundingClientRect().height/parseFloat(getComputedStyle(node).lineHeight)),0));
    assert.ok(budget<=(page.viewportSize().width<760?1:2),`${id}: first-screen explanations fit COPY (${budget} lines)`);
  }

  // Both ordinary and administrator workbenches expose the same one entry.
  const interactive=await context();
  await interactive.grantPermissions(['clipboard-read','clipboard-write'],{origin});
  const workbench=await interactive.newPage();
  async function login(page,username,password){
    await page.goto(origin);
    await page.locator('#login-form [name=username]').fill(username);
    await page.locator('#login-form [name=password]').fill(password);
    await page.locator('#login-form [type=submit]').click();
    await page.locator('#login-dialog').waitFor({state:'hidden'});
    const count=await page.locator('.guide-link').count();
    if(count!==1)entryErrors.push(`${username}: expected one workbench guide entry, found ${count}`);
    assert.equal(await page.locator('[data-user-guide]').count(),0,'no secondary execution guide button duplicates the shared entry');
    const entries=page.locator('.guide-link');
    assert.equal(await entries.count(),1,'the shared guide entry must exist exactly once');
    assert.equal(await entries.getAttribute('href'),'/guide');
    assert.equal(await entries.isVisible(),true);
    await noAdminLinks(page);
    return entries;
  }
  const entry=await login(workbench,'chen-research',DEMO_MEMBER_PASSWORD);
  let guide=workbench;
  if(await entry.getAttribute('target')==='_blank'){
    [guide]=await Promise.all([interactive.waitForEvent('page'),entry.click()]);
  }else await entry.click();
  await guide.waitForLoadState('domcontentloaded');
  assert.equal(new URL(guide.url()).pathname,'/guide');
  assert.equal(await guide.locator('.guide-card').count(),7);
  assert.deepEqual(await guide.locator('.guide-card').evaluateAll(items=>items.map(item=>item.getAttribute('href'))),chapterPaths);
  await noAdminLinks(guide);
  await capture(guide,'guide-index-desktop.png');

  let copied=0,multilineCopied=0;
  for(let index=0;index<chapters.length;index++){
    await guide.goto(origin+'/guide');
    await guide.locator(`.guide-card[href="${chapterPaths[index]}"]`).click();
    await chapter(guide,index);
    const blocks=guide.locator('.guide-code');
    for(let n=0;n<await blocks.count();n++){
      const block=blocks.nth(n),text=await block.locator('pre code').textContent();
      assert.ok(text.length>0,'copy text is actual nonempty code');
      await block.locator('.copy-code').click();
      await block.locator('.copy-code').filter({hasText:/^已复制$/}).waitFor();
      assert.equal(await guide.locator('#guide-copy-status').textContent(),'命令已复制。');
      assert.equal(await guide.evaluate(()=>navigator.clipboard.readText()),text,'clipboard preserves code text and line breaks, not labels or HTML');
      assert.equal(await block.locator('.copy-code').textContent(),'已复制');
      copied++;if(text.includes('\n'))multilineCopied++;
    }
    if(index===1){
      const container=guide.getByRole('heading',{name:'个人容器',exact:true});
      await container.waitFor({state:'visible'});
      const explanation=container.locator('xpath=following-sibling::details[1]');
      assert.equal(await explanation.getAttribute('class'),'guide-explanation');
      assert.equal(await explanation.evaluate(node=>node.open),false,'container details stay out of the first-screen explanation budget');
      await explanation.locator('summary').click();
      assert.match(await explanation.innerText(),/容器内 root 不是服务器 root，开发阶段无 GPU/);
      assert.match(await explanation.innerText(),/发布前先结束所有开发终端/);
      assert.match(await explanation.innerText(),/先选好要训练的版本.*训练固定该镜像版本/);
      const containerCommand=explanation.locator('p>code').filter({hasText:'gpuctl project create system-project'});
      assert.equal(await containerCommand.evaluate(node=>getComputedStyle(node).whiteSpace),'nowrap','desktop inline command stays on one line');
      assert.equal(await containerCommand.evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);return range.getClientRects().length;}),1);
      await noPageOverflow(guide,'desktop personal container');
      await container.evaluate(node=>window.scrollTo(0,window.scrollY+node.getBoundingClientRect().top-80));
      await guide.screenshot({path:join(screenshots,'guide-container-1440.png')});
      await guide.setViewportSize({width:390,height:844});
      await container.evaluate(node=>window.scrollTo(0,window.scrollY+node.getBoundingClientRect().top-80));
      assert.equal(await containerCommand.evaluate(node=>getComputedStyle(node).whiteSpace),'normal','mobile inline command may wrap');
      assert.ok(await guide.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'personal container guidance fits 390px');
      await guide.screenshot({path:join(screenshots,'guide-container-390.png')});
      await guide.setViewportSize({width:1440,height:1050});
      await explanation.locator('summary').click();
      await capture(guide,'guide-development-desktop.png');
    }
    if(index===2)await capture(guide,'guide-training-desktop.png');
    if(index===3){
      const direct=guide.locator('.guide-explanation').filter({hasText:'网页选择目录后'});
      await direct.locator('summary').click();
      assert.match(await direct.innerText(),/路线显示实际仓库的直传入口，路径中没有门户中转/);
      assert.match(await direct.innerText(),/实际入库位置与训练目标可以不同/);
      assert.match(await direct.innerText(),/如果只提供中转或无法确认路线，先停止/);
      assert.match(await direct.innerText(),/--via direct/);
      const workspace=guide.locator('.guide-explanation').filter({hasText:'已有文件或外接硬盘中的大数据'});
      await workspace.locator('summary').click();
      assert.match(await workspace.innerText(),/能够直接读取就共用原目录，不必再入库/);
      assert.match(await workspace.innerText(),/需要固定快照或跨机副本时，联系管理员从原位置整理并入仓库/);
      assert.match(await guide.locator('.guide-prose').textContent(),/多个任务共用原目录，不用上传、发布或准备另一份副本/);
      assert.match(await workspace.innerText(),/不要把训练缓存当作长期数据仓库/);
      assert.match(await workspace.innerText(),/压缩包不会自动解压/);
      const dataText=await guide.locator('.guide-prose').textContent();
      assert.doesNotMatch(dataText,/机械|固态|原件|\b(?:SSD|HDD)\b/);
      assert.match(dataText,/gpuctl data upload \.\/my-data --name my-data --via direct/);
      assert.match(dataText,/gpuctl transfer upload \.\/my-data --name my-data --via direct/);
      assert.doesNotMatch(dataText,/云盘|云端副本|分享链接|链接导入|gpuctl data (?:cloud|import|put)|--via relay/);
      await direct.locator('summary').click();
      await workspace.locator('summary').click();
    }
    // Follow the actual next/previous links, not just their href values.
    if(index<chapters.length-1){
      await guide.getByRole('navigation',{name:'相邻章节'}).locator('a').last().click();
      await chapter(guide,index+1);
      await guide.getByRole('navigation',{name:'相邻章节'}).locator('a').first().click();
      await chapter(guide,index);
    }
  }
  assert.ok(copied>=10&&multilineCopied>=3,'exercise real single- and multi-line command blocks');

  // Clipboard denial degrades to an accurate selection with an announced hint.
  await guide.goto(origin+'/guide/start');
  await guide.evaluate(()=>{Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw Error('fixture clipboard denied');}});});
  const fallback=guide.locator('.guide-code').first();
  const fallbackText=await fallback.locator('code').textContent();
  await fallback.locator('button').click();
  await guide.waitForFunction(()=>document.querySelector('#guide-copy-status').textContent.includes('手动复制'));
  assert.equal(await guide.evaluate(()=>getSelection().toString()),fallbackText);
  assert.equal(await fallback.locator('button').textContent(),'已选中，请复制');

  // Keyboard: the first stop is a visible skip link, then ordinary links work.
  await guide.goto(origin+'/guide');
  await guide.keyboard.press('Tab');
  assert.equal(await guide.evaluate(()=>document.activeElement.className),'guide-skip');
  assert.equal(await guide.locator('.guide-skip').isVisible(),true);
  assert.notEqual(await guide.locator('.guide-skip').evaluate(item=>getComputedStyle(item).outlineStyle),'none');
  await guide.keyboard.press('Enter');
  assert.equal(await guide.evaluate(()=>document.activeElement.id),'guide-main');
  await guide.locator('.guide-start').focus();
  await Promise.all([guide.waitForURL(origin+'/guide/start'),guide.keyboard.press('Enter')]);
  await chapter(guide,0);
  await guide.getByRole('navigation',{name:'指南章节'}).locator('a[href="/guide/results"]').focus();
  await Promise.all([guide.waitForURL(origin+'/guide/results'),guide.keyboard.press('Enter')]);
  await chapter(guide,4);

  // Every chapter fits a phone; long commands scroll within their own block.
  await guide.setViewportSize({width:390,height:844});
  await guide.goto(origin+'/guide');await noPageOverflow(guide,'index 390px');
  await capture(guide,'guide-index-mobile.png');
  let scrollingCode=0;
  for(let index=0;index<chapters.length;index++){
    await guide.goto(origin+chapterPaths[index]);await chapter(guide,index);
    await noPageOverflow(guide,chapters[index][0]+' 390px');
    scrollingCode+=await guide.locator('.guide-code pre').evaluateAll(blocks=>blocks.filter(block=>{
      if(block.scrollWidth<=block.clientWidth+1)return false;
      block.scrollLeft=block.scrollWidth;const scrolled=block.scrollLeft>0;block.scrollLeft=0;return scrolled;
    }).length);
    if([1,2,3,6].includes(index))await capture(guide,`guide-${chapters[index][0]}-mobile.png`);
  }
  assert.ok(scrollingCode>0,'long command lines should scroll internally without widening the page');
  await guide.setViewportSize({width:320,height:844});
  await guide.goto(origin+'/guide');await noPageOverflow(guide,'index 320px');await capture(guide,'guide-index-320.png');
  for(let index=0;index<chapters.length;index++){
    await guide.goto(origin+chapterPaths[index]);await chapter(guide,index);
    await noPageOverflow(guide,chapters[index][0]+' 320px');
  }
  await capture(guide,'guide-troubleshooting-320.png');

  // Force the real sidebar transition to begin at a known frame. The existing
  // AA assertion must wait for it, but still reject genuinely unreadable text.
  const transitioning=await guide.evaluate(()=>{
    const link=document.querySelector('.guide-sidebar [aria-current=page]');
    link.style.transition='none';link.removeAttribute('aria-current');
    getComputedStyle(link).backgroundColor;
    link.style.removeProperty('transition');link.setAttribute('aria-current','page');
    getComputedStyle(link).backgroundColor;
    const animations=link.getAnimations();
    for(const animation of animations){animation.pause();animation.currentTime=0;}
    const number=link.querySelector('.guide-number');
    const colors={foreground:getComputedStyle(number).color,background:getComputedStyle(link).backgroundColor};
    for(const animation of animations)animation.play();
    return {count:animations.length,colors};
  });
  assert.ok(transitioning.count>0,'regression exercises the real navigation color transition');
  await noPageOverflow(guide,'settled navigation transition 320px');
  const unreadable=guide.locator('.guide-sidebar [aria-current=page] .guide-number');
  await unreadable.evaluate(number=>{number.style.color=getComputedStyle(number.parentElement).backgroundColor;});
  await assert.rejects(noPageOverflow(guide,'unreadable final color fixture'),/guide helper text retains AA contrast/,
    'the unchanged 4.5 threshold still rejects an unreadable final color');
  await unreadable.evaluate(number=>number.style.removeProperty('color'));
  await noPageOverflow(guide,'restored navigation contrast 320px');
  await writeFile(join(screenshots,'guide-navigation-contrast.json'),JSON.stringify({
    transition:transitioning,
    settled:await unreadable.evaluate(number=>({
      foreground:getComputedStyle(number).color,
      background:getComputedStyle(number.parentElement).backgroundColor,
      animations:document.getAnimations().length,
    })),
    minimumContrast:4.5,
    unreadableFinalColorRejected:true,
  },null,2));

  // The document and all navigation remain functional without JavaScript.
  const staticContext=await context({javaScriptEnabled:false,viewport:{width:390,height:844}});
  const staticPage=await staticContext.newPage();
  await staticPage.goto(origin+'/guide');
  assert.equal(await staticPage.locator('.guide-card').count(),7);
  for(let index=0;index<chapters.length;index++){
    if(index===0)await staticPage.locator('.guide-card[href="/guide/start"]').click();
    else await staticPage.getByRole('navigation',{name:'相邻章节'}).locator('a').last().click();
    await chapter(staticPage,index,{scripts:false});
    await noPageOverflow(staticPage,'no-JS '+chapters[index][0]);
  }
  await staticPage.goto(origin+'/guide/development');
  assert.match(await staticPage.locator('.guide-prose').innerText(),/gpuctl project create/);
  await staticPage.locator('.guide-toc summary').click();
  const destination=await staticPage.locator('.guide-toc a').last().getAttribute('href');
  await staticPage.locator('.guide-toc a').last().click();assert.equal(new URL(staticPage.url()).hash,destination);
  assert.equal(await staticPage.evaluate(()=>document.activeElement.id),destination.slice(1),'native contents links focus the section without JavaScript');
  await capture(staticPage,'guide-development-no-js-mobile.png');
  const adminContext=await context(),admin=await adminContext.newPage();
  await login(admin,DEMO_ADMIN.username,DEMO_ADMIN.password);

  // Check production route parity with a disposable DB, never a bridge/node.
  const bootstrap=join(folder,'bootstrap.json'),port=await reservePort(),productionOrigin='http://127.0.0.1:'+port;
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Guide-Fixture-Only-2026!'}),{mode:0o600});
  portal=await createPortalServer({database:join(folder,'portal.sqlite'),bootstrap,origin:productionOrigin,secure:false,
    bridge:async(...args)=>{bridgeCalls.push(args);throw Error('Guide acceptance must never contact an executor');}});
  clearInterval(portal.service.executionTimer);
  await new Promise(resolve=>portal.server.listen(port,'127.0.0.1',resolve));
  for(const base of [origin,productionOrigin]){
    for(const path of ['/guide',...chapterPaths]){
      const response=await fetch(base+path);
      assert.equal(response.status,200,`${base}${path}`);
      assert.match(response.headers.get('content-type'),/text\/html/);
      const text=await response.text();assert.match(text,/<h1>/);assert.doesNotMatch(text,/href="\/guide\/admin/);
      const head=await fetch(base+path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    }
    for(const path of deniedPaths){
      const response=await fetch(base+path);assert.equal(response.status,404,`${path} must not publish an administrator manual`);
      assert.doesNotMatch(await response.text(),/gpuctl ssh[^\n]*--root|管理员手册/);
    }
    for(const [old,target] of [['/guide/user','/guide/start'],['/guide/projects','/guide/development'],['/guide/datasets','/guide/data']]){
      const response=await fetch(base+old);assert.equal(response.status,200);assert.equal(new URL(response.url).pathname,target);
    }
  }
  assert.deepEqual(entryErrors,[]);assert.deepEqual(pageErrors,[]);assert.deepEqual(unexpectedHTTP,[]);assert.deepEqual(blocked,[]);assert.deepEqual(bridgeCalls,[]);
  console.log(`GUIDE UI PASS: single workbench entry for member/admin; seven chapters; ${copied} exact clipboard copies; fallback, keyboard, no-JS, 320/390px layout, public-route parity; screenshots: ${screenshots}`);
}finally{
  await browser?.close();
  await closeServer(portal?.server);await closeServer(server);
  await rm(folder,{recursive:true,force:true});
}
