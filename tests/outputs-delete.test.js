import test from 'node:test';
import assert from 'node:assert/strict';
import {deleteJobOutputs,deletableResultJob,resultFilesHTML,resultFilePath} from '../dist/job-results-ui.js';
const job={id:'11111111-1111-4111-8111-111111111111',machine:'fixture-node',ownerId:'another-member',state:'RUNNING'};
test('team members can delete running peer outputs into trash with no repeated confirmation',async()=>{
 const calls=[],store={production:true,principal:{userId:'member',role:'member'},call:async(op,args)=>{calls.push({op,args});return {state:'TRASHED',key:args.key};}};
 let confirmations=0;const out=await deleteJobOutputs(store,job,{confirm:()=>{confirmations++;return false;}});assert.equal(out.state,'TRASHED');assert.equal(confirmations,0);assert.equal(calls.length,1);assert.equal(calls[0].op,'outputs.delete');assert.equal(calls[0].args.dryRun,false);assert.ok(calls[0].args.key);
 for(const state of ['RUNNING','PENDING','SUCCEEDED','FAILED','CANCELED'])assert.equal(deletableResultJob(store,{...job,state}),true);
 store.principal=null;assert.equal(deletableResultJob(store,job),false);
});
test('an uncertain output delete keeps the original key for the next explicit attempt',async()=>{
 const requests=[],store={production:true,principal:{userId:'member'},call:async(op,args)=>{requests.push(args);if(requests.length===1)throw Error('connection interrupted');return {state:'TRASHED',key:args.key};}};
 await assert.rejects(deleteJobOutputs(store,job),/interrupted/);assert.equal(requests.length,1);await deleteJobOutputs(store,job);assert.equal(requests[1].key,requests[0].key);
});
test('output paths stay inside their selected directory and render escaped file controls',()=>{
 for(const path of ['../secret','/etc/passwd','a/b','a\\b'])assert.throws(()=>resultFilePath('.',path));
 const html=resultFilesHTML([{name:'result.pt',type:'file',size:4096},{name:'nested',type:'directory'}],'.',{deletable:true});assert.match(html,/data-result-delete="result.pt"/);assert.match(html,/data-delete-recursive="true"/);
});
