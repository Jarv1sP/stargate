import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {chooseCampusEndpoint,approvedCampusEndpoints} from '../client-campus-endpoints.mjs';
import {pinnedUploadAgent,probeDirectUploadRoute} from '../client-direct-upload.mjs';
import {createPersonalFileTransport} from '../client-personal-file-campus.mjs';
import {safeNetworkTarget,networkFailureCategory} from '../client-network-errors.mjs';

const grant={machine:'fixture-node',endpoint:'https://campus.example:18441',certificateSha256:'a'.repeat(64),revision:'b'.repeat(64),routes:[{id:'primary',kind:'campus-direct',endpoint:'https://campus.example:18441'},{id:'node-lan',kind:'campus-direct',endpoint:'https://192.168.50.7:18441'}]};
const capability={protocol:'dataset-upload-v1',listenerReady:true,machine:grant.machine,revision:grant.revision};
const secret='fixture-secret-bearer-that-must-never-be-sent';

for(const [code,want] of [['CERTIFICATE_MISMATCH','TLS_PIN'],['TLS_FAILED','TLS_HANDSHAKE']])test(`Mac JS ${code} survives endpoint selection as ${want}`,async()=>{
  await assert.rejects(chooseCampusEndpoint(grant,approvedCampusEndpoints(grant),{probe:async()=>{throw Object.assign(Error(secret),{uploadProbeCode:code});}}),error=>{
    assert.equal(error.endpointErrors.length,2);for(const row of error.endpointErrors){assert.equal(row.category,want);assert.equal(row.code,want);assert.match(row.target,/:18441$/);}
    assert.match(error.message,new RegExp(want));assert.doesNotMatch(error.message,new RegExp(secret));return true;
  });
});
test('host:port output strips all URL secrets and refuses malformed authorities',()=>{
  assert.equal(safeNetworkTarget(grant.endpoint),'campus.example:18441');
  for(const value of ['https://user:secret@campus.example','https://campus.example/?token=secret','https://campus.example/path','https://campus.example/#secret'])assert.equal(safeNetworkTarget(value),'unavailable');
  assert.equal(networkFailureCategory({code:secret}),'PROBE_FAILED');
});
test('anonymous capabilities probe has no authorization header, cookie, body or redirect',async()=>{
  const result=await probeDirectUploadRoute({...grant,ticket:secret,token:secret},{agentFactory:()=>({destroy(){}}),request:(target,options,respond)=>{
    assert.equal(target.pathname,'/capabilities');assert.equal(target.search,'');assert.equal(options.method,'GET');assert.deepEqual(options.headers,{Accept:'application/json'});
    const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{assert.equal(body,undefined);queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/json'};res.destroy=()=>{};respond(res);res.emit('data',Buffer.from(JSON.stringify(capability)));res.emit('end');});};return req;
  }});assert.deepEqual(result,capability);
});
test('pin agent distinguishes TCP timeout from TLS timeout and never releases an unpinned socket',async()=>{
  for(const connected of [false,true]){
    let released=0;const socket=new EventEmitter();socket.destroy=()=>{};
    const agent=pinnedUploadAgent(grant.certificateSha256,{timeoutMs:5,connect:()=>{if(connected)queueMicrotask(()=>socket.emit('connect'));return socket;}});
    // Keep the test alive while the production unref'ed deadline fires.
    const keeper=setTimeout(()=>{},100);
    const error=await new Promise(resolve=>agent.createConnection({},(error,value)=>{if(value)released++;resolve(error);}));clearTimeout(keeper);agent.destroy();
    assert.equal(error.uploadProbeCode,connected?'HANDSHAKE_TIMEOUT':'TCP_TIMEOUT');assert.equal(released,0);
  }
});
