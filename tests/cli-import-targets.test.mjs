import test from 'node:test';
import assert from 'node:assert/strict';
import {runCloudImport} from '../client-cloud-import.mjs';
import {runCloudFiles} from '../client-cloud-files.mjs';
const key='11111111-1111-4111-8111-111111111111',stderr={write(){}};
test('link import rejects --project before inspecting either source, including mixed targets and resume',async()=>{
 for(const url of ['https://example.test/data.zip','https://www.alipan.com/s/SHARE'])for(const project of ['demo','',null]){
  for(const action of ['import','import-resume']){
   await assert.rejects(runCloudImport({action,positionals:action==='import'?['data','import',url,'data.zip']:['data',action,key],options:{project,dataset:'images'},machine:'fixture',stderr,call:()=>assert.fail('rejected target contacted Portal')}),/--project.*--dataset/);
  }
 }
});
test('link imports require a dataset and keep the original key for HTTPS and Aliyun',async()=>{
 await assert.rejects(runCloudImport({action:'import',positionals:['data','import','https://example.test/file','file'],options:{},call:()=>assert.fail('missing target contacted Portal')}),/--dataset/);
 for(const aliyun of [false,true]){
  const calls=[],url=aliyun?'https://www.alipan.com/s/SHARE':'https://example.test/file';
  await runCloudImport({action:'import',positionals:['data','import',url,'file'],options:{dataset:'images',key},machine:'fixture',stderr,call:async(op,args)=>{calls.push({op,args});return {result:op==='cloud.inspect'?{inspectionId:'scan',files:[{id:'file-id',name:'file',size:3}]}:{state:'PENDING'}};}});
  const args=calls.at(-1).args;assert.equal(args.area,'dataset');assert.equal(args.dataset,'images');assert.equal(args.key,key);assert.equal(args.project,undefined);
 }
});
test('cloud download rejects --project and missing dataset before listing cloud files',async()=>{
 for(const options of [{project:'demo'},{project:'demo',dataset:'images'},{project:''},{project:null},{}]){
  await assert.rejects(runCloudFiles({positionals:['data','cloud','download','file-id','file'],options,machine:'fixture',stderr,call:()=>assert.fail('rejected target contacted Portal')}),/--dataset/);
 }
});
