import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const principal={userId:'demo-user-1',username:'terminal-tester',role:'member'};
const original='11111111-2222-4333-8444-555555555555';
const entry=process.env.TERMINAL_RECOVERY_TEST_CLI||fileURLToPath(new URL('../cli.mjs',import.meta.url));
async function assertPrivateSession(path){
  if(process.platform!=='win32'){assert.equal((await stat(path)).mode&0o777,0o600);return;}
  // NTFS reports synthetic POSIX 0666. Verify the real DACL instead: only
  // this user, SYSTEM and local administrators may read/write fixture data.
  const quoted=path.replaceAll("'","''");
  const command=`$ErrorActionPreference='Stop';$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$allowed=@($user,'S-1-5-18','S-1-5-32-544');$acl=Get-Acl -LiteralPath '${quoted}';foreach($ace in $acl.Access){if($ace.AccessControlType -eq 'Allow' -and (([int]$ace.FileSystemRights -band 7) -ne 0)){$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid -notin $allowed){throw 'Fixture session allows another principal'}}}`;
  execFileSync(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{stdio:'pipe'});
}

async function fixture(t,{open, drop=false, status, close, exchange, dropExchange=false, openStatus=503,openError}={}){
  const dir=await mkdtemp(join(tmpdir(),'terminal-open-recovery-'));
  const session=join(dir,'session.json'), marker=join(dir,'raw-mode.jsonl'), preload=join(dir,'tty.mjs');
  const calls=[];let stderr='',atDispatch;
  await writeFile(preload,`import {appendFileSync} from 'node:fs';
    Object.defineProperty(process.stdin,'isTTY',{value:true});
    process.stdin.setRawMode=value=>{appendFileSync(${JSON.stringify(marker)},JSON.stringify(value)+'\\n');return process.stdin;};`);
  const server=createServer(async(req,res)=>{
    try{
      let body='';for await(const chunk of req)body+=chunk;
      const {operation,args={}}=JSON.parse(body);
      res.setHeader('Content-Type','application/json');
      const state={demo:false,gpuqConnected:true,machines:[{id:'gpu-1'}],users:[],jobs:[]};
      if(operation==='community.announcements.pending'){assert.deepEqual(args,{});res.end(JSON.stringify({result:{posts:[]}}));return;}
      calls.push({operation,args});
      if(operation==='community.notes.delete')return res.end(JSON.stringify({result:{deleted:true,id:args.id}}));
      if(operation==='state')return res.end(JSON.stringify({state}));
      if(operation==='terminal.open'){
        atDispatch={cache:JSON.parse(await readFile(session,'utf8')),stderr};
        if(drop){req.socket.destroy();return;}
        if(open)return res.end(JSON.stringify({result:{clientId:args.clientId,mode:args.mode,hostAdmin:args.hostAdmin,leaseExpiresAt:Date.now()/1000+30,...await open(args)}}));
        res.statusCode=openStatus;return res.end(JSON.stringify(openError||{error:'node unavailable'}));
      }
      if(operation==='terminal.status')return res.end(JSON.stringify({result:status?await status(args):{protocol:'terminal-session-status-v1',id:args.id,state:'UNKNOWN',evidence:{confirmed:false}}}));
      if(operation==='terminal.exchange'){
        if(dropExchange){req.socket.destroy();return;}
        return res.end(JSON.stringify({result:exchange?await exchange(args):{offset:0,data:'',exited:true}}));
      }
      if(operation==='terminal.close')return res.end(JSON.stringify({result:close?await close(args):{closed:true}}));
      if(operation==='terminal.detach')return res.end(JSON.stringify({result:{detached:true}}));
      throw Error('Unexpected operation: '+operation);
    }catch(error){res.statusCode=error.status||400;res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  await writeFile(session,JSON.stringify({url,token:'test-only',principal,machine:'gpu-1',projectsByMachine:{'gpu-1':'alpha'}}),{mode:0o600});
  const cli=(argv,input='')=>new Promise((resolve,reject)=>{
    stderr='';let stdout='';
    const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,entry,'--session-file',session,'--json',...argv]);
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input);
  });
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return {url,session,marker,calls,cli,dispatch:()=>atDispatch};
}

function errorJSON(result){
  const line=result.stderr.trim().split(/\r?\n/).findLast(value=>value.startsWith('{'));
  assert.ok(line,'JSON errors remain machine-readable on stderr');return JSON.parse(line);
}

