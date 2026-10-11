// Shared policy model; preview uses memory while the portal persists it.
export const validUsername = value => typeof value==='string' && /^[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}$/u.test(value);
import {MACHINES} from './machines.js';
import {displayName} from './task-metadata.js';
export {MACHINES};
// Display names, approval notes and revision counters do not grant access.
// Compare effective grants in a stable order; quota changes still invalidate
// work admitted under an earlier authorization.
export const authorizationPolicy = user => JSON.stringify(user ? {
  id:user.id,username:user.username,enabled:user.enabled===true,role:user.role||'member',
  total:user.total,limits:Object.entries(user.limits||{}).filter(([,cards])=>cards>0).sort(([a],[b])=>a.localeCompare(b)),
} : null);
const clone = value => JSON.parse(JSON.stringify(value));
const demoLimits = allocations => Object.fromEntries(allocations.flatMap(([index,cards])=>{
  const machine=MACHINES[index];return machine?[[machine.id,Math.min(cards,machine.cards)]]:[];
}));
export class DemoStore {
  constructor(){
    this.users=[
      {id:'demo-chen',name:'陈同学',username:'chen-research',enabled:true,total:4,limits:demoLimits([[0,2],[1,4],[2,2]])},
      {id:'demo-lin',name:'林同学',username:'lin-vision',enabled:true,total:2,limits:demoLimits([[1,2],[3,2]])},
      {id:'demo-wang',name:'王同学',username:'wang-lab',enabled:true,total:0,limits:{}},
    ];this.jobs=[];this.sequence=0;
  }
  snapshot(){return clone({machines:MACHINES,users:this.users.map(u=>this.get(u.id)),jobs:this.jobs,demo:true});}
  get(id){const u=this.users.find(u=>u.id===id);if(!u)throw Error('找不到这个演示用户。');return clone(u.role==='admin'?{...u,limits:Object.fromEntries(MACHINES.map(m=>[m.id,m.cards])),total:MACHINES.reduce((n,m)=>n+m.cards,0)}:{...u,role:'member'});}
  setRole(id,role){this.get(id);if(!['admin','member'].includes(role))throw Error('角色须为 admin 或 member。');this.users.find(u=>u.id===id).role=role;return this.get(id);}
  create(name,username){
    name=displayName(name);username=String(username).trim();
    if(!validUsername(username))throw Error('用户名须为 2–24 位，使用汉字或小写字母开头，可含数字、下划线和短横线。');
    if(this.users.some(u=>u.username===username))throw Error('这个用户名已存在，请换一个。');
    const u={id:`demo-user-${++this.sequence}`,name,username,enabled:true,total:0,limits:{}};this.users.push(u);return clone(u);
  }
  save(id,policy){
    const user=this.get(id);const {limits,total}=policy??{};
    if(user.role==='admin')throw Error('管理员可访问全部机器且免个人累计用卡额度，无需配置个人额度；资源不足时正常排队。');
    if(!limits||typeof limits!=='object'||Array.isArray(limits))throw Error('机器授权格式无效。');
    const capacity=MACHINES.reduce((n,m)=>n+m.cards,0);
    if(!Number.isInteger(total)||total<0||total>capacity)throw Error(`总上限必须是 0–${capacity} 之间的整数。`);
    const clean={};let sum=0;
    for(const [key,value] of Object.entries(limits)){
      const m=MACHINES.find(m=>m.id===key);if(!m)throw Error('存在未知机器。');
      if(!Number.isInteger(value)||value<1||value>m.cards)throw Error(`${key} 的卡数须为 1–${m.cards} 的整数。`);
      clean[key]=value;sum+=value;
    }
    if(sum===0&&total!==0)throw Error('未授权任何机器时，总上限应为 0。');
    if(sum>0&&(total<1||total>sum))throw Error(`总上限须为 1–${sum} 张，且不大于各机上限之和。`);
    const updated={...user,limits:clean,total};this.users[this.users.findIndex(u=>u.id===id)]=updated;return clone(updated);
  }
  setEnabled(id,enabled){if(typeof enabled!=='boolean')throw Error('状态无效。');this.get(id);this.users.find(u=>u.id===id).enabled=enabled;return this.get(id);}
  setName(id,name){this.get(id);this.users.find(u=>u.id===id).name=displayName(name);return this.get(id);}
  usage(id,machine){return this.jobs.filter(j=>j.userId===id&&(!machine||j.machine===machine)).reduce((n,j)=>n+j.cards,0);}
  request(id,machine,cards){
    const user=this.get(id);const host=MACHINES.find(m=>m.id===machine);
    if(!user.enabled)throw Error('账号已暂停，不能申请新的 GPU。');
    if(!host||!user.limits[machine])throw Error('这台机器未授权，请联系管理员。');
    if(!Number.isInteger(cards)||cards<1)throw Error('申请卡数须为大于 0 的整数。');
    if(cards>host.cards)throw Error('申请卡数超出单机容量。');
    if(user.role!=='admin'&&cards+this.usage(id,machine)>user.limits[machine])throw Error(`超出这台机器的上限：已用 ${this.usage(id,machine)} 张，最多 ${user.limits[machine]} 张。`);
    if(user.role!=='admin'&&cards+this.usage(id)>user.total)throw Error(`超出跨机器总上限：已用 ${this.usage(id)} 张，最多 ${user.total} 张。`);
    const occupied=this.jobs.filter(j=>j.machine===machine).reduce((n,j)=>n+j.cards,0);
    if(occupied+cards>host.cards)throw Error('模拟资源暂时不足；真实接入后交由 GPUQ 排队。');
    const job={id:`DEMO-${String(++this.sequence).padStart(3,'0')}`,userId:id,machine,cards};this.jobs.push(job);return clone(job);
  }
  release(id,userId){const i=this.jobs.findIndex(j=>j.id===id);if(i<0)throw Error('找不到这个模拟任务。');if(this.jobs[i].userId!==userId)throw Error('不能结束其他用户的任务。');this.jobs.splice(i,1);}
}
