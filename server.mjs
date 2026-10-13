import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {DemoService} from './dist/service.js';
import {guideTarget,guidePage} from './guide.mjs';
import {STARBASE_ASSETS} from './frontend-assets.mjs';
const routes={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/workspace.css':'workspace.css','/datasets.css':'datasets.css','/app.js':'app.js','/model.js':'model.js','/machines.js':'machines.js','/client.js':'client.js','/service.js':'service.js','/execution-ui.js':'execution-ui.js','/terminal-ui.js':'terminal-ui.js','/resources-ui.js':'resources-ui.js','/datasets-ui.js':'datasets-ui.js'};
routes['/dataset-upload.js']='dataset-upload.js';
routes['/project-management-ui.js']='project-management-ui.js';
routes['/data-workspace.js']='data-workspace.js';
routes['/personal-upload.js']='personal-upload.js';
routes['/cloud-files-ui.js']='cloud-files-ui.js';
routes['/transfers-ui.js']='transfers-ui.js';routes['/transfer-upload.js']='transfer-upload.js';
routes['/data-route.js']='data-route.js';
routes['/job-progress.js']='job-progress.js';routes['/job-progress-ui.js']='job-progress-ui.js';
routes['/task-metadata.js']='task-metadata.js';
routes['/job-diagnostics-ui.js']='job-diagnostics-ui.js';routes['/job-diagnostics.css']='job-diagnostics.css';
routes['/scheduling-policy.js']='scheduling-policy.js';
routes['/scheduling-ui.js']='scheduling-ui.js';
routes['/gpu-allocation.js']='gpu-allocation.js';
routes['/gpu-allocation-ui.js']='gpu-allocation-ui.js';
Object.assign(routes,STARBASE_ASSETS);
const mime={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',woff2:'font/woff2',png:'image/png',svg:'image/svg+xml',ico:'image/x-icon'};
routes['/guide.css']='guide.css';routes['/guide.js']='guide.js';
routes['/community-ui.js']='community-ui.js';routes['/community.css']='community.css';
routes['/cloud-import-ui.js']='cloud-import-ui.js';
routes['/maintenance-ui.js']='maintenance-ui.js';routes['/maintenance.css']='maintenance.css';
routes['/task-notes-ui.js']='task-notes-ui.js';routes['/submission-keys.js']='submission-keys.js';
export async function createServer(){
  const service=await DemoService.create();
  return http.createServer(async(req,res)=>{
    const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
    try{
      // Loopback only. Reject DNS rebinding and cross-origin state changes.
      if(!/^127\.0\.0\.1:\d+$/.test(req.headers.host||''))return json(403,{error:'Only the local demo host is allowed.'});
      if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return json(403,{error:'Cross-origin requests are not allowed.'});
      const path=new URL(req.url,'http://localhost').pathname;
      if(path.startsWith('/api/')){
        if(req.method!=='POST')return json(405,{error:'POST required'});
        if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{error:'JSON required'});
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)return json(413,{error:'Request too large'});}
        let data;try{data=JSON.parse(body);}catch{return json(400,{error:'Invalid JSON'});}
        if(path==='/api/login')return json(200,await service.login(data.username,data.password));
        if(path==='/api/call')return json(200,await service.invoke(req.headers.authorization?.replace(/^Bearer /,''),data.operation,data.args));
        return json(404,{error:'Not found'});
      }
      const guide=guideTarget(path);
      if(guide){
        if(!['GET','HEAD'].includes(req.method))return json(405,{error:'GET required'});
        if(guide.redirect){res.writeHead(302,{'Location':guide.redirect,'Cache-Control':'no-store'});return res.end();}
        const content=await guidePage(guide.chapter,`http://${req.headers.host}`);
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});return res.end(req.method==='HEAD'?undefined:content);
      }
      const file=routes[path];if(!file){res.writeHead(404);return res.end('Not found');}
      let content=await readFile(new URL(`./dist/${file}`,import.meta.url));
      if(file==='index.html')content=content.toString().replace('globalThis.GPUQ_LOCAL_API=false','globalThis.GPUQ_LOCAL_API=true');
      res.writeHead(200,{'Content-Type':mime[file.split('.').pop()],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});res.end(content);
    }catch(e){json(e.status||400,{error:e.message});}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=await createServer();server.listen(Number(process.env.PORT||58418),'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${server.address().port}\nDemo only: admin / AdminDemo!2026. State resets when this process stops.`));
}
