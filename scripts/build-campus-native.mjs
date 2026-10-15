import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
const targets=[['linux-x64','linux','amd64'],['linux-arm64','linux','arm64'],
  ['windows-x64','windows','amd64'],['windows-arm64','windows','arm64']];

export async function buildCampusNative({root=fileURLToPath(new URL('..',import.meta.url)),
  outfile=resolve(root,'build/campus-native/embedded-artifacts.private.json'),
  go=process.env.STARGATE_GO_BINARY||'go',run=execute}={}){
  const env={...process.env,CGO_ENABLED:'0',GOTOOLCHAIN:'local',GOPROXY:'off',GOSUMDB:'off',GOWORK:'off',GOFLAGS:''};
  const manifest={artifacts:{}};
  const work=await mkdtemp(join(tmpdir(),'stargate-native-build-'));
  try{
    for(const [platform,GOOS,GOARCH] of targets){
      const binary=join(work,platform+(GOOS==='windows'?'.exe':''));
      await run(go,['build','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',binary,'.'],
        {cwd:resolve(root,'native/campus-http'),env:{...env,GOOS,GOARCH},maxBuffer:1024*1024});
      const bytes=await readFile(binary);
      manifest.artifacts[platform]={bytes:bytes.length,base64:bytes.toString('base64')};
    }
    await mkdir(dirname(outfile),{recursive:true});
    // Publish the complete four-platform input together; a failed build keeps
    // the previous usable input.
    const pending=outfile+'.tmp-'+process.pid;
    try{await writeFile(pending,JSON.stringify(manifest)+'\n');await rename(pending,outfile);}
    finally{await rm(pending,{force:true});}
    return manifest;
  }finally{await rm(work,{recursive:true,force:true});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const manifest=await buildCampusNative();
  for(const [platform,artifact] of Object.entries(manifest.artifacts))console.log(`${platform}: ${artifact.bytes} B`);
}
