import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cliHelp} from '../cli-help.mjs';

const cli=fileURLToPath(new URL('../cli.mjs',import.meta.url));
const offline=args=>spawnSync(process.execPath,[cli,'--url','http://127.0.0.1:1','--session-file','/fixture-no-credentials/session.json',...args],{encoding:'utf8',timeout:5000});

test('default help exposes persistent projects and direct local-data training',()=>{
  const text=cliHelp();
  for(const command of ['gpuctl login','gpuctl project create my-project','gpuctl push .','gpuctl ssh','gpuctl run -g 1 --interactive','gpuctl ssh --job JOB_ID','gpuctl project status','gpuctl run -g 1','gpuctl watch JOB','gpuctl diagnostics JOB','gpuctl pull --job JOB_ID','gpuctl data put LOCAL_FILE folder/file --via relay','gpuctl data copy SOURCE_DIR DEST_DIR'])assert.ok(text.includes(command),command);
  assert.doesNotMatch(text,/gpuctl project publish|上传、发布/);
  assert.match(text,/不需要入库、数据发布或缓存准备/);
  assert.match(text,/跨机传输是独立操作，训练不会自动复制数据/);
  assert.match(text,/原命令结果不明确时先查询，不重复启动/);
  assert.doesNotMatch(text,/--env-mode|--legacy|--data-read|data (?:cloud|import|prepare|shell|publish|unregister)|--hami|--sm-percent|Slurm|SSH 密钥|VS Code Remote/);
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
  assert.match(guide,/只有当前门户与节点确认支持的入口才可使用/);
  assert.match(guide,/不能仅凭客户端已更新或源码已合并判断可用/);
  assert.match(guide,/能力未确认时不改走旧工作区、其他存储盘或中转路线/);
  assert.match(guide,/显式选择校园直连的上传或下载只走已确认的入口/);
  assert.match(guide,/不自动改用中转、不换新编号/);
  assert.match(guide,/保留原任务编号和 `Submission key`，不要另建一份训练/);
  assert.doesNotMatch(guide,/project create my-container/,'Avoid a second competing first-use walkthrough');
});
