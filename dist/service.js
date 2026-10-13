import {DemoStore} from './model.js';

// Shared browser preview / local API logic. Never calls real GPUQ or SSH.
export const DEMO_ADMIN={username:'admin',password:'AdminDemo!2026'};
export const DEMO_MEMBER_PASSWORD='MemberDemo!2026';
const encoder=new TextEncoder();
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
function validatePassword(password){if(typeof password!=='string'||password.length<8||password.length>128)throw Error('密码需为 8–128 个字符。');}
async function hashPassword(password,salt,iterations=210000){
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},key,256));
}
export async function credential(password,iterations=210000){const salt=crypto.getRandomValues(new Uint8Array(16));return {salt,hash:await hashPassword(password,salt,iterations),iterations};}
async function matches(password,record){const actual=await hashPassword(password,record.salt,record.iterations||210000);let diff=0;for(let i=0;i<actual.length;i++)diff|=actual[i]^record.hash[i];return diff===0;}
export class DemoService{
  constructor(){this.store=new DemoStore();this.store.users.unshift({id:'builtin-admin',name:'管理员',username:'admin',role:'admin',enabled:true,limits:{},total:0});this.credentials=new Map();this.sessions=new Map();this.failures=new Map();}
  static async create(){
    const service=new DemoService();service.credentials.set('admin',await credential(DEMO_ADMIN.password));
    for(const user of service.store.users.filter(u=>u.username!=='admin'))service.credentials.set(user.username,await credential(DEMO_MEMBER_PASSWORD));
    service.dummy=await credential(random());return service;
  }
  async login(username,password){
    username=String(username??'').trim();
    if(username.length>24)throw Error('用户名或密码错误。');
    if(this.failures.size>2000)for(const [key,value] of this.failures)if(value.until<Date.now())this.failures.delete(key);
    if(typeof password!=='string'||password.length>128)throw Error('用户名或密码错误。');
    const attempts=this.failures.get(username);
    if(attempts?.count>=5&&attempts.until>Date.now())throw Error('尝试次数过多，请一分钟后重试。');
    const record=this.credentials.get(username);const valid=await matches(password,record||this.dummy);
    if(!record||!valid){const current=attempts?.until>Date.now()?attempts:{count:0,until:Date.now()+60000};current.count++;this.failures.set(username,current);throw Error('用户名或密码错误。');}
    const user=this.store.users.find(u=>u.username===username);if(user&&!user.enabled)throw Error('账号已暂停，请联系管理员。');
    this.failures.delete(username);
    const principal={username,role:user.role||'member',userId:user.id};
    const token=this.issueSession(principal);return {token,principal,state:this.state(principal)};
  }
  issueSession(principal){const token=random();this.sessions.set(token,{...principal,expires:Date.now()+8*60*60*1000});return token;}
  revokeSession(token){this.sessions.delete(token);}
  principal(token){const session=this.sessions.get(token);if(!session||session.expires<Date.now()){this.revokeSession(token);const e=Error('请先登录，或重新登录。');e.status=401;throw e;}return session;}
  state(principal){const state=this.store.snapshot();if(principal.role!=='admin'){state.users=state.users.filter(u=>u.id===principal.userId);state.jobs=state.jobs.filter(j=>j.userId===principal.userId);state.machines=state.machines.filter(m=>state.users[0]?.limits[m.id]);}return state;}
  invalidate(username){for(const [token,session] of this.sessions)if(session.username===username)this.sessions.delete(token);}
  async invoke(token,operation,args={}){
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
    const principal=this.principal(token);let result;
    const admin=()=>{if(principal.role!=='admin'){const e=Error('此操作需要管理员权限。');e.status=403;throw e;}};
    const subject=()=>{if(principal.role==='admin')return args.userId;if(args.userId&&args.userId!==principal.userId){const e=Error('不能操作其他用户。');e.status=403;throw e;}return principal.userId;};
    switch(operation){
      case 'state':break;
      case 'data.roots':{
        if(Object.keys(args).join(',')!=='machine')throw Error('目录查询只接受目标服务器。');
        const user=this.store.get(principal.userId);
        if(!user.enabled||!user.limits[args.machine])throw Object.assign(Error('这台机器未授权。'),{status:403});
        // Demo-only paths: no host directory is read and no node is contacted.
        result={directories:[],personal:{path:'/data/mine',readOnly:false}};break;
      }
      case 'logout':this.revokeSession(token);return {result:{loggedOut:true}};
      case 'users.create':{admin();validatePassword(args.password);const role=args.role||'member';if(!['admin','member'].includes(role))throw Error('角色无效。');const username=String(args.username??'').trim();if(username==='admin')throw Error('这个用户名已存在，请换一个。');const record=await credential(args.password,this.production?600000:210000);const user=this.store.create(args.name??username,username);this.credentials.set(user.username,record);result=this.store.setRole(user.id,role);break;}
      case 'profile.update':{if(Object.keys(args).some(k=>k!=='name'))throw Error('个人姓名参数无效，不能修改其他账号或权限。');const user=this.store.get(principal.userId);if(!user.enabled)throw Error('账号已暂停。');result=this.store.setName(user.id,args.name);break;}
      case 'users.reset':{admin();const user=this.store.get(args.userId);validatePassword(args.password);this.credentials.set(user.username,await credential(args.password,this.production?600000:210000));this.invalidate(user.username);result={userId:user.id,reset:true};break;}
      case 'users.enabled':{admin();const user=this.store.get(args.userId);if(user.role==='admin'&&!args.enabled&&!this.store.users.some(u=>u.id!==user.id&&u.enabled&&u.role==='admin'))throw Error('不能暂停最后一名可登录管理员。');if(args.userId===principal.userId&&!args.enabled)throw Error('不能暂停当前登录账号。');result=this.store.setEnabled(args.userId,args.enabled);if(!args.enabled)this.invalidate(result.username);break;}
      case 'users.role':{admin();const user=this.store.get(args.userId);if(user.role==='admin'&&args.role!=='admin'&&!this.store.users.some(u=>u.id!==user.id&&u.enabled&&u.role==='admin'))throw Error('不能降级最后一名可登录管理员。');if(args.userId===principal.userId)throw Error('请使用其他管理员账号修改自己的角色。');result=this.store.setRole(args.userId,args.role);this.invalidate(result.username);break;}
      case 'policy.save':admin();result=this.store.save(args.userId,args);break;
      case 'request':result=this.store.request(subject(),args.machine,args.cards);break;
      case 'release':this.store.release(args.jobId,subject());result={released:true};break;
      default:throw Error('未知操作。');
    }
    return {result,state:this.state(principal)};
  }
}
