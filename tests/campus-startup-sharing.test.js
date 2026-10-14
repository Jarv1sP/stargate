import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedNativeExtractor} from '../client-campus-native.mjs';
import {chooseCampusEndpoint,probeCampusEndpoint} from '../client-campus-endpoints.mjs';

test('concurrent agents extract once and retain the executable until the last agent closes',async()=>{
  let extracted=0,removed=0;const artifacts={schema:1};
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

const grant={endpoint:'https://campus.example:18441',machine:'fixture',revision:'b'.repeat(64),certificateSha256:'a'.repeat(64)};
const endpoints=[{id:'node-lan',endpoint:'https://192.168.50.7:18441'},{id:'primary',endpoint:grant.endpoint}];
const capabilities={protocol:'dataset-upload-v1',listenerReady:true,machine:grant.machine,revision:grant.revision};
test('first valid parallel probe wins without waiting for unreachable LAN and cancels its anonymous probe',async()=>{
  const seen=[];let canceled=false;
  const selected=await chooseCampusEndpoint(grant,endpoints,{parallel:true,probe:async(value,endpoint,{signal})=>{
    assert.equal(value,grant);seen.push(endpoint.id);
    if(endpoint.id==='primary')return capabilities;
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{canceled=true;reject(Object.assign(Error('canceled'),{code:'ABORT_ERR'}));},{once:true}));
  }});
  assert.equal(selected,endpoints[1]);assert.deepEqual(seen,['node-lan','primary']);assert.equal(canceled,true);
});
test('canceling an anonymous probe closes only its own helper and does not send a grant',async()=>{
  const controller=new AbortController();let closed=0,sent;
  const probing=probeCampusEndpoint(grant,endpoints[0],{signal:controller.signal,agentFactory:()=>({
    request:async header=>{sent=header;return new Promise((resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('closed')),{once:true}));},
    destroy:async()=>{closed++;}
  })});
  controller.abort();await assert.rejects(probing,/closed/);assert.ok(closed>=1);
  assert.equal(sent.op,'probe');assert.equal(sent.grant,undefined);assert.equal(sent.ticket,undefined);assert.equal(sent.endpoint,grant.endpoint);assert.equal(sent.certificateSha256,grant.certificateSha256);
});

test('parallel probes accept authenticated revision changes with unchanged machine',async()=>{
 const selected=await chooseCampusEndpoint(grant,endpoints,{parallel:true,probe:async()=>({...capabilities,revision:'c'.repeat(64)})});assert.equal(selected,endpoints[0]);
});
