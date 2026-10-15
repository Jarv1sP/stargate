import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readFile,appendFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Compile the actual import graph. Shared CLI modules need no special export
// registry, runtime compiler, text inlining, or hand-maintained dependency list.
export async function buildClient({root=fileURLToPath(new URL('..',import.meta.url)),outfile=resolve(root,'build/gpuctl.mjs'),revision=process.env.STARGATE_RELEASE_REVISION}={}){
  // Release builds regenerate all four helpers with build:release. A plain
  // bundle would silently lose Windows control and campus transfer support.
  const artifacts=JSON.parse(await readFile(resolve(root,'build/campus-native/embedded-artifacts.private.json'),'utf8'));
  await build({absWorkingDir:root,entryPoints:['cli.mjs'],outfile,bundle:true,
    define:{STARGATE_CAMPUS_NATIVE_BUNDLE:JSON.stringify(artifacts)},
    platform:'node',format:'esm',target:'node22.13',charset:'utf8',sourcemap:false,
    legalComments:'inline',logLevel:'silent'});
  if(!revision)try{revision=(await promisify(execFile)('git',['rev-parse','HEAD'],{cwd:root,windowsHide:true})).stdout.trim();}catch{}
  // Count origin substitutions once while building. At runtime a bounded
  // footer read and stat give the rendered size; the CLI is never prehashed.
  const literal=Buffer.from(JSON.stringify('__GPUQ_PUBLIC_ORIGIN__'));let tail=Buffer.alloc(0),originSlots=0;
  for await(const chunk of createReadStream(outfile)){
    const data=Buffer.concat([tail,chunk]);let at=0,index;
    while((index=data.indexOf(literal,at))!==-1){originSlots++;at=index+literal.length;}
    tail=data.subarray(Math.max(at,data.length-literal.length+1));
  }
  await appendFile(outfile,'\n// STARGATE_BUILD_INFO '+JSON.stringify({revision:revision||null,originSlots})+'\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await buildClient();process.stdout.write('Built standalone client: build/gpuctl.mjs\n');
}
