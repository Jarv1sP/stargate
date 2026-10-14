import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PortalService} from '../portal-service.mjs';
const password='Account-Local-Only-Password!';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'C2-accounts-')),bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});const service=await PortalService.open(join(dir,'db'),bootstrap);clearInterval(service.executionTimer);t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});const admin=await service.login('admin',password);return {service,admin,call:async(op,args={},token=admin.token)=>(await service.invoke(token,op,args)).result};}
test('invitations register a member, profile changes persist, and logout revokes the original session',async t=>{
 const f=await fixture(t),invite=await f.call('invites.rotate',{role:'member'});assert.equal((await f.call('invites.list')).code,invite.code);
 assert.equal((await f.service.register({username:'alice',password,invite:invite.code,role:'admin',extra:true})).role,'member');const login=await f.service.login('alice',password);
 await f.call('profile.update',{name:'团队成员'},login.token);assert.equal(f.service.store.users.find(u=>u.username==='alice').name,'团队成员');
 await assert.rejects(f.call('invites.rotate',{role:'member'},login.token),e=>e.status===403);await f.call('logout',{},login.token);assert.throws(()=>f.service.principal(login.token),e=>e.status===401);
 await f.call('invites.disable',{role:'member'});await assert.rejects(f.service.register({username:'bob',password,invite:invite.code}),e=>e.status===403);
});
test('administrator account/role/password controls keep login revocation and members cannot impersonate an administrator',async t=>{
 const f=await fixture(t),user=await f.call('users.create',{username:'alice',password}),login=await f.service.login('alice',password);
 await assert.rejects(f.call('users.create',{username:'attacker',password,role:'admin'},login.token),e=>e.status===403);
 await f.call('users.reset',{userId:user.id,password:password+'new'});assert.throws(()=>f.service.principal(login.token),e=>e.status===401);await assert.rejects(f.service.login('alice',password));
 await f.call('users.role',{userId:user.id,role:'admin'});const next=await f.service.login('alice',password+'new');assert.equal(next.principal.role,'admin');
 await f.call('users.enabled',{userId:user.id,enabled:false});assert.throws(()=>f.service.principal(next.token),e=>e.status===401);await f.call('users.delete',{userId:user.id});assert.equal(f.service.store.users.some(row=>row.id===user.id),false);
});
