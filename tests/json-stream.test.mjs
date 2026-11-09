import test from 'node:test';
import assert from 'node:assert/strict';
import {jsonChunks,JSONItems} from '../json-stream.mjs';

test('bounded snapshot JSON preserves nested records, omitted fields and Unicode across chunks',()=>{
  const value={result:{machines:[{machine:'gpu-1',checkedAt:null,refreshing:false,unknown:undefined,
    projects:{disks:[{items:[{kind:'external',path:'路径/😀'.repeat(20000),bytes:123}]}]},
    datasets:{datasets:[{size:null,complete:false,ownerName:'管理员',extra:{array:[undefined,NaN,true]}}]}}]},principal:{role:'admin'}};
  const chunks=[...jsonChunks(value)];
  assert.ok(chunks.length>4);assert.ok(chunks.every(chunk=>Buffer.byteLength(chunk)<=65536));
  assert.equal(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))).toString(),JSON.stringify(value));
});

test('storage nodes are read on demand and a disconnected response closes the iterator',()=>{
  let reads=0,closed=false;
  function* rows(){try{for(let i=0;i<4;i++){reads++;yield {path:'x'.repeat(40000)};}}finally{closed=true;}}
  const stream=jsonChunks({machines:new JSONItems(rows())});
  assert.equal(reads,0);assert.ok(stream.next().value.length>0);assert.equal(reads,1);
  stream.return();assert.equal(closed,true);assert.equal(reads,1);
});
