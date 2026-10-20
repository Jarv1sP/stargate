// Use the mainline frame renderer and runtime unchanged, with a local zero-permission package.
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const mainline=process.env.WORKSHOP_ROOT;
if(!mainline)throw Error('Set WORKSHOP_ROOT to the checkout containing workshop-frame.mjs');
const {chromium}=await import(pathToFileURL(resolve(mainline,'node_modules/playwright/index.mjs')));
const {renderWorkshopFrame}=await import(pathToFileURL(resolve(mainline,'workshop-frame.mjs')));
const {normalizeWorkshopPackage}=await import(pathToFileURL(resolve(mainline,'dist/workshop-package.js')));
const pkg=normalizeWorkshopPackage(JSON.parse(await readFile(process.argv[2],'utf8')));
assert.deepEqual(pkg.permissions,[]);
let origin;
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,origin).pathname;
 if(path.startsWith('/workshop/frame/')){const frame=renderWorkshopFrame(pkg,{origin,nonce:'fixtureNonce1234567890abcd'});res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':frame.csp});return res.end(frame.html);}
 if(path==='/'){res.writeHead(200,{'Content-Type':'text/html'});return res.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/workshop.css"></head><body class="sb"><div class="shell"><button id="portal-action">原平台</button><div id="widgets"></div></div><script type="module">import {createWorkshopRuntime} from '/workshop-runtime.js';const store={principal:{userId:'fixture'},authGeneration:1,onAuthChange:()=>()=>{},jobs:[],data:{}};window.exits=[];const runtime=createWorkshopRuntime({store,root:document.querySelector('#widgets'),navigate(){},toast(){},exitInterface:id=>{exits.push(id);runtime.setInstalled([]);}});runtime.setInstalled([{item:{id:'demo',version:'v1'},package:${JSON.stringify(pkg)}}]);</script></body></html>`);}
 if(['/workshop.css','/workshop-runtime.js','/workshop-package.js'].includes(path)){res.writeHead(200,{'Content-Type':extname(path)==='.css'?'text/css':'text/javascript'});return res.end(await readFile(resolve(mainline,'dist','.'+path)));}
 res.writeHead(404).end();
});
let browser;
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin);const f=page.frameLocator('iframe');if(pkg.presentation!=='interface')await f.locator('#demo-open').click();await f.locator('.mside').waitFor();
 if(pkg.presentation==='interface'){assert.equal(await page.locator('iframe').evaluate(n=>n.getBoundingClientRect().height),1000);assert.equal(await page.locator('.shell').evaluate(n=>n.inert),true);assert.equal(await page.locator('iframe').evaluate(n=>n.getBoundingClientRect().width),1440);}
 const frame=page.frames().find(frame=>frame.url().includes('/workshop/frame/'));
 const go=async route=>{await frame.evaluate(route=>ROUTE.go(ROUTE.AIDP+route),route);await f.locator('.pg-title,.crumb').first().waitFor();};
 await go('model-develop/training/j3');await f.locator('[data-act=jobTab][data-t=log]').click();await f.locator('.log').filter({hasText:'exit status 127'}).waitFor();
 await f.locator('[data-act=logDl]').click();await f.locator('.workshop-demo-text').filter({hasText:'exit status 127'}).waitFor();await f.locator('.dialog [data-x]').click();
 await go('model-develop/notebook');await f.locator('[data-act=nbOpen][data-id=n1]').click();await f.getByText('Launcher',{exact:true}).first().waitFor();await page.keyboard.press('Alt+ArrowLeft');await f.locator('[data-act=nbNew]').waitFor();
 await go('model-develop/automl');await f.locator('[data-act=demoNew]').click();await f.locator('.dialog [name=name]').fill('工坊内创建');await f.locator('.dialog [data-ok]').click();await f.locator('.tbl').filter({hasText:'工坊内创建'}).waitFor();
 assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
 assert.equal(await frame.evaluate(()=>{try{localStorage.getItem('x');return false;}catch{return true;}}),true);
 assert.equal(await page.locator('.workshop-widget>.form-error').isVisible(),false);
 await mkdir('out/ceake-demo/工坊验证截图',{recursive:true});await page.screenshot({path:'out/ceake-demo/工坊验证截图/组件实际运行.png'});
 if(pkg.presentation==='interface'){assert.equal(await page.locator('.workshop-interface-actions').count(),0);await f.locator('#demo-search').focus();await page.keyboard.press('Control+Alt+0');await page.locator('.workshop-interface').waitFor({state:'detached'});assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.locator('.shell').evaluate(n=>n.inert),false);assert.equal(await page.locator('#portal-action').isVisible(),true);assert.deepEqual(await page.evaluate(()=>exits),['demo']);await page.goto(origin+'/?workshop=off');assert.equal(await page.locator('iframe').count(),0);}
 assert.deepEqual(errors,[]);console.log('PASS actual frame CSP + runtime, open, failure log/text export, same-frame Notebook, mock create, zero permissions, opaque storage blocked');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