for(const {name,argv,scope,command} of [
  {name:'project',argv:['ssh'],scope:{machine:'gpu-1',project:'alpha'},command:'--project alpha'},
])test(`503 prints the original ${name} UUID and scope before dispatch, without entering interaction`,async t=>{
  const f=await fixture(t),result=await f.cli(argv);
  assert.equal(result.code,1);
  const opened=f.calls.find(call=>call.operation==='terminal.open').args;
  assert.match(opened.key,UUID);
  assert.ok(f.dispatch().stderr.includes(opened.key),'The original UUID must be printed before dispatch');
  const error=errorJSON(result);
  assert.equal(error.status,503);
  assert.equal(error.ok,false);assert.equal(error.terminal.id,opened.key);
  assert.equal(error.terminal.state,'UNKNOWN');for(const [key,value] of Object.entries(scope))assert.equal(error.terminal[key],value);
  assert.equal(error.terminal.statusCommand,`gpuctl terminal status ${opened.key} --machine gpu-1 ${command} --url '${f.url}' --session-file '${f.session}'`);
  assert.deepEqual(f.calls.map(call=>call.operation),['terminal.open','terminal.status'],'Only one read of the original session, never another open, attach, exchange or close');
  assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
  await assertPrivateSession(f.session);
});

test('a lost open response retains the original UUID instead of creating another session',async t=>{
  const f=await fixture(t,{drop:true}),result=await f.cli(['ssh']);
  assert.equal(result.code,1);
  const id=f.calls.find(call=>call.operation==='terminal.open').args.key;
  assert.equal(errorJSON(result).terminal.id,id);
  assert.deepEqual(f.calls.map(call=>call.operation),['terminal.open','terminal.status']);
});

test('an uncertain reconnect retains the old session UUID, not the new request key',async t=>{
  const f=await fixture(t),result=await f.cli(['ssh','--reconnect',original]);
  const args=f.calls.find(call=>call.operation==='terminal.open').args;
  assert.notEqual(args.key,original);assert.equal(args.id,original);assert.equal(args.takeover,false);
  const error=errorJSON(result);assert.equal(error.terminal.id,original);
  assert.equal(error.terminal.statusCommand,`gpuctl terminal status ${original} --machine gpu-1 --project alpha --url '${f.url}' --session-file '${f.session}'`);
  assert.deepEqual(f.calls.map(call=>call.operation),['terminal.open','terminal.status']);
});

test('a matching ID without a write lease never enters interaction',async t=>{
  const f=await fixture(t,{open:args=>({id:args.key})}),result=await f.cli(['ssh']);
  assert.equal(result.code,1);assert.equal(errorJSON(result).terminal.state,'UNKNOWN');
  assert.deepEqual(f.calls.map(call=>call.operation),['terminal.open']);
  assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
});

test('the node writer lease allows interaction and stays out of disk',async t=>{
  const token=randomUUID();
  const f=await fixture(t,{open:args=>({id:args.id||args.key,writerToken:token})}),result=await f.cli(['ssh']);
  assert.equal(result.code,0,result.stderr);
  const args=f.calls.find(call=>call.operation==='terminal.open').args;
  assert.deepEqual(f.calls.map(call=>call.operation),['terminal.open','terminal.exchange','terminal.status'],'A confirmed shell exit only reads the original status; it does not close or detach');
  assert.equal(f.calls[1].args.id,args.key);assert.equal(f.calls[1].args.writerToken,token);
  assert.equal(await readFile(f.marker,'utf8'),'true\nfalse\n');
  const cache=await readFile(f.session,'utf8');assert.doesNotMatch(cache,/writerToken|clientId/);assert.equal(cache.includes(token),false);
});

for(const argv of [['ssh'],['ssh','--reconnect',original]])test(`uncertain ${argv.join(' ')} observes the original ALIVE session once and requires explicit reconnect`,async t=>{
  const f=await fixture(t,{drop:true,status:args=>({protocol:'terminal-session-status-v1',id:args.id,state:'ALIVE',writerLeaseExpired:true,evidence:{confirmed:true,socket:'RESPONDING'},writerToken:'never-trust-or-persist-status-credentials'})});
  const result=await f.cli(argv),error=errorJSON(result),opened=f.calls.find(c=>c.operation==='terminal.open').args;
  const id=opened.id||opened.key;
  assert.equal(result.code,1,'A read status cannot acquire a writer or enter interaction');
  assert.equal(error.terminal.id,id);assert.equal(error.terminal.state,'ALIVE');assert.equal(error.terminal.writerLeaseExpired,true);assert.ok(error.terminal.reconnectCommand.includes(f.url));assert.ok(error.terminal.reconnectCommand.includes(f.session));
  assert.match(error.error,/原终端仍在运行，尚未附着/);assert.ok(error.error.includes(error.terminal.reconnectCommand));assert.ok(error.terminal.reconnectCommand.includes('--reconnect '+id));
  assert.deepEqual(f.calls.map(c=>c.operation),['terminal.open','terminal.status']);
  const probe=f.calls.at(-1).args;assert.equal(probe.id,id);assert.equal(probe.machine,'gpu-1');assert.equal(probe.hostAdmin,opened.hostAdmin);
  assert.equal(probe.project,opened.project);assert.equal(probe.dataWorkspace,opened.dataWorkspace);
  for(const key of ['key','clientId','writerToken','input','takeover'])assert.equal(Object.hasOwn(probe,key),false);
  assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
  assert.doesNotMatch(result.stderr+await readFile(f.session,'utf8'),/never-trust-or-persist-status-credentials/);
});

