// Actual Chromium HTTPS/CORS/CSP probe. Only disposable local certs use the
// test context's TLS exception; the product never bypasses browser trust.
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const dir=await mkdtemp(join(tmpdir(),'fixed-upload-browser-'));
let browser,node,portal,origin,primary,alternate,allowAlternate=false;
const observed=[],errors=[],revision='a'.repeat(64);
try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
  const tls={key:await readFile(join(dir,'key')),cert:await readFile(join(dir,'cert'))};
  node=createServer(tls,(req,res)=>{
    observed.push({url:req.url,cookie:req.headers.cookie,authorization:req.headers.authorization,origin:req.headers.origin});
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':origin,'Cache-Control':'no-store'});
    res.end(JSON.stringify({protocol:'dataset-upload-v1',machine:req.headers.host.startsWith('localhost:')?'wrong-node':'node-a',revision,listenerReady:true}));
  });
  await new Promise(resolve=>node.listen(0,'127.0.0.1',resolve));
  primary='https://localhost:'+node.address().port;alternate='https://127.0.0.1:'+node.address().port;
  portal=createServer(tls,async(req,res)=>{
    try{
      if(req.url==='/'){
        res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':`default-src 'none'; script-src 'self'; connect-src ${primary}${allowAlternate?' '+alternate:''};`});
        return res.end('<!doctype html><title>Local upload routing fixture</title>');
      }
      if(!['/upload-routes.js','/dataset-upload.js','/campus-ticket-time.js'].includes(req.url)){res.writeHead(404);return res.end();}
      res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile(new URL('../dist'+req.url,import.meta.url)));
    }catch(error){errors.push(error.message);res.destroy();}
  });
  await new Promise(resolve=>portal.listen(0,'127.0.0.1',resolve));origin='https://127.0.0.1:'+portal.address().port;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({ignoreHTTPSErrors:true});
  await context.addCookies([{name:'portal-session-fixture',value:'must-not-leak',url:origin,httpOnly:true,secure:true}]);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const run=()=>page.evaluate(async({primary,alternate,revision})=>{
    const {selectUploadRoute}=await import('/upload-routes.js');const {probeBrowserUploadRoute}=await import('/dataset-upload.js');
    const descriptor={available:true,protocol:'dataset-upload-v1',machine:'node-a',revision,certificateSha256:'b'.repeat(64),routes:[
      {id:'primary',kind:'campus-direct',endpoint:primary},{id:'tail',kind:'tail-upload',endpoint:alternate}]};
    try{return {id:(await selectUploadRoute(descriptor,'node-a',route=>probeBrowserUploadRoute(route))).id};}
    catch(error){return {error:error.message};}
  },{primary,alternate,revision});
  await page.goto(origin);assert.match((await run()).error,/no ticket issued/);
  assert.ok(observed.every(row=>row.url==='/capabilities'));
  const before=observed.length;allowAlternate=true;await page.reload();assert.deepEqual(await run(),{id:'tail'});
  assert.ok(observed.length>before);assert.ok(observed.every(row=>row.cookie===undefined&&row.authorization===undefined&&row.origin===origin));
  assert.deepEqual(errors,[]);await context.close();
  console.log('PASS real Chromium: exact CSP denies unlisted alternate, permits listed origin; anonymous cross-origin probes omit cookies and bearer; machine/revision select fixed tail route.');
}finally{
  await browser?.close();for(const server of [portal,node])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(dir,{recursive:true,force:true});
}
