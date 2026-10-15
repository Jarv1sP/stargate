import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export function featureItems(markdown){
  let active=false;const items=[];
  for(const line of markdown.split('\n')){
    if(line.startsWith('## '))active=/^## [一二三四五六七八九十]+、/.test(line);
    if(active&&line.startsWith('- '))items.push(line.slice(2));
  }
  return items;
}
export function checkFeatures({markdown,features,waivers,steps,today=new Date().toISOString().slice(0,10)}){
  const expected=featureItems(markdown),errors=[];
  if(features.length!==expected.length)errors.push('功能条数不一致');
  for(const text of expected){
    const rows=features.filter(row=>row.text===text);
    if(rows.length!==1){errors.push('缺少或重复功能：'+text);continue;}
    const row=rows[0],mapped=Array.isArray(row.steps)&&row.steps.length>0;
    if(mapped===!!row.waiver)errors.push('必须选择步骤或豁免：'+text);
    if(mapped&&row.steps.some(id=>!steps.includes(id)))errors.push('未知步骤：'+text);
    if(row.waiver&&!waivers.some(w=>w.id===row.waiver&&w.reason&&w.owner&&w.expires>=today))errors.push('豁免不存在或已过期：'+text);
  }
  if(errors.length)throw Error(errors.join('\n'));
  return {total:expected.length,steps:features.filter(r=>r.steps?.length).length,waivers:features.filter(r=>r.waiver).length};
}
export async function checkRepository(sourceRoot){
  const root=new URL('../../',import.meta.url);
  const [markdown,features,waivers,files]=await Promise.all([readFile(sourceRoot?resolve(sourceRoot,'docs/FEATURES.md'):new URL('docs/FEATURES.md',root),'utf8'),readFile(new URL('tests/gray/features.json',root),'utf8'),readFile(new URL('tests/gray/waivers.json',root),'utf8'),readdir(new URL('tests/gray/steps/',root))]);
  return checkFeatures({markdown,features:JSON.parse(features),waivers:JSON.parse(waivers),steps:files.filter(f=>/^G\d\d-/.test(f)).map(f=>f.slice(0,3))});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await checkRepository(process.argv[2])));
