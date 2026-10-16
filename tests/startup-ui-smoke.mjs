import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../dist'),origin='https://startup-offline.test',temporary=await mkdtemp(join(tmpdir(),'stargate-startup-'));
const shots=process.env.UI_SCREENSHOTS||temporary;await mkdir(shots,{recursive:true});
// The cover exactly as the platform page ships it; window.start stands in for the app finishing its first render.
const index=await readFile(resolve(root,'index.html'),'utf8'),cover=index.match(/<button id="startup-wordmark"[\s\S]*?<\/button>/)[0];
// With every platform stylesheet behind it, as shipped, so app rules that would hide or restyle the opening show up here.
const sheets=[...index.matchAll(/<link rel="stylesheet" href="\.\/([^"]+\.css)" \/>/g)].map(match=>match[1]).filter(name=>name!=='splash.css');
const page_=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/splash.css"><body class="sb root">${cover}${sheets.map(name=>'<link rel="stylesheet" href="/'+name+'">').join('')}<script type="module">import {installWordmark} from '/startup-ui.js';window.start=installWordmark;</script>`;
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  for(const scenario of ['normal','slow','skip','reduce']){
    const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:scenario==='reduce'?'reduce':'no-preference'}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());assert.equal(url.origin,origin);
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:page_});
      return route.fulfill({contentType:extname(url.pathname)==='.js'?'text/javascript':'text/css',body:await readFile(resolve(root,'.'+url.pathname))});
    });
    const cover=page.locator('#startup-wordmark'),since=()=>page.evaluate(()=>performance.now());
    await page.goto(origin);await page.waitForFunction(()=>typeof window.start==='function');
    assert.equal(await cover.isVisible(),true,'the opening is up from the first paint, before the app runs');
    if(scenario==='reduce'){
      assert.equal(await page.locator('.lift-word').evaluate(node=>getComputedStyle(node).opacity),'1','reduced motion holds the finished wordmark');
      assert.deepEqual(await cover.evaluate(node=>node.getAnimations({subtree:true}).map(animation=>animation.animationName).filter(name=>!/^startup-(fallback|wait)$/.test(name))),[],'no lift-off under reduced motion');
      await page.evaluate(()=>window.start());await cover.waitFor({state:'hidden',timeout:2000});
    }else{
      assert.equal(await page.locator('.lift-rocket').count(),1,'Λ in its ring lifts off');
      const lambda=await page.locator('.auth-lambda').evaluate(node=>{const timing=node.getAnimations()[0].effect.getTiming();return {duration:timing.duration,delay:timing.delay,easing:getComputedStyle(node).animationTimingFunction};});
      assert.deepEqual(lambda,{duration:600,delay:1550,easing:'cubic-bezier(0.2, 0.8, 0.2, 1)'});
      assert.equal(await cover.evaluate(node=>node.getAnimations().find(animation=>animation.animationName==='startup-fallback').effect.getTiming().delay),15000,'steps aside after 15 s even if the app never runs');
      assert.deepEqual(await cover.evaluate(node=>[...new Set(node.getAnimations({subtree:true}).filter(animation=>/^(lift-|auth-lambda)/.test(animation.animationName)).flatMap(animation=>animation.effect.getKeyframes().flatMap(Object.keys)))].filter(key=>!['offset','computedOffset','easing','composite','transform','opacity'].includes(key))),[],'the lift-off moves only transform and opacity, so loading underneath never stalls it');
      if(scenario==='normal'){
        await page.evaluate(()=>window.start());await page.waitForTimeout(Math.max(0,1500-await since()));
        await page.screenshot({path:join(shots,'startup-1440.png')});
        assert.equal(await cover.isVisible(),true,'a ready app still waits for one full lift-off');
        await cover.waitFor({state:'hidden',timeout:4000});assert.ok(await since()>=2150,'opened after the cycle');
      }else if(scenario==='slow'){
        await page.waitForTimeout(Math.max(0,3200-await since()));
        assert.equal(await cover.isVisible(),true);assert.equal(await page.locator('.startup-status').evaluate(node=>getComputedStyle(node).opacity),'1','still loading shows the scan line and status');
        await page.screenshot({path:join(shots,'startup-waiting-1440.png')});
        await page.evaluate(()=>window.start());await cover.waitFor({state:'hidden',timeout:1500});
      }else{
        await page.evaluate(()=>window.start());await cover.click();await cover.waitFor({state:'hidden',timeout:1000});
      }
    }
    await page.reload();await page.waitForFunction(()=>typeof window.start==='function');assert.equal(await cover.isVisible(),true,'every page load opens with it');
    assert.deepEqual(errors,[]);await context.close();console.log('startup '+scenario+' PASS');
  }
}finally{await browser.close();if(!process.env.UI_SCREENSHOTS)await rm(temporary,{recursive:true,force:true});}