test('confirmed STOPPED after a lost open is reported as ended without creating a replacement',async t=>{
 const f=await fixture(t,{status:args=>({protocol:'terminal-session-status-v1',id:args.id,state:'STOPPED',evidence:{confirmed:true,cgroupEmpty:true}})});
 const result=await f.cli(['ssh']),error=errorJSON(result);assert.equal(error.terminal.state,'STOPPED');assert.match(error.error,/原终端已结束/);
 assert.deepEqual(f.calls.map(c=>c.operation),['terminal.open','terminal.status']);assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
});

for(const code of [400,401,403,409,429])test(`explicit open refusal ${code} does not trigger a recovery request`,async t=>{
 const f=await fixture(t,{openStatus:code}),result=await f.cli(['ssh']);assert.equal(result.code,1);
 assert.deepEqual(f.calls.map(c=>c.operation),['terminal.open']);assert.equal(errorJSON(result).status,code);
});

const stopped=args=>({protocol:'terminal-session-status-v1',id:args.id,state:'STOPPED',evidence:{confirmed:true,cgroupEmpty:true,socket:'ABSENT'}});
const validOpen=args=>({id:args.id||args.key,writerToken:randomUUID()});
const lostExit=args=>{
  if(!args.input)return {offset:0,data:'',exited:false};
  assert.equal(Buffer.from(args.input,'base64').toString(),'exit\n');
  throw Object.assign(Error('node exit response unavailable'),{status:503});
};
test('note deletion sends the original ID once',async t=>{
 const f=await fixture(t),result=await f.cli(['note-delete','42']);
 assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).data.deleted,true);
 assert.deepEqual(f.calls,[{operation:'community.notes.delete',args:{id:'42'}}]);
});
test('terminal recovery queries the original session and preserves a newly selected local login',async t=>{
 let f;f=await fixture(t,{open:validOpen,exchange:lostExit,status:async args=>{
  const cache=JSON.parse(await readFile(f.session,'utf8'));
  await writeFile(f.session,JSON.stringify({...cache,principal:{...principal,userId:'demo-user-2'}}));return stopped(args);
 }});
 const result=await f.cli(['ssh'],'exit\n');assert.equal(result.code,0,result.stderr);
 assert.equal(JSON.parse(await readFile(f.session,'utf8')).principal.userId,'demo-user-2');
 assert.equal(f.calls.filter(call=>call.operation==='terminal.open').length,1);
 assert.equal(f.calls.filter(call=>call.operation==='terminal.exchange'&&call.args.input).length,1);
 assert.equal(f.calls.filter(call=>call.operation==='terminal.status').length,1);
 assert.equal(f.calls.filter(call=>call.operation==='terminal.close').length,0);
 assert.doesNotMatch(await readFile(f.session,'utf8'),/writerToken|clientId/);
});

