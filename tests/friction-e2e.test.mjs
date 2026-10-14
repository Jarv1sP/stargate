import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer as reserveServer} from 'node:net';
import {mkdtemp,writeFile,readFile,rm,stat,open,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';
import {createPortalServer} from '../portal-server.mjs';
import {MACHINES} from '../dist/model.js';
const root=fileURLToPath(new URL('..',import.meta.url)),machine=MACHINES[0].id,password='Paired-Directory-Local-Only!';
const python=String.raw`
import importlib.util,json,sys
from pathlib import Path
source=Path(sys.argv[1])
s=importlib.util.spec_from_file_location('paired_current_projects',source/'tests/project-security.test.py')
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
case=f.ProjectContract();case.setUp();node=case.node()
node.projects().store.create('builtin-admin','test')
runtime=None
def enable_runtime():
 import base64,os,socket,sqlite3,subprocess,threading
 ops=node.projects();sessions={};runs={};launches=[]
 class LocalOCI:
  # Substitute only the unavailable local OCI/GPU/service-manager transport.
  # Git, programs, node state, file operations and HTTP are real, isolated bytes.
  def git(self,user,project,argv):
   code=ops.store.dev_paths(user,project)['code']
   result=subprocess.run(['git','-C',str(code),*argv],capture_output=True,text=True)
   if result.returncode:raise ValueError(result.stderr)
   return result.stdout.strip()
 ops.oci=lambda user:LocalOCI()
 source=case.base/'source-repo';source.mkdir()
 subprocess.run(['git','init','--initial-branch=main',str(source)],check=True,capture_output=True)
 (source/'train.py').write_text('import json,sys\nfrom pathlib import Path\ndata=Path(sys.argv[1]).read_bytes()\noutput=Path(sys.argv[2]);output.mkdir(exist_ok=True)\n(output/"result.json").write_text(json.dumps({"bytes":len(data),"prefix":data[:16].decode("ascii")}))\n')
 subprocess.run(['git','-C',str(source),'add','train.py'],check=True)
 subprocess.run(['git','-C',str(source),'-c','user.name=Local Test','-c','user.email=local@example.invalid','commit','-m','fixture'],check=True,capture_output=True)
 def shell(folder,jid):
  sock=socket.socket(socket.AF_UNIX);sock.bind(str(folder/(jid+'.sock')));sock.listen(4)
  value={'socket':sock,'history':b'','alive':True};sessions[jid]=value
  def serve():
   while value['alive']:
    try:connection,_=sock.accept()
    except OSError:break
    with connection:
     raw=b''
     while b'\n' not in raw:
      part=connection.recv(32768)
      if not part:break
      raw+=part
     request=json.loads(raw);spec=node.module('project-store').read_json(folder/(jid+'.json'))
     if request.get('input'):
      text=base64.b64decode(request['input']).decode()
      code=ops.store.dev_paths(spec['ownerId'],spec['project'])['code']
      result=subprocess.run(['/bin/bash','--noprofile','--norc','-c',text],cwd=code,capture_output=True,timeout=10)
      value['history']+=result.stdout+result.stderr
     offset=request.get('offset',0);data=value['history'][offset:]
     connection.sendall((json.dumps({'data':base64.b64encode(data).decode(),'offset':len(value['history']),'exited':False})+'\n').encode())
  thread=threading.Thread(target=serve,daemon=True);thread.start();value['thread']=thread
 def transport(argv,timeout=18):
  if '--project-init-worker' in argv:
   at=argv.index('--project-init-worker');assert ops.initialize(argv[at+1],argv[at+2])==0;return ''
  unit=next((a.split('=',1)[1] for a in argv if a.startswith('--unit=amax-term-')),None)
  if unit:
   jid=unit.removeprefix('amax-term-');shell(node.ROOT/'terminals',jid);return ''
  if 'show' in argv:
   jid=argv[argv.index('show')+1].removeprefix('amax-term-').removesuffix('.service')
   alive=sessions.get(jid,{}).get('alive',False)
   return 'ActiveState='+('active' if alive else 'inactive')+'\nMainPID='+str(os.getpid() if alive else 0)
  if 'stop' in argv:
   jid=argv[argv.index('stop')+1].removeprefix('amax-term-').removesuffix('.service');end_terminal(jid);return ''
  raise AssertionError('Unexpected service-manager transport: '+str(argv))
 def end_terminal(jid):
  value=sessions[jid];value['alive']=False
  try:value['socket'].shutdown(socket.SHUT_RDWR)
  except OSError:pass
  value['socket'].close();value['thread'].join(timeout=2)
  (node.ROOT/'terminals'/(jid+'.sock')).unlink(missing_ok=True)
 node.run=transport
 def scheduler(*args):
  if args[0]=='submit':
   jid=args[args.index('--submit-key')+1];spec=node.module('project-store').read_json(node.ROOT/'jobs'/(jid+'.json'))
   paths=ops.store.runtime_paths(spec,jid)
   program=[str(paths['code']/spec['argv'][1]),*spec['argv'][2:]]
   program=[a.replace('/datasets',str(case.config['datasetsRoot'])).replace('/outputs',str(paths['output'])) for a in program]
   result=subprocess.run([sys.executable,*program],cwd=paths['code'],capture_output=True,timeout=10)
   identifier='J'+format(len(runs)+1,'012x');runs[identifier]={'id':identifier,'state':'SUCCEEDED' if result.returncode==0 else 'FAILED','priority':2,'submit_key':jid}
   with sqlite3.connect(node.CONFIG['database']) as db:db.execute('insert into jobs values(?,?)',(identifier,jid))
   launches.append({'id':jid,'argv':spec['argv'],'launcher':args[-2]})
   return {'job_id':identifier}
  if args[0]=='show':return {'job':runs[args[1]],'attempts':[]}
  raise AssertionError('Unexpected GPU transport: '+str(args))
 node.gpu=scheduler
 return {'repo':str(source),'runs':runs,'launches':launches,'sessions':sessions,'close':lambda:[end_terminal(jid) for jid,value in list(sessions.items()) if value['alive']]}
try:
 for line in sys.stdin:
  request=json.loads(line)
  try:
   if request['op']=='fixture.enable-runtime':
    runtime=enable_runtime();result={'repo':runtime['repo']}
   elif request['op']=='fixture.runtime-result':result={'launches':runtime['launches']}
   elif request['op']=='fixture.seed-output':
    import base64
    args=request['args'];folder=node.projects().store.workspace_output('','',jobid=args['jobId'],create=True)
    for name,encoded in args['files'].items():
     target=folder/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(base64.b64decode(encoded))
    result={'seeded':True}
   else:result=node.process(request['op'],request['args'])
   value={'id':request['id'],'result':result}
  except Exception as error:value={'id':request['id'],'error':str(error),'status':403 if isinstance(error,PermissionError) else 400}
  print(json.dumps(value),flush=True)
finally:
 if runtime:runtime['close']()
 case.doCleanups()
`;
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'C2-paired-directories-')),bootstrap=join(dir,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
 // C4's fixture supplies a synthetic mount table/free-space sample; actual
 // node code performs all byte writes, offsets, atomic renames and trash operations.
 const child=spawn(process.env.PYTHON||'python3',['-u','-c',python,process.env.C2_NODE_ROOT||root],{stdio:['pipe','pipe','pipe']});
 let seq=0,stderr='';const pending=new Map(),calls=[],f={dir,calls,failChunk:false,failStatus:false};
 const lines=createInterface({input:child.stdout});child.stderr.on('data',part=>stderr+=part);
 lines.on('line',line=>{const value=JSON.parse(line),wait=pending.get(value.id);if(!wait)return;pending.delete(value.id);value.error?wait.reject(Object.assign(Error(value.error),{status:value.status})):wait.resolve(value.result);});
 child.on('close',code=>{for(const wait of pending.values())wait.reject(Error('Local node fixture exited '+code+': '+stderr));pending.clear();});
 const node=(op,args)=>new Promise((resolve,reject)=>{if(child.exitCode!==null)return reject(Error('Node fixture exited: '+stderr));const id=++seq;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,op,args})+'\n');});
 const bridge=async(host,op,args)=>{assert.equal(host,machine);calls.push({op,args:structuredClone(args)});
  if(op==='files.get'&&args.area==='output'&&args.offset>0&&f.failOutput)throw Object.assign(Error('output connection temporarily lost'),{status:503,code:'EXECUTOR_UNAVAILABLE'});
  if(op==='data.upload.status'&&f.failStatus)throw Object.assign(Error('local temporary disconnect'),{status:503,code:'EXECUTOR_UNAVAILABLE'});
  const value=await node(op,args);
  if(op==='data.upload.chunk'&&f.failChunk){f.failChunk=false;f.failStatus=true;throw Object.assign(Error('lost reply after real durable chunk'),{status:503,code:'EXECUTOR_UNAVAILABLE'});}return value;
 };
 const reserved=reserveServer();await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve));const port=reserved.address().port;await new Promise(resolve=>reserved.close(resolve));
 const origin='http://127.0.0.1:'+port,{server,service}=await createPortalServer({database:join(dir,'db'),bootstrap,origin,secure:false,bridge});clearInterval(service.executionTimer);
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));const login=await service.login('admin',password),session=join(dir,'session');await writeFile(session,JSON.stringify({url:origin,token:login.token,principal:login.principal}),{mode:0o600});
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve));lines.close();await rm(dir,{recursive:true,force:true});});
 const call=async(operation,args={},token=login.token)=>{const response=await fetch(origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({operation,args:{machine,...args},client:{name:'gpuctl',protocol:2}})});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{status:response.status,code:value.code});return value.result;};
 const cli=args=>new Promise((resolve,reject)=>{const entry=process.env.FRICTION_CLI_ENTRY||process.env.FRICTION_CLI_BUNDLE||join(root,'build/gpuctl.mjs'),child=spawn(process.execPath,[entry,'--url',origin,'--session-file',session,'--json',...args]);let out='',err='';child.stdout.on('data',part=>out+=part);child.stderr.on('data',part=>err+=part);child.once('error',reject);child.once('close',code=>resolve({code,out,err}));});
 return Object.assign(f,{origin,call,cli,service,login,node});
}
test('current CLI and Portal resume real node workspace bytes under the original key and publish atomically',async t=>{
 const f=await fixture(t),source=join(f.dir,'source'),destination=join(f.dir,'pulled'),bytes=randomBytes(512*1024+37),key=randomUUID();await writeFile(source,bytes);
 const args=['push',source,'paired.bin','--machine',machine,'--project','test','--key',key,'--via','relay'];f.failChunk=true;const first=await f.cli(args);assert.equal(first.code,1,first.out);assert.ok(first.err.includes(key),first.err);
 assert.equal(f.calls.filter(row=>row.op==='data.upload.chunk').length,1,first.err+' RPC='+JSON.stringify(f.calls));assert.equal(f.calls.some(row=>row.op==='data.upload.finish'),false);
 f.failStatus=false;const resumed=await f.cli(args);assert.equal(resumed.code,0,resumed.err);assert.deepEqual(f.calls.filter(row=>row.op==='data.upload.chunk').map(row=>row.args.offset),[0,512*1024]);
 assert.ok(f.calls.filter(row=>row.op==='data.upload.begin').every(row=>row.args.key===key&&!Object.hasOwn(row.args,'sha256')));
 const pulled=await f.cli(['pull','paired.bin',destination,'--machine',machine,'--project','test','--via','portal']);assert.equal(pulled.code,0,pulled.err);assert.deepEqual(await readFile(destination),bytes);
});
test('Portal and real node replace same-size dataset bytes, retain partial writes and share trash restore',async t=>{
 const f=await fixture(t),scope={area:'dataset',dataset:'shared'},key=randomUUID();
 const write=async(value,id)=>{await f.call('data.upload.begin',{...scope,key:id,path:'data.bin',totalSize:value.length});await f.call('data.upload.chunk',{...scope,key:id,offset:0,data:Buffer.from(value).toString('base64')});return f.call('data.upload.finish',{...scope,key:id});};
 await write('old',randomUUID());await f.call('data.upload.begin',{...scope,key,path:'data.bin',totalSize:3});await f.call('data.upload.chunk',{key,offset:0,data:Buffer.from('ne').toString('base64')});
 assert.equal(Buffer.from((await f.call('files.get',{...scope,path:'data.bin'})).data,'base64').toString(),'old');await assert.rejects(f.call('data.upload.finish',{key}),/尚未完成/);assert.equal((await f.call('data.upload.status',{key})).offset,2);
 await f.call('data.upload.chunk',{key,offset:2,data:Buffer.from('w').toString('base64')});await f.call('data.upload.finish',{key});assert.equal(Buffer.from((await f.call('files.get',{...scope,path:'data.bin'})).data,'base64').toString(),'new');
 const member=await f.call('users.create',{username:'paired-member',password}),login=await f.service.login(member.username,password),deletion=randomUUID();assert.equal((await f.call('datasets.delete',{dataset:'shared',key:deletion},login.token)).state,'TRASHED');assert.equal((await f.call('datasets.list')).datasets.length,0);
 const entry=(await f.call('projects.retire.list')).items.find(row=>row.key===deletion);assert.equal(entry.kind,'dataset');assert.equal(entry.actor.userId,member.id);await f.call('projects.retire.restore',{key:deletion,kind:'dataset'});assert.equal(Buffer.from((await f.call('files.get',{...scope,path:'data.bin'})).data,'base64').toString(),'new');
});
test('CLI delivery retains bounded Range, release ETag and atomic local publication',async t=>{
 const f=await fixture(t),first=await fetch(f.origin+'/gpuctl.mjs',{headers:{range:'bytes=0-1023'}});assert.equal(first.status,206);const etag=first.headers.get('etag'),total=Number(first.headers.get('content-range').split('/')[1]),partial=join(f.dir,'partial'),destination=join(f.dir,'gpuctl.mjs');assert.ok(etag);const file=await open(partial,'wx',0o600);
 try{await file.write(Buffer.from(await first.arrayBuffer()));const rest=await fetch(f.origin+'/gpuctl.mjs',{headers:{range:'bytes=1024-','if-range':etag}});assert.equal(rest.status,206);assert.equal(rest.headers.get('etag'),etag);let offset=1024;for await(const bytes of rest.body){await file.write(bytes,0,bytes.length,offset);offset+=bytes.length;}assert.equal(offset,total);await file.sync();}finally{await file.close();}await rename(partial,destination);assert.equal((await stat(destination)).size,total);
});
test('current CLI displays targeted announcements and acknowledges only the explicitly read edition',async t=>{
 const f=await fixture(t),post=(await f.call('community.posts.create',{key:randomUUID(),kind:'announcement',title:'Paired notice',body:'Local notice text',popup:true,audience:{type:'users',userIds:[f.login.principal.userId]}})).post;
 const shown=await f.cli(['community','posts']);assert.equal(shown.code,0,shown.err);assert.match(shown.err,/Local notice text/);assert.equal((await f.call('community.announcements.pending')).posts.length,1);const ack=await f.cli(['community','ack',post.id,'--revision',String(post.revision)]);assert.equal(ack.code,0,ack.err);assert.equal((await f.call('community.announcements.pending')).posts.length,0);
});

