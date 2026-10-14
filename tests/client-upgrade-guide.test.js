import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseGuide,guidePage,chapters} from '../guide.mjs';
test('guide pins official launchers and checks actual executing file against official decoded SHA',async()=>{
 const text=await readFile(new URL('../docs/USER_GUIDE.md',import.meta.url),'utf8');assert.equal(parseGuide(text).size,7);
 for(const value of ['研究工具包装器','exec "$HOME/.local/bin/gpuctl" "$@"','GPUQConsole\\bin\\gpuctl.cmd','client-info --json','sha256sum','Get-FileHash','ETag','exit $LASTEXITCODE','包装器由其维护者修改'])assert.ok(text.includes(value),value);
 assert.doesNotMatch(text,/\/data1\/cyx|0e0bdcdb/);const html=await guidePage(chapters[0],'https://portal.example');assert.match(html,/研究工具包装器/);assert.match(html,/https:\/\/portal.example\/gpuctl.mjs/);assert.doesNotMatch(html,/https:\/\/gpu.example.com/);
});
