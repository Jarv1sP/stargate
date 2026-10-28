import test from 'node:test';
import assert from 'node:assert/strict';
import {projectStatusText,trainingTarget,projectDiskQuotaHTML} from '../dist/execution-ui.js';
import {datasetRows,directoryBytes,gaugeDiskHTML,storageMixHTML,projectStorageRows,baseImages} from '../dist/datasets-ui.js';
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
 const html=resourceCards({machines:[machine],...options});assert.match(html,/class="resource-gpuline"/);assert.match(html,/80%/);assert.doesNotMatch(html,/resource-tower[^>]*disabled/);
});

test('storage distinguishes lower bounds, unknown and real zero without filling an unknown bar',()=>{
 assert.equal(directoryBytes({size:null,complete:false}),'未知');assert.equal(directoryBytes({size:0,complete:true}),'0 B');assert.equal(directoryBytes({size:3,complete:false}),'至少 3 B');
 const unknown=gaugeDiskHTML('SSD',{usedBytes:null,totalBytes:null,availableBytes:null});assert.match(unknown,/is-unknown/);assert.match(unknown,/未知/);assert.doesNotMatch(unknown,/<i |空间不足/);
 const low=gaugeDiskHTML('HDD',{usedBytes:100,totalBytes:200,availableBytes:50});assert.match(low,/空间不足/);assert.match(low,/data-fill="50"/);
});

test('shared HDD quota renders once using measured media',()=>{
 const volume={kind:'shared',media:'hdd',fs:'9223372036854775815',usedBytes:100,totalBytes:200,availableBytes:100};
 const html=projectDiskQuotaHTML({volumes:[volume],projectUsage:{size:null,complete:false}});
 assert.equal((html.match(/<li>/g)||[]).length,1);assert.match(html,/HDD · 工作区与数据集共用/);assert.match(html,/项目文件用量：未知/);assert.doesNotMatch(html,/SSD/);
 const gauge=gaugeDiskHTML('HDD · 工作区与数据集共用',volume);assert.match(gauge,/HDD · 工作区与数据集共用/);assert.match(gauge,/data-fill="50"/);assert.doesNotMatch(gauge,/SSD/);
});

test('quota labels use measured media and unknown media stays a data disk',()=>{
 for(const [media,label] of [['ssd','SSD'],['hdd','HDD'],['mixed','混合盘'],[null,'数据盘']]){
  const html=projectDiskQuotaHTML({volumes:[{kind:'workspace',media},{kind:'datasets',media}]});
  assert.ok(html.includes('工作区 · '+label));assert.ok(html.includes('数据集 · '+label));
  assert.ok(projectDiskQuotaHTML({volumes:[{kind:'shared',media}]}).includes(label+' · 工作区与数据集共用'));
 }
});

