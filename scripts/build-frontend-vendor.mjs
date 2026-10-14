import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const vendorFiles=[
  ['@xterm/xterm','lib/xterm.js','xterm.js'],
  ['@xterm/xterm','css/xterm.css','xterm.css'],
  ['@xterm/addon-fit','lib/addon-fit.js','addon-fit.js'],
  ['@xterm/xterm','LICENSE','XTERM-LICENSE'],
  ['@xterm/addon-fit','LICENSE','ADDON-FIT-LICENSE'],
];
export async function buildFrontendVendor({root=fileURLToPath(new URL('..',import.meta.url))}={}){
  const files=[];
  for(const [pkg,source,target] of vendorFiles){
    const bytes=await readFile(resolve(root,'node_modules',pkg,source));
    files.push({target,bytes});
  }
  // Validate the complete set before replacing any previously built asset.
  await mkdir(resolve(root,'dist/vendor'),{recursive:true});
  for(const {target,bytes} of files)await writeFile(resolve(root,'dist/vendor',target),bytes);
  return files.map(({target,bytes})=>({target,bytes:bytes.length}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildFrontendVendor()));