for(const argv of [['ssh'],['ssh','--reconnect',original]])test(`lost exit response for ${argv.join(' ')} finishes when the original UUID is confirmed STOPPED, without replay`,async t=>{
  const f=await fixture(t,{open:validOpen,exchange:lostExit,status:stopped});
  const result=await f.cli(argv,'exit\n');
  assert.equal(result.code,0,result.stderr);assert.match(result.stderr,/此终端已结束/);
  assert.doesNotMatch(result.stderr,/终端状态未确认|写入权释放未确认/);
  const opened=f.calls.find(call=>call.operation==='terminal.open').args;
  assert.equal(f.calls.filter(call=>call.operation==='terminal.open').length,1);
  assert.equal(f.calls.filter(call=>call.operation==='terminal.exchange'&&call.args.input).length,1,'The exit input is dispatched once');
  assert.deepEqual(f.calls.slice(-1).map(call=>call.operation),['terminal.status']);
  assert.equal(f.calls.filter(call=>['terminal.close','terminal.detach'].includes(call.operation)).length,0);
  const probe=f.calls.at(-1).args;
  assert.equal(probe.id,opened.id||opened.key);assert.equal(probe.machine,'gpu-1');
  assert.equal(probe.project,opened.project);assert.equal(probe.hostAdmin,opened.hostAdmin);assert.equal(probe.dataWorkspace,opened.dataWorkspace);
  for(const name of ['key','clientId','writerToken','input','takeover'])assert.equal(Object.hasOwn(probe,name),false);
  assert.equal(await readFile(f.marker,'utf8'),'true\nfalse\n');
  assert.doesNotMatch(await readFile(f.session,'utf8'),/writerToken|clientId/);
});

test('a disconnected exchange observes STOPPED once without another exchange, open or close',async t=>{
  const f=await fixture(t,{open:validOpen,dropExchange:true,status:stopped});
  const result=await f.cli(['ssh']);assert.equal(result.code,0,result.stderr);
  assert.deepEqual(f.calls.map(call=>call.operation),['terminal.open','terminal.exchange','terminal.status']);
});

test('a confirmed shell exit remains ended while the helper is still draining output or status is unavailable',async t=>{
  // The existing ten-second observation allows reads at 0/1/3/7s; it never replays input.
  for(const [status,reads] of [[args=>({protocol:'terminal-session-status-v1',id:args.id,state:'UNKNOWN',evidence:{confirmed:false}}),1],[()=>{throw Object.assign(Error('status temporarily unavailable'),{status:503});},4]]){
    const f=await fixture(t,{open:validOpen,status}),result=await f.cli(['ssh']);
    assert.equal(result.code,0,result.stderr);assert.match(result.stderr,/此终端已结束/);
    assert.deepEqual(f.calls.map(call=>call.operation),['terminal.open','terminal.exchange',...Array(reads).fill('terminal.status')]);
    const probes=f.calls.filter(call=>call.operation==='terminal.status');
    assert.equal(probes.length,reads);assert.ok(probes.every(probe=>JSON.stringify(probe.args)===JSON.stringify(probes[0].args)));
    for(const name of ['key','clientId','writerToken','input','takeover'])assert.equal(Object.hasOwn(probes[0].args,name),false);
  }
});

for(const [name,status,state] of [
  ['ALIVE',args=>({protocol:'terminal-session-status-v1',id:args.id,state:'ALIVE',evidence:{confirmed:true,socket:'RESPONDING'}}),'ALIVE'],
])test(`lost exit response with ${name} never claims the original session stopped or replays input`,async t=>{
  const f=await fixture(t,{open:validOpen,exchange:lostExit,status}),result=await f.cli(['ssh'],'exit\n');
  assert.equal(result.code,1,result.stderr);assert.equal(errorJSON(result).terminal.state,state);
  assert.doesNotMatch(result.stderr,/此终端已结束/);
  assert.equal(f.calls.filter(call=>call.operation==='terminal.open').length,1);
  assert.equal(f.calls.filter(call=>call.operation==='terminal.exchange'&&call.args.input).length,1);
  assert.equal(f.calls.filter(call=>call.operation==='terminal.status').length,1);
  assert.equal(f.calls.filter(call=>call.operation==='terminal.close').length,0);
});

for(const status of [401,403])test(`explicit exchange refusal ${status} is not hidden by a STOPPED observation`,async t=>{
  const f=await fixture(t,{open:validOpen,status:stopped,exchange:()=>{throw Object.assign(Error('access refused'),{status});}});
  const result=await f.cli(['ssh']);assert.equal(result.code,1);assert.equal(errorJSON(result).status,status);
  assert.deepEqual(f.calls.map(call=>call.operation),['terminal.open','terminal.exchange','terminal.detach']);
});

// #158: explicit non-creation and absence must not send the user into an
// endless status/reconnect loop; neither result may auto-create a replacement.
test('admission refusal reaches the CLI as REJECTED with exact reason and no status loop',async t=>{
 const reason='availableBytes=100; requestedBytes=1024; hardFloorBytes=68719476736';
 const f=await fixture(t,{openStatus:400,openError:{error:reason,code:'TERMINAL_OPEN_REJECTED'}});
 const result=await f.cli(['ssh']),error=errorJSON(result);
 assert.equal(result.code,1);assert.equal(error.code,'TERMINAL_OPEN_REJECTED');assert.equal(error.status,400);
 assert.equal(error.terminal.state,'REJECTED');assert.ok(error.error.includes(reason));assert.match(error.error,/终端未创建/);
 assert.doesNotMatch(error.error,/状态未确认|确认仍在运行后重连/);
 assert.deepEqual(f.calls.map(c=>c.operation),['terminal.open']);assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
});

