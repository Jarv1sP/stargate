import net from 'node:net';

export function bridgeClient(socketPath){
  return (machine,operation,args,options={})=>new Promise((resolve,reject)=>{
    const socket=net.createConnection(socketPath);let raw='',settled=false;
    const boundedRead=['logs','watch','diagnostics'].includes(operation),signal=boundedRead?options.signal:undefined;
    const timeoutMs=boundedRead&&Number.isInteger(options.rpcTimeoutMs)?Math.max(1,Math.min(32000,options.rpcTimeoutMs)):32000;
    let timer;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const unavailable=()=>Object.assign(Error('节点执行桥暂时不可用；操作结果未确认，请查询原任务状态。'),{status:503,code:'EXECUTOR_UNAVAILABLE'});
    const timeout=()=>Object.assign(Error('节点响应超时；操作结果未确认，请查询原任务状态。'),{status:504,code:'EXECUTOR_TIMEOUT'});
    const abort=()=>socket.destroy(signal.reason||Object.assign(Error('任务查询已取消。'),{status:499}));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
    // A bridge restart is infrastructure unavailability, not a bad user
    // request. Never reconnect/replay here: input or a mutation may be sent.
    // This is an elapsed deadline, not merely an inactivity timeout: partial
    // bytes cannot keep an abandoned remote query alive indefinitely.
    timer=setTimeout(()=>socket.destroy(timeout()),timeoutMs);
    socket.setTimeout(timeoutMs,()=>socket.destroy(timeout()));
    socket.on('connect',()=>socket.end(JSON.stringify({machine,operation,args})+'\n'));
    socket.on('data',part=>{raw+=part;if(Buffer.byteLength(raw)>2_000_000)socket.destroy(Object.assign(Error('节点执行桥响应过大；操作结果未确认。'),{status:502}));});
    socket.on('error',error=>finish(Number.isInteger(error.status)?error:unavailable()));
    socket.on('end',()=>{
      if(!raw)return finish(unavailable());
      let data;
      try{data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.ok!=='boolean')throw Error();}
      catch{return finish(Object.assign(Error('节点执行桥响应不完整；操作结果未确认。'),{status:502}));}
      // Native domain refusals keep their existing semantics, never become a
      // transient transport error and never trigger an implicit second write.
      if(!data.ok){
        if(['storage.training.plan','datasets.training.status'].includes(operation)&&data.code==='TRAINING_ADMISSION_BUSY'&&data.status===503)
          return finish(Object.assign(Error('数据正在使用，请稍后用原提交键重试；未提交训练。'),{status:503,code:'TRAINING_ADMISSION_BUSY'}));
        const transports={NODE_TRANSPORT_BUSY:[503,'节点连接查询繁忙；请稍后查询原状态。'],NODE_CONNECT_FAILED:[503,'节点连接暂时失败；操作结果未确认，请查询原状态。'],NODE_RESPONSE_TIMEOUT:[504,'节点处理超时；操作结果未确认，请查询原状态。'],NODE_SSH_AUTH_FAILED:[502,'节点 SSH 身份校验失败，请联系管理员；原操作不会自动重派。'],NODE_SSH_HOSTKEY_FAILED:[502,'节点 SSH 主机密钥校验失败，请联系管理员；原操作不会自动重派。'],NODE_RESPONSE_INVALID:[502,'节点响应协议异常；操作结果未确认，请查询原状态。']};
        const known=Object.hasOwn(transports,data.code)?transports[data.code]:null;
        if(known&&data.status===known[0])return finish(Object.assign(Error(known[1]),{status:known[0],code:data.code}));
        // A fixed training entry can fail before invoking the operation. Its
        // explicit uncertainty is not proof that a published release is absent.
        if(data.outcomeUnconfirmed===true)return finish(Object.assign(Error('节点操作结果未确认，请稍后查询原状态；不会自动重试。'),{status:503,code:'EXECUTOR_UNCONFIRMED'}));
        return finish(Error(data.error||'节点操作失败'));
      }
      finish(null,data.result);
    });
    socket.on('close',()=>{if(!settled)finish(unavailable());});
  });
}
