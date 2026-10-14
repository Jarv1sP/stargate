import test from 'node:test';
import assert from 'node:assert/strict';
import {terminalContext,terminalLaunchContext,terminalRequestContext,projectTerminalStorage} from '../dist/terminal-ui.js';
test('team terminal context addresses the selected project owner and ignores removed scope fields',()=>{
 assert.deepEqual(terminalLaunchContext({machine:'node-a',project:'vision',ownerId:'member-b',dataWorkspace:true,hostAdmin:true,futureField:true}),{machine:'node-a',project:'vision',ownerId:'member-b'});
 assert.deepEqual(terminalRequestContext({machine:'node-a',ownerId:'member-b',project:'vision',dataWorkspace:true}),{machine:'node-a',ownerId:'member-b',project:'vision'});
 assert.deepEqual(terminalContext({machine:'node-a'}),{machine:'node-a'});
 assert.throws(()=>terminalContext({machine:'node-a',project:'../../system'}),/项目名称/);
});
test('terminal reconnect remembers the default OCI project and distinguishes same-name peer projects',()=>{
 const values=new Map(),storage={get length(){return values.size;},key:index=>[...values.keys()][index],getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 const cache=projectTerminalStorage(storage),base={userId:'member-a',machine:'node-a'},ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
 cache.remember({...base,project:'',id:ids[0]});cache.remember({...base,ownerId:'member-a',project:'vision',id:ids[1]});cache.remember({...base,ownerId:'member-b',project:'vision',id:ids[2]});
 assert.equal(cache.list('member-a').length,3);assert.equal(cache.list('member-b').length,0);assert.equal(cache.list('member-a').find(row=>row.id===ids[2]).ownerId,'member-b');
 cache.forget({...base,ownerId:'member-b',project:'vision',id:ids[2]});assert.equal(cache.list('member-a').length,2);assert.ok(cache.list('member-a').some(row=>row.id===ids[0]));
});
