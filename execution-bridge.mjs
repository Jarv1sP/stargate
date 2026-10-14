import net from 'node:net';

export function bridgeClient(socketPath){
  return (machine,operation,args,options={})=>new Promise((resolve,reject)=>{
    let socket,raw='',settled=false,retries=0,retryTimer,lastErrno=null;
    // Only trusted read contexts can shorten/cancel a bridge request. Wire args
    // cannot opt a mutation into replay or change its original 32s deadline.
    const boundedRead=['data.upload.status','datasets.list','files.list','files.get','files.stat','logs','watch','diagnostics',
      'projects.list','projects.quota','projects.status','projects.retire.list','projects.retire.status'].includes(operation);
    const signal=boundedRead?options.signal:undefined;
    const timeoutMs=boundedRead&&Number.isInteger(options.rpcTimeoutMs)?Math.max(1,Math.min(32000,options.rpcTimeoutMs)):32000;
    const deadline=Date.now()+timeoutMs;
    let timer;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(retryTimer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const abort=()=>{const error=signal.reason||Object.assign(Error('上传查询已取消。'),{status:499,code:'UPLOAD_READ_CANCELLED'});if(socket)socket.destroy(error);else finish(error);};
    if(signal?.aborted){finish(signal.reason);return;}
    signal?.addEventListener('abort',abort,{once:true});
    const unavailable=()=>Object.assign(Error('节点执行桥暂时不可用；结果未知，请查询原任务状态。'+(lastErrno?' ('+lastErrno+')':'')),{status:503,code:'EXECUTOR_UNAVAILABLE',...(lastErrno?{errno:lastErrno}:{})});
    const timeout=()=>Object.assign(Error('节点响应超时；结果未知，请查询原任务状态。'),{status:504,code:'EXECUTOR_TIMEOUT'});
    // Only an EAGAIN before connect (zero request bytes) is safe to retry.
    // Refusal, EOF and errors after connect never replay an operation.
    // This is an elapsed deadline, not merely an inactivity timeout: partial
    // bytes cannot keep an abandoned remote query alive indefinitely.
    timer=setTimeout(()=>socket?socket.destroy(timeout()):finish(timeout()),timeoutMs);
    const connect=()=>{
    if(settled)return;
    if(Date.now()>=deadline)return finish(timeout());
    const current=socket=net.createConnection(socketPath);let connected=false;
    current.setTimeout(Math.max(1,deadline-Date.now()),()=>current.destroy(timeout()));
    current.on('connect',()=>{connected=true;lastErrno=null;current.end(JSON.stringify({machine,operation,args})+'\n');});
    current.on('data',part=>{raw+=part;if(Buffer.byteLength(raw)>2_000_000)current.destroy(Object.assign(Error('节点执行桥响应过大；结果未知。'),{status:502}));});
    current.on('error',error=>{
      if(settled||socket!==current)return;
      lastErrno=typeof error.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:null;
      if(error.code==='EAGAIN'&&!connected&&current.bytesWritten===0&&retries<8&&Date.now()<deadline){
        retries++;socket=null;current.destroy();
        retryTimer=setTimeout(connect,Math.min(10+Math.floor(Math.random()*71),deadline-Date.now()));
        return;
      }
      finish(Number.isInteger(error.status)?error:unavailable());
    });
    current.on('end',()=>{
      if(!raw)return finish(unavailable());
      let data;
      try{data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.ok!=='boolean')throw Error();}
      catch{return finish(Object.assign(Error('节点执行桥响应不完整；结果未知。'),{status:502}));}
      // Native domain refusals keep their existing semantics, never become a
      // transient transport error and never trigger an implicit second write.
      if(!data.ok){
        if(operation==='data.upload.status'&&data.error==='UPLOAD_STATUS_BUSY')
          return finish(Object.assign(Error('上传元数据暂时繁忙；请稍后用原上传编号查询，状态未知，请按原编号查询。'),{status:503,code:'UPLOAD_STATUS_BUSY'}));
        const transports={NODE_TRANSPORT_BUSY:[503,'节点连接查询繁忙；请稍后查询原状态。'],NODE_CONNECT_FAILED:[503,'节点连接暂时失败；结果未知，请查询原状态。'],NODE_RESPONSE_TIMEOUT:[504,'节点处理超时；结果未知，请查询原状态。'],NODE_SSH_AUTH_FAILED:[502,'节点登录失败，请联系管理员；原操作不会自动重派。'],NODE_SSH_HOSTKEY_FAILED:[502,'节点证书校验失败，请联系管理员；原操作不会自动重派。'],NODE_RESPONSE_INVALID:[502,'节点响应协议异常；结果未知，请查询原状态。']};
        const known=Object.hasOwn(transports,data.code)?transports[data.code]:null;
        if(known&&data.status===known[0])return finish(Object.assign(Error(known[1]),{status:known[0],code:data.code}));
        // A fixed training entry can fail before invoking the operation. Its
        // an uncertain result cannot be treated as an absent operation.
        if(data.outcomeUnconfirmed===true)return finish(Object.assign(Error('节点结果未知，请稍后查询原状态；不会自动重试。'),{status:503,code:'EXECUTOR_UNCONFIRMED'}));
        return finish(Error(data.error||'节点操作失败'));
      }
      finish(null,data.result);
    });
    current.on('close',()=>{if(!settled&&socket===current)finish(unavailable());});
    };
    connect();
  });
}
