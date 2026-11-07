import test from 'node:test';
import assert from 'node:assert/strict';
import {projectStatusText,trainingTarget,projectDiskQuotaHTML} from '../dist/execution-ui.js';
import {datasetRows,directoryBytes,gaugeDiskHTML,diskGroups,diskMixHTML,storageMixHTML,projectStorageRows,ownerStorageRows} from '../dist/datasets-ui.js';
import {ownerUsage,quotaReport,quotaUsageLines} from '../dist/storage-usage.js';
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
 assert.match(projectDiskQuotaHTML({extra:true,volumes:[{kind:'workspace',usedBytes:1024,totalBytes:4096,availableBytes:3072}],projectUsage:{size:12,complete:false}}),/项目用量：至少 12 B<\/p><p class="disk-quota-parts">文件 至少 12 B · 输出 未知 · 环境 未知/);
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
 assert.equal((html.match(/<li>/g)||[]).length,1);assert.match(html,/HDD · 工作区与数据集共用/);assert.match(html,/项目用量：未知/);assert.doesNotMatch(html,/SSD/);
 const gauge=gaugeDiskHTML('HDD · 工作区与数据集共用',volume);assert.match(gauge,/HDD · 工作区与数据集共用/);assert.match(gauge,/data-fill="50"/);assert.doesNotMatch(gauge,/SSD/);
});

test('quota labels use measured media and unknown media stays a data disk',()=>{
 for(const [media,label] of [['ssd','SSD'],['hdd','HDD'],['mixed','混合盘'],[null,'数据盘']]){
  const html=projectDiskQuotaHTML({volumes:[{kind:'workspace',media},{kind:'datasets',media}]});
  assert.ok(html.includes('工作区 · '+label));assert.ok(html.includes('数据集 · '+label));
  assert.ok(projectDiskQuotaHTML({volumes:[{kind:'shared',media}]}).includes(label+' · 工作区与数据集共用'));
 }
});

const G=1024**3;
const quotaDisk={mountPoint:'/fixture/data0',media:'ssd',roles:['workspace'],accounting:'quota',totalBytes:3500*G,usedBytes:1400*G,availableBytes:2000*G,trashBytes:42*G,items:[
 {kind:'project',ownerId:'a',ownerName:'甲',project:'chga',files:374*G,outputs:300*G,environment:26*G},{kind:'project',ownerId:'b',ownerName:'乙',project:'small',files:10*G,outputs:0,environment:40*G},
 {kind:'images',ownerId:'a',ownerName:'甲',bytes:30*G},{kind:'images',ownerId:'b',ownerName:'乙',bytes:20*G},{kind:'dataset',name:'images',bytes:200*G},{kind:'platform',bytes:5*G},
 {kind:'external',path:'/fixture/data0/cyx',bytes:300*G},{kind:'external',path:'/fixture/data0/lpl',bytes:70*G},{kind:'unassignedOutputs',bytes:3*G},{kind:'untracked',bytes:20*G},{kind:'filesystem',bytes:2*G},{kind:'futureKind',bytes:1}]};
