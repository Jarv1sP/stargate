import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export function validateStack(stack){
  const url=new URL(stack.origin);
  if(stack.project!=='stargate-gray'||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.search||url.hash||url.username||url.password)
    throw Error('只接受 127.0.0.1 和 stargate-gray 项目');
  return stack;
}
export async function loadStack(file){
  file=resolve(file);const stack=validateStack(JSON.parse(await readFile(file,'utf8')));
  return {...stack,file,admin:{username:'admin',password:(await readFile(resolve(dirname(file),'admin-password'),'utf8')).trim()},
    config:{tier:stack.tier,nodes:stack.machines.length}};
}
export async function compose(stack,...args){
  validateStack(stack);
  return promisify(execFile)('docker',['compose','-p','stargate-gray','-f',resolve(dirname(stack.file),'compose.yml'),...args],{timeout:180000,maxBuffer:4*1024*1024});
}
export async function stackExec(stack,service,...args){
  if(!/^gray-(node-1|bridge|collector|portal|git|registry)$/.test(service))throw Error('服务不属于灰度栈');
  return compose(stack,'exec','-T',service,...args);
}
