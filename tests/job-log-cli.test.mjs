// CLI -> real Portal HTTP/SQLite -> Python node reader -> real log bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createInterface} from 'node:readline';
import {mkdtemp,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';

const root=resolve(import.meta.dirname,'..'),machine=MACHINES[0].id;
const python=String.raw`
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('logs_fixture',Path(sys.argv[1])/'tests/job-log-download.test.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
case=m.JobLogDownload();case.setUp()
try:
 print(json.dumps({'ready':True,'jobId':case.job['id']}),flush=True)
 for line in sys.stdin:
  request=json.loads(line)
  try:
   if request['op']=='fixture.new-attempt':
    path=case.base/'new.log';path.write_bytes(b'new run must not replace the old download')
    case.attempts.insert(0,{'id':'A'+'3'*32,'log_path':str(path)});result={}
   else:result=case.node.process(request['op'],request['args'])
   reply={'id':request['id'],'result':result}
  except Exception as error:reply={'id':request['id'],'error':str(error),'status':400}
  print(json.dumps(reply),flush=True)
finally:case.doCleanups()
`;

test('official CLI exports and resumes a complete canceled-job log through the Portal',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'job-log-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const child=spawn(process.env.PYTHON||'python3',['-u','-c',python,root],{stdio:['pipe','pipe','pipe']});
 let seq=0,stderr='',readyResolve,readyReject;const pending=new Map();
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 child.stderr.on('data',b=>stderr+=b);
 createInterface({input:child.stdout}).on('line',line=>{
  const value=JSON.parse(line);if(value.ready)return readyResolve(value);
  const request=pending.get(value.id);pending.delete(value.id);
  value.error?request.reject(Object.assign(Error(value.error),{status:value.status})):request.resolve(value.result);
 });
 child.on('error',readyReject);child.on('close',code=>{
  const error=Error('node fixture exited '+code+': '+stderr);readyReject(error);
  for(const request of pending.values())request.reject(error);pending.clear();
 });
 t.after(async()=>{child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve));});
 const node=(op,args={})=>new Promise((resolve,reject)=>{
  const id=++seq;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,op,args})+'\n');
 });
 const {jobId}=await ready;
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const origin='http://127.0.0.1:'+port;
 const bootstrap=join(dir,'bootstrap'),password='Job-Log-Only-Fixture-2026!';await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 let stopped=false;const calls=[];
 const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge:async(host,op,args)=>{
  assert.equal(host,machine);assert.equal(op,'logs');calls.push({...args});
  if(stopped&&args.offset)throw Object.assign(Error('fixture interrupted'),{status:400});
  return node(op,args);
 }});
 for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer'])clearInterval(service[key]);
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const admin=await service.login('admin',password);await service.invoke(admin.token,'users.create',{username:'reader',password});
 const reader=await service.login('reader',password);
 service.store.jobs.push({id:jobId,key:jobId,userId:'alice',machine,state:'CANCELED',cards:1,
  spec:{id:jobId,userId:'alice',project:'demo',cards:1,argv:['true']}});service.save();
 const session=join(dir,'session');await writeFile(session,JSON.stringify({url:origin,token:reader.token,principal:reader.principal}),{mode:0o600});
 const cli=argv=>new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,[process.env.LOG_DOWNLOAD_CLI||join(root,'cli.mjs'),'--session-file',session,'--url',origin,'--json',...argv]);let out='',err='';
  p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',code=>resolve({code,out,err}));
 });
 const tail=await cli(['logs',jobId]);assert.equal(tail.code,0,tail.err);assert.equal(JSON.parse(tail.out).data.text,'last 200 lines\n');
 const destination=join(dir,'job.log');stopped=true;
 const interrupted=await cli(['logs',jobId,'--output',destination]);assert.equal(interrupted.code,1,interrupted.err);
 assert.equal((await lstat(destination+'.gpuctl-partial')).size,1024**2);await assert.rejects(lstat(destination),{code:'ENOENT'});
 await node('fixture.new-attempt');stopped=false;calls.length=0;
 const resumed=await cli(['logs',jobId,'--output',destination]);assert.equal(resumed.code,0,resumed.err);
 const chunks=calls.filter(args=>args.offset!==undefined);
 assert.equal(chunks[0].offset,1024**2);assert.ok(chunks.every(args=>args.attemptId==='A'+'2'.repeat(32)));
 const expected=Buffer.concat([Buffer.from('first line\n'+'x\n'.repeat(1024**2)+'last line\n'),Buffer.from([255])]);
 assert.deepEqual(await readFile(destination),expected);assert.equal(JSON.parse(resumed.out).data.bytes,expected.length);
 const mark=calls.length,invalid=await cli(['queue','--output',join(dir,'bad.log')]);assert.equal(invalid.code,1);
 assert.match(invalid.err,/只用于 logs/);assert.equal(calls.length,mark);
});
