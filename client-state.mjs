import {recoverOriginalWrite} from './client-http.mjs';
// Target operations authorize themselves. State is fetched for displays and
// commands that actually need to choose from its directory, never as admission.
const FULL_STATE_COMMANDS=new Set(['state','jobs','queue']);
const DIRECTORY_COMMANDS=new Set(['use','profile','users','user','grant','policy','maintenance','task-label','files']);
export async function readCLIState(call,command){
  return FULL_STATE_COMMANDS.has(command)||DIRECTORY_COMMANDS.has(command)?(await call('state',FULL_STATE_COMMANDS.has(command)?{}:{view:'summary'})).state:{machines:[],users:[]};
}

// An original-key read recovers a reply, but absence cannot prove that an
// earlier submission has finished its asynchronous admission checks.
export async function submitJobWithReceipt(call,args,principal){
  const frozen=structuredClone(args);
  return recoverOriginalWrite(()=>call('jobs.submit',frozen),{
    query:()=>call('state',{jobKey:frozen.key}),
    classify:observed=>{
      if(observed.principal?.userId!==principal.userId||!Array.isArray(observed.state?.jobs))return;
      const matches=observed.state.jobs.filter(job=>job.userId===principal.userId&&job.key===frozen.key);
      if(matches.length===1&&typeof matches[0].id==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(matches[0].id))return {value:{result:matches[0],principal:observed.principal,receiptRecovered:true}};
    },
    unresolved:failure=>Object.assign(failure,{message:`${failure.message}\n原提交键：${frozen.key}。查询：gpuctl jobs --key ${frozen.key} --json`})
  });
}
