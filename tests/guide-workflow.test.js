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

test('guide CLI examples use registered options and independent data operations',()=>{
  let parsed=0,metadata=0;const taskLabels=[],dataCommands=[];
  for(const block of blocks)for(const line of block.trim().split('\n')){
    if(!line.startsWith('gpuctl '))continue;
    const argv=words(line).slice(1);
    if(['profile','queue'].includes(argv[0])||argv.includes('--description'))metadata++;
    if(argv[0]==='data')dataCommands.push(argv[1]);
    if(argv[0]==='task-label')taskLabels.push(argv);
    const result=parseCLIOptions(argv);assert.ok(result.positionals.length,line);parsed++;
    if(argv[0]==='run'){if(result.options.interactive)assert.equal(result.training.length,0);else assert.ok(result.training.length,'run needs executable argv after --: '+line);}
  }
  assert.ok(parsed>=27);assert.equal(metadata,5);
  assert.deepEqual(dataCommands,['put','copy','copy-status','copy-resume']);
  assert.deepEqual(taskLabels,[['task-label','get','MACHINE_ID','NODE_JOB_ID','--json'],
    ['task-label','set','MACHINE_ID','NODE_JOB_ID','--revision','HASH','--name','中文实验名','--description','本次训练说明']]);
  assert.match(source,/多人同时修改时，过期版本会被拒绝/);
  assert.match(source,/写入超时先查询同一编号，不自动重发/);
  assert.match(source,/姓名与描述（需任务信息新版）/);assert.match(source,/不要把指南更新当作功能已经上线/);
  assert.match(source,/训练不创建数据准备任务/);
  assert.match(source,/目录逐文件读取，不创建归档或服务器副本/);
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
  assert.match(source,/`copy-cancel` 停止原传输并保留断点，之后仍可 `copy-resume`/);
  assert.match(source,/只在想关闭通知时/);
  assert.match(source,/作者可用.*note-delete.*管理员可删除他人留言/);
});
test('guide covers merged workflow changes while keeping completion, permissions and adaptation boundaries',()=>{
  const chapters=parseGuide(source);
  for(const token of ['--rank P1','--yield never','--yield now','--yield save','--mode preempt1','--mode preempt2','--restart-policy on-preempt'])assert.ok(chapters.get('queue').includes(token),token);
  assert.match(chapters.get('training'),/P2、`yield=never`、`mode=queue`/);
  assert.match(chapters.get('training'),/1、2、4、8/);assert.match(chapters.get('training'),/空闲 3 张时启动 2 张/);
  assert.match(chapters.get('training'),/不支持弹性、自动让位、自动恢复或主动抢占/);
  assert.match(chapters.get('results'),/Ctrl\+C 只停止查看/);assert.match(chapters.get('results'),/管理员为你的账号配置 Telegram/);
  for(const token of ['sync git','sync code','data copy','CODE_READY','check-attr --source','缺少系统依赖','旧维护申请流程已停用'])assert.ok(chapters.get('troubleshooting').includes(token),token);
  assert.match(chapters.get('queue'),/退出码 75/);assert.match(chapters.get('troubleshooting'),/不能提交脚本申请 root/);
  assert.doesNotMatch(source,/gpuctl maintenance (?:request|approve|withdraw)/);
  assert.match(chapters.get('data'),/任务在服务器后台运行，关闭客户端不停止复制/);
  assert.doesNotMatch(chapters.get('data'),/云盘|云端副本|分享链接|链接导入|data (?:cloud|import)/);
  assert.match(chapters.get('data'),/gpuctl data put \.\/labels.json labels.json --via relay/);
  for(const token of ['data copy','data copy-status','data copy-resume','copy-cancel'])assert.ok(chapters.get('data').includes(token),token);
  assert.match(chapters.get('data'),/节点间通道由管理员配置，不需要你提供 SSH 密钥/);
  assert.match(chapters.get('troubleshooting'),/显式选择校园直连[\s\S]*不自动改用中转、不换新编号/);
  assert.doesNotMatch(chapters.get('data'),/data prepare|--data-read|--data [^\n]*@/);
  assert.doesNotMatch(source,/gpuctl (?:transfer copy|sync data|data shell|data publish)\b/);
  assert.doesNotMatch(source,/没有后台 URL 下载按钮|不提供后台 URL 下载队列/);
});

test('CLI-first path binds login, live workspace and original transfer recovery',()=>{
  const chapters=parseGuide(source);
  const login=blocks.flatMap(block=>block.split('\n')).find(line=>line.startsWith('gpuctl login '));
  const parsedLogin=parseCLIOptions(words(login).slice(1));
  assert.deepEqual(parsedLogin.positionals,['login','USERNAME']);
  assert.equal(parsedLogin.options.url,'https://gpu.example.com');
  assert.match(chapters.get('start'),/Windows 与 WSL 分别安装、分别登录/);
  const firstRun=chapters.get('training').match(/^gpuctl run .+$/m)?.[0];
  assert.equal(parseCLIOptions(words(firstRun).slice(1)).options.release,undefined);
  const data=chapters.get('data');
  assert.match(data,/不选数据集版本，不先复制到 SSD，也不等待缓存服务/);
  assert.match(data,/gpuctl data copy-status COPY_KEY --machine TARGET/);
  assert.match(data,/gpuctl data copy-resume COPY_KEY --machine TARGET/);
  assert.match(data,/中断后沿原编号续传；不换编号、不重新上传/);
  assert.match(chapters.get('training'),/只在已有同名工作区的候选服务器中选卡，不复制工作区或数据/);
  assert.match(chapters.get('results'),/保留原目标及 `\.gpuctl-directory\.json`、`\*\.gpuctl-download\.json` 回执/);
  assert.match(chapters.get('results'),/gpuctl completion JOB_ID --json[\s\S]*gpuctl use MACHINE_ID\ngpuctl project use my-project\ngpuctl files --job JOB_ID/);
});
