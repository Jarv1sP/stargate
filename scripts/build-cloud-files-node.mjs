import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const entry=fileURLToPath(new URL('../node/cloud-files-worker.mjs',import.meta.url));
const result=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',target:'node24',format:'esm',legalComments:'eof',
  banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
process.stdout.write(result.outputFiles[0].contents);
