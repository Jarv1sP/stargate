// Exact trusted read-only replies for offline API/placement fixtures.
export const projectFootprint={codeBytes:1,codeEntries:1,imageUnpackedBytes:1024,imageEntries:1024};
export function trainingSource(machine,args,{state='READY',bytes=0,files=0,directories=0}={}){
  return {protocol:'dataset-training-source-v1',machine,dataset:args.dataset,version:args.version,
    datasetReadMode:args.datasetReadMode,datasetWarehouseRead:args.datasetReadMode==='warehouse'?1:0,
    authority:args.datasetReadMode==='warehouse'?'hdd':null,warehouseReady:args.datasetReadMode==='warehouse',
    state,canPrepare:true,reference:{dataset:args.dataset,version:args.version},
    bytes,files,directories,manifestBytes:100,footprintBytes:bytes+4096*(files+directories)+8192,remainingBytes:state==='READY'?0:bytes};
}
export function trainingPlan(machine,args,{availableBytes=2**40,activeReservedBytes=0,budgetBytes=null,quotaBytes=null}={}){
  const cache=args.datasetReadMode==='cache'&&args.datasets.length>0;
  const requiredBytes=65536+(cache?args.datasetFootprints.reduce((sum,f)=>sum+f.bytes+4096*(f.files+f.directories)+8192,0):0);
  const requiredInodes=16+(cache?args.datasetFootprints.reduce((sum,f)=>sum+f.files+f.directories+16,0):0);
  const volume={volumeDeviceId:'1'.repeat(64),roles:['project',...(cache?['cache']:[])],guarded:true,readOnly:false,
    availableBytes,reserveBytes:1024,activeReservedBytes,requiredBytes,usableBytes:Math.max(0,availableBytes-1024-activeReservedBytes),
    availableInodes:1000000,reserveInodes:1024,activeReservedInodes:0,requiredInodes,usableInodes:1000000-1024};
  const cacheBudget={enabled:budgetBytes!==null,budgetBytes,usedOrReservedBytes:0,requiredBytes:cache?requiredBytes-65536:0};
  const quota={enabled:quotaBytes!==null,volumes:quotaBytes===null?null:[{volumeDeviceId:volume.volumeDeviceId,
    remainingBytes:quotaBytes,remainingInodes:1000000,requiredBytes,requiredInodes}]};
  const fits=availableBytes>=1024+activeReservedBytes+requiredBytes&&(budgetBytes===null||cacheBudget.requiredBytes<=budgetBytes)&&
    (quotaBytes===null||quotaBytes>=requiredBytes);
  return {protocol:'training-storage-plan-v1',machine,owner:args.userId,
    checkedAt:new Date().toISOString(),noReclaim:true,fits,volumes:[volume],cacheBudget,quota};
}
