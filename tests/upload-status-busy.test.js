import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {request} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bridgeClient} from '../execution.mjs';
import {createPortalServer} from '../portal-server.mjs';

async function fixture(t,reply){
  const directory=await mkdtemp(join(tmpdir(),'upload-status-busy-')),path=join(directory,'bridge.sock'),requests=[];
  const server=net.createServer(socket=>{
    let raw='';socket.on('data',part=>raw+=part);socket.on('end',()=>{
      requests.push(JSON.parse(raw));socket.end(JSON.stringify(reply));
    });
  });
  await new Promise(resolve=>server.listen(path,resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  return {bridge:bridgeClient(path),requests};
}
for(const op of ['data.upload.status'])test(`${op} maps only the exact node BUSY refusal to HTTP503`,async t=>{
  const f=await fixture(t,{ok:false,error:'UPLOAD_STATUS_BUSY'});
  await assert.rejects(f.bridge('fixture',op,{key:'original-id'}),e=>e.status===503&&e.code==='UPLOAD_STATUS_BUSY'&&/原上传编号/.test(e.message));
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].args.key,'original-id');
});
for(const op of ['data.upload.begin','data.upload.chunk','data.upload.finish','jobs.submit']){
  test(`${op} is never reclassified or replayed on a matching error string`,async t=>{
    const f=await fixture(t,{ok:false,error:'UPLOAD_STATUS_BUSY'});
    await assert.rejects(f.bridge('fixture',op,{key:'original-id'}),e=>e.message==='UPLOAD_STATUS_BUSY'&&e.status===undefined);
    assert.equal(f.requests.length,1);
  });
}
for(const error of ['[Errno 11] Resource temporarily unavailable','UPLOAD_STATUS_BUSY: private details','Permission denied','Corrupt upload identity']){
  test(`unrecognized refusal remains strict: ${error}`,async t=>{
    const f=await fixture(t,{ok:false,error});
    await assert.rejects(f.bridge('fixture','data.upload.status',{}),e=>e.message===error&&e.code!=='UPLOAD_STATUS_BUSY');
    assert.equal(f.requests.length,1);
  });
}
test('a successful original status and exact offset are unchanged',async t=>{
  const result={key:'original-id',state:'UPLOADING',remainingBytes:17,totalBytes:20};
  const f=await fixture(t,{ok:true,result});assert.deepEqual(await f.bridge('fixture','data.upload.status',{}),result);assert.equal(f.requests.length,1);
});
test('authenticated HTTP upload status exposes BUSY/503 without a false READY or second RPC',async t=>{
  const f=await fixture(t,{ok:false,error:'UPLOAD_STATUS_BUSY'}),dir=await mkdtemp(join(tmpdir(),'upload-busy-api-'));
  const bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Private-Busy-Fixture-Password-2026'}));
  const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin:'http://localhost',secure:false,bridge:f.bridge});
  const user=service.store.users[0];user.limits={'gpu-1':1};user.total=1;
  const token=service.issueSession({userId:user.id,username:user.username,role:user.role});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const body=JSON.stringify({client:{name:'gpuctl',protocol:2},operation:'data.upload.status',args:{machine:'gpu-1',key:'11111111-1111-4111-8111-111111111111'}});
  const response=await new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path:'/api/call',method:'POST',headers:{Host:'localhost',
      'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),Authorization:`Bearer ${token}`}},res=>{
      let raw='';res.on('data',part=>raw+=part);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(raw)}));
    });req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('HTTP fixture timed out')));req.end(body);
  });
  const value=response.value;assert.equal(response.status,503,JSON.stringify(value));assert.equal(value.code,'UPLOAD_STATUS_BUSY');
  assert.equal(value.result,undefined);assert.equal(value.state,undefined);assert.equal(f.requests.length,2);assert.deepEqual(f.requests[0],f.requests[1]);
});