test('real node output browsing, single-file resume, directory download and trash restore use files.get',async t=>{
 const f=await fixture(t),jobId=randomUUID(),bytes=randomBytes(1024**2+37),destination=join(f.dir,'output.bin'),directory=join(f.dir,'output-tree');
 await f.node('fixture.seed-output',{jobId,files:{'result.bin':bytes.toString('base64'),'nested/note.txt':Buffer.from('output note').toString('base64')}});
 f.service.store.jobs.push({id:jobId,key:randomUUID(),userId:'builtin-admin',ownerId:'builtin-admin',machine,project:'test',spec:{project:'test',argv:['true']},state:'SUCCEEDED',cards:1});
 const context={area:'output',runId:jobId};assert.equal((await f.call('files.list',{...context,path:'.'})).entries.length,2);
 const args=['pull','result.bin',destination,'--machine',machine,'--project','test','--job',jobId,'--via','portal'];f.failOutput=true;
 const first=await f.cli(args);assert.equal(first.code,1,first.out);assert.equal((await stat(destination+'.gpuctl-partial')).size,1024**2);
 const count=f.calls.length;f.failOutput=false;const resumed=await f.cli(args);assert.equal(resumed.code,0,resumed.err);assert.equal(f.calls.slice(count).find(row=>row.op==='files.get').args.offset,1024**2);assert.deepEqual(await readFile(destination),bytes);
 const tree=await f.cli(['pull','.',directory,'--machine',machine,'--project','test','--job',jobId,'--via','portal']);assert.equal(tree.code,0,tree.err);assert.deepEqual(await readFile(join(directory,'result.bin')),bytes);assert.equal(await readFile(join(directory,'nested/note.txt'),'utf8'),'output note');
 const key=randomUUID();assert.equal((await f.call('outputs.delete',{jobId,key,path:'result.bin'})).state,'TRASHED');assert.equal((await f.call('projects.retire.list')).items.find(row=>row.key===key).kind,'output');await f.call('projects.retire.restore',{key,kind:'output'});assert.equal(Buffer.from((await f.call('files.get',{...context,path:'result.bin'})).data,'base64').length,1024**2);
 assert.ok(f.calls.filter(row=>row.op.startsWith('files.')).every(row=>row.op==='files.list'||row.op==='files.get'));
});

