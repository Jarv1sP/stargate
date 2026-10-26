import {UUID,selectFields} from './portal-request-validation.mjs';
import {MACHINES} from './dist/model.js';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const terminal=new Set(['SUCCEEDED','CANCELED']);
const known=machine=>MACHINES.some(row=>row.id===machine);
export function installTransfers(service){
  // A new-operation index only. Byte state and offsets belong to the nodes.
  service.db.exec('CREATE TABLE IF NOT EXISTS directory_transfers (id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  service.transferWrites=new Map();
}
const load=(service,id)=>{const row=service.db.prepare('SELECT data FROM directory_transfers WHERE id=?').get(id);return row&&JSON.parse(row.data);};
const save=(service,row)=>service.db.prepare('INSERT INTO directory_transfers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(row.id,JSON.stringify(row));
export async function transferCall(service,principal,operation,input,check=()=>{}){
  check();if(!service.store.get(principal.userId).enabled)fail('请重新登录。',403);
  service.assertMaintenanceAllowed?.(operation,input,principal);
  const actor={userId:principal.userId,isAdmin:principal.role==='admin'},userId=principal.userId;
  const call=async(machine,op,args)=>{check();const value=await service.bridge(machine,op,{...args,userId,actor});check();return value;};
  const action=operation.slice('transfers.'.length);
  if(action==='list'){
    const args=selectFields(input,['machine']);if(args.machine!==undefined&&!known(args.machine))fail('请选择列表中的服务器。');
    const machines=args.machine?[args.machine]:MACHINES.map(row=>row.id),results=await Promise.allSettled(machines.map(machine=>call(machine,'transfers.list',{})));
    const parents=service.db.prepare('SELECT data FROM directory_transfers ORDER BY rowid DESC LIMIT 1000').all().map(value=>JSON.parse(value.data)).filter(row=>row.kind!=='copy'&&machines.includes(row.machine));
    const remote=results.flatMap((result,index)=>result.status==='fulfilled'&&Array.isArray(result.value?.transfers)?result.value.transfers.map(row=>({...row,machine:machines[index]})):[]);
    const unavailable=results.every(result=>result.status==='rejected'||!Array.isArray(result.value?.transfers));
    return {state:unavailable?'UNKNOWN':'AVAILABLE',transfers:unavailable&&!parents.length?null:[...parents,...remote.filter(row=>!parents.some(parent=>parent.id===row.id))],
      partial:results.some(result=>result.status==='rejected'||!Array.isArray(result.value?.transfers)),
      errors:results.flatMap((result,index)=>result.status==='rejected'||!Array.isArray(result.value?.transfers)?[{machine:machines[index],message:'传输列表暂未读到，请稍后查询。'}]:[])};
  }
  if(action==='capabilities')return {upload:true,download:true,copy:true};
  const args=selectFields(input,action==='create'?['key','kind','machine','from','reference','name','timeoutSec']:['id','machine','action','path','offset','bytes','complete']);
  const id=action==='create'?args.key:args.id;if(!UUID.test(id||''))fail('请使用原传输 UUID。');
  let row=load(service,id),fresh=false;
  if(action==='create'&&!row){
    if(!known(args.machine)||args.kind==='copy'&&!known(args.from))fail('请选择列表中的服务器。');
    if(!['upload','copy','download'].includes(args.kind))fail('请选择上传、下载或服务器间复制。');
    const ref=selectFields(args.reference,['dataset','project','ownerId','path','environment','jobId']);
    if(!ref.dataset&&!ref.project)fail('请选择来源数据集或项目目录。');
    row={id,key:id,kind:args.kind,machine:args.machine,from:args.from??args.machine,reference:ref,name:args.name??ref.dataset,
      state:args.kind==='copy'?'CREATED':'WAITING_CLIENT',actor:userId,createdAt:new Date().toISOString()};save(service,row);fresh=true;
  }
  if(!row){
    if(!known(args.machine))return {id,key:id,state:'UNKNOWN',message:'传输位置暂未读到，请保留原编号稍后查询。'};
    return call(args.machine,operation,{...args,id});
  }
  const view=value=>({...row,...value,id,key:id});
  const finish=async value=>{
    if(row.reference.environment&&['FAILED','CANCELED'].includes(value.state)){
      row.state=value.state;row.sourceCompletePending=true;save(service,row);
      try{await call(row.from,'transfers.project.complete',{id});delete row.sourceCompletePending;save(service,row);}
      catch{} // The original status/cancel retries; the source's hourly collect also expires abandoned exports.
    }
    return view(value);
  };
  if(row.kind!=='copy'){
    if(action==='cancel'||row.state==='CANCELING'&&action==='resume'){
      row.state='CANCELING';save(service,row);
      try{for(const key of row.uploadKeys||[])await call(row.machine,'data.upload.cancel',{key});row.state='CANCELED';save(service,row);return row;}
      catch{return {...row,state:'UNKNOWN',message:'取消结果未知，请按原传输编号继续查询或取消。'};}
    }
    if(action==='progress'&&row.state!=='CANCELED'){if(!Number.isSafeInteger(args.bytes)||args.bytes<0)fail('传输字节数无效。');row.bytes=args.bytes;if(args.complete===true)row.state='SUCCEEDED';save(service,row);return row;}
    if(['create','status','resume','progress'].includes(action))return row;
  }
  if(action==='status'){
    if(service.transferWrites.has(id))return view({state:'RUNNING'});
    return finish(await call(row.machine,'transfers.status',{id}));
  }
  if(action==='cancel')return finish(await call(row.machine,'transfers.cancel',{id}));
  if(!['create','resume'].includes(action))fail('未知传输操作。');
  if(service.transferWrites.has(id))return service.transferWrites.get(id);
  const write=(async()=>{
    if(!fresh){
      const status=await call(row.machine,'transfers.status',{id});
      if(action==='resume'&&['RUNNING','PENDING'].includes(status.state))return finish(await call(row.machine,'transfers.resume',{id}));
      if(terminal.has(status.state)||!['ABSENT','FAILED','PAUSED'].includes(status.state))return finish(status);
      if(['FAILED','PAUSED'].includes(status.state)){
        if(row.reference.environment)await call(row.from,'transfers.project.prepare',{id,source:{...row.reference,userId:principal.userId},targetMachine:row.machine,mode:row.mode});
        delete row.sourceCompletePending;save(service,row);
        return finish(await call(row.machine,'transfers.resume',{id}));
      }
    }
    // Only one source authorization, then one target start. Both nodes dedupe
    // this original UUID. Source bytes are never hashed or compared in Portal.
    const target={...row.reference,...(row.name?{[row.reference.project?'project':'dataset']:row.name}:{}),userId:principal.userId};
    if(row.reference.environment&&!row.mode){
      const value=await call(row.machine,'transfers.project.mode',{target});row.mode=value.mode;save(service,row);
    }
    const source=await call(row.from,row.reference.environment?'transfers.project.prepare':'transfers.prepare',{id,source:{...row.reference,userId:principal.userId},targetMachine:row.machine,mode:row.mode});
    if(typeof source?.token!=='string')return view({state:source?.state||'UNKNOWN',message:'来源目录正在读取，请按原编号查询。'});
    row.state='DISPATCHING';delete row.sourceCompletePending;save(service,row);
    const result=await call(row.machine,row.reference.environment?'transfers.project.start':'transfers.start',{id,source:{...row.reference,userId:principal.userId},target:{...target,...(row.mode?{mode:row.mode}:{})},ticket:{id:source.id??id,token:source.token},sourceMachine:row.from});
    service.audit(principal.username,operation,id,JSON.stringify({from:row.from,machine:row.machine,reference:row.reference}));
    return finish(result);
  })().finally(()=>service.transferWrites.delete(id));
  service.transferWrites.set(id,write);return write;
}
