import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../dist/',import.meta.url));
const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/datasets.css"><link rel="stylesheet" href="/dataset-flow.css">
<style>body{margin:0;padding:12px}*{box-sizing:border-box}input,select{max-width:100%;min-width:0}section{max-width:100%}</style></head>
<body><section id="page-datasets"></section><script type="module">
import{datasetsUI}from'/datasets-ui.js';
window.calls=[];let row=null;window.loseCopy=true;
window.store={production:true,authGeneration:1,principal:{userId:'demo-user-1',role:'member'},
users:[{id:'demo-user-1',enabled:true,limits:{'gpu-1':1,'gpu-2':1}}],data:{machines:[{id:'gpu-1'},{id:'gpu-2'}]},
call:async(operation,args)=>{calls.push({operation,args});
if(operation==='data.roots')return{directories:[{path:'/data/hdd',readOnly:true}],personal:{path:'/data/mine',readOnly:false}};
if(operation==='datasets.workspace.list')return{path:args.path,entries:[{name:'uploaded.bin',type:'file',size:3}]};
if(operation==='data.upload.status')return row||{state:'ABSENT',path:args.path,receivedBytes:0};
if(operation==='data.upload.begin'){row={...args,state:'UPLOADING',receivedBytes:0};return row;}
if(operation==='data.upload.chunk'){row={...row,receivedBytes:row.receivedBytes+atob(args.data).length};return row;}
if(operation==='data.upload.finish'){row={...row,state:'COMPLETE'};return row;}
if(operation==='data.copy.start'){if(window.loseCopy){window.loseCopy=false;throw Error('reply lost; original key retained');}return{state:'RUNNING',key:args.key};}
throw Error('Unexpected old-flow operation '+operation);}};
window.render=datasetsUI(store,()=>{});render();
</script></body></html>`;
const server=createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
    if(!/^\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(path)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(root+path.slice(1)));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.getByText('/data/hdd',{exact:true}).waitFor();
  assert.equal(await page.locator('#data-workspace-publish-form').count(),0);
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await page.locator('[name=data-workspace-files]').setInputFiles({name:'uploaded.bin',mimeType:'application/octet-stream',buffer:Buffer.from('abc')});
  await page.locator('#data-workspace-upload').click();await page.waitForFunction(()=>calls.some(c=>c.operation==='data.upload.finish'));
  await page.locator('[name=copy-from]').selectOption('gpu-2');
  await page.locator('[name=copy-source]').fill('imagenet');await page.locator('[name=copy-destination]').fill('datasets/imagenet');
  await page.locator('[data-copy-action=start]').click();await page.getByText('reply lost; original key retained',{exact:true}).waitFor();
  const key=await page.locator('[name=copy-key]').inputValue();assert.match(key,/^[a-f0-9-]{36}$/);
  await page.locator('[data-copy-action=start]').click();await page.waitForFunction(()=>calls.filter(c=>c.operation==='data.copy.start').length===2);
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.operation==='data.copy.start').map(c=>c.args.key)),[key,key]);
  assert.equal(await page.evaluate(()=>calls.some(c=>/publish|prepare|cache/.test(c.operation))),false);
  await page.evaluate(()=>{store.authGeneration++;render();});
  await page.locator('[name=data-workspace-files]').setInputFiles({name:'uploaded.bin',mimeType:'application/octet-stream',buffer:Buffer.from('abc')});
  const before=await page.evaluate(()=>calls.filter(c=>c.operation==='data.upload.status').length);
  await page.locator('#data-workspace-upload').click();
  await page.waitForFunction(n=>calls.filter(c=>c.operation==='data.upload.status').length>n,before);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.operation==='data.upload.status').length),before+1,'One upload listener after an auth refresh');
  assert.deepEqual(errors,[]);
  console.log('Direct storage UI: upload, original-key retry, account refresh and 1440/390/320 passed');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
