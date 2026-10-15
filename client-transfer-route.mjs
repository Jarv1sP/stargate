import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tcpCampusReachable} from './client-campus-endpoints.mjs';

// This is operation state: a resumed transfer never chooses another lane.
export async function selectTransferRoute({area,via,action,stateFile,getGrant,probe=tcpCampusReachable,notify=message=>process.stderr.write(message+'\n')}){
 if(stateFile&&(!via||via==='auto'))try{return JSON.parse(await readFile(stateFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 let grant;
 if(!via||via==='auto'){
  via=action==='put'?'relay':'portal';
  if(area==='dataset'){
   grant=await getGrant();
   if(await probe(grant))via='direct';else notify('校园网不可达，本次经 VPS 传输（较慢）。');
  }
 }
 const selected={via};
 if(stateFile){await mkdir(dirname(stateFile),{recursive:true,mode:0o700});const temporary=stateFile+'.'+randomUUID()+'.new';await writeFile(temporary,JSON.stringify(selected),{mode:0o600});await rename(temporary,stateFile);}
 return {...selected,...(via==='direct'&&grant?{grant}:{})};
}
