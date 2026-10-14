// Actual C4 node storage and Portal HTTP; only the mount/space fixture is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer as createTCPServer} from 'node:net';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';
const root=resolve(import.meta.dirname,'..'),machine=MACHINES[0].id;
const python=String.raw`
import base64,importlib.util,json,sys
from pathlib import Path
root=Path(sys.argv[1]);jid=sys.argv[2]
s=importlib.util.spec_from_file_location('c3_output_contract',root/'tests/project-security.test.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
case=m.ProjectContract();case.setUp();node=case.node()
try:
 node.projects().store.create('peer','demo');output=node.projects().store.runtime_paths({'userId':'peer','project':'demo'},jid)['output']
 (output/'render'/'nested').mkdir(parents=True);(output/'render'/'empty').mkdir();(output/'render'/'nested'/'small.txt').write_bytes(b'nested output')
 (output/'render'/'many').mkdir()
 for n in range(205):(output/'render'/'many'/str(n)).write_text(str(n))
 (output/'render'/'large.bin').write_bytes(b'R'*(1024*1024+37))
 print(json.dumps({'ready':True}),flush=True)
 for line in sys.stdin:
  request=json.loads(line)
  try:reply={'id':request['id'],'result':node.process(request['op'],request['args'])}
  except Exception as error:reply={'id':request['id'],'error':str(error),'status':400}
  print(json.dumps(reply),flush=True)
finally:case.doCleanups()
`;
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'c3-real-output-')),jobId=randomUUID(),bootstrap=join(dir,'bootstrap'),password='C3-Actual-Output-Fixture!';await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
 const child=spawn(process.env.PYTHON||'python3',['-u','-c',python,process.env.C4_FIXTURE_ROOT||root,jobId],{stdio:['pipe','pipe','pipe']});let seq=0,stderr='',readyResolve,readyReject;
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;}),pending=new Map(),calls=[];child.stderr.on('data',bytes=>stderr+=bytes);
 createInterface({input:child.stdout}).on('line',line=>{const row=JSON.parse(line);if(row.ready)return readyResolve();const wait=pending.get(row.id);pending.delete(row.id);row.error?wait.reject(Object.assign(Error(row.error),{status:row.status})):wait.resolve(row.result);});
 child.on('error',readyReject);child.on('close',code=>{const error=Error('Actual node fixture exited '+code+': '+stderr);readyReject(error);for(const wait of pending.values())wait.reject(error);pending.clear();});
 const node=(op,args)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,op,args})+'\n');});let paused=false;
 await ready;
 const reservation=createTCPServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const origin='http://127.0.0.1:'+port;
 const {server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge:async(host,op,args)=>{
  assert.equal(host,machine);assert.ok(['files.list','files.get'].includes(op),op);calls.push({op,args:structuredClone(args)});const result=await node(op,args);
  if(paused&&op==='files.get'&&args.offset===1024**2)throw Object.assign(Error('fixture connection interrupted'),{status:503});return result;
 }});for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer'])clearInterval(service[key]);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 const admin=await service.login('admin',password);await service.invoke(admin.token,'users.create',{username:'reader',password});const reader=await service.login('reader',password);service.store.jobs.push({id:jobId,key:jobId,userId:'peer',ownerId:'peer',machine,project:'demo',name:'actual outputs',state:'SUCCEEDED',cards:1,spec:{id:jobId,userId:'peer',project:'demo',argv:['true']}});service.save();
 const session=join(dir,'session');await writeFile(session,JSON.stringify({url:origin,token:reader.token,principal:reader.principal}),{mode:0o600});
 const cli=args=>new Promise((resolve,reject)=>{const process=spawn(globalThis.process.execPath,[globalThis.process.env.OUTPUT_NODE_CLI||join(root,'build/gpuctl.mjs'),'--session-file',session,'--url',origin,'--json',...args,'--job',jobId]);let out='',err='';process.stdout.on('data',b=>out+=b);process.stderr.on('data',b=>err+=b);process.on('error',reject);process.on('close',code=>resolve({code,out,err}));});
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));child.stdin.end();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('close',resolve));await rm(dir,{recursive:true,force:true});});
 return {dir,calls,cli,jobId,pause:value=>{paused=value;}};
}
test('bundled CLI resumes actual node output bytes at the saved offset using only files.get',async t=>{
 const f=await fixture(t),destination=join(f.dir,'output.bin');f.pause(true);const stopped=await f.cli(['pull','render/large.bin',destination]);assert.equal(stopped.code,1,stopped.err);assert.equal((await lstat(destination+'.gpuctl-partial')).size,1024**2);await assert.rejects(lstat(destination),{code:'ENOENT'});
 f.pause(false);const mark=f.calls.length,value=await f.cli(['pull','render/large.bin',destination]);assert.equal(value.code,0,value.err);assert.equal(f.calls[mark].op,'files.get');assert.equal(f.calls[mark].args.offset,1024**2);assert.equal(f.calls[mark].args.runId,f.jobId);assert.deepEqual(await readFile(destination),Buffer.alloc(1024**2+37,82));
});
test('bundled CLI browses and resumes an actual node output directory, retaining nested and empty folders',async t=>{
 const f=await fixture(t),destination=join(f.dir,'outputs');const list=await f.cli(['files','render','--machine',machine]);assert.equal(list.code,0,list.err);assert.equal(JSON.parse(list.out).data.entries.length,4);
 f.pause(true);const stopped=await f.cli(['pull','render',destination]);assert.equal(stopped.code,1,stopped.err);const journal=JSON.parse(await readFile(destination+'.gpuctl-directory.json','utf8'));f.pause(false);const value=await f.cli(['pull','render',destination]);assert.equal(value.code,0,value.err);assert.equal(JSON.parse(value.out).data.downloadId,journal.id);assert.equal(await readFile(join(destination,'nested/small.txt'),'utf8'),'nested output');assert.equal((await lstat(join(destination,'empty'))).isDirectory(),true);assert.equal(JSON.parse(value.out).data.files,207);assert.equal(await readFile(join(destination,'many/204'),'utf8'),'204');assert.deepEqual(await readFile(join(destination,'large.bin')),Buffer.alloc(1024**2+37,82));assert.ok(f.calls.every(row=>['files.get','files.list'].includes(row.op)));
});
