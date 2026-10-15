// Shared policy model; preview uses memory while the portal persists it.
export const validUsername = value => typeof value==='string' && /^[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}$/u.test(value);
import {MACHINES} from './machines.js';
import {displayName} from './task-metadata.js';
export {MACHINES};
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
}
