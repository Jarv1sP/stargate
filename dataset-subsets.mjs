import {createHash} from 'node:crypto';

export const SUBSET_PROTOCOL = 'dataset-subset-v1';
export const SUBSET_LIMITS = Object.freeze({include:64,exclude:64,rules:64,ruleBytes:1024,files:100000,filesBytes:8*1024*1024,pathBytes:4096,selectionBytes:16*1024*1024,chunkBytes:256*1024});
const HASH=/^[a-f0-9]{64}$/;
const forbidden=new Set(['.ssh','.env','.git','.venv','anaconda3','miniconda3','.conda']);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const compare=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
function fail(message){throw new TypeError(message);}
function keys(value,expected){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected.sort().join(',');}
export function canonical(value){
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function path(value){
  if(typeof value!=='string'||!value||!value.isWellFormed()||Buffer.byteLength(value)>SUBSET_LIMITS.pathBytes||/[\x00-\x1f\x7f\\]/.test(value)||/^[A-Za-z]:/.test(value))fail('Invalid relative dataset path');
  if(value.split('/').some(p=>!p||p==='.'||p==='..'||forbidden.has(p)))fail('Unsafe relative dataset path');
  return value;
}
function segment(pattern){
  const chars=Array.from(pattern),tokens=[];
  for(let i=0;i<chars.length;i++){
    const c=chars[i];
    if(c==='*'){if(tokens.at(-1)?.kind!=='star')tokens.push({kind:'star'});}
    else if(c==='?')tokens.push({kind:'any'});
    else if(c==='['){
      const end=chars.indexOf(']',i+1);
      if(end<0)fail('Unclosed glob character class');
      let list=chars.slice(i+1,end),negated=false;
      if(list[0]==='!'){negated=true;list=list.slice(1);}
      if(!list.length||list.includes('['))fail('Invalid glob character class');
      const ranges=[];
      for(let j=0;j<list.length;j++){
        const low=list[j].codePointAt(0);
        const high=j+2<list.length&&list[j+1]==='-'?list[j+=2].codePointAt(0):low;
        if(low>high)fail('Invalid glob character range');
        ranges.push([low,high]);
      }
      tokens.push({kind:'class',negated,ranges});i=end;
    }else if(c===']')fail('Unmatched glob character class');
    else tokens.push({kind:'literal',value:c});
  }
  return tokens;
}
function compile(pattern){return path(pattern).split('/').map(p=>p==='**'?null:segment(p));}
function character(token,c){
  if(token.kind==='any')return true;
  if(token.kind==='literal')return token.value===c;
  const code=c.codePointAt(0),inside=token.ranges.some(([low,high])=>low<=code&&code<=high);
  return token.negated?!inside:inside;
}
function matchSegment(tokens,text){
  const chars=Array.from(text);let i=0,j=0,star=-1,retry=0;
  while(i<chars.length){
    if(j<tokens.length&&tokens[j].kind!=='star'&&character(tokens[j],chars[i])){i++;j++;}
    else if(j<tokens.length&&tokens[j].kind==='star'){star=j++;retry=i;}
    else if(star>=0){i=++retry;j=star+1;}
    else return false;
  }
  while(j<tokens.length&&tokens[j].kind==='star')j++;
  return j===tokens.length;
}
function matches(parts,text){
  const names=text.split('/');let i=0,j=0,star=-1,retry=0;
  while(i<names.length){
    if(j<parts.length&&parts[j]!==null&&matchSegment(parts[j],names[i])){i++;j++;}
    else if(j<parts.length&&parts[j]===null){star=j++;retry=i;}
    else if(star>=0){i=++retry;j=star+1;}
    else return false;
  }
  while(j<parts.length&&parts[j]===null)j++;
  return j===parts.length;
}
export function parseFilesFrom(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>SUBSET_LIMITS.filesBytes)fail('files-from exceeds 8 MiB');
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('files-from must be UTF-8');}
  const lines=text.replace(/\r\n/g,'\n').split('\n');
  if(lines.at(-1)==='')lines.pop();
  if(lines.length>SUBSET_LIMITS.files)fail('files-from exceeds 100000 lines');
  const result=lines.filter(p=>p!=='').map(path);
  if(!result.length)fail('files-from is empty');
  return result;
}
export function normalizeSelection(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['include','exclude','files'].includes(k)))fail('Invalid subset selection fields');
  const result={};
  for(const key of ['include','exclude','files']){
    const values=Object.hasOwn(value,key)?value[key]:[];
    if(!Array.isArray(values)||values.length>SUBSET_LIMITS[key])fail(`Too many subset ${key} entries`);
    for(const item of values){path(item);if(key!=='files'){if(Buffer.byteLength(item)>SUBSET_LIMITS.ruleBytes)fail('Subset glob exceeds 1024 bytes');compile(item);}}
    if(key==='files'&&Buffer.byteLength(values.join('\n'))>SUBSET_LIMITS.filesBytes)fail('files-from exceeds 8 MiB');
    result[key]=[...new Set(values)].sort(compare);
  }
  if((value.include?.length??0)+(value.exclude?.length??0)>SUBSET_LIMITS.rules)fail('Too many subset glob rules');
  if(!result.include.length&&!result.exclude.length&&!result.files.length)fail('Empty subset selection rules');
  if(Buffer.byteLength(canonical(result))>SUBSET_LIMITS.selectionBytes)fail('Subset selection exceeds 16 MiB');
  return result;
}
export function normalizeManifest(value){
  if(!keys(value,['schema','directories','files'])||value.schema!==1||!Array.isArray(value.directories)||!Array.isArray(value.files)||value.directories.length+value.files.length>500000)fail('Invalid fixed version manifest');
  const directories=value.directories.map(path).sort(compare),seen=new Set(directories);
  if(seen.size!==directories.length)fail('Duplicate manifest directory');
  const files=value.files.map(item=>{
    if(!keys(item,['path','size','sha256'])||!Number.isSafeInteger(item.size)||item.size<0||typeof item.sha256!=='string'||item.sha256.length!==64||!HASH.test(item.sha256))fail('Invalid manifest file');
    path(item.path);if(seen.has(item.path))fail('Duplicate manifest path');seen.add(item.path);
    return {path:item.path,size:item.size,sha256:item.sha256};
  }).sort((a,b)=>compare(a.path,b.path));
  const parents=new Set(directories);
  for(const name of seen){const parent=name.slice(0,name.lastIndexOf('/')<0?0:name.lastIndexOf('/'));if(parent&&!parents.has(parent))fail('Manifest missing parent directory');}
  const result={schema:1,directories,files};
  if(Buffer.byteLength(canonical(result))>64*1024*1024)fail('Fixed version manifest too large');
  return result;
}
export function resolveSelection(manifest,version,selection,{checkpoint=()=>{}}={}){
  if(typeof checkpoint!=='function')fail('Invalid subset checkpoint');
  const deadline=performance.now()+5000;
  const check=()=>{checkpoint();if(performance.now()>deadline)throw new Error('Subset resolution exceeded its work budget');};
  check();
  manifest=normalizeManifest(manifest);
  if(typeof version!=='string'||!HASH.test(version)||digest(manifest)!==version)fail('Fixed version manifest SHA mismatch');
  const rules=normalizeSelection(selection),include=rules.include.map(compile),exclude=rules.exclude.map(compile);
  const exact=new Set(rules.files),selected=[],present=new Set();
  let count=0;
  for(const file of manifest.files){
    if(count++%256===0)check();
    if(exact.has(file.path))present.add(file.path);
    if((!include.length&&!exact.size||exact.has(file.path)||include.some(rule=>matches(rule,file.path)))&&!exclude.some(rule=>matches(rule,file.path)))selected.push(file);
  }
  if(present.size!==exact.size)fail('A files-from path is not in this fixed version');
  if(!selected.length)fail('Subset selection is empty');
  const filesSha256=digest(selected.map(f=>[f.path,f.size,f.sha256]));
  const selectionId=digest([SUBSET_PROTOCOL,version,rules,filesSha256]);
  const dirs=new Set();let bytes=0;
  for(const file of selected){bytes+=file.size;if(!Number.isSafeInteger(bytes))fail('Subset byte count exceeds safe integer range');const names=file.path.split('/');for(let i=1;i<names.length;i++)dirs.add(names.slice(0,i).join('/'));}
  check();
  return {protocol:SUBSET_PROTOCOL,version,selectionId,filesSha256,rules,fileCount:selected.length,bytes,manifest:{schema:1,directories:[...dirs].sort(compare),files:selected}};
}
export function requireSubsetCapability(value,feature='prepare'){
  if(!['prepare','cacheRead','warehouseRead'].includes(feature))fail('Invalid subset capability');
  if(value?.subset?.protocol!==SUBSET_PROTOCOL||value.subset[feature]!==true){
    const error=new Error('这台服务器暂不支持按文件准备，请使用整版 prepare');
    error.status=409;error.code='DATASET_SUBSET_UNSUPPORTED';throw error;
  }
}
