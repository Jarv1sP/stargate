import {spawn} from 'node:child_process';
export function command(executable,args,{cwd,input='',timeoutMs=60000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,stdio:['pipe','pipe','pipe']}),timer=setTimeout(()=>child.kill('SIGTERM'),timeoutMs);let stdout='',stderr='';
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);
    child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
