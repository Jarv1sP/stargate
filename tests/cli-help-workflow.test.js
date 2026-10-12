import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cliHelp} from '../cli-help.mjs';

const cli=fileURLToPath(new URL('../cli.mjs',import.meta.url));
const offline=args=>spawnSync(process.execPath,[cli,'--url','http://127.0.0.1:1','--session-file','/fixture-no-credentials/session.json',...args],{encoding:'utf8',timeout:5000});

test('default help exposes one personal-project and warehouse-first workflow',()=>{
  const text=cliHelp();
  for(const command of ['gpuctl login','gpuctl project create my-project','gpuctl push .','gpuctl ssh','gpuctl run -g 1 --interactive','gpuctl ssh --job JOB_ID','gpuctl project status','gpuctl run -g 1','gpuctl watch JOB','gpuctl diagnostics JOB','gpuctl pull --job JOB_ID','gpuctl data upload FILE.tar.gz --name NAME --via direct','gpuctl data prepare NAME@VERSION'])assert.ok(text.includes(command),command);
  assert.doesNotMatch(text,/gpuctl project publish|上传、发布/);
  assert.ok(text.indexOf('data upload FILE.tar.gz')<text.indexOf('data prepare NAME@VERSION'));
  assert.match(text,/确认对应版本 READY/);assert.match(text,/当前服务回包/);
  assert.doesNotMatch(text,/--env-mode|--legacy|--via relay|data (?:cloud|import|put|shell|publish|unregister)|--hami|--sm-percent|Slurm|SSH 密钥|VS Code Remote/);
  assert.match(text,/用户不需要 Tail 或节点密钥/);
  assert.ok(text.split('\n').length<65,'Daily discovery stays short');
});

test('daily, admin and community help are offline and never require an account',()=>{
  for(const args of [['--help'],['help'],['help','daily'],['help','admin'],['help','community']]){
    const result=offline(args);assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');assert.match(result.stdout,/STARGATE/);
  }
  const admin=offline(['help','admin']);assert.match(admin.stdout,/ssh --root/);assert.match(admin.stdout,/data unregister NAME\[@VERSION\]/);assert.match(admin.stdout,/帮助文本不授予权限/);
  const community=offline(['help','community']);assert.match(community.stdout,/post/);
});

test('unknown or malformed help topics fail locally without contacting the portal',()=>{
  for(const args of [['help','cloud'],['help','admin','extra'],['help','admin','--','dangerous-command']]){
    const result=offline(args);assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/Usage: gpuctl help/);assert.doesNotMatch(result.stderr,/fetch failed|Login|ENOENT/);
  }
});

test('guide uses deployment evidence instead of promising merged protocol support',async()=>{
  const {readFile}=await import('node:fs/promises');
  const guide=await readFile(new URL('../docs/USER_GUIDE.md',import.meta.url),'utf8');
  assert.match(guide,/指南描述操作方法，不是功能开通清单/);
  assert.match(guide,/文件读取回包确认 `protocol:2`/);
  assert.match(guide,/不能仅凭客户端已更新或源码已合并判断可用/);
  assert.match(guide,/节点必须确认用途受限的校园 HTTPS 文件票据/);
  assert.match(guide,/能力缺失或无法连接时暂停，不转 VPS\/Tail/);
  assert.doesNotMatch(guide,/project create my-container/,'Avoid a second competing first-use walkthrough');
});
