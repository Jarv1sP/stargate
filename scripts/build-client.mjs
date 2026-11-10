import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readFile,appendFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {gzipSync} from 'node:zlib';

// Compile the actual import graph. Shared CLI modules need no special export
// registry, runtime compiler, text inlining, or hand-maintained dependency list.
export async function buildClient({root=fileURLToPath(new URL('..',import.meta.url)),outfile=resolve(root,'build/gpuctl.mjs'),revision=process.env.STARGATE_RELEASE_REVISION}={}){
  // Release builds regenerate all four helpers with build:release. A plain
  // bundle would silently lose Windows control and campus transfer support.
  const artifacts=JSON.parse(await readFile(resolve(root,'build/campus-native/embedded-artifacts.private.json'),'utf8'));
  if(!revision)try{revision=(await promisify(execFile)('git',['rev-parse','HEAD'],{cwd:root,windowsHide:true})).stdout.trim();}catch{}
  // Keep the standalone client portable. Only extraction of a selected helper
  // inflates it; help and cached-helper reuse never allocate the original bytes.
  const helpers=Object.entries(artifacts.artifacts).map(([platform,item])=>{
    const packed=gzipSync(Buffer.from(item.base64,'base64'),{level:9}).toString('base64');
    return `${JSON.stringify(platform)}:{bytes:${JSON.stringify(item.bytes)},get base64(){return gunzipSync(Buffer.from(${JSON.stringify(packed)},'base64')).toString('base64');}}`;
  });
  const nativeSource=`import {gunzipSync} from 'node:zlib';
    const bundle={version:${JSON.stringify(revision||artifacts.version)},artifacts:{${helpers.join(',')}}};
    export {bundle as STARGATE_CAMPUS_NATIVE_BUNDLE};`;
  await build({absWorkingDir:root,entryPoints:['cli.mjs'],outfile,bundle:true,
    inject:['stargate-native-bundle'],plugins:[{name:'packed-native-helpers',setup(build){
      build.onResolve({filter:/^stargate-native-bundle$/},()=>({path:'helpers',namespace:'native-bundle'}));
      build.onLoad({filter:/.*/,namespace:'native-bundle'},()=>({contents:nativeSource,loader:'js'}));
    }}],
    platform:'node',format:'esm',target:'node22.13',charset:'utf8',sourcemap:false,
    legalComments:'inline',logLevel:'silent'});
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
