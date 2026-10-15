import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {loadStack,compose,stackExec} from '../../tests/gray/lib/stack.mjs';
const run=promisify(execFile),stack=await loadStack(process.argv[2]),checks=[],containers=[];
const check=(name,ok)=>{checks.push({name,ok});if(!ok)throw Error(name);};
const internal=await run('docker',['network','inspect','stargate-gray_gray','--format','{{.Internal}}']);
check('灰度业务网络为 internal',internal.stdout.trim()==='true');
for(const service of ['gray-portal','gray-bridge','gray-collector','gray-node-1','gray-registry','gray-git']){
  const id=(await compose(stack,'ps','-q',service)).stdout.trim();
  const raw=JSON.parse((await run('docker',['inspect',id])).stdout)[0],host=raw.HostConfig;
  const row={service,memory:host.Memory,readOnly:host.ReadonlyRootfs,privileged:host.Privileged,capDrop:host.CapDrop,networks:Object.keys(raw.NetworkSettings.Networks),ports:host.PortBindings};containers.push(row);
  check(service+' 内存有界',row.memory>0&&row.memory<=((service==='gray-node-1'?4096:service==='gray-portal'?512:256)*1024**2));
  check(service+' 仅灰度网络',row.networks.every(n=>n==='stargate-gray_gray'||service==='gray-portal'&&n==='stargate-gray_host-access'));
  if(service==='gray-portal'){
    check('门户只读且去掉全部能力',row.readOnly&&row.capDrop?.includes('ALL')&&!row.privileged);
    check('门户端口仅发布本机',Object.values(row.ports).flat().every(p=>p.HostIp==='127.0.0.1'));
  }else check(service+' 不发布宿主端口',!Object.keys(row.ports||{}).length);
}
const observation=await stackExec(stack,'gray-node-1','python3','-c',`import json,ipaddress
from pathlib import Path
peers=[]
for line in Path('/proc/net/tcp').read_text().splitlines()[1:]:
 parts=line.split()
 if parts[3]=='01':peers.append(str(ipaddress.ip_address(int.from_bytes(bytes.fromhex(parts[2].split(':')[0]),'little'))))
print(json.dumps(dict(routes=Path('/proc/net/route').read_text(),establishedPeers=peers)))`);
const node=JSON.parse(observation.stdout);
check('节点已建立 IPv4 连接仅内部或回环',node.establishedPeers.every(ip=>ip.startsWith('172.30.77.')||ip.startsWith('127.')));
await writeFile(join(dirname(stack.file),'isolation.json'),JSON.stringify({checks,containers,node,note:'配置和当前连接观察；门户有 host-access，不能据此声称门户无出网能力。'},null,2)+'\n');
console.log('隔离与内存检查通过：'+checks.length+' 项');
