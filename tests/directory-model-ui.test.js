import test from 'node:test';
import assert from 'node:assert/strict';
import {projectStatusText,trainingTarget,projectDiskQuotaHTML} from '../dist/execution-ui.js';
import {datasetRows,directoryBytes,storageVolumeHTML} from '../dist/datasets-ui.js';
import {trashReference,trashLabel} from '../dist/trash-ui.js';
import {uploadPersonalFile} from '../dist/personal-upload.js';
import {resourceServerView,resourceCards} from '../dist/resources-ui.js';

test('ordinary dataset rows show uploader and actions without versions or preparation',()=>{
 const html=datasetRows([{dataset:'images',name:'images',size:12,ownerName:'成员乙',modifiedAt:1700000000}]);
 assert.match(html,/成员乙/);for(const action of ['open','download','delete'])assert.match(html,new RegExp('data-dataset-'+action+'="images"'));
 assert.doesNotMatch(html,/version|prepare|warehouse|@/);
});
test('projects display repository and automatic jobs can use the default OCI workspace',()=>{
 assert.equal(projectStatusText({git:{url:'https://example.test/team/repo.git',branch:'main',commit:'abc123'}}),'https://example.test/team/repo.git · main · abc123');
 assert.deepEqual(trainingTarget('auto','node-a',null,'node-a',[{id:'node-a'}]),{machine:'auto',machineSelection:{mode:'auto',candidates:['node-a']}});
 assert.match(projectDiskQuotaHTML({extra:true,volumes:[{kind:'workspace',usedBytes:1024,totalBytes:4096,availableBytes:3072}],projectUsage:{size:12,complete:false}}),/项目文件用量：至少 12 B/);
});
test('one shared trash restores outputs and datasets using the original key and kind',()=>{
 const row={key:'original-operation',kind:'output',ownerId:'member-b',project:'vision',jobId:'job',originalPath:'models/final.pt'};
 assert.deepEqual(trashReference('node-a',row),{machine:'node-a',key:'original-operation',kind:'output',ownerId:'member-b',project:'vision'});
 assert.equal(trashLabel(row),'输出 · models/final.pt');
 assert.deepEqual(trashReference('node-a',{key:'k',kind:'dataset',dataset:'images'}),{machine:'node-a',key:'k',kind:'dataset'});
});
test('new uploads of equal length reuse no content identity and resume keeps the original key and offset',async()=>{
 const calls=[],uploads=new Map();
 const call=async(operation,args)=>{
  calls.push([operation,structuredClone(args)]);let row=uploads.get(args.key);
  if(operation==='data.upload.begin'){if(!row){row={key:args.key,totalSize:args.totalSize,state:'UPLOADING',offset:0,bytes:[]};uploads.set(args.key,row);}return {...row,unknownFutureField:true};}
  if(operation==='data.upload.chunk'){const bytes=Buffer.from(args.data,'base64');assert.equal(args.offset,row.offset);row.bytes.push(...bytes);row.offset+=bytes.length;return {...row};}
  if(operation==='data.upload.finish'){row.state='COMPLETE';return {key:args.key,state:'COMPLETE',size:row.totalSize};}
  if(operation==='data.upload.status')return {...row};
  assert.fail(operation);
 };
 const send=(bytes,key)=>uploadPersonalFile({call,machine:'node-a',area:'dataset',dataset:'images',path:'data.bin',size:bytes.length,read:async(offset,length)=>bytes.subarray(offset,offset+length),...(key?{key}:{})});
 const a=await send(Buffer.from('aaaa')),b=await send(Buffer.from('bbbb'));assert.notEqual(a.key,b.key);assert.equal(uploads.size,2);assert.deepEqual(uploads.get(b.key).bytes,[98,98,98,98]);
 uploads.set('resume-key',{key:'resume-key',totalSize:4,state:'UPLOADING',offset:2,bytes:[97,97]});
 await send(Buffer.from('aaaa'),'resume-key');const chunks=calls.filter(([op,args])=>op==='data.upload.chunk'&&args.key==='resume-key');assert.equal(chunks.length,1);assert.equal(chunks[0][1].offset,2);assert.deepEqual(uploads.get('resume-key').bytes,[97,97,97,97]);
 assert.ok(calls.every(([,args])=>args.area==='dataset'&&args.dataset==='images'&&args.path==='data.bin'&&args.key));
});

test('zero GPU quota does not hide shared server readings or the workspace entry',()=>{
 const machine={id:'node-a',cards:1,model:'Example GPU'},gpu={index:0,model:'Example GPU',utilization:80,memoryUsedMiB:1024,memoryTotalMiB:8192,temperatureC:45,processesAvailable:true,processes:[]};
 const options={limits:{},production:true,snapshot:{stale:false,hosts:[{id:'node-a',reachable:true,checkedAt:'2026-10-14T11:00:00Z',gpus:[gpu],gpuq:{connected:true,health:'ok'}}]}};
 const view=resourceServerView(machine,options);assert.equal(view.quota,0);assert.equal(view.observed,true);assert.equal(view.fresh,true);assert.deepEqual(view.gpus,[gpu]);
 const html=resourceCards({machines:[machine],...options});assert.match(html,/data-use-machine="node-a"/);assert.match(html,/80%/);assert.doesNotMatch(html,/resource-tower[^>]*disabled/);
});

test('storage distinguishes lower bounds, unknown and real zero without filling an unknown bar',()=>{
 assert.equal(directoryBytes({size:null,complete:false}),'未知');assert.equal(directoryBytes({size:0,complete:true}),'0 B');assert.equal(directoryBytes({size:3,complete:false}),'至少 3 B');
 const unknown=storageVolumeHTML('workspace',{usedBytes:null,totalBytes:null,availableBytes:null});assert.match(unknown,/is-unknown/);assert.doesNotMatch(unknown,/<i |空间不足/);
 const low=storageVolumeHTML('datasets',{usedBytes:100,totalBytes:200,availableBytes:50});assert.match(low,/空间不足/);assert.match(low,/data-fill="50"/);
});
