import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {installTransfers,transferCall} from '../transfers.mjs';
import {MACHINES} from '../dist/model.js';

function fixture(t){
 const calls=[],db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const principal={userId:'alice',username:'alice',role:'member'},from=MACHINES[0].id,machine=MACHINES[1].id,id=randomUUID();
 let state='RUNNING',unavailable=false,startError=null;
 const service={db,store:{get:()=>({enabled:true})},audit(){},bridge:async(host,operation,args)=>{
  calls.push({host,operation,args});
  if(operation==='transfers.project.mode')return {mode:'full'};
  if(operation==='transfers.project.prepare')return {id,token:'fixture-ticket',state:'PREPARING'};
  if(operation==='transfers.project.start'&&startError)throw startError;
  if(operation==='transfers.cancel')return {state:'CANCELED'};
  if(operation==='transfers.project.complete'){if(unavailable)throw Error('source offline');return {state:'COMPLETE'};}
  return {state};
 }};installTransfers(service);
 return {id,calls,from,machine,service,state:value=>state=value,offline:value=>unavailable=value,startError:value=>startError=value,
  create:()=>transferCall(service,principal,'transfers.create',{key:id,kind:'copy',from,machine,reference:{project:'demo',ownerId:'alice',environment:true}}),
  call:action=>transferCall(service,principal,'transfers.'+action,{id}),
  saved:()=>JSON.parse(db.prepare('SELECT data FROM directory_transfers WHERE id=?').get(id).data)};
}

test('Portal cancels an export even if target start never received its ticket',async t=>{
 const f=fixture(t);f.startError(Error('target unavailable'));await assert.rejects(f.create());
 assert.equal(f.calls.some(row=>row.operation==='transfers.project.complete'),false);
 assert.equal((await f.call('cancel')).state,'CANCELED');
 assert.ok(f.calls.some(row=>row.host===f.from&&row.operation==='transfers.project.complete'&&row.args.id===f.id));
});

test('failed target releases the source and retries unavailable cleanup under the same operation',async t=>{
 const f=fixture(t);await f.create();f.state('FAILED');f.offline(true);
 assert.equal((await f.call('status')).state,'FAILED');assert.equal(f.saved().sourceCompletePending,true);
 f.offline(false);assert.equal((await f.call('status')).state,'FAILED');assert.equal(f.saved().sourceCompletePending,undefined);
 assert.equal(f.calls.filter(row=>row.operation==='transfers.project.complete').length,2);
 assert.equal((await f.call('resume')).state,'FAILED');
 assert.equal(f.calls.filter(row=>row.operation==='transfers.project.prepare').length,2);
});

test('paused or uncertain target preserves its source for original-key resume',async t=>{
 const f=fixture(t);await f.create();
 for(const state of ['PAUSED','UNKNOWN']){f.state(state);assert.equal((await f.call('status')).state,state);}
 assert.equal(f.calls.some(row=>row.operation==='transfers.project.complete'),false);
});
