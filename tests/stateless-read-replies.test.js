import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
const machine=MACHINES[0].id,id='11111111-1111-4111-8111-111111111111';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'C2-stateless-')),bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Stateless-Local-Only-Password!'}));const service=await PortalService.open(join(dir,'db'),bootstrap,undefined,async(host,operation,args)=>operation==='projects.list'?{projects:[]}:operation==='datasets.list'?{datasets:[]}:operation==='files.list'?{entries:[],nextOffset:null}:operation==='data.upload.status'?{key:id,state:'UPLOADING',offset:12,totalSize:20}:{project:args.project,nodeJobId:'J0123456789ab',state:'SUCCEEDED',assignedIndices:[],text:'log'});clearInterval(service.executionTimer);const user=service.store.users[0],token=service.issueSession({userId:user.id,username:user.username,role:user.role});service.store.jobs=[{id,key:id,userId:user.id,machine,cards:1,state:'SUCCEEDED',nodeJobId:'J0123456789ab',spec:{id,userId:user.id,project:'test',argv:['true']}}];t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});return {service,user,token};}
test('current directory/project/task reads do not rebuild the full dashboard or repeat writes',async t=>{
 const f=await fixture(t);f.service.state=()=>assert.fail('A point read must not rebuild the dashboard');
 for(const [op,args] of [['datasets.list',{machine}],['data.upload.status',{machine,key:id}],['files.list',{machine,area:'dataset',dataset:'shared'}],['projects.list',{machine}],['projects.status',{machine,project:'test'}],['projects.quota',{machine}],['projects.catalog',{}],['projects.group.get',{id}],['jobs.logs',{jobId:id}],['jobs.watch',{jobId:id}],['jobs.diagnostics',{jobId:id}],['jobs.completion',{jobId:id}],['terminal.status',{machine,id}],['invites.list',{}],['notifications.job',{jobId:id}]]){const reply=await f.service.invoke(f.token,op,args);assert.equal(Object.hasOwn(reply,'state'),false,op);assert.ok(reply.result,op);}
});
for(const change of ['logout','disabled','role','closing'])test('an async directory read rejects '+change+' before returning delayed data',async t=>{
 const f=await fixture(t);let release,started;const held=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);f.service.bridge=async()=>{started();await held;return {datasets:[]};};const pending=f.service.invoke(f.token,'datasets.list',{machine}),rejected=assert.rejects(pending,e=>[401,403,503].includes(e.status));await ready;
 if(change==='logout')f.service.revokeSession(f.token);if(change==='disabled')f.user.enabled=false;if(change==='role')f.user.role='member';if(change==='closing')f.service.closing=true;release();await rejected;
});
test('new upload status retries a transient lock once under the same UUID and keeps unknown replies unknown',async t=>{
 const f=await fixture(t),calls=[];f.service.bridge=async(host,op,args)=>{calls.push({host,op,args});if(calls.length===1)throw Object.assign(Error('lock busy'),{status:503});return {key:id,state:'UNKNOWN',offset:null};};const reply=await f.service.invoke(f.token,'data.upload.status',{machine,key:id});assert.equal(reply.result.state,'UNKNOWN');assert.equal(reply.result.offset,null);assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);
});
