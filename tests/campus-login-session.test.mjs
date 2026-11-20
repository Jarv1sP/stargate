import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {createPersonalFileTransport} from '../client-personal-file-campus.mjs';
import {uploadPersonalFile} from '../dist/personal-upload.js';

async function fixture(t,{central=false,prepare}={}){
  const root=await mkdtemp(join(tmpdir(),'campus-login-')),database=join(root,'business.sqlite'),accounts=join(root,'accounts.sqlite'),bootstrap=join(root,'bootstrap');
  const environment=Object.fromEntries(['TEAM_ACCOUNTS_DATABASE','TEAM_IDENTITY_CONFIG'].map(name=>[name,process.env[name]]));
  for(const name of Object.keys(environment))delete process.env[name];
  let service;
  t.after(async()=>{
    service?.close();
    for(const [name,value] of Object.entries(environment))if(value===undefined)delete process.env[name];else process.env[name]=value;
    await rm(root,{recursive:true,force:true});
  });
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Synthetic-File-Login-Only-2026!'}));
  const bridge=async(machine,operation,args)=>{
    assert.equal(operation,'files.direct.prepare');
    if(prepare)return prepare(args);
    return {available:true,grantId:args.uploadId??randomUUID(),ticket:randomBytes(32).toString('hex'),
      endpoint:'https://campus.invalid',certificateSha256:'a'.repeat(64),expiresAt:Date.now()/1000+300,
      chunkBytes:1024**2,file:{size:3}};
  };
  service=await PortalService.open(database,bootstrap,undefined,bridge,undefined,accounts);
  clearInterval(service.executionTimer);
  const user=service.accounts.byName('admin');
  if(central){
    service.accounts.db.exec(`CREATE TABLE identity_users(id TEXT PRIMARY KEY,epoch TEXT);
      CREATE TABLE identity_access(user_id TEXT,app_id TEXT,allowed INTEGER,expires REAL);
      CREATE TABLE identity_session_scopes(token_hash TEXT PRIMARY KEY,app_id TEXT,epoch TEXT);`);
    service.accounts.db.prepare('INSERT INTO account_metadata VALUES(?,?)').run('updated_at',String(Date.now()));
    service.accounts.db.prepare('INSERT INTO identity_users VALUES(?,?)').run(user.id,'version-1');
    service.accounts.db.prepare('INSERT INTO identity_access VALUES(?,?,1,NULL)').run(user.id,'amax');
    service.loginSessions.identityApp='amax';
  }
  const token=service.issueSession({userId:user.id,username:user.username,role:user.role});
  return {get service(){return service;},token,user,
    async grant(action){return (await service.invoke(token,'files.direct-ticket',{
      machine:MACHINES[0].id,project:'fixture',area:'code',path:'sample',action,
      ...(action==='put'?{uploadId:randomUUID(),totalSize:3}:{}),
    })).result;},
    async restart(){service.close();service=await PortalService.open(database,undefined,undefined,bridge,undefined,accounts);clearInterval(service.executionTimer);},
  };
}

for(const action of ['get','put']){
  test(`direct ${action} checks the separate login database and survives a portal restart`,async t=>{
    const f=await fixture(t),grant=await f.grant(action);
    assert.equal(f.service.db.prepare("SELECT 1 FROM sqlite_master WHERE name='login_sessions_v2'").get(),undefined);
    assert.equal(f.service.principal(f.token).userId,f.user.id);
    assert.deepEqual(f.service.checkFileTicket({ticket:grant.ticket}),{allowed:true,protocol:'campus-file'});
    await f.restart();
    assert.equal(f.service.checkFileTicket({ticket:grant.ticket}).allowed,true);
    f.service.revokeSession(f.token);
    assert.throws(()=>f.service.checkFileTicket({ticket:grant.ticket}),error=>error.status===401);
  });
}

for(const [label,change,status] of [
  ['expired login',db=>db.exec('UPDATE login_sessions_v2 SET expires_at=1,touched_at=1'),401],
  ['disabled account',db=>db.exec('UPDATE accounts SET enabled=0'),403],
  ['changed role',db=>db.exec("UPDATE accounts SET role='member'"),403],
])test(`direct files reject ${label} even with a cached user profile`,async t=>{
  const f=await fixture(t),grant=await f.grant('get');
  change(f.service.accounts.db);
  assert.throws(()=>f.service.checkFileTicket({ticket:grant.ticket}),error=>error.status===status);
});