test('each disk lists its full composition, summing to used space, with no "other"',()=>{
 const groups=diskGroups(quotaDisk);
 assert.deepEqual(groups.map(group=>group.label),['项目','镜像与容器引擎','数据集','平台运行数据','外部目录','未归属输出','未登记','文件系统开销']);
 assert.equal(groups.reduce((sum,group)=>sum+group.size,0),quotaDisk.usedBytes);
 assert.deepEqual(groups[0].rows.map(row=>[row.label,row.size/G]),[['甲',700],['乙',50]]);assert.deepEqual(groups[4].rows.map(row=>row.label),['/fixture/data0/cyx','/fixture/data0/lpl']);
 const html=diskMixHTML(quotaDisk);
 assert.doesNotMatch(html,/其他|基础镜像/);assert.match(html,/\/fixture\/data0\/cyx<\/span><span class="num">300 GiB/);assert.match(html,/镜像与容器引擎<\/span><span class="num">50 GiB/);
 assert.match(html,/可用<\/span><span class="num">2.0 TiB/);assert.match(html,/其中回收站 42 GiB，7 天内可恢复/);assert.match(html,/\/fixture\/data0/);
 assert.equal((html.match(/data-fill=/g)||[]).length,8);
 // Overhead is reported as is, even slightly negative, and never drawn.
 const negative=diskMixHTML({...quotaDisk,items:[...quotaDisk.items.filter(item=>item.kind!=='filesystem'),{kind:'filesystem',bytes:-3*1024**2}]});
 assert.match(negative,/文件系统开销<\/span><span class="num">−3.0 MiB/);assert.doesNotMatch(negative,/data-k="filesystem" data-fill/);
 // Empty groups are left out except the overhead line.
 assert.deepEqual(diskGroups({...quotaDisk,items:[{kind:'platform',bytes:5}]}).map(group=>group.kind),['platform','filesystem']);
});
test('a disk without project accounting, or no disk reading at all, stays unknown instead of zero',()=>{
 const off=diskMixHTML({...quotaDisk,accounting:'unavailable',items:[]});
 assert.match(off,/未开启项目记账，用量未知/);assert.match(off,/dr-mix-bar is-unknown/);assert.doesNotMatch(off,/data-fill|>0 B</);
 assert.match(diskMixHTML({...quotaDisk,usedBytes:null,totalBytes:null}),/用量未知/);
 for(const projects of [undefined,{error:'x'},{projects:[]}])assert.match(storageMixHTML(projects),/空间构成<\/strong><span>未知，请刷新重试/);
 const two=storageMixHTML({disks:[quotaDisk,{...quotaDisk,mountPoint:'/fixture/data1',accounting:'unavailable',items:[]}]});
 assert.equal((two.match(/<section class="dr-mix"/g)||[]).length,2);assert.equal(storageMixHTML({disks:[]}),'');
});
test('project rows show the total with files, outputs and environment and sort by the total',()=>{
 const html=projectStorageRows([{project:'small',ownerName:'甲',size:10*G,complete:true,outputs:{size:0,complete:true,count:0},environment:{size:40*G,complete:true}},
  {project:'chga',ownerName:'乙',size:374*G,complete:true,outputs:{size:688*G,complete:true,count:1617},environment:{size:26*G,complete:true}},{project:'old',size:5*G,complete:true}]);
 assert.ok(html.indexOf('chga')<html.indexOf('small')&&html.indexOf('small')<html.indexOf('old'));
 assert.match(html,/文件 374 GiB · 输出 688 GiB · 环境 26 GiB<\/div><\/div>.*data-project-total>1.1 TiB/);
 assert.match(html,/文件 10 GiB · 输出 0 B · 环境 40 GiB/);
 // A part read as unknown makes the total a lower bound; nothing known stays unknown.
 assert.match(html,/文件 5 GiB · 输出 未知 · 环境 未知<\/div><\/div>.*data-project-total>至少 5 GiB/);
 assert.match(projectStorageRows([{project:'p',size:null,complete:false,outputs:{size:null,complete:false},environment:{size:null,complete:false}}]),/data-project-total>未知/);
 assert.doesNotMatch(html,/基础镜像/);
});
test('people sum their projects and images over accounted disks; an unaccounted disk makes totals a lower bound',()=>{
 const owners=ownerUsage([quotaDisk]);
 assert.deepEqual(owners.map(row=>[row.ownerName,row.projects.size/G,row.images.size/G,row.total.size/G,row.total.complete]),[['甲',700,30,730,true],['乙',50,20,70,true]]);
 const html=ownerStorageRows(owners);assert.match(html,/甲<\/div><div class="dr-s">项目 700 GiB · 镜像与容器引擎 30 GiB/);assert.ok(html.indexOf('甲')<html.indexOf('乙'));
 const partial=ownerUsage([quotaDisk,{mountPoint:'/fixture/data1',accounting:'unavailable',items:[]}]);assert.equal(partial[0].total.complete,false);assert.match(ownerStorageRows(partial),/至少 730 GiB/);
 assert.equal(ownerUsage([{accounting:'unavailable',items:[]}]),null);assert.equal(ownerUsage(undefined),null);assert.match(ownerStorageRows(null),/未知/);
});
test('CLI report reads the same snapshot row as the web and lists every project and person',()=>{
 const sample={machine:'node-a',quota:{volumes:[{kind:'shared',usedBytes:1}],checkedAt:'2026-11-07T00:00:00Z'},projects:{checkedAt:'2026-11-07T00:10:00Z',disks:[quotaDisk],projects:[
  {project:'small',ownerId:'b',ownerName:'乙',shared:true,size:10*G,complete:true,outputs:{size:0,complete:true},environment:{size:40*G,complete:true}},
  {project:'chga',ownerId:'a',ownerName:'甲',size:374*G,complete:true,outputs:{size:300*G,complete:true},environment:{size:26*G,complete:true}}]}};
 const one=quotaReport(sample,{project:'small',ownerId:'b'});assert.equal(one.checkedAt,'2026-11-07T00:10:00Z');assert.equal(one.projectUsage.total.size,50*G);
 const lines=quotaUsageLines(one,Date.parse('2026-11-07T00:13:00Z'));
 assert.deepEqual(lines,['项目 small（共用 · 创建人 乙）：合计 50 GiB；文件 10 GiB · 输出 0 B · 环境 40 GiB','统计于 3 分钟前']);
 const web=projectStorageRows(sample.projects.projects);assert.match(web,/data-project-row="small"[\s\S]*共用 · 创建人 乙[\s\S]*data-project-total>50 GiB/);
 const all=quotaUsageLines(quotaReport(sample,{all:true}),Date.parse('2026-11-07T00:13:00Z'));
 assert.ok(all.indexOf('  chga（甲）：合计 700 GiB；文件 374 GiB · 输出 300 GiB · 环境 26 GiB')<all.indexOf('  small（共用 · 创建人 乙）：合计 50 GiB；文件 10 GiB · 输出 0 B · 环境 40 GiB'));
 assert.ok(all.includes('  甲：合计 730 GiB；项目 700 GiB · 镜像与容器引擎 30 GiB'));
 assert.deepEqual(quotaUsageLines(quotaReport(sample,{project:'missing',ownerId:'a'})).slice(0,1),['项目 missing：合计 未知；文件 未知 · 输出 未知 · 环境 未知']);
 assert.deepEqual(quotaUsageLines(quotaReport({...sample,projects:{error:'x'}},{all:true})).slice(0,4),['本机项目（按合计排序）：','  未知，请稍后重试。','按人汇总：','  未知：这台服务器还没有项目记账数据。']);
});

test('a shared project shows as 共用 in pickers and with its creator in storage views',async()=>{
 const {projectSelectHTML}=await import('../dist/project-management-ui.js'),{projectOwnerText}=await import('../dist/workbench-ui.js');
 const own={project:'mine',ownerName:'甲',machine:'amax-5090'},team={project:'team',ownerName:'乙',shared:true,machine:'amax-5090'};
 assert.equal(projectOwnerText(own),'甲');assert.equal(projectOwnerText(team),'共用');
 const options=projectSelectHTML([own,team]);assert.match(options,/mine · 甲/);assert.match(options,/team · 共用/);assert.doesNotMatch(options,/乙/);
 // Storage views keep the creator of a shared project visible.
 const rows=projectStorageRows([{...own,size:1,complete:true},{...team,size:2,complete:true}]);
 assert.match(rows,/甲 的项目/);assert.match(rows,/<div class="dr-s">共用 · 创建人 乙<\/div>/);
});
