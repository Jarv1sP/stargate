import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedNativeExtractor} from '../client-campus-native.mjs';

test('concurrent agents extract once and retain the executable until the last agent closes',async()=>{
  let extracted=0,removed=0;const artifacts={};
  const extract=createSharedNativeExtractor(async value=>{assert.equal(value,artifacts);extracted++;return {path:'private-helper',cleanup:async()=>{removed++;}};});
  const [control,lan,primary]=await Promise.all([extract(artifacts),extract(artifacts),extract(artifacts)]);
  assert.equal(extracted,1);assert.equal(control.path,primary.path);
  await lan.cleanup();await lan.cleanup();await primary.cleanup();assert.equal(removed,0);
  const transfer=await extract(artifacts);assert.equal(extracted,1);
  await transfer.cleanup();assert.equal(removed,0);await control.cleanup();assert.equal(removed,1);
  const next=await extract(artifacts);assert.equal(extracted,2);await next.cleanup();assert.equal(removed,2);
});
test('different artifacts never share an executable and a failed extraction is not cached',async()=>{
  let calls=0;const first={},other={};
  const extract=createSharedNativeExtractor(async value=>{calls++;if(calls===1)throw Error('extract failed');return {path:value===first?'first':'other',cleanup:async()=>{}};});
  await assert.rejects(extract(first),/extract failed/);
  const [a,b]=await Promise.all([extract(first),extract(other)]);assert.equal(calls,3);assert.notEqual(a.path,b.path);
  await a.cleanup();await b.cleanup();
});
