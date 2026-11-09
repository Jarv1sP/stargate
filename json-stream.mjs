// Snapshot data is made of plain JSON records. Serialize it in bounded pieces so
// a large storage page does not allocate one giant string plus a response Buffer.
export class JSONItems{
  constructor(values){this.values=values;}
}
function* parts(value){
  if(value===null||typeof value!=='object'){yield JSON.stringify(value)??'null';return;}
  if(Array.isArray(value)||value instanceof JSONItems){
    yield '[';
    let first=true;
    for(const item of value instanceof JSONItems?value.values:value){if(!first)yield ',';first=false;yield* parts(item);}
    yield ']';return;
  }
  yield '{';let first=true;
  for(const key of Object.keys(value)){
    const item=value[key];
    if(item===undefined||typeof item==='function'||typeof item==='symbol')continue;
    if(!first)yield ',';first=false;
    yield JSON.stringify(key);yield ':';yield* parts(item);
  }
  yield '}';
}

export function* jsonChunks(value,chunkSize=16384){
  let pending='';
  for(const part of parts(value)){
    pending+=part;
    while(pending.length>=chunkSize){
      // A chunk boundary must not split a surrogate pair before UTF-8 encoding.
      const end=/[\uD800-\uDBFF]/.test(pending[chunkSize-1])?chunkSize-1:chunkSize;
      yield pending.slice(0,end);pending=pending.slice(end);
    }
  }
  if(pending)yield pending;
}
