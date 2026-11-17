import {stackExec} from './stack.mjs';
import {call,openTerminal,terminalCommand} from './exec.mjs';

// Age only synthetic sessions inside the isolated Docker gray stack.
export async function idleTerminalRegression(ctx,member,project){
  const sessions=[];
  try{
    for(let index=0;index<3;index++){
      const terminal=await openTerminal(ctx,member,project);sessions.push(terminal);
      await terminalCommand(ctx,member,terminal,(index===1?'sleep 300 & ':'')+"printf 'GRAY_%s\\n' IDLE_READY\n",'GRAY_IDLE_READY');
      if(index<2)await call(ctx,member,'terminal.detach',terminal);
    }
    const script=`import importlib.util,json,os,sys,time
from pathlib import Path
os.environ['STARGATE_CORE_PROFILE']='7IM'
path=Path('/data1/stargate/releases/current/node/node-executor.py')
spec=importlib.util.spec_from_file_location('gray_terminal_executor',path)
node=importlib.util.module_from_spec(spec);sys.modules[spec.name]=node;spec.loader.exec_module(node)
node.platform_root_check()
ids=json.loads(sys.argv[1]);folder=node.ROOT/'terminals';old=time.time()-90000
time.sleep(1)
for jid in ids:
 session=node.module('project-store').read_json(folder/(jid+'.session.json'));session['lastInteractionAt']=old
 if jid==ids[-1]:session['leaseExpiresAt']=time.time()+300
 node.atomic_json(folder/(jid+'.session.json'),session)
 node.atomic_json(folder/(jid+'.activity.json'),{'lastOutputAt':old,'lastInputAt':old})
 for suffix in ('.json','.session.json','.output'):os.utime(folder/(jid+suffix),(old,old))
node.storage_collect()
print(json.dumps([node.terminal_status({'id':jid}) for jid in ids]))`;
    const {stdout}=await stackExec(ctx.stack,'gray-node-1','runuser','-u','gpuops','--','env',
      'XDG_RUNTIME_DIR=/run/user/1001','DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus',
      'python3','-B','-c',script,JSON.stringify(sessions.map(session=>session.id)));
    const [idle,busy,leased]=JSON.parse(stdout);
    ctx.check('每小时清理关闭 24 小时无活动且只剩 shell 的终端',idle.state==='STOPPED'&&idle.closedReason==='idle',idle);
    ctx.check('后台进程存在时保留终端',busy.state==='ALIVE'&&!busy.closedReason,busy);
    ctx.check('客户端租约有效时保留终端',leased.state==='ALIVE'&&!leased.closedReason,leased);
    const reader=await call(ctx,member,'terminal.open',{...sessions[0],key:ctx.key(),clientId:ctx.key(),mode:'reconnect'});
    const history=await call(ctx,member,'terminal.exchange',{...sessions[0],clientId:reader.clientId,writerToken:reader.writerToken,offset:0});
    ctx.check('回收后按原编号重连只读历史，不复活终端',reader.readOnly&&reader.closedReason==='idle'&&history.exited&&Buffer.from(history.data,'base64').toString().includes('GRAY_IDLE_READY'));
  }finally{
    for(const terminal of sessions)await call(ctx,member,'terminal.close',{machine:ctx.machine,id:terminal.id,project});
  }
}
