// M1 四条验收中的前三条；拆除与残留检查由 teardown.sh 完成。
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const file=resolve(process.argv[2]),folder=dirname(file);
const stack=JSON.parse(await readFile(file,'utf8'));
const url=new URL(stack.origin);
assert.equal(url.hostname,'127.0.0.1');assert.equal(stack.project,'stargate-gray');
const health=await fetch(url.origin+'/healthz').then(r=>r.json());assert.equal(health.ok,true);
const python='import socket,json;s=socket.socket(socket.AF_UNIX);s.connect("/bridge/bridge.sock");s.sendall(json.dumps({"machine":"gray-node-1","operation":"projects.list","args":{"userId":"builtin-admin"}}).encode()+b"\\n");s.shutdown(socket.SHUT_WR);print(s.makefile().read())';
const {stdout}=await promisify(execFile)('docker',['compose','-p','stargate-gray','-f',folder+'/compose.yml','exec','-T','gray-bridge','python3','-c',python],{timeout:40000});
const bridge=JSON.parse(stdout);assert.equal(bridge.ok,true,stdout);
const post=async(path,body,token)=>{
  const response=await fetch(url.origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:url.origin,...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
};
const login=await post('/api/login',{username:'admin',password:(await readFile(folder+'/admin-password','utf8')).trim()});
let host;
for(let attempt=0;attempt<30;attempt++){
  const state=(await post('/api/call',{operation:'state',args:{}},login.token)).state;
  host=state.gpuq?.hosts?.find(h=>h.id==='gray-node-1');
  if(host?.reachable&&host.gpus?.length===2&&host.gpuq?.connected)break;
  await new Promise(r=>setTimeout(r,2000));
}
assert.equal(host?.reachable,true);assert.equal(host.gpus.length,2);assert.equal(host.gpuq.connected,true);
await post('/api/call',{operation:'logout',args:{}},login.token);
await writeFile(folder+'/m1-acceptance.json',JSON.stringify({health,bridge,host},null,2));
console.log('M1 前三条通过：healthz、projects.list、已登录资源状态；拆除验收待执行。');
