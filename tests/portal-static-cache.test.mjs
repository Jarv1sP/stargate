import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createPortalServer} from '../portal-server.mjs';

test('static files revalidate to an empty 304 while the page itself is never cached',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'portal-cache-')),bootstrap=join(dir,'bootstrap');
 await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Synthetic-Cache-2026!'}),{mode:0o600});
 const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const origin='http://127.0.0.1:'+port,{server,service}=await createPortalServer({database:join(dir,'portal.sqlite'),bootstrap,origin,secure:false,bridge:async()=>({})});
 clearInterval(service.executionTimer);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 const first=await fetch(origin+'/splash.css'),tag=first.headers.get('etag');
 assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-cache');assert.match(tag,/^"[0-9a-z]+-[0-9a-z]+"$/);assert.ok((await first.text()).includes('#startup-wordmark'));
 const again=await fetch(origin+'/splash.css',{headers:{'If-None-Match':tag}});
 assert.equal(again.status,304);assert.equal(await again.text(),'');
 // A compressing proxy hands the browser a weak or suffixed tag, which comes back as is.
 assert.equal((await fetch(origin+'/splash.css',{headers:{'If-None-Match':'W/'+tag.replace(/"$/,'-gzip"')}})).status,304);
 assert.equal((await fetch(origin+'/splash.css',{headers:{'If-None-Match':'"0-0"'}})).status,200,'a changed file downloads again');
 const media=await fetch(origin+'/disk-media.js');assert.equal(media.status,200);assert.match(media.headers.get('content-type'),/javascript/);assert.match(await media.text(),/export function diskLabel/);
 const page=await fetch(origin+'/');assert.equal(page.status,200);assert.equal(page.headers.get('cache-control'),'no-store');assert.equal(page.headers.get('etag'),null);
});
