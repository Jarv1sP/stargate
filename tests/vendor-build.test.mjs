import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildFrontendVendor,vendorFiles} from '../scripts/build-frontend-vendor.mjs';
test('npm assets and both licenses are copied exactly without package/hash admission checks',async t=>{
 const root=await mkdtemp(join(tmpdir(),'vendor-copy-'));t.after(()=>rm(root,{recursive:true,force:true}));await symlink(new URL('../node_modules',import.meta.url).pathname,join(root,'node_modules'));
 const built=await buildFrontendVendor({root});assert.equal(built.length,5);
 for(const [pkg,source,target] of vendorFiles){const actual=await readFile(join(root,'dist/vendor',target)),expected=await readFile(join(root,'node_modules',pkg,source));assert.deepEqual(actual,expected);assert.equal(built.find(row=>row.target===target).bytes,expected.length);}
});
test('a missing input is read before any existing built asset is replaced',async t=>{
 const root=await mkdtemp(join(tmpdir(),'vendor-input-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'dist/vendor'),{recursive:true});const previous=join(root,'dist/vendor/xterm.js');await writeFile(previous,'previous');await assert.rejects(buildFrontendVendor({root}),e=>e.code==='ENOENT');assert.equal(await readFile(previous,'utf8'),'previous');
});
