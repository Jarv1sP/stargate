import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tcpCampusReachable} from './client-campus-endpoints.mjs';
import {DATASET_DIRECT_HELP} from './dist/personal-upload.js';

// Keep the selected lane with the original key, including a VPS continuation.
export async function selectTransferRoute({area,via,stateFile,getGrant,probe=tcpCampusReachable}){
 if(area==='dataset'&&via&& !['auto','direct'].includes(via))throw Error(DATASET_DIRECT_HELP);
 const save=async lane=>{if(!stateFile)return;await mkdir(dirname(stateFile),{recursive:true,mode:0o700});const temporary=stateFile+'.'+randomUUID()+'.new';await writeFile(temporary,JSON.stringify({via:lane}),{mode:0o600});await rename(temporary,stateFile);};
 if(stateFile&&(!via||via==='auto'))try{const saved=JSON.parse(await readFile(stateFile,'utf8'));if(area!=='dataset'||saved.via==='direct')return {...saved,save};}catch(error){if(error.code!=='ENOENT')throw error;}
 let grant;
 if(area==='dataset'){
  grant=await getGrant();
  if(!await probe(grant))throw Error(DATASET_DIRECT_HELP);
 }
 via=via&&via!=='auto'?via:'direct';await save(via);
 return {via,save,...(grant?{grant}:{})};
}