test('repository project, terminal git, dataset resume, training bytes, output download and shared recovery form one local chain',async t=>{
 const f=await fixture(t),setup=await f.node('fixture.enable-runtime',{}),project='repository-chain';
 const created=await f.cli(['project','create',project,'--repo',setup.repo,'--machine',machine]);assert.equal(created.code,0,created.err);
 const status=await f.call('projects.status',{project});assert.equal(status.git.url,setup.repo);assert.equal(status.git.branch,'main');assert.match(status.git.commit,/^[a-f0-9]{40}$/);
 const key=randomUUID(),clientId=randomUUID(),terminal=await f.call('terminal.open',{project,key,clientId,mode:'new'});assert.equal(terminal.state,'OPEN');
 const command='git branch --show-current && git rev-parse HEAD\n';
 const read=await f.call('terminal.exchange',{project,id:terminal.id,clientId,writerToken:terminal.writerToken,offset:0,input:Buffer.from(command).toString('base64')});
 const text=Buffer.from(read.data,'base64').toString();assert.match(text,/main/);assert.ok(text.includes(status.git.commit));
 assert.equal(f.calls.filter(row=>row.op==='terminal.exchange'&&row.args.input).length,1,'terminal input is sent once');
 const bytes=Buffer.concat([Buffer.from('directory-dataset'),Buffer.alloc(512*1024,97)]),local=join(f.dir,'dataset.bin'),uploadKey=randomUUID();await writeFile(local,bytes);
 const upload=['data','put',local,'shared','dataset.bin','--machine',machine,'--key',uploadKey,'--via','relay'];
 f.failChunk=true;const interrupted=await f.cli(upload);assert.equal(interrupted.code,1);assert.ok(interrupted.err.includes(uploadKey));
 f.failStatus=false;const resumed=await f.cli(upload);assert.equal(resumed.code,0,resumed.err);
 const chunks=f.calls.filter(row=>row.op==='data.upload.chunk'&&row.args.key===uploadKey);assert.deepEqual(chunks.map(row=>row.args.offset),[0,512*1024]);
 assert.equal((await f.call('datasets.list')).datasets.find(row=>row.dataset==='shared').size,bytes.length);
 const jobKey=randomUUID(),run=await f.cli(['run','--machine',machine,'--project',project,'-g','1','--key',jobKey,'--','python3','train.py','/datasets/shared/dataset.bin','/outputs']);assert.equal(run.code,0,run.err);
 const submitted=JSON.parse(run.out).data,deadline=Date.now()+5000;let observed;
 do{observed=await f.call('jobs.watch',{jobId:submitted.id});if(observed.state==='SUCCEEDED')break;await new Promise(resolve=>setTimeout(resolve,30));}while(Date.now()<deadline);
 assert.equal(observed.state,'SUCCEEDED',JSON.stringify(observed));
 const runtime=await f.node('fixture.runtime-result',{});assert.equal(runtime.launches.length,1);assert.equal(runtime.launches[0].id,submitted.id);assert.match(runtime.launches[0].launcher,/oci-runner\.py$/);assert.deepEqual(runtime.launches[0].argv,['python3','train.py','/datasets/shared/dataset.bin','/outputs']);
 const output=join(f.dir,'result.json'),pulled=await f.cli(['pull','result.json',output,'--machine',machine,'--project',project,'--job',submitted.id,'--via','portal']);assert.equal(pulled.code,0,pulled.err);
 assert.deepEqual(JSON.parse(await readFile(output,'utf8')),{bytes:bytes.length,prefix:bytes.subarray(0,16).toString()});
 const member=await f.call('users.create',{username:'chain-member',password}),login=await f.service.login(member.username,password);
 const datasetTrash=randomUUID(),deleted=await f.call('datasets.delete',{dataset:'shared',key:datasetTrash},login.token);assert.equal(deleted.state,'TRASHED');
 assert.equal((await f.call('datasets.list')).datasets.length,0);await f.call('projects.retire.restore',{key:datasetTrash,kind:'dataset'});assert.deepEqual(Buffer.from((await f.call('files.get',{area:'dataset',dataset:'shared',path:'dataset.bin'})).data,'base64'),bytes);
 const outputTrash=randomUUID();assert.equal((await f.call('outputs.delete',{jobId:submitted.id,path:'result.json',key:outputTrash},login.token)).state,'TRASHED');await f.call('projects.retire.restore',{key:outputTrash,kind:'output'});
 const projectTrash=randomUUID();assert.equal((await f.call('projects.retire',{project,ownerId:'builtin-admin',key:projectTrash},login.token)).state,'TRASHED');await f.call('projects.retire.restore',{key:projectTrash,kind:'project'});
 assert.equal((await f.call('projects.status',{project})).git.commit,status.git.commit);
 await f.call('terminal.close',{project,id:terminal.id,clientId,writerToken:terminal.writerToken});
});
