import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonical,normalizeManifest,normalizeSelection,parseFilesFrom,resolveSelection,requireSubsetCapability,SUBSET_PROTOCOL} from '../dataset-subsets.mjs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/dataset-subsets.json',import.meta.url)));
for(const [i,vector] of fixture.vectors.entries())test(`subset golden vector ${i+1}`,()=>{
  assert.deepEqual(resolveSelection(fixture.manifest,fixture.version,vector.selection),vector.expected);
});
test('normalized rules are deterministic without changing fixed version or names',()=>{
  const before=JSON.stringify(fixture.manifest);
  const a=resolveSelection(fixture.manifest,fixture.version,{include:['train/**','metadata.json','train/**'],exclude:['**/*.tmp']});
  const b=resolveSelection(fixture.manifest,fixture.version,{exclude:['**/*.tmp'],include:['metadata.json','train/**']});
  assert.equal(a.selectionId,b.selectionId);assert.equal(a.filesSha256,b.filesSha256);
  assert.equal(JSON.stringify(fixture.manifest),before);
  const all=resolveSelection(fixture.manifest,fixture.version,{include:['**']});
  assert.notEqual(all.selectionId,fixture.version);assert.equal(all.fileCount,fixture.manifest.files.length);
});
test('glob stars stay inside components and double star includes zero directories',()=>{
  const single=resolveSelection(fixture.manifest,fixture.version,{include:['train/*.bin']});
  assert.deepEqual(single.manifest.files.map(f=>f.path),['train/a.bin']);
  const double=resolveSelection(fixture.manifest,fixture.version,{include:['**/*.bin']});
  assert.ok(double.manifest.files.some(f=>f.path==='root.bin'));
  assert.ok(double.manifest.files.some(f=>f.path==='train/nested/b.bin'));
  assert.deepEqual(resolveSelection(fixture.manifest,fixture.version,{files:['metadata.json']}).manifest.directories,[]);
});
test('files-from preserves spaces and #, supports BOM and CRLF, rejects invalid UTF-8',()=>{
  assert.deepEqual(parseFilesFrom(Buffer.from('\ufeffnotes #1.txt\r\n train \r\n\r\n')),['notes #1.txt',' train ']);
  assert.throws(()=>parseFilesFrom(Buffer.from([0xff])),/UTF-8/);
  for(const raw of ['', '\n\r\n'])assert.throws(()=>parseFilesFrom(Buffer.from(raw)),/empty/);
  assert.throws(()=>parseFilesFrom(Buffer.from('bad\rname\n')),/relative/);
});
test('files-from enforces raw byte and line bounds before deduplication',()=>{
  assert.equal(parseFilesFrom(Buffer.from('a\n'.repeat(100000))).length,100000);
  assert.throws(()=>parseFilesFrom(Buffer.from('a\n'.repeat(100001))),/100000/);
  const boundary=Buffer.from(('a'.repeat(2047)+'\n').repeat(4096));
  assert.equal(boundary.length,8*1024*1024);assert.equal(parseFilesFrom(boundary).length,4096);
  assert.throws(()=>parseFilesFrom(Buffer.alloc(8*1024*1024+1)),/8 MiB/);
});
test('64 include and exclude rules combined; glob and path byte limits',()=>{
  assert.equal(normalizeSelection({include:Array(32).fill('a'),exclude:Array(32).fill('b')}).include.length,1);
  assert.throws(()=>normalizeSelection({include:Array(33).fill('a'),exclude:Array(32).fill('b')}),/glob rules/);
  assert.equal(normalizeSelection({include:['a'.repeat(1024)]}).include[0].length,1024);
  assert.throws(()=>normalizeSelection({include:['a'.repeat(1025)]}),/1024/);
  assert.throws(()=>normalizeSelection({files:['a'.repeat(4097)]}),/relative/);
  assert.throws(()=>normalizeSelection({files:Array(100001).fill('a')}),/Too many/);
});
test('invalid fields and traversal do not become whole-version requests',()=>{
  for(const value of [{}, {files:[]}, {include:null}, {include:['a'],extra:true},[]])assert.throws(()=>normalizeSelection(value));
  for(const name of ['/etc/passwd','a/../b','a//b','a/./b','C:/data','a\\b','.git/config','a\u0000b','\ud800']){
    assert.throws(()=>normalizeSelection({files:[name]}),/relative|Unsafe|credential/);
  }
  for(const pattern of ['a[','a[]','a[z-a]','a]'])assert.throws(()=>normalizeSelection({include:[pattern]}),/glob/);
  assert.throws(()=>resolveSelection(fixture.manifest,fixture.version,{files:['*.bin']}),/not in/);
  assert.throws(()=>resolveSelection(fixture.manifest,fixture.version,{include:['missing/**']}),/empty/);
});
test('manifest and selected file proof cannot be forged',()=>{
  assert.throws(()=>resolveSelection(fixture.manifest,'0'.repeat(64),{include:['**']}),/SHA mismatch/);
  for(const change of [m=>m.schema=true,m=>m.files[0].size=2**53,m=>m.files[0].sha256+='\n',m=>m.files.push({...m.files[0]})]){
    const manifest=structuredClone(fixture.manifest);change(manifest);assert.throws(()=>normalizeManifest(manifest));
  }
  const manifest=structuredClone(fixture.manifest);manifest.directories=[];
  assert.throws(()=>normalizeManifest(manifest),/parent/);
});
test('resolution is cancelable before parsing and during bounded work',()=>{
  assert.throws(()=>resolveSelection(fixture.manifest,fixture.version,{include:['**']},{checkpoint(){throw new Error('canceled');}}),/canceled/);
  let calls=0;
  assert.throws(()=>resolveSelection(fixture.manifest,fixture.version,{include:['**']},{checkpoint(){if(++calls===2)throw new Error('revoked');}}),/revoked/);
});
test('old, unknown and wrong protocol nodes reject with explicit 409',()=>{
  for(const cap of [undefined,{}, {subset:{}}, {subset:{protocol:'dataset-subset-v0',prepare:true}}, {subset:{protocol:SUBSET_PROTOCOL,prepare:1}}]){
    assert.throws(()=>requireSubsetCapability(cap),error=>error.status===409&&error.code==='DATASET_SUBSET_UNSUPPORTED');
  }
  const cap={subset:{protocol:SUBSET_PROTOCOL,prepare:true,cacheRead:true,warehouseRead:false}};
  requireSubsetCapability(cap);requireSubsetCapability(cap,'cacheRead');
  assert.throws(()=>requireSubsetCapability(cap,'warehouseRead'),{code:'DATASET_SUBSET_UNSUPPORTED'});
});
test('canonical JSON preserves Unicode and uses compact sorted object keys',()=>{
  assert.equal(canonical({z:['😀','\ue000'],a:'"'}),'{'+'"a":"\\\"","z":["😀","\ue000"]}');
});
