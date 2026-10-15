import test from 'node:test';
import assert from 'node:assert/strict';
import {symlink,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseCLIOptions} from '../cli.mjs';
import {personalHTTPFixture,originalKey as key} from './fixtures/personal-http-upload.mjs';
// 8bfd363 + cb206c1 use the shared HTTPS uploader; original UUID, size and offset remain.
test('first-byte TCP timeout and authoritative ABSENT preserve the explicit UUID on the next command',async t=>{
 const f=await personalHTTPFixture(t);let down=true;
 f.onCall=(op,args)=>{if(op==='data.upload.begin'&&down)throw Object.assign(Error('connect failed'),{code:'TCP_TIMEOUT'});return f.perform(op,args);};
 await assert.rejects(f.run(),{code:'TCP_TIMEOUT'});assert.equal(f.stored.length,0);assert.match(f.messages.join(''),new RegExp(key));
 down=false;assert.equal((await f.run()).uploaded,1);assert.deepEqual(f.stored,f.bytes);assert.ok(f.calls.filter(row=>row.args.key).every(row=>row.args.key===key));
});
test('lost final acknowledgement is queried by original UUID and never sends completed bytes twice',async t=>{
 const f=await personalHTTPFixture(t);let writes=0;
 f.onCall=(op,args)=>{if(op==='data.upload.chunk')writes++;const reply=f.perform(op,args);if(op==='data.upload.finish')throw Object.assign(Error('lost reply'),{code:'ACK_UNCONFIRMED'});return reply;};
 assert.equal((await f.run()).uploaded,1);assert.equal(writes,1);assert.equal(f.calls.at(-1).operation,'data.upload.status');assert.equal(f.receipt().key,key);
});
test('push-status is read-only and an already complete original upload sends no payload',async t=>{
 const f=await personalHTTPFixture(t);await f.run();f.calls.length=0;
 const read=await f.run({inspectOnly:true});assert.deepEqual(read.files,[f.receipt()]);assert.deepEqual(f.calls.map(row=>row.operation),['data.upload.status']);
 f.calls.length=0;assert.equal((await f.run()).uploaded,1);assert.deepEqual(f.calls.map(row=>row.operation),['data.upload.begin','data.upload.finish']);
});
test('symlinks and malformed original upload IDs never start a transfer',async t=>{
 const f=await personalHTTPFixture(t),link=join(f.root,'link');await symlink(f.local,link);
 for(const extra of [{local:link},{key:'not-a-uuid'}])await assert.rejects(f.run(extra),/链接|UUID/);
 assert.equal(f.calls.length,0);
});
test('403 never becomes absence or retry and the original UUID remains visible',async t=>{
 const f=await personalHTTPFixture(t);f.onCall=()=>{throw Object.assign(Error('login expired'),{status:403});};
 await assert.rejects(f.run(),error=>error.status===403);assert.equal(f.calls.length,1);assert.equal(f.stored.length,0);assert.match(f.messages.join(''),new RegExp(key));
});
test('the CLI parser retains --key for push and push-status',()=>{
 for(const command of ['push','push-status'])assert.equal(parseCLIOptions([command,'payload','payload','--key',key]).options.key,key);
});
test('a saved campus route survives the VPS default until relay is explicitly selected',async t=>{
 const f=await personalHTTPFixture(t),stateDirectory=join(f.root,'states');await mkdir(stateDirectory);await writeFile(join(stateDirectory,key+'.route.json'),JSON.stringify({via:'direct'}));
 f.onCall=(op,args)=>{if(op==='files.direct-ticket')throw Object.assign(Error('campus offline'),{status:400});return f.perform(op,args);};
 await assert.rejects(f.run({stateDirectory,via:undefined}),/campus offline/);assert.equal(f.stored.length,0);
 f.calls.length=0;assert.equal((await f.run({stateDirectory,via:'relay'})).uploaded,1);assert.equal(f.calls.some(row=>row.operation==='files.direct-ticket'),false);assert.deepEqual(f.stored,f.bytes);assert.equal(f.receipt().key,key);
});
