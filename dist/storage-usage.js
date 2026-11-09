// Disk usage shared by the data page, the project panel and the CLI. All three
// read the Portal storage snapshot and format it here, so one project shows the
// same numbers everywhere. Unknown stays unknown, never zero.
import {transferBytes} from './data-route.js';
export const storageBytes=n=>!Number.isFinite(n)?'未知':n<0?'−'+storageBytes(-n):n>=1024**4?(n/1024**4).toFixed(1)+' TiB':n>=1024**3?(n/1024**3).toLocaleString('en-US',{maximumFractionDigits:n>=100*1024**3?0:1})+' GiB':transferBytes(n);
export const statisticsTime=(value,now=Date.now())=>{const age=(now-Date.parse(value))/60000;return Number.isFinite(age)?`统计于 ${Math.max(0,Math.floor(age))} 分钟前`:'统计时间未知';};
export const usageText=row=>!Number.isFinite(row?.size)?'未知':(row.complete===false?'至少 ':'')+storageBytes(row.size);
export function filesLimitText(row){
  let text='文件 '+usageText(row);
  if(row?.desiredLimitBytes==null&&row?.limitBytes==null)return text;
  const applied=row.enforced===true&&row.limitBytes>0?row.limitBytes:null;
  text+=' / 上限 '+storageBytes(applied??row.desiredLimitBytes);
  if(!applied)text+=' · 上限未生效';
  const expected=row.graceUntil?row.effectiveLimitBytes:row.desiredLimitBytes;
  if(expected!=null&&(!applied||Math.ceil(expected/1024)*1024!==applied))text+=' · 待生效';
  if(row.graceUntil&&row.size>row.desiredLimitBytes)text+=' · 超限，宽限至 '+new Date(row.graceUntil*1000).toLocaleDateString('zh-CN');
  else if(applied&&row.size>=applied)text+=' · 超限';
  else if(applied&&row.size>=applied*0.9)text+=' · 已用 ≥90%';
  return text;
}
const part=row=>Number.isFinite(row?.size)?{size:row.size,complete:row.complete!==false}:{size:null,complete:false};
// Unknown parts make a total a lower bound; all parts unknown stays unknown.
const total=parts=>{const known=parts.filter(row=>Number.isFinite(row.size));return {size:known.length?known.reduce((sum,row)=>sum+row.size,0):null,complete:parts.every(row=>Number.isFinite(row.size)&&row.complete)};};
// A project's files, its job outputs on this server and its own container environment.
export function projectUsage(row){const files={...part(row),...Object.fromEntries(['limitBytes','enforced','desiredLimitBytes','effectiveLimitBytes','graceUntil'].filter(key=>row?.[key]!==undefined).map(key=>[key,row[key]]))},outputs=part(row?.outputs),environment=part(row?.environment);return {files,outputs,environment,total:total([files,outputs,environment])};}
export const usagePartsText=usage=>`${filesLimitText(usage.files)} · 输出 ${usageText(usage.outputs)} · 环境 ${usageText(usage.environment)}`;
// A shared project still names the person who created it.
export const projectOwnerLabel=row=>{const name=row?.ownerName||row?.ownerId||'未知';return row?.shared?'共用 · 创建人 '+name:name;};
const known=value=>Number.isFinite(value)?value:0;
export const itemBytes=item=>item?.kind==='project'?known(item.files)+known(item.outputs)+known(item.environment):known(item?.bytes);
// Each person's projects (by creator) and images across this server's disks.
// A disk without project accounting makes every total a lower bound; with no
// accounted disk at all the summary is unknown.
export function ownerUsage(disks){
  if(!Array.isArray(disks)||!disks.some(disk=>disk?.accounting==='quota'))return null;
  const complete=disks.every(disk=>disk?.accounting==='quota'),people=new Map();
  for(const disk of disks)if(disk?.accounting==='quota')for(const item of Array.isArray(disk.items)?disk.items:[]){
    if(item?.kind!=='project'&&item?.kind!=='images')continue;
    const id=item.ownerId??'',row=people.get(id)||{ownerId:id,ownerName:item.ownerName??null,projects:0,images:0};
    people.set(id,row);row[item.kind==='project'?'projects':'images']+=itemBytes(item);
  }
  return [...people.values()].map(row=>({ownerId:row.ownerId,ownerName:row.ownerName,projects:{size:row.projects,complete},images:{size:row.images,complete},total:{size:row.projects+row.images,complete}}))
    .sort((a,b)=>b.total.size-a.total.size);
}
const projectReport=row=>({project:row.project,ownerId:row.ownerId,ownerName:row.ownerName??null,shared:row.shared===true,...projectUsage(row)});
// `gpuctl project quota`: the same snapshot the web pages read.
export function quotaReport(sample,{project,ownerId,all=false}={}){
  const projects=!sample||sample.projects?.error?null:sample.projects,rows=projects?.projects||[];
  const report={machine:sample?.machine??null,checkedAt:(project||all?projects?.checkedAt:sample?.quota?.checkedAt)??null,volumes:sample?.quota?.error?[]:sample?.quota?.volumes||[]};
  if(project)report.projectUsage=projectReport(rows.find(row=>row.project===project&&row.ownerId===ownerId)||{project,ownerId});
  if(all){
    report.projects=projects?rows.map(projectReport).sort((a,b)=>(Number.isFinite(b.total.size)?b.total.size:-1)-(Number.isFinite(a.total.size)?a.total.size:-1)):null;
    report.owners=projects?ownerUsage(projects.disks):null;
  }
  return report;
}
export function quotaUsageLines(report,now=Date.now()){
  const project=row=>`${row.project}${row.ownerName||row.shared?'（'+projectOwnerLabel(row)+'）':''}：合计 ${usageText(row.total)}；${usagePartsText(row)}`,lines=[];
  if(report.projectUsage)lines.push('项目 '+project(report.projectUsage));
  if(report.projects!==undefined){
    lines.push('本机项目（按合计排序）：',...!report.projects?['  未知，请稍后重试。']:report.projects.length?report.projects.map(row=>'  '+project(row)):['  还没有项目。']);
    lines.push('按人汇总：',...!report.owners?['  未知：这台服务器还没有项目记账数据。']:report.owners.length?report.owners.map(row=>`  ${row.ownerName||row.ownerId||'未知'}：合计 ${usageText(row.total)}；项目 ${usageText(row.projects)} · 镜像与容器引擎 ${usageText(row.images)}`):['  还没有人占用空间。']);
  }
  lines.push(statisticsTime(report.checkedAt,now));
  return lines;
}
