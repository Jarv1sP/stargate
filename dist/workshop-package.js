export const WORKSHOP_PERMISSIONS=Object.freeze(['resources.read','jobs.read','jobs.cancel','ui.navigate']);
export const THEME_TOKENS=Object.freeze([
  '--bg','--bg-1','--bg-2','--bg-3','--bg-4','--line','--line-2','--line-3',
  '--ink','--ink-2','--ink-3','--ink-4','--run','--queue','--prep','--err',
  '--run-bg','--queue-bg','--prep-bg','--err-bg','--hatch','--fill-mine','--fill-other',
  '--primary','--primary-hover','--on-primary','--on-danger','--term','--term-ink',
  '--scrim','--seg-on','--code-bg','--ring',
]);
export const WORKSHOP_PACKAGE_BYTES=128*1024;
const fail=message=>{throw Object.assign(Error(message),{status:400});};
function fields(value,allowed,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(`${label}字段无效。`);
}
function text(value,max,label,empty=false){
  if(typeof value!=='string'||!value.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(`${label}格式无效。`);
  value=value.trim();
  if((!empty&&!value)||[...value].length>max)fail(`${label}不能超过 ${max} 字。`);
  return value;
}

// Shared by the publisher and server. Theme packages never inject CSS or code;
// plugin code is stored verbatim and executed only by the isolated frame runtime.
export function normalizeWorkshopPackage(input){
  fields(input,['apiVersion','kind','name','description','theme','permissions','html','css','script'],'作品');
  let bytes;
  try{bytes=new TextEncoder().encode(JSON.stringify(input)).byteLength;}catch{fail('作品须为 JSON。');}
  if(bytes>WORKSHOP_PACKAGE_BYTES)fail('作品不能超过 128 KiB。');
  if(input.apiVersion!==1||!['theme','plugin'].includes(input.kind))fail('作品版本或类型无效。');
  const result={apiVersion:1,kind:input.kind,name:text(input.name,64,'名称'),description:text(input.description,1000,'描述',true)};
  if(input.kind==='theme'){
    if(['html','css','script'].some(key=>Object.hasOwn(input,key))||input.permissions!==undefined&&(!Array.isArray(input.permissions)||input.permissions.length))fail('主题只能包含颜色和布局，不能包含代码或权限。');
    fields(input.theme,['tokens','density','width','columns'],'主题');
    fields(input.theme.tokens??{},THEME_TOKENS,'主题颜色');
    const tokens={};
    for(const key of THEME_TOKENS){
      if(!Object.hasOwn(input.theme.tokens??{},key))continue;
      const value=input.theme.tokens[key];
      if(typeof value!=='string'||!/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value))fail('主题颜色须为 #RGB、#RRGGBB 或 #RRGGBBAA。');
      tokens[key]=value.toLowerCase();
    }
    const {density='comfortable',width='normal',columns=1}=input.theme;
    if(!['comfortable','compact'].includes(density)||!['normal','wide'].includes(width)||![1,2].includes(columns))fail('主题布局无效。');
    result.theme={tokens,density,width,columns};
  }else{
    if(Object.hasOwn(input,'theme'))fail('插件不能修改门户主题；请单独发布主题。');
    if(!Array.isArray(input.permissions)||input.permissions.some(value=>!WORKSHOP_PERMISSIONS.includes(value))||new Set(input.permissions).size!==input.permissions.length)fail('插件权限无效。');
    result.permissions=WORKSHOP_PERMISSIONS.filter(value=>input.permissions.includes(value));
    for(const key of ['html','css','script']){
      if(typeof input[key]!=='string'||!input[key].isWellFormed()||input[key].includes('\0'))fail(`插件 ${key} 须为文本。`);
      result[key]=input[key];
    }
  }
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>WORKSHOP_PACKAGE_BYTES)fail('作品不能超过 128 KiB。');
  return result;
}
