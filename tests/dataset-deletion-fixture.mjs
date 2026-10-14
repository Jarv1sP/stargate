import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {installDatasetDeletion} from '../dataset-deletion.mjs';
import {MACHINES} from '../dist/model.js';
export const hosts=MACHINES.map(m=>m.id),version='a'.repeat(64);
export const principal={userId:'demo-user-1',username:'alice',role:'member'};
export const request=()=>({dataset:'personal',version,key:randomUUID()});
export function fixture(t,{onlySource=true}={}){
 const db=new DatabaseSync(':memory:'),calls=[],nodes=new Map();
 const users=[{id:principal.userId,username:'alice',role:'member',enabled:true,limits:Object.fromEntries(hosts.map(h=>[h,1]))}];
 const f={onlySource};
 const service={db,store:{get:id=>users.find(u=>u.id===id),users},audit(){},bridge:async(host,op,args)=>{
  calls.push({host,op,args});await f.before?.(host,op,args);
  if(op==='datasets.list')return {datasets:host===hosts[0]||!f.onlySource?[{dataset:'personal',versions:[{version,state:'READY',bytes:4}]}]:[]};
  const action=op.split('.').at(-1);let node=nodes.get(args.operationId);
  if(action==='delete'){node={state:'TRASHED',active:false,exists:false,size:4,retainUntil:Date.now()/1000+7*86400};nodes.set(args.operationId,node);}
  if(action==='restore'){node={state:'RESTORED',active:false,exists:true,size:4};nodes.set(args.operationId,node);}
  if(!node)throw Object.assign(Error('operation not found'),{status:404});return node;
 }};
 installDatasetDeletion(service,{pollMs:1});t.after(async()=>{await service.waitDatasetDeletions();db.close();});
 return Object.assign(f,{service,calls,call:(op,args)=>service.datasetDeletionCall(principal,op,args),
  start:async()=>{const args=request();await service.datasetDeletionCall(principal,'datasets.delete',args);await service.waitDatasetDeletions();return service.datasetDeletionCall(principal,'datasets.delete.status',{key:args.key});}});
}
export const writes=f=>f.calls.filter(c=>c.args.action==='delete'||c.args.action==='restore');
