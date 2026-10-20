import {readFile} from 'node:fs/promises';

export const chapters=[
  {id:'start',title:'首次使用',description:'Windows、WSL、Linux 安装并登录，开始完整 CLI 流程。'},
  {id:'development',title:'项目开发',description:'上传代码、安装依赖，持续使用同一个工作区。'},
  {id:'training',title:'提交训练',description:'直接运行或连接 GPU 终端，选择多卡、弹性或共享方式。'},
  {id:'data',title:'数据目录',description:'直接读取本机数据，独立上传和跨机复制。'},
  {id:'results',title:'日志与结果',description:'查询进度，设置通知与留言，下载结果。'},
  {id:'queue',title:'排队与协作',description:'分清等级、抢占、保存让位与自动恢复。'},
  {id:'workshop',title:'创意工坊',description:'预览和安装主题、小组件，发布共享作品或恢复默认。'},
  {id:'troubleshooting',title:'常见问题',description:'容器网络诊断、排查故障与反馈问题。'},
];
const aliases={'/guide/':'/guide','/guide/user':'/guide/start','/guide/projects':'/guide/development','/guide/datasets':'/guide/data','/guide/community':'/guide/queue','/guide/terminal-sessions':'/guide/development','/guide/diagnostics':'/guide/results','/guide/ray-resources':'/guide/troubleshooting','/guide/project-network':'/guide/troubleshooting'};
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// The guide supports a deliberately small Markdown subset. Raw HTML is always
// text; links never become scripts or arbitrary local-file URLs.
export function inline(text){
  const pattern=/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let result='',last=0;
  for(const match of text.matchAll(pattern)){
    result+=escape(text.slice(last,match.index));last=match.index+match[0].length;
    if(match[1])result+=`<code>${escape(match[1])}</code>`;
    else if(match[2])result+=`<strong>${escape(match[2])}</strong>`;
    else{
      const href=match[4],safe=/^https?:\/\//.test(href)||/^\/guide(?:\/[a-z-]+)?(?:#[a-z-]+)?$/.test(href)||/^#[a-z-]+$/.test(href);
      result+=safe?`<a href="${escape(href)}"${/^https?:/.test(href)?' rel="noreferrer"':''}>${escape(match[3])}</a>`:escape(match[3]);
    }
  }
  return result+escape(text.slice(last));
}
export function renderMarkdown(source,{headings=[],condense=false}={}){
  const lines=source.replaceAll('\r','').split('\n');let output='',paragraph=[],list=null,section=0,explanation='';
  const append=html=>{if(condense)explanation+=html;else output+=html;};
  const flush=()=>{if(paragraph.length){append(`<p>${inline(paragraph.join(' '))}</p>`);paragraph=[];}if(list){append(`</${list}>`);list=null;}};
  const explain=()=>{if(explanation){output+=`<details class="guide-explanation"><summary>操作说明</summary><div>${explanation}</div></details>`;explanation='';}};
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(line.startsWith('```')){
      const where=/^```[a-z]+ (local|project|data)\s*$/.exec(line)?.[1],location={local:'本机终端',project:'项目开发终端',data:'数据终端'}[where]||'命令示例';
      flush();explain();const code=[];while(++i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i]);
      const language=line.startsWith('```powershell')?'<small>PowerShell</small>':'';
      output+=`<div class="guide-code"><div class="guide-code-bar"><span>${location}</span>${language}<button type="button" class="copy-code" hidden aria-label="复制这段命令">复制</button></div><pre tabindex="0"><code>${escape(code.join('\n'))}</code></pre></div>`;continue;
    }
    if(!line.trim()){flush();continue;}
    if(line.startsWith('#### ')){flush();explain();output+=`<h3>${inline(line.slice(5))}</h3>`;continue;}
    if(line.startsWith('### ')){flush();explain();const title=line.slice(4),id='section-'+(++section);headings.push({id,title});output+=`<h2 id="${id}" tabindex="-1">${inline(title)}</h2>`;continue;}
    if(line.startsWith('! ')){flush();explain();output+=`<p class="guide-critical">${inline(line.slice(2))}</p>`;continue;}
    const item=/^(?:([-*]) |(\d+)\. )(.*)$/.exec(line);
    if(item){const type=item[1]?'ul':'ol';if(paragraph.length||list&&list!==type)flush();if(!list){append(`<${type}>`);list=type;}append(`<li>${inline(item[3])}</li>`);continue;}
    if(list)flush();paragraph.push(line);
  }
  flush();explain();return output;
}
export function parseGuide(source){
  const sections=new Map();let id=null,body=[];
  const flush=()=>{if(id){if(sections.has(id))throw Error('Duplicate guide chapter');sections.set(id,body.join('\n').trim());}};
  for(const line of source.split('\n')){
    const match=/^## .+ \{#([a-z-]+)\}\s*$/.exec(line);
    if(match){flush();id=match[1];body=[];}else if(id)body.push(line);
  }
  flush();if(sections.size!==chapters.length||chapters.some(chapter=>!sections.get(chapter.id)))throw Error('Incomplete user guide');
  return sections;
}
export function guideTarget(path){
  if(Object.hasOwn(aliases,path))return {redirect:aliases[path]};
  if(path==='/guide')return {chapter:null};
  const chapter=chapters.find(item=>path==='/guide/'+item.id);
  return chapter?{chapter}:null;
}
export async function guidePage(chapter,origin){
  const sections=parseGuide((await readFile(new URL('./docs/USER_GUIDE.md',import.meta.url),'utf8')).replaceAll('https://gpu.example.com',origin));
  const nav=chapters.map((item,index)=>`<a href="/guide/${item.id}"${chapter?.id===item.id?' aria-current="page"':''}><span class="guide-number">${String(index+1).padStart(2,'0')}</span><span>${item.title}</span><span class="guide-arrow" aria-hidden="true">↗</span></a>`).join('');
  const index=chapter?chapters.findIndex(item=>item.id===chapter.id):-1;
  const sibling=(item,label)=>item?`<a href="/guide/${item.id}"><small>${label}</small><span>${item.title} <span aria-hidden="true">→</span></span></a>`:'<span></span>';
  const headings=[],prose=chapter?renderMarkdown(sections.get(chapter.id),{headings,condense:true}):'';
  const toc=chapter?`<details class="guide-toc"><summary>本章内容</summary><nav aria-label="本章内容">${headings.map(item=>`<a href="#${item.id}">${escape(item.title)}</a>`).join('')}</nav></details>`:'';
  const content=chapter?`<div class="guide-layout"><aside class="guide-sidebar"><a class="guide-overview" href="/guide">全部内容</a><nav aria-label="指南章节">${nav}</nav></aside><article class="guide-article"><header><p class="guide-eyebrow">使用指南 / ${String(index+1).padStart(2,'0')}</p><h1>${chapter.title}</h1></header>${toc}<div class="guide-prose">${prose}</div><nav class="guide-pagination" aria-label="相邻章节">${sibling(chapters[index-1],'上一章')}${sibling(chapters[index+1],'下一章')}</nav></article></div>`:
    `<section class="guide-hero"><div><p class="guide-eyebrow">STARGATE / 使用指南</p><h1>用命令行，<br>跑完一次训练。</h1><a class="guide-start" href="/guide/start">安装并登录 <span aria-hidden="true">↗</span></a></div></section><section class="guide-topics" aria-labelledby="topics-title"><div class="guide-section-heading"><h2 id="topics-title">按功能查阅</h2></div><div class="guide-cards">${chapters.map((item,i)=>`<a href="/guide/${item.id}" class="guide-card"><span class="guide-number">${String(i+1).padStart(2,'0')}</span><h3>${item.title}</h3><span class="guide-arrow" aria-hidden="true">↗</span></a>`).join('')}</div></section>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="theme-color" content="#0A0B0D"><title>${chapter?chapter.title+' · ':''}使用指南 · STARGATE</title><meta name="description" content="STARGATE CLI 使用指南：安装登录、创建项目、上传数据、提交训练与下载结果。"><link rel="icon" type="image/x-icon" sizes="16x16 32x32 48x48" href="/favicon.ico?v=stargate-2"><link rel="icon" type="image/svg+xml" href="/favicon.svg?v=stargate-2"><link rel="mask-icon" href="/mask-icon.svg?v=stargate-2" color="#0A0B0D"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=stargate-2"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/starbase.css"><link rel="stylesheet" href="/guide.css"><script src="/guide.js" defer></script></head><body><a class="guide-skip" href="#guide-main">跳到正文</a><header class="guide-topbar"><a class="guide-brand" href="/guide" aria-label="STARGATE 使用指南"><span class="wordmark guide-wordmark" aria-hidden="true"></span><small>使用指南</small></a><a class="guide-return" href="/">返回工作台 <span aria-hidden="true">↗</span></a></header><main id="guide-main" tabindex="-1">${content}</main><footer class="guide-footer"><span>STARGATE · 独立开源研究计算工作台</span><a href="/#community">仍有疑问？前往协作区</a></footer><div id="guide-copy-status" class="guide-sr-only" role="status" aria-live="polite"></div></body></html>`;
}
