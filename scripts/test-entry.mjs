import {readdir,access,copyFile,unlink,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {buildClient} from './build-client.mjs';
import {buildFrontendVendor} from './build-frontend-vendor.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
export async function testEntries(directory=resolve(root,'tests')){
  const files=(await readdir(directory)).sort();
  return {node:files.filter(file=>/\.test\.(js|mjs)$/.test(file)),
    python:files.filter(file=>/\.test\.py$/.test(file)),
    ui:files.filter(file=>/-(ui-smoke|ui)\.mjs$/.test(file))};
}

async function run(command,args){
  return new Promise((resolveRun,reject)=>{
    const child=spawn(command,args,{cwd:root,stdio:['inherit','pipe','inherit']});let tail='';
    child.stdout.on('data',chunk=>{process.stdout.write(chunk);tail=(tail+chunk).slice(-16384);});
    child.once('error',reject);child.once('close',(code,signal)=>resolveRun({exitCode:code,signal,
      ...Object.fromEntries([...tail.matchAll(/^# (tests|pass|fail|skipped|cancelled) (\d+)$/gm)].map(match=>[match[1],Number(match[2])]))}));
  });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mode=process.argv[2]||'node';
  if(!['node','ui','all'].includes(mode))throw Error('Expected node, ui or all');
  const inventory=resolve(root,'dist/machines.js');let synthetic=false;
  const results={};
  try{
    try{await access(inventory);}catch(error){
      if(error.code!=='ENOENT')throw error;
      await copyFile(resolve(root,'tests/fixtures/machines.js'),inventory,constants.COPYFILE_EXCL);synthetic=true;
    }
    // Build once using the actual source graph and fixed helpers, after a
    // public synthetic inventory is available. Never read private inventory.
    await buildFrontendVendor();await buildClient();
    const entries=await testEntries();
    if(mode!=='ui')results.node=await run(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1',...entries.node.map(file=>'tests/'+file)]);
    if(mode==='all')results.python=await run(process.env.PYTHON||'python3',['scripts/test-python.py']);
    if(mode!=='node'){
      results.ui=[];
      for(const file of entries.ui){console.log('\nUI '+file);results.ui.push({file,...await run(process.execPath,['tests/'+file])});}
    }
    console.log('TEST_ENTRY_RESULTS '+JSON.stringify(results));
    if(process.env.TEST_RESULTS)await writeFile(process.env.TEST_RESULTS,JSON.stringify(results,null,2)+'\n');
    process.exitCode=[results.node,results.python,...(results.ui||[])].filter(Boolean).some(result=>result.exitCode!==0)?1:0;
  }finally{if(synthetic)await unlink(inventory);}
}
