import {randomBytes,randomUUID} from 'node:crypto';
import {PortalClient} from './http.mjs';
export class SkipStep extends Error{}
export class AssertionFailure extends Error{}
export function createContext({stack,artifacts,log=console.error}){
  const runId=randomBytes(3).toString('hex');
  const ctx={stack,artifacts,log,runId,admin:stack.admin,machine:stack.machines[0],config:stack.config,shared:{},cleanups:[],step:null,
    name:suffix=>`gr-${runId}-${suffix}`.slice(0,24),key:randomUUID,password:()=>`Gray-${randomBytes(12).toString('base64url')}`};
  ctx.client=new PortalClient(stack.origin,{recordOperation:(operation,outcome)=>ctx.step?.calls.push({operation,outcome})});
  ctx.check=(name,ok,detail)=>{
    ctx.step.assertions.push({name,ok:ok===true,...(detail===undefined?{}:{detail})});
    if(ok!==true)throw new AssertionFailure(name+(detail?': '+JSON.stringify(detail).slice(0,500):''));
  };
  ctx.note=text=>ctx.step.notes.push(text);
  ctx.skip=reason=>{throw new SkipStep(reason);};
  ctx.todo=(id,text)=>ctx.step.todo.push({id,text});
  return ctx;
}
export async function waitFor(read,predicate,{timeoutMs=120000,intervalMs=2000,what='状态变化'}={}){
  const end=Date.now()+timeoutMs;
  for(;;){const result=await read();if(predicate(result))return result;
    if(Date.now()>=end)throw new AssertionFailure('等待超时：'+what);
    await new Promise(resolve=>setTimeout(resolve,intervalMs));}
}
