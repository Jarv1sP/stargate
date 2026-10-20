// Package the user's standalone demo for the existing zero-permission workshop sandbox.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {gzipSync} from 'node:zlib';
const [source,output]=process.argv.slice(2);
if(!source||!output)throw Error('Usage: node scripts/package-ceake-workshop.mjs SOURCE_DIRECTORY OUTPUT.json');
const read=path=>readFile(resolve(source,path),'utf8');
let store=await read('js/store.js');
const loadStart=store.indexOf('  function load()'),loadEnd=store.indexOf('\n\n',store.indexOf('  function save()',loadStart));
store=store.slice(0,loadStart)+`  function load(){if(!db)db={users:{},session:null,seeded:false};}
  function save(){}
`+store.slice(loadEnd);
let api=await read('js/demo-api.js');
const bootStart=api.indexOf('  const params=new URLSearchParams(location.search);'),bootEnd=api.indexOf('  return {request,page,boot,reset()',bootStart);
api=api.slice(0,bootStart)+`  boot();S.db.session={user:'演示用户'};location.hash='#/region/default/console/tenant/compute/aidp/overview';\n`+api.slice(bootEnd);
let pages=(await read('js/pages.js')).replace("window.open('#/jupyter/' + encodeURIComponent(n.name), '_blank');","ROUTE.go('/jupyter/'+encodeURIComponent(n.name));");
let jupyter=await read('js/jupyter.js');
const downloadStart=jupyter.indexOf('  function download(p) {'),downloadEnd=jupyter.indexOf('\n  }',downloadStart)+4;
jupyter=jupyter.slice(0,downloadStart)+`  function download(p){window.demoShowText(S.base(p),S.fs()[p]?.text||'');}`+jupyter.slice(downloadEnd);
jupyter=jupyter.replace("navigator.clipboard && navigator.clipboard.writeText(p.slice(WS.length + 1));","window.demoShowText('文件路径',p.slice(WS.length+1));");
const adapter=`
window.demoShowText=(title,text)=>UI.dialog({title,width:760,footer:false,body:'<textarea class="workshop-demo-text" readonly aria-label="文件内容">'+UI.esc(text)+'</textarea>'});
ACT.logDl=a=>{const job=S.db.jobs.find(j=>j.id===a.dataset.id);demoShowText(job.name+'.log',(job.logs||[]).join('\\n'));};
const back=document.createElement('button');back.className='workshop-demo-back';back.textContent='返回 Notebook 列表';back.onclick=()=>ROUTE.go(ROUTE.AIDP+'model-develop/notebook');document.body.append(back);
const routeChanged=()=>back.hidden=!location.hash.startsWith('#/jupyter/');addEventListener('hashchange',routeChanged);routeChanged();
`;
const css=(await read('css/style.css'))+'\n'+await read('css/demo.css')+`
html{color-scheme:light}button,input,select{min-height:0}body{padding:0;overflow:auto;overflow-wrap:normal}#app{min-width:1100px;min-height:850px}#workshop-root{height:100vh}
.workshop-demo-back{position:fixed;right:12px;top:2px;z-index:2000;background:#fff;border:1px solid #dce4ee;color:#246fdf;padding:5px 12px}
.workshop-demo-text{width:100%;min-height:300px;font:13px/1.7 monospace}
`;
const script=[store,await read('js/ui.js'),api,pages,jupyter,await read('js/shell.js'),await read('js/demo-ui.js'),adapter].join('\n;\n');
const payload=gzipSync(Buffer.from(JSON.stringify({css,script}))).toString('base64');
const pkg={apiVersion:1,kind:'plugin',presentation:'interface',name:'仓浪平台 · 整站演示界面',description:'安装后整个门户切换为仓浪/AISpace演示界面：项目、Notebook、镜像、数据集、训练与日志。全部为组件内模拟数据，不读取或操作真实平台；重新打开会重置。Notebook同窗打开，下载显示可复制文本。',permissions:[],html:'<div id="demo-intro"><h2>仓浪平台演示</h2><p>独立模拟环境，不连接真实服务器。</p><button id="demo-open">打开演示</button><p id="demo-status" role="status"></p></div>',css:'body{color:#293548;background:#f4f7fb}#demo-intro{padding:24px}#demo-open{padding:10px 24px;background:#3985f7;color:white;border:0;border-radius:3px}',script:`(()=>{const nonce=document.currentScript.nonce;document.querySelector('#demo-open').onclick=async()=>{const button=document.querySelector('#demo-open');button.disabled=true;try{const bytes=Uint8Array.from(atob('${payload}'),c=>c.charCodeAt(0));const content=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();const style=document.createElement('style');style.textContent=content.css;document.head.append(style);document.querySelector('#workshop-root').innerHTML='<div id="app"></div><div id="layers"></div><div id="toasts"></div>';const script=document.createElement('script');script.nonce=nonce;script.textContent=content.script;document.body.append(script);}catch(error){const status=document.querySelector('#demo-status');if(status)status.textContent='打开失败：'+error.message;button.disabled=false;}};document.querySelector('#demo-open').click();})();`};
const text=JSON.stringify(pkg);const size=Buffer.byteLength(text);
if(size>128*1024)throw Error(`Package exceeds current workshop limit: ${size} bytes`);
await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,text+'\n');
console.log(`${resolve(output)} (${size} bytes, zero permissions)`);
