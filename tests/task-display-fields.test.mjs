import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeTaskDisplay} from '../dist/task-metadata.js';
import {schedulingFields} from '../dist/scheduling-ui.js';
test('display metadata ignores unknown fields and does not compare a saved actor with current labels',()=>{
 const value={name:'训练',description:'输出',submitter:{name:'成员',username:'other',internalExtra:true},futureField:'ignored'};const before=structuredClone(value);assert.deepEqual(nativeTaskDisplay(value,'previous'),{name:'训练',description:'输出',submitter:{name:'成员',username:'other'}});assert.deepEqual(value,before);
 for(const patch of [{name:'x'.repeat(65)},{name:'bad\u0000name'},{description:'x'.repeat(2001)}])assert.equal(nativeTaskDisplay({...value,...patch},'previous'),null);
});
test('all signed-in team members can choose every existing queue priority',()=>{const html=schedulingFields(false);for(let n=0;n<=4;n++)assert.ok(html.includes('value="P'+n+'"'));});

import {completionHTML} from '../dist/job-diagnostics-ui.js';
test('current failed or canceled completion is shown directly rather than withheld as unconfirmed',()=>{assert.match(completionHTML({state:'FAILED',completed:true}),/失败/);assert.match(completionHTML({state:'CANCELED',completed:true}),/已取消/);assert.match(completionHTML({state:'UNKNOWN',completed:false}),/未知.*原编号/);});
