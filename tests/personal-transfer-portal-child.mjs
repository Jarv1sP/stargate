// Isolated real Portal process used by the mid-transfer restart test only.
import {readFile} from 'node:fs/promises';
import {createPortalServer} from '../portal-server.mjs';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
let sequence=0;const pending=new Map();
process.on('message',message=>{
  const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);
  if(message.error)entry.reject(Object.assign(Error(message.error),{status:message.status}));else entry.resolve(message.result);
});
const bridge=(machine,operation,args)=>new Promise((resolve,reject)=>{
  const id=++sequence;pending.set(id,{resolve,reject});process.send({id,machine,operation,args});
});
const {server,service}=await createPortalServer({...config,bridge,secure:false});
clearInterval(service.executionTimer);
await new Promise(resolve=>server.listen(config.port,'127.0.0.1',resolve));
process.send({ready:true,pid:process.pid});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