for(const legacy of [false,true]){
  test(`long upload with a ${legacy?'legacy':'renewing'} node continues under the original key`,async t=>{
    const machine=MACHINES[0].id,key=randomUUID(),ttl=150,bytes=Buffer.from('multi-cycle transfer');
    const started=Math.floor(Date.now()/1000);
    let elapsed=0,grant,issued=0,offset=0,begins=0,rejected=0;
    const rejectedOffsets=[];
    const f=await fixture(t,{prepare:args=>{
      assert.equal(args.uploadId,key);
      const now=Date.now()/1000;
      if(!grant||grant.expiresAt-now<=(legacy?0:120)){
        issued++;
        grant={available:true,grantId:key,ticket:randomBytes(32).toString('hex'),expiresAt:now+ttl,
          endpoint:'https://campus.invalid',certificateSha256:'a'.repeat(64),chunkBytes:1024**2};
      }
      return grant;
    }});
    const skew=legacy?30:0;
    t.mock.method(Date,'now',()=>(started+elapsed+skew)*1000);
    const scope={machine,area:'dataset',dataset:'shared',path:'sample'};
    const transport=await createPersonalFileTransport((op,args)=>f.service.invoke(f.token,op,args),{
      ...scope,context:{area:'dataset',dataset:'shared'},action:'put',identity:{uploadId:key,totalSize:bytes.length},
      now:()=>started+elapsed,monotonic:()=>elapsed*1000,
      agentFactory:()=>({destroy:async()=>{}}),send:async(value,_agent,_action,chunk)=>{
        try{f.service.checkFileTicket({ticket:value.ticket});}
        catch{
          rejected++;
          rejectedOffsets.push(chunk.offset);
          throw Object.assign(Error('HTTP 403'),{status:403,nodeError:'登录已失效，请重新登录。'});
        }
        assert.equal(chunk.offset,offset);
        assert.equal(chunk.bytes[0],bytes[offset]);
        elapsed+=35;
        return {state:'UPLOADING',offset:++offset};
      },
    });
    try{
      const result=await uploadPersonalFile({...scope,key,size:bytes.length,chunkBytes:1,rawChunks:true,
        read:async at=>bytes.subarray(at,at+1),call:async(operation,args)=>{
          assert.equal(args.key,key);
          if(operation==='data.upload.begin'){begins++;return {state:'UPLOADING',offset};}
          if(operation==='data.upload.finish')return {state:'COMPLETE',offset};
          assert.equal(operation,'data.upload.chunk');
          return transport.request({offset:args.offset,bytes:args.data,final:false});
        },
      });
      assert.equal(result.state,'COMPLETE');
      assert.equal(offset,bytes.length);
      assert.equal(begins,1);
      assert.ok(elapsed>3*ttl&&issued>=4);
      if(legacy)assert.ok(rejected>0&&new Set(rejectedOffsets).size===rejected);
      else assert.equal(rejected,0);
    }finally{await transport.close();}
  });
}

test('a revoked login cannot refresh a direct ticket or replay the rejected write',async t=>{
  const f=await fixture(t),initialGrant=await f.grant('put');
  let sends=0,ticketRequests=0;
  const transport=await createPersonalFileTransport((op,args)=>{
    ticketRequests++;
    return f.service.invoke(f.token,op,args);
  },{
    machine:MACHINES[0].id,context:{area:'code',project:'fixture'},path:'sample',action:'put',initialGrant,
    identity:{uploadId:initialGrant.grantId,totalSize:3},
    agentFactory:()=>({destroy:async()=>{}}),send:async value=>{
      sends++;
      assert.throws(()=>f.service.checkFileTicket({ticket:value.ticket}),error=>error.status===401);
      throw Object.assign(Error('HTTP 403'),{status:403,nodeError:'登录已失效，请重新登录。'});
    },
  });
  try{
    f.service.revokeSession(f.token);
    await assert.rejects(transport.request({offset:0,bytes:Buffer.from('abc'),final:false}),error=>error.status===401);
    assert.equal(ticketRequests,1);
    assert.equal(sends,1);
  }finally{await transport.close();}
});

test('direct files use the same sliding login lifetime as control requests',async t=>{
  const f=await fixture(t),grant=await f.grant('put');
  f.service.accounts.db.prepare('UPDATE login_sessions_v2 SET touched_at=?,expires_at=?').run(Date.now()-7200000,Date.now()+60000);
  assert.equal(f.service.checkFileTicket({ticket:grant.ticket}).allowed,true);
  assert.ok(f.service.accounts.db.prepare('SELECT expires_at FROM login_sessions_v2').get().expires_at>Date.now()+86400000);
});

test('direct files accept a current central identity session',async t=>{
  const f=await fixture(t,{central:true}),grant=await f.grant('get');
  assert.equal(f.service.checkFileTicket({ticket:grant.ticket}).allowed,true);
});

for(const [label,change,status] of [
  ['application access revoked',db=>db.exec('UPDATE identity_access SET allowed=0'),403],
  ['application access expired',db=>db.exec('UPDATE identity_access SET expires=1'),403],
  ['password or global logout changed',db=>db.exec("UPDATE identity_users SET epoch='version-2'"),401],
  ['different application session',db=>db.exec("UPDATE identity_session_scopes SET app_id='mission'"),401],
  ['stale identity directory',db=>db.exec("UPDATE account_metadata SET value='1' WHERE key='updated_at'"),503],
])test(`direct files reject central identity with ${label}`,async t=>{
  const f=await fixture(t,{central:true}),grant=await f.grant('put');
  change(f.service.accounts.db);
  assert.throws(()=>f.service.checkFileTicket({ticket:grant.ticket}),error=>error.status===status);
});

test('unknown and expired file tickets and machine maintenance still stop direct files',async t=>{
  const f=await fixture(t),grant=await f.grant('get');
  assert.throws(()=>f.service.checkFileTicket({ticket:'unknown'}),error=>error.status===403);
  t.mock.method(f.service,'maintenanceFor',()=>({reason:'fixture'}));
  assert.throws(()=>f.service.checkFileTicket({ticket:grant.ticket}),error=>error.status===503);
  t.mock.restoreAll();
  for(const entry of f.service.fileTickets.values())entry.expiresAt=1;
  assert.throws(()=>f.service.checkFileTicket({ticket:grant.ticket}),error=>error.status===403);
});
