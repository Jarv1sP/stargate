import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseCLIOptions} from '../cli.mjs';
import {parseGuide} from '../guide.mjs';

const source=readFileSync(new URL('../docs/USER_GUIDE.md',import.meta.url),'utf8');
const blocks=[...source.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map(m=>m[1]);
const words=line=>(line.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)||[]).map(word=>/^['"]/.test(word)?word.slice(1,-1):word);

test('guide separates optional CLI installation and code upload from dataset publishing',()=>{
  const chapters=parseGuide(source);
  assert.match(chapters.get('start'),/仅使用网页无需安装客户端或 Node\.js/);
  assert.match(chapters.get('start'),/使用命令行时，自己的电脑需要 Node\.js 22\.13/);
  assert.match(chapters.get('development'),/不会登记或发布数据集/);
  assert.match(chapters.get('development'),/不会自动排除数据目录，不要把数据集混进代码目录/);
  assert.doesNotMatch(chapters.get('development'),/不会上传数据集/);
});

test('guide CLI examples use registered options and a single data preparation workflow',()=>{
  let parsed=0,metadata=0,transfers=0;const taskLabels=[];
  for(const block of blocks)for(const line of block.trim().split('\n')){
    if(!line.startsWith('gpuctl '))continue;
    const argv=words(line).slice(1);
    if(['profile','queue'].includes(argv[0])||argv.includes('--description'))metadata++;
    if(argv[0]==='transfer')transfers++;
    if(argv[0]==='task-label')taskLabels.push(argv);
    const result=parseCLIOptions(argv);assert.ok(result.positionals.length,line);parsed++;
    if(argv[0]==='run'){if(result.options.interactive)assert.equal(result.training.length,0);else assert.ok(result.training.length,'run needs executable argv after --: '+line);}
  }
  assert.ok(parsed>=27);assert.equal(metadata,5);assert.ok(transfers>=6);
  assert.deepEqual(taskLabels,[['task-label','get','MACHINE_ID','NODE_JOB_ID','--json'],
    ['task-label','set','MACHINE_ID','NODE_JOB_ID','--revision','HASH','--name','中文实验名','--description','本次训练说明']]);
  assert.match(source,/多人同时修改时，过期版本会被拒绝/);
  assert.match(source,/写入超时先查询同一编号，不自动重发/);
  assert.match(source,/姓名与描述（需任务信息新版）/);assert.match(source,/不要把指南更新当作功能已经上线/);
  assert.match(source,/训练缓存由 `data prepare` 管理，不需要自己在各台服务器复制长期数据/);
  assert.match(source,/目录下载需节点已提供对应能力，无法确认时会停止/);
});
test('copy blocks never silently undo the preceding upload, subscription or note creation',()=>{
  for(const block of blocks){
    assert.ok(!(block.includes('data upload ./')&&block.includes('upload-discard')));
    assert.ok(!(block.includes('notify JOB_ID on')&&block.includes('notify JOB_ID off')));
    assert.ok(!(block.includes('note --job')&&block.includes('note-delete')));
    assert.ok(!(block.includes('maintenance request')&&block.includes('maintenance withdraw')));
    assert.ok(!(block.includes('project publish')&&block.includes('gpuctl run')));
    assert.ok(!(block.includes('data prepare')&&block.includes('gpuctl run')));
  }
  assert.match(source,/仅当想放弃未完成上传/);assert.match(source,/只在想关闭通知时/);
  assert.match(source,/作者可用.*note-delete.*管理员可删除他人留言/);
});
test('guide covers merged workflow changes while keeping completion, permissions and adaptation boundaries',()=>{
  const chapters=parseGuide(source);
  for(const token of ['--rank P1','--yield never','--yield now','--yield save','--mode preempt1','--mode preempt2','--restart-policy on-preempt'])assert.ok(chapters.get('queue').includes(token),token);
  assert.match(chapters.get('training'),/P2、`yield=never`、`mode=queue`/);
  assert.match(chapters.get('training'),/1、2、4、8/);assert.match(chapters.get('training'),/空闲 3 张时启动 2 张/);
  assert.match(chapters.get('training'),/不支持弹性、自动让位、自动恢复或主动抢占/);
  assert.match(chapters.get('results'),/Ctrl\+C 只停止查看/);assert.match(chapters.get('results'),/管理员为你的账号配置 Telegram/);
  for(const token of ['sync git','sync code','data prepare','CODE_READY','check-attr --source','缺少系统依赖','旧维护申请流程已停用'])assert.ok(chapters.get('troubleshooting').includes(token),token);
  assert.match(chapters.get('queue'),/退出码 75/);assert.match(chapters.get('troubleshooting'),/不能提交脚本申请 root/);
  assert.doesNotMatch(source,/gpuctl maintenance (?:request|approve|withdraw)/);
  assert.match(chapters.get('data'),/已经开始的服务器校验会继续/);assert.match(chapters.get('data'),/没有整份已发布数据集的一键下载入口/);
  assert.doesNotMatch(chapters.get('data'),/云盘|云端副本|分享链接|链接导入|data (?:cloud|import)/);
  assert.match(chapters.get('data'),/gpuctl data upload \.\/my-data --name my-data --via direct/);
  assert.match(chapters.get('data'),/gpuctl transfer upload \.\/my-data --name my-data --via direct/);
  assert.match(chapters.get('data'),/入口不可达时停止，不改走中转/);
  for(const token of ['transfer upload','transfer download','transfer cancel','WAITING_CLIENT'])assert.ok(chapters.get('data').includes(token),token);
  assert.match(chapters.get('data'),/目录下载需节点已提供对应能力，无法确认时会停止/);assert.match(chapters.get('data'),/终止后不可恢复/);
  assert.match(chapters.get('data'),/管理员启用节点间私网传输后/);
  assert.match(chapters.get('data'),/服务器间准备在 LAN 后台执行，不占 GPU，关电脑仍继续/);
  assert.doesNotMatch(source,/gpuctl (?:transfer copy|sync data|data shell|data publish)\b/);
  assert.doesNotMatch(source,/没有后台 URL 下载按钮|不提供后台 URL 下载队列/);
});

test('CLI-first path binds login, fixed releases and original upload recovery',()=>{
  const chapters=parseGuide(source);
  const login=blocks.flatMap(block=>block.split('\n')).find(line=>line.startsWith('gpuctl login '));
  const parsedLogin=parseCLIOptions(words(login).slice(1));
  assert.deepEqual(parsedLogin.positionals,['login','USERNAME']);
  assert.equal(parsedLogin.options.url,'https://gpu.example.com');
  assert.match(chapters.get('start'),/Windows 与 WSL 分别安装、分别登录/);
  const firstRun=chapters.get('training').match(/^gpuctl run .+$/m)?.[0];
  assert.equal(parseCLIOptions(words(firstRun).slice(1)).options.release,undefined);
  const data=chapters.get('data');
  assert.match(data,/现役 CLI 接收本机目录；压缩包先在本机解压/);
  assert.ok(data.indexOf('Expand-Archive')<data.indexOf('gpuctl data upload ./my-data'));
  assert.match(data,/gpuctl data upload-status UPLOAD_ID --machine MACHINE_ID/);
  assert.match(data,/同一目录、原机器选择和名称，重复原命令可续传/);
  assert.doesNotMatch(data,/gpuctl data upload [^\n]*\.(?:zip|tar|tgz)(?:\s|$)/);
  assert.match(chapters.get('results'),/gpuctl completion JOB_ID --json[\s\S]*gpuctl use MACHINE_ID\ngpuctl project use my-project\ngpuctl files --job JOB_ID/);
});
