import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../dist'),origin='https://startup-offline.test',temporary=await mkdtemp(join(tmpdir(),'stargate-startup-'));
const shots=process.env.UI_SCREENSHOTS||temporary;await mkdir(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  for(const scenario of ['normal','skip','reduce','reduce-change']){
    const reducedMotion=scenario==='reduce'?'reduce':'no-preference';
    const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());assert.equal(url.origin,origin);
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/portal-shell.css"><body class="sb root"><button id="startup-wordmark" class="startup-wordmark" type="button" hidden aria-label="跳过开场动画"></button><main>算力</main><script type="module">import {installWordmark} from "/startup-ui.js";window.start=installWordmark;</script>'});
      return route.fulfill({contentType:extname(url.pathname)==='.js'?'text/javascript':extname(url.pathname)==='.css'?'text/css':'application/octet-stream',body:await readFile(resolve(root,'.'+url.pathname))});
    });
    await page.goto(origin);await page.waitForFunction(()=>typeof window.start==='function');await page.evaluate(()=>document.fonts.ready);
    // Freeze the original 650ms lifecycle while inspecting the animation midpoint.
    await page.clock.install({time:new Date('2026-10-15T18:00:00Z')});await page.clock.pauseAt(new Date('2026-10-15T18:00:01Z'));
    await page.evaluate(()=>window.start());
    if(reducedMotion==='reduce'){
      assert.equal(await page.locator('#startup-wordmark').isVisible(),false);assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
    }else{
      await page.locator('#startup-wordmark').waitFor({state:'visible'});
      const timing=await page.locator('.auth-lambda').evaluate(node=>{const animation=node.getAnimations()[0];animation.pause();animation.currentTime=300;return {duration:animation.effect.getTiming().duration,easing:getComputedStyle(node).animationTimingFunction};});
      assert.equal(timing.duration,600);assert.equal(timing.easing,'cubic-bezier(0.2, 0.8, 0.2, 1)');
      assert.equal(await page.locator('#startup-wordmark circle').count(),0,'original A ignition has no prototype gate rings');
      if(scenario==='normal')await page.screenshot({path:join(shots,'startup-1440.png')});
      if(scenario==='skip')await page.locator('#startup-wordmark').click();else if(scenario==='reduce-change')await page.emulateMedia({reducedMotion:'reduce'});else await page.clock.runFor(650);
      assert.equal(await page.locator('#startup-wordmark').isVisible(),false);
    }
    await page.reload();await page.waitForFunction(()=>typeof window.start==='function');await page.evaluate(()=>window.start());assert.equal(await page.locator('#startup-wordmark').isVisible(),false,'same browser session does not replay');
    assert.deepEqual(errors,[]);await context.close();console.log('startup '+scenario+' PASS');
  }
}finally{await browser.close();if(!process.env.UI_SCREENSHOTS)await rm(temporary,{recursive:true,force:true});}