test('space mix adds up to used space and never derives "other" from an unknown part',()=>{
 const G=1024**3,disk={kind:'workspace',media:'ssd',usedBytes:1400*G,totalBytes:3500*G,availableBytes:2100*G};
 const snapshot={projects:{complete:true,projects:[{size:437*G,complete:true}],areas:{outputs:{size:692*G,complete:true},environments:{size:208*G,complete:true},trash:{size:42*G,complete:true},temporary:{size:0,complete:true}}}};
 const html=storageMixHTML(disk,snapshot);
 for(const label of ['项目文件','任务输出','容器环境','回收站','传输暂存','其他'])assert.ok(html.includes(label),label);
 assert.match(html,/data-k="other" data-fill="0\.6/);assert.doesNotMatch(html,/data-k="temporary" data-fill/);assert.doesNotMatch(html,/data-k="datasets"/);
 const partial=storageMixHTML(disk,{projects:{...snapshot.projects,areas:{...snapshot.projects.areas,outputs:{size:600*G,complete:false}}}});
 assert.match(partial,/至少 600 GiB/);assert.match(partial,/至多 /);
 const unknown=storageMixHTML(disk,{projects:{complete:true,projects:[{size:437*G,complete:true}]}});
 assert.doesNotMatch(unknown,/data-k="other" data-fill/);assert.match(unknown,/<li data-k="other" class="unk">/);assert.match(unknown,/<li data-k="outputs" class="unk">/);
 assert.match(storageMixHTML({...disk,kind:'shared'},{...snapshot,datasets:{datasets:[{size:5*G,complete:true}]}},{datasets:true}),/数据集<span class="num">5 GiB/);
 assert.equal(storageMixHTML({usedBytes:null,totalBytes:null},snapshot),'');
});

test('project rows count job outputs and sort by the combined footprint',()=>{
 const G=1024**3,html=projectStorageRows([{project:'small',ownerName:'甲',size:10*G,complete:true,outputs:{size:0,complete:true,count:0}},
  {project:'chga',ownerName:'乙',size:374*G,complete:true,outputs:{size:688*G,complete:true,count:1617}},{project:'old',size:5*G,complete:true}]);
 assert.ok(html.indexOf('chga')<html.indexOf('small'));assert.match(html,/1,062 GiB|1062 GiB|1\.0 TiB/);
 // One total per project container, no per-part breakdown.
 assert.doesNotMatch(html,/文件 |输出 |dr-split/);assert.equal((html.slice(0,html.indexOf('small')).match(/data-fill/g)||[]).length,1);
 assert.match(projectStorageRows([{project:'p',size:G,complete:true,outputs:{size:null,complete:false}}]),/至少 /);
});

test('base images show as the last row after the projects',()=>{
 const G=1024**3,areas={outputs:{size:699*G,complete:true},environments:{size:213*G,complete:true}};
 const projects=[{project:'chga',ownerName:'乙',size:378*G,complete:true,outputs:{size:689*G,complete:true},environment:{size:129*G,complete:true}},
  {project:'small',ownerName:'甲',size:69*G,complete:true,outputs:{size:4*G,complete:true},environment:{size:40*G,complete:true}}];
 const shared=baseImages({projects:{complete:true,projects,areas}});assert.deepEqual(shared,{size:44*G,complete:true,upper:false});
 const html=projectStorageRows(projects,shared);
 assert.match(html,/<div class="dr-t">基础镜像<\/div>/);assert.ok(html.indexOf('chga')<html.indexOf('small')&&html.indexOf('small')<html.indexOf('基础镜像'));
 // Larger than a project, still last.
 assert.ok(projectStorageRows([projects[1]],{size:500*G,complete:true}).indexOf('small')<projectStorageRows([projects[1]],{size:500*G,complete:true}).indexOf('基础镜像'));
 assert.doesNotMatch(html,/不属于单个项目|合计|回收站|data-rest-trash/);
 // With no projects the whole container environment is base images.
 assert.deepEqual(baseImages({projects:{complete:true,projects:[],areas}}),{size:213*G,complete:true,upper:false});
 // A project environment the node couldn't read leaves base images as an upper bound, never zero.
 const short=baseImages({projects:{complete:true,projects:[{...projects[0],environment:null},projects[1]],areas}});
 assert.equal(short.upper,true);assert.match(projectStorageRows([{...projects[0],environment:null}],short),/至少 1\.0 TiB[\s\S]*至多 173 GiB/);
 assert.deepEqual(baseImages({projects:{complete:true,projects,areas:{}}}),{size:null,complete:false});
 assert.equal(baseImages({projects:{error:'x'}}),null);
});

test('a shared project shows as 共用 instead of its creator',async()=>{
 const {projectSelectHTML}=await import('../dist/project-management-ui.js'),{projectOwnerText}=await import('../dist/workbench-ui.js');
 const own={project:'mine',ownerName:'甲',machine:'amax-5090'},team={project:'team',ownerName:'乙',shared:true,machine:'amax-5090'};
 assert.equal(projectOwnerText(own),'甲');assert.equal(projectOwnerText(team),'共用');
 const options=projectSelectHTML([own,team]);assert.match(options,/mine · 甲/);assert.match(options,/team · 共用/);assert.doesNotMatch(options,/乙/);
 const rows=projectStorageRows([{...own,size:1,complete:true},{...team,size:2,complete:true}]);
 assert.match(rows,/甲 的项目/);assert.match(rows,/<div class="dr-s">共用<\/div>/);assert.doesNotMatch(rows,/乙/);
});