test('lost open followed by confirmed NOT_FOUND gives a new-shell command without replay',async t=>{
 const f=await fixture(t,{drop:true,status:args=>({protocol:'terminal-session-status-v1',id:args.id,state:'NOT_FOUND',canCreate:true,evidence:{confirmed:true,socket:'ABSENT'}})});
 const result=await f.cli(['ssh']),error=errorJSON(result);
 assert.equal(result.code,1);assert.equal(error.terminal.state,'NOT_FOUND');assert.match(error.error,/可以直接新建/);
 assert.match(error.error,/gpuctl ssh --machine gpu-1 --project alpha/);assert.doesNotMatch(error.error,/确认仍在运行后重连/);
 assert.deepEqual(f.calls.map(c=>c.operation),['terminal.open','terminal.status']);assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
});

test('original status exposes NOT_FOUND and recovery text without requiring a TTY',async t=>{
 const f=await fixture(t,{status:args=>({protocol:'terminal-session-status-v1',id:args.id,state:'NOT_FOUND',canCreate:true,evidence:{confirmed:true},message:'未找到这个终端，可以重新运行原 ssh 命令新建终端。'})});
 const result=await f.cli(['terminal','status',original]);assert.equal(result.code,0,result.stderr);
 const row=JSON.parse(result.stdout).data;assert.equal(row.state,'NOT_FOUND');assert.equal(row.id,original);assert.match(row.message,/重新运行/);
 assert.deepEqual(f.calls.map(c=>c.operation),['terminal.status']);
});

test('a lost explicit rejection is recovered by original UUID with its actual reason',async t=>{
 const reason='Personal workspace hard floor reached: availableBytes=100; requestedBytes=10; hardFloorBytes=200';
 const f=await fixture(t,{drop:true,status:args=>({protocol:'terminal-session-status-v1',id:args.id,state:'REJECTED',created:false,reason,evidence:{confirmed:true,socket:'ABSENT'},canCreate:true})});
 const result=await f.cli(['ssh']),error=errorJSON(result);
 assert.equal(result.code,1);assert.equal(error.terminal.state,'REJECTED');assert.equal(error.code,'TERMINAL_OPEN_REJECTED');assert.equal(error.status,400);assert.ok(error.error.includes(reason));assert.match(error.error,/终端未创建/);
 assert.doesNotMatch(error.error,/操作结果尚未确认|终端状态未确认/);
 assert.deepEqual(f.calls.map(c=>c.operation),['terminal.open','terminal.status']);assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
});

test('idle detached close confirms a physical stop without acquiring a writer or replacing the original session',async t=>{
  const f=await fixture(t,{close:args=>({protocol:'terminal-session-status-v1',id:args.id,closed:true,state:'STOPPED',metadataOnly:false})});
  const result=await f.cli(['terminal','close',original]);assert.equal(result.code,0,result.stderr);
  const value=JSON.parse(result.stdout);assert.equal(value.data.id,original);assert.equal(value.data.metadataOnly,false);
  assert.deepEqual(f.calls.map(call=>call.operation),['terminal.close']);
  const args=f.calls[0].args;assert.equal(args.project,'alpha');assert.equal(args.id,original);assert.equal(args.writerToken,undefined);assert.equal(args.clientId,undefined);
});

for(const argv of [['ssh'],['ssh','--reconnect',original]])test(`voided ${argv.join(' ')} explains NOT_FOUND without interacting or reopening`,async t=>{
 const f=await fixture(t,{open:args=>({id:args.id||args.key,state:'NOT_FOUND',canCreate:true,created:false,error:'这个终端连接键已确认未创建并作废，请重新新建终端。'})});
 const result=await f.cli(argv),error=errorJSON(result);
 assert.equal(result.code,1);assert.equal(error.terminal.state,'NOT_FOUND');assert.match(error.error,/可以直接新建/);assert.match(error.error,/作废/);
 assert.ok(error.terminal.newCommand.includes('gpuctl ssh'));assert.ok(!error.terminal.newCommand.includes('--reconnect'));
 assert.deepEqual(f.calls.map(c=>c.operation),['terminal.open']);assert.equal(await readFile(f.marker,'utf8').catch(()=>''),'');
});
