import test from 'node:test';
import assert from 'node:assert/strict';
import {hostDiagnosticAvailability,hostDiagnosticPresets,hostDiagnosticText} from '../dist/host-diagnostics-ui.js';
const data={gpuq:{stale:false,hosts:[{id:'fixture-node',reachable:true,disks:[{mountPoint:'/fixture-data',totalBytes:8*1024**3,usedBytes:3*1024**3,availableBytes:5*1024**3}],gpus:[{index:0,model:'fixture GPU',utilization:75,memoryUsedMiB:1200,memoryTotalMiB:24000,temperatureC:66,processesAvailable:true,processes:[{pid:123,memoryUsedMiB:1200,task:{id:'peer-job',name:'peer training'}}]}]}]}};
test('both existing diagnostic buttons use sampled host state',()=>{
 assert.deepEqual(hostDiagnosticPresets.map(row=>[row.id,row.title]),[['gpu','GPU 状态'],['disk','数据盘用量']]);
 assert.throws(()=>hostDiagnosticPresets.push({id:'shell'}));assert.equal(hostDiagnosticAvailability(data,'fixture-node'),'');
});
test('GPU diagnostics keep model, utilization, memory, temperature and peer task',()=>{
 const text=hostDiagnosticText(data,'fixture-node','gpu');
 for(const expected of ['fixture GPU','75%','1200 / 24000 MiB','66 °C','peer training','PID 123'])assert.ok(text.includes(expected),expected);
});
test('disk diagnostics keep every data mount with total, used and available bytes',()=>{
 const text=hostDiagnosticText(data,'fixture-node','disk');
 for(const expected of ['/fixture-data','已用 3.00 GiB','总量 8.00 GiB','可用 5.00 GiB'])assert.ok(text.includes(expected),expected);
});
test('missing or old sampling remains visibly unknown rather than zero or idle',()=>{
 assert.match(hostDiagnosticAvailability({gpuq:{hosts:[]}},'fixture-node'),/未知/);
 assert.match(hostDiagnosticAvailability({...data,gpuq:{...data.gpuq,stale:true}},'fixture-node'),/过期/);
 const text=hostDiagnosticText({gpuq:{hosts:[{id:'fixture-node',gpus:[{index:0}]}]}},'fixture-node');
 assert.match(text,/使用率 未知/);assert.match(text,/任务：未知/);assert.doesNotMatch(text,/0%|任务：无/);
});
