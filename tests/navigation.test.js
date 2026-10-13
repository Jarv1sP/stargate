import test from 'node:test';
import assert from 'node:assert/strict';
import {roomOrder,pageForRoute,roomForPage,hashForPage} from '../dist/navigation.js';

test('transfer routes identify the dataset room and use one canonical tab URL',()=>{
  for(const route of ['transfers','#transfers','datasets/transfers','#datasets/transfers']){
    const page=pageForRoute(route);assert.equal(page,'transfers');
    assert.equal(roomForPage(page),'datasets');assert.equal(hashForPage(page),'#datasets/transfers');
  }
  assert.equal(pageForRoute('#datasets'),'datasets');assert.equal(hashForPage('datasets'),'#datasets');
});
test('room ordering excludes the transfer tab while keeping account and admin routes',()=>{
  assert.deepEqual(roomOrder,['work','resources','datasets','community','workshop']);
  for(const page of [...roomOrder,'me','maintenance']){
    assert.equal(pageForRoute(hashForPage(page)),page);assert.equal(roomForPage(page),page);
  }
});
test('workshop is a first-class room without changing the admin or training routes',()=>{
  assert.equal(pageForRoute('#workshop'),'workshop');assert.equal(hashForPage('workshop'),'#workshop');
  assert.equal(pageForRoute('#workshop/unknown'),null);
  assert.equal(pageForRoute('#work'),'work');assert.equal(pageForRoute('#admin'),'admin');
});
test('native document anchors and unrecognised routes are not treated as rooms',()=>{
  for(const route of ['',null,undefined,'#main-content','#guide-main','#datasets/missing','#missing','/#transfers'])assert.equal(pageForRoute(route),null);
});

test('legacy member management links stay in the admin frame, outside the primary rooms',()=>{
  assert.equal(pageForRoute('#users'),'admin');assert.equal(hashForPage('users'),'#admin/members');
  assert.equal(pageForRoute('#admin/members'),'admin');assert.equal(roomOrder.includes('users'),false);
});

test('storage aliases retain the canonical dataset and transfer routes',()=>{
  assert.equal(pageForRoute('#storage'),'datasets');assert.equal(hashForPage(pageForRoute('#storage')),'#datasets');
  assert.equal(pageForRoute('#storage/transfers'),'transfers');
});
