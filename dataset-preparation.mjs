import {cancelTrainingPreparations} from './training-preparation.mjs';

// Historical tasks are read/cancel only. Retain their exact worker and lease
// bindings for cleanup; new workspace tasks never enter data preparation.
const terminal=new Set(['CANCELED','FAILED','SUCCEEDED']);

function persist(service,job,change){
  const before=structuredClone(job);
  try{change();service.save();}
  catch(error){for(const key of Object.keys(job))delete job[key];Object.assign(job,before);throw error;}
}

export async function releaseDataPreparation(service,job){
  if(service.closing||!terminal.has(job.state))return;
  const held=structuredClone(job.dataPreparationHold);
  if(job.trainingPreparations?.length&&job.trainingPreparationsReleased!==true){
    const preparations=structuredClone(job.trainingPreparations),identity=JSON.stringify(preparations);
    await cancelTrainingPreparations(service,{...job,trainingPreparations:preparations});
    const confirmed=await service.enqueue(()=>{
      const current=service.store.jobs.find(row=>row.id===job.id);
      if(service.closing||!current||!terminal.has(current.state)||JSON.stringify(current.trainingPreparations)!==identity)return false;
      persist(service,current,()=>{current.trainingPreparationsReleased=true;});return true;
    });
    if(!confirmed)return;
  }
  if(service.closing||!terminal.has(job.state)||!held||held.state==='RELEASED')return;
  // INTENT may already hold a lease when its preparation reply was lost.
  const result=await service.bridge(job.machine,'storage.lease.cancel',{job:held.spec});
  if(result?.state!=='CANCELED'||result.jobId!==job.id||result.released!==true)throw Error('准备数据的保活释放尚未确认。');
  await service.enqueue(()=>{
    const current=service.store.jobs.find(row=>row.id===job.id);
    if(!service.closing&&current&&terminal.has(current.state)&&JSON.stringify(current.dataPreparationHold?.spec)===JSON.stringify(held.spec))
      persist(service,current,()=>{current.dataPreparationHold.state='RELEASED';});
  });
}
