import {clientUpgradeMessage} from './client-compatibility.mjs';
import {validateFileLanEndpoints} from './campus-files.mjs';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {PortalService} from './portal-service.mjs';
import {bridgeClient} from './execution.mjs';
import {standaloneClientStream,standaloneClientInfo,standaloneClientRangeStream,clientByteRange,watchClientDownload} from './client-bundle.mjs';
import {pipeline} from 'node:stream/promises';
import {loadTelegramNotifications} from './job-notifications.mjs';
import {guideTarget,guidePage} from './guide.mjs';
import {LOGIN_POLICY} from './login-sessions.mjs';
import {STARBASE_ASSETS} from './frontend-assets.mjs';
import {directUploadConnectSources} from './direct-upload-policy.mjs';
import {centralLogin} from './accounts/oidc.mjs';

const files={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/workspace.css':'workspace.css','/app.js':'app.js','/model.js':'model.js','/machines.js':'machines.js','/client.js':'client.js','/execution-ui.js':'execution-ui.js','/terminal-ui.js':'terminal-ui.js','/resources-ui.js':'resources-ui.js','/xterm.js':'vendor/xterm.js','/xterm.css':'vendor/xterm.css','/addon-fit.js':'vendor/addon-fit.js'};
files['/job-progress.js']='job-progress.js';files['/job-progress-ui.js']='job-progress-ui.js';
files['/task-metadata.js']='task-metadata.js';
files['/project-management-ui.js']='project-management-ui.js';
files['/job-diagnostics-ui.js']='job-diagnostics-ui.js';files['/job-diagnostics.css']='job-diagnostics.css';
files['/scheduling-policy.js']='scheduling-policy.js';
files['/scheduling-ui.js']='scheduling-ui.js';
files['/gpu-allocation.js']='gpu-allocation.js';
files['/gpu-allocation-ui.js']='gpu-allocation-ui.js';
Object.assign(files,STARBASE_ASSETS);
const mime={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',woff2:'font/woff2',png:'image/png',svg:'image/svg+xml',ico:'image/x-icon'};
const requestTokens=(req,name='team_session')=>({
  bearer:/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1],
  fromCookie:new RegExp('(?:^|;\\s*)'+name+'=([a-f0-9]{64})(?:;|$)').exec(req.headers.cookie||'')?.[1],
});
const escapeHTML=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
files['/guide.css']='guide.css';files['/guide.js']='guide.js';
files['/datasets-ui.js']='datasets-ui.js';
files['/data-route.js']='data-route.js';
files['/disk-media.js']='disk-media.js';
files['/personal-upload.js']='personal-upload.js';
files['/datasets.css']='datasets.css';
files['/dataset-upload.js']='dataset-upload.js';
files['/transfers-ui.js']='transfers-ui.js';files['/transfer-upload.js']='transfer-upload.js';
files['/cloud-import-ui.js']='cloud-import-ui.js';
files['/community-ui.js']='community-ui.js';files['/community.css']='community.css';
files['/chat-content.js']='chat-content.js';files['/chat-compose-ui.js']='chat-compose-ui.js';files['/mention-popup-ui.js']='mention-popup-ui.js';files['/chat-rooms-ui.js']='chat-rooms-ui.js';
files['/maintenance-ui.js']='maintenance-ui.js';files['/maintenance.css']='maintenance.css';
files['/task-notes-ui.js']='task-notes-ui.js';files['/submission-keys.js']='submission-keys.js';
export async function createPortalServer({database,bootstrap,origin,secure=true,statusPath,bridgeSocket,fileBridgeSocket,bridge,notificationConfigPath,fileLanEndpoints=process.env.GPUQ_FILE_LAN_ENDPOINTS||'{}',directUploadOrigins=process.env.GPUQ_DIRECT_UPLOAD_ORIGINS||'[]'}){
  const lanEndpoints=validateFileLanEndpoints(fileLanEndpoints);
  const uploadConnect=directUploadConnectSources(directUploadOrigins);
  const url=new URL(origin);const clientInfo=await standaloneClientInfo(url.origin);
  const config=await loadTelegramNotifications(notificationConfigPath);
  const executor=bridgeSocket?bridgeClient(bridgeSocket):undefined;
  const fileExecutor=fileBridgeSocket?bridgeClient(fileBridgeSocket):executor;
  const routedBridge=bridge||(executor&&((machine,operation,args,context)=>(operation==='files.direct.prepare'?fileExecutor:executor)(machine,operation,args,context)));
  const service=await PortalService.open(database,bootstrap,statusPath,routedBridge,config);service.fileLanEndpoints=lanEndpoints;const rate=new Map();
  const central=service.accounts.central;
  const cookieName=central?(secure?'__Host-amax_session':'amax_session'):'team_session';
  const tokens=req=>requestTokens(req,cookieName);
  const loginHandler=central?centralLogin(service,origin,secure):null;
  const server=http.createServer(async(req,res)=>{
    const styleNonce=randomBytes(18).toString('base64');
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data:; connect-src 'self'${uploadConnect?' '+uploadConnect:''}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`};
    const json=(code,data,extra={})=>{res.writeHead(code,{...headers,'Content-Type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(data));};
    const cookie=(token,name=cookieName)=>`${name}=${token}; Path=/; HttpOnly; SameSite=${central?'Lax':'Strict'}; Max-Age=${token?LOGIN_POLICY.cookieSeconds:0}${secure?'; Secure':''}${!central&&process.env.TEAM_SESSION_COOKIE_DOMAIN?'; Domain='+process.env.TEAM_SESSION_COOKIE_DOMAIN:''}`;
    const expiredCookies=()=>[cookie('')];
    let inventoryRequest=false;
    try{
      if(req.headers.host!==url.host)return json(403,{error:'Invalid host'});
      if(req.headers.origin&&req.headers.origin!==url.origin)return json(403,{error:'Cross-origin requests are not allowed'});
      const path=new URL(req.url,origin).pathname;
      if(loginHandler&&await loginHandler(req,res,headers,cookie))return;
      if(path==='/healthz'){
        if(service.accounts.central)service.accounts.sessions.assertIdentityFresh();
        return json(200,{ok:true,service:'gpuq-console',executionEnabled:service.executionEnabled});
      }
      if(path.startsWith('/api/')){
        headers['Cache-Control']='private, no-store';
        if(req.method!=='POST')return json(405,{error:'POST required'});
        if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{error:'JSON required'});
        // Only our private reverse proxy can reach this server; it overwrites this header.
        const ip=req.headers['x-real-ip']||req.socket.remoteAddress;
        const kind=path==='/api/register'?'register':path==='/api/login'?'login':path==='/api/files/direct-check'?'file-control':'api';
        if(path!=='/api/call'){
          const key=`${ip}:${kind}`;const limit=kind==='register'?5:kind==='login'?20:kind==='file-control'?24000:1200;
          if(rate.size>5000)for(const [k,v] of rate)if(v.until<Date.now())rate.delete(k);
          let bucket=rate.get(key);if(!bucket||bucket.until<Date.now()){bucket={count:0,until:Date.now()+60000};rate.set(key,bucket);}
          if(++bucket.count>limit)return json(429,{error:'请求过多，请稍后重试。'},{'Retry-After':'60'});
        }
        let raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>(kind==='file-control'?8192:1500000))return json(413,{error:'Request too large'});}
        let data;try{data=JSON.parse(raw);}catch{return json(400,{error:'Invalid JSON'});}
        if(!data||typeof data!=='object'||Array.isArray(data))return json(400,{error:'Invalid JSON object'});
        if(path!=='/api/files/direct-check'&&!req.headers.origin&&!(data.client?.name==='gpuctl'&&data.client.protocol===2))return json(426,{error:clientUpgradeMessage(url.origin,data.client?.platform),code:'CLIENT_UPGRADE_REQUIRED'});
        if(path==='/api/files/direct-check')return json(200,service.checkFileTicket(data));
        if(path==='/api/register'){
          if(central)return json(409,{error:'请在统一门户注册团队账号。',url:new URL('/register',service.accounts.config.portalOrigin).href});
          let global=rate.get('register:global');if(!global||global.until<Date.now()){global={count:0,until:Date.now()+60000};rate.set('register:global',global);}
          if(++global.count>30)return json(429,{error:'注册繁忙，请稍后重试。'},{'Retry-After':'60'});
          return json(200,await service.register(data));
        }
        if(path==='/api/login'){
          if(central&&data.client==='browser')return json(409,{error:'请使用统一账号登录入口。',url:'/auth/login'});
          const login=await service.login(data.username,data.password);
          if(data.client==='browser'){const {token,...safe}=login;return json(200,safe,{'Set-Cookie':cookie(token)});}
          return json(200,login);
        }
        if(path==='/api/call'){
          const {bearer,fromCookie}=tokens(req);
          if(!bearer&&fromCookie&&req.headers.origin!==url.origin)return json(403,{error:'Browser origin required'});
          // Abort only pure upload observations. A disconnected write remains
          // an unconfirmed operation and must never be implicitly replayed.
          const cancellable=data.operation==='data.upload.status';
          const controller=cancellable?new AbortController():null;
          const abort=()=>{if(!res.writableEnded)controller.abort(Object.assign(Error('上传查询连接已关闭。'),{status:499,code:'UPLOAD_READ_CANCELLED'}));};
          if(controller){req.once('aborted',abort);res.once('close',abort);}
          try{
            // CLI submissions consume the durable receipt only. Browser writes
            // retain their dashboard; this presentation hint grants nothing.
            const options={...(controller?{signal:controller.signal}:{}),
              ...(bearer&&!req.headers.origin&&data.operation==='jobs.submit'?{omitResponseState:true}:{})};
            const result=await service.invoke(bearer||fromCookie,data.operation,data.args,options);
            if(!res.destroyed)return json(200,result,data.operation==='logout'?{'Set-Cookie':expiredCookies()}:{});
          }finally{if(controller){req.removeListener('aborted',abort);res.removeListener('close',abort);}}
          return;
        }
        return json(404,{error:'Not found'});
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return json(405,{error:'GET required'});
      if(path==='/runtime.js'){
        const {bearer,fromCookie}=tokens(req);let authenticated=false;
        try{if(bearer||fromCookie){service.principal(bearer||fromCookie);authenticated=true;}}
        catch(error){if(![401,403,503].includes(error.status))throw error;}
        // Avoid an expected 401 fetch (and browser console error) on public
        // login. This hint grants nothing: state and inventory recheck auth.
        // A delayed read-only hint from another tab must not clear a newer
        // login cookie. Explicit logout remains the cookie-clearing operation.
        res.writeHead(200,{...headers,'Cache-Control':'private, no-store','Content-Type':mime.js});
        return res.end(req.method==='HEAD'?undefined:`globalThis.GPUQ_LOCAL_API=true;globalThis.GPUQ_PRODUCTION=true;globalThis.GPUQ_HAS_SESSION=${authenticated};globalThis.GPUQ_CENTRAL_IDENTITY=${central?JSON.stringify({portal:service.accounts.config.portalOrigin}):'null'};`);
      }
      if(path==='/gpuctl.mjs'){
        watchClientDownload(res);
        const etag='"'+clientInfo.etag+'"';
        const downloadHeaders={...headers,'Content-Type':'text/javascript; charset=utf-8','Content-Length':clientInfo.bytes,'Content-Disposition':'attachment; filename="gpuctl.mjs"','Accept-Ranges':'bytes','ETag':etag,'X-GPUQ-Client-Bytes':String(clientInfo.bytes)};
        const rangeRequested=req.headers.range&&(!req.headers['if-range']||req.headers['if-range']===etag);
        if(rangeRequested){
          const range=clientByteRange(req.headers.range,clientInfo.bytes);
          if(!range){res.writeHead(416,{...downloadHeaders,'Content-Length':'0','Content-Range':'bytes */'+clientInfo.bytes});return res.end();}
          res.writeHead(206,{...downloadHeaders,'Content-Length':range.end-range.start+1,'Content-Range':`bytes ${range.start}-${range.end}/${clientInfo.bytes}`});
          if(req.method==='HEAD')return res.end();
          return await pipeline(standaloneClientRangeStream(url.origin,range),res);
        }
        res.writeHead(200,downloadHeaders);
        if(req.method==='HEAD')return res.end();
        return await pipeline(standaloneClientStream(url.origin),res);
      }
      if(path==='/install.sh'||path==='/install.ps1'){
        const template=path==='/install.sh'?'install-client.sh':'install-client.ps1';
        const installer=(await readFile(new URL(`./deploy/${template}`,import.meta.url),'utf8')).replaceAll('__GPUQ_PUBLIC_ORIGIN__',url.origin);
        res.writeHead(200,{...headers,'Content-Type':'text/plain; charset=utf-8'});return res.end(req.method==='HEAD'?undefined:installer);
      }
      // Only the beginner-facing guide is public. Operations manuals and raw
      // repository documentation are never served, even to logged-in admins.
      const guide=guideTarget(path);
      if(guide){
        if(guide.redirect){res.writeHead(302,{...headers,Location:guide.redirect});return res.end();}
        const text=await guidePage(guide.chapter,url.origin);res.writeHead(200,{...headers,'Content-Type':mime.html});return res.end(req.method==='HEAD'?undefined:text);
      }
      const chatImage=/^\/community\/chat-images\/([1-9][0-9]{0,14})$/.exec(path);
      if(chatImage){
        const {bearer,fromCookie}=tokens(req),image=service.communityImage(bearer||fromCookie,chatImage[1]);
        // A sent picture never changes, so the browser keeps its copy across chat polls.
        res.writeHead(200,{...headers,'Cache-Control':'private, max-age=2592000, immutable','Content-Type':image.type,'Content-Length':image.data.byteLength,'Content-Security-Policy':"default-src 'none'; sandbox"});
        return res.end(req.method==='HEAD'?undefined:image.data);
      }
      const file=files[path];if(!file)return json(404,{error:'Not found'});
      inventoryRequest=file==='machines.js';
      const {bearer,fromCookie}=inventoryRequest?tokens(req):{};
      if(inventoryRequest){headers['Cache-Control']='private, no-store';service.principal(bearer||fromCookie);}
      else if(file!=='index.html'){
        // Static files revalidate on every load, since any release may change them, but an
        // unchanged one costs an empty 304 instead of a download. The proxy's compression
        // may weaken or suffix the tag, so match on its core.
        const info=await stat(new URL(`./dist/${file}`,import.meta.url)),tag=info.size.toString(36)+'-'+Math.trunc(info.mtimeMs).toString(36);
        headers['Cache-Control']='no-cache';headers.ETag=`"${tag}"`;
        if(req.headers['if-none-match']?.includes(tag)){res.writeHead(304,headers);return res.end();}
      }
      let content=await readFile(new URL(`./dist/${file}`,import.meta.url));
      // Revalidate after I/O so a revoked session cannot receive the catalogue.
      if(inventoryRequest)service.principal(bearer||fromCookie);
      if(file==='index.html'){
        // Public HTML contains only the global reason, never host scopes,
        // inventory, timestamps, actors or the maintenance revision.
        const entry=service.globalMaintenanceActive()?service.maintenanceFor():null;
        if(entry)content=content.toString().replaceAll('<p class="auth-maintenance" data-public-maintenance hidden role="status"></p>',`<p class="auth-maintenance" data-public-maintenance role="status">${escapeHTML(entry.reason)}</p>`);
      }
      if(file==='index.html')content=content.toString().replace('</head>',`<meta name="gpuq-style-nonce" content="${styleNonce}"><link rel="stylesheet" href="/xterm.css"><script src="/xterm.js" defer></script><script src="/addon-fit.js" defer></script></head>`);
      if(file==='index.html')content=content.toString().replace('<script>globalThis.GPUQ_LOCAL_API=false;</script>','<script src="/runtime.js"></script>').replace(/<details class="demo-credentials">[\s\S]*?<\/details>/,'').replaceAll('独立演示环境','账号管理已上线').replaceAll('GPUQ 管理入口 · Demo','GPUQ 管理入口').replaceAll('管理员视角（演示）','管理员工作空间').replaceAll('列表中的用户均为演示账号。','账号与授权保存于服务器。').replaceAll('这里只用测试密码。','').replaceAll('仅演示账号和授权流程 · 尚未接入真实 GPUQ','账号与权限已持久化 · GPUQ 执行尚未接入').replace('本地 API 版的网页和 CLI 共用同一个服务与状态。当前线上静态预览不提供远程 CLI 接口。','网页和 CLI 共用此 VPS 后台；CLI 使用同一账号登录。下载客户端后指定本站地址。').replace('npm start&#10;',`curl -fsS ${url.origin}/gpuctl.mjs -o gpuctl.mjs&#10;export GPUQ_URL=${url.origin}&#10;`).replaceAll('node cli.mjs','node gpuctl.mjs');
      if(file==='index.html')content=content.toString().replace('账号与权限已持久化 · GPUQ 执行尚未接入','账号、终端与 GPUQ 训练已接入');
      res.writeHead(200,{...headers,'Content-Type':mime[file.split('.').pop()]});res.end(req.method==='HEAD'?undefined:content);
    }catch(e){
      if(res.headersSent||res.destroyed){if(!res.destroyed)res.destroy();return;}
      // An old asset response must never clear a newer login cookie.
      if(inventoryRequest&&(e.status===401||e.status===403)){res.writeHead(401,{...headers,'Content-Length':'0'});return res.end();}
      // Authentication failure may belong to an older request from another
      // tab. Do not expire its shared cookie; only explicit logout clears it.
      if(e.status===401)return json(401,{error:e.message});json(e.status||400,{error:e.message?.includes('SQLITE')?'保存失败，请联系管理员。':e.message,...(['TERMINAL_OPEN_REJECTED','MAINTENANCE_ACTIVE','SUBMISSION_REJECTED','TRAINING_ADMISSION_BUSY','CAMPUS_DATA_PLANE_REQUIRED','CAMPUS_FILE_REQUIRED','UPLOAD_STATUS_BUSY','CLIENT_UPGRADE_REQUIRED'].includes(e.code)?{code:e.code}:{})});
    }
  });
  server.headersTimeout=10000;server.requestTimeout=45000;server.keepAliveTimeout=5000;server.maxConnections=64;
  server.on('close',()=>service.close());return {server,service};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.umask(0o077);
  const {server}=await createPortalServer({database:process.env.DATABASE_PATH||'/data/portal.sqlite',bootstrap:process.env.BOOTSTRAP_FILE,origin:process.env.PUBLIC_ORIGIN,statusPath:process.env.GPUQ_STATUS_PATH,bridgeSocket:process.env.EXECUTOR_SOCKET,fileBridgeSocket:process.env.GPUQ_FILE_SOCKET,notificationConfigPath:process.env.GPUQ_NOTIFICATIONS_CONFIG,secure:true});
  server.listen(Number(process.env.PORT||8080),process.env.LISTEN_HOST||'0.0.0.0',()=>console.log('GPUQ portal ready.'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
