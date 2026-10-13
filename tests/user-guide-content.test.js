import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const guide = readFileSync(new URL('../docs/USER_GUIDE.md', import.meta.url), 'utf8');
const datasetManual = readFileSync(new URL('../docs/DATASETS.md', import.meta.url), 'utf8');
const chapters = [
  ['首次使用', 'start'],
  ['项目开发', 'development'],
  ['提交训练', 'training'],
  ['数据集', 'data'],
  ['日志与结果', 'results'],
  ['排队与协作', 'queue'],
  ['常见问题', 'troubleshooting'],
];

test('user guide source contains no captured command diagnostics', () => {
  assert.match(guide, /^# 使用指南\r?\n/, 'The guide must begin with its user-facing title');
  assert.doesNotMatch(guide, /^(?:git:\s+(?:warning|error):|fatal:|npm (?:WARN|ERR!)\b|Traceback \(most recent call last\):)/m);
});

test('guide keeps personal model inputs and training outputs in persistent project paths',()=>{
  assert.match(guide,/个人预训练权重、tokenizer 和模型配置.*`\/workspace\/weights`/);
  for(const path of ['/workspace/models','/workspace/tokenizers','/outputs'])assert.ok(guide.includes('`'+path+'`'));
  assert.match(guide,/训练直接读取，不用每次从电脑重新上传或在服务器内部复制快照/);
  assert.match(guide,/新 checkpoint 可写共享的 `\/outputs` 或自选项目子目录/);
  assert.match(guide,/不要覆盖输入权重/);
  assert.match(guide,/是否按实验分目录由自己决定/);
});

test('data guidance separates shared read-only sources from personal writable files',()=>{
  const data=guide.split('## 数据集 {#data}\n')[1]?.split('\n## ')[0];
  assert.ok(data);
  assert.match(data,/`\/data\/hdd`：本机共享机械盘数据，只读/);
  assert.match(data,/`\/data\/ssd`：本机共享 SSD 数据，只读（配置了才有）/);
  assert.match(data,/`\/data\/mine`：本人的可写数据目录，跨任务保留/);
  assert.match(data,/同一份共享数据可被多个任务同时读取，不产生任务副本/);
  assert.match(data,/python preprocess.py --input \/data\/hdd\/imagenet --output \/data\/mine\/processed/);
  assert.match(data,/多个任务共用；自行分子目录避免覆盖/);
  assert.doesNotMatch(data,/--data-read|data prepare|--data [^\n]*@/);
});

test('historical dataset reference preserves registered-version name and permission contracts', () => {
  const section = datasetManual.split('## 数据整理约定\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'The dataset reference contains the same organization rules');
  assert.equal((section.match(/^- /gm) || []).length, 3);
  assert.match(section, /完整、可复用的集合/);
  assert.match(section, /同一集合更新时保留名称，用新的内容版本区分/);
  assert.match(section, /显示名称说明内容和用途，不只用纯数字、随机字符/);
  assert.match(section, /不要故意登记没有独立复用用途的零散临时小数据集/);
  assert.match(section, /预训练权重、tokenizer 和模型配置放个人项目/);
  assert.match(section, /新训练产物写 `\/outputs`，不登记为数据集/);
  assert.match(section, /不改变上传名称的接口规则/);
  assert.match(section, /内部数据集 ID 和完整 64 位版本哈希保持不可变/);
  assert.match(section, /不做全局重命名，也不改变读取授权/);
  assert.match(section, /训练继续使用原始 `NAME@VERSION`/);
  assert.match(datasetManual, /名称使用 1–40 位字母、数字、下划线或连字符/);
  assert.match(datasetManual, /数据集与来源编号使用 1–64 位 ASCII 字母、数字、下划线或连字符/);
});

test('user guide has the seven stable chapters used by the website', () => {
  const headings = [...guide.matchAll(/^## (.+) \{#([a-z-]+)\}$/gm)].map(match => [match[1], match[2]]);
  assert.deepEqual(headings, chapters);
  assert.equal((guide.match(/^## /gm) || []).length, chapters.length);
  const slugs = new Set(chapters.map(([, slug]) => slug));
  for (const [, slug] of guide.matchAll(/\]\(\/guide\/([^)#/]+)(?:#[^)]*)?\)/g)) {
    assert.ok(slugs.has(slug), `Unknown guide chapter: ${slug}`);
  }
});

test('guide uses the supported simple page formatting without admin manuals', () => {
  assert.equal((guide.match(/^```/gm) || []).length % 2, 0, 'Code fences must be paired');
  assert.doesNotMatch(guide, /^\s*\|.*\|\s*$/m, 'Avoid tables in the chapter renderer');
  assert.doesNotMatch(guide, /^ {2,}(?:[-*]|\d+\.)\s/m, 'Avoid nested lists');
  assert.doesNotMatch(guide, /ADMIN_README|\/guide\/admin|\]\([^)]*\.md(?:#.*?)?\)/);
  assert.doesNotMatch(guide, /gpuctl (?:ssh[^\n]*--root|host\b)|sudo python3|systemctl/);
});

test('first-time users can install and select an actual machine without joining Tail', () => {
  assert.match(guide, /Node\.js 22\.13/);
  assert.match(guide, /https:\/\/gpu\.example\.com\/install\.sh/);
  assert.match(guide, /https:\/\/gpu\.example\.com\/install\.ps1/);
  assert.match(guide, /Windows 可直接使用 PowerShell/);
  assert.match(guide, /不需要 WSL/);
  assert.match(guide, /不需要安装 Tailscale/);
  assert.match(guide, /gpuctl login[\s\S]*gpuctl state[\s\S]*gpuctl use MACHINE_ID/);
  assert.match(guide, /新账号的用卡额度为 0/);
  assert.match(guide, /机器 ID/);
  assert.doesNotMatch(guide, /\bgpu-\d+\b/, 'server arguments use the catalog ID parameter, never an example server name');
});

test('training walkthrough documents direct workspace execution and persistent GPU shells', () => {
  for (const command of ['gpuctl push .', 'gpuctl run -g 1 --interactive', 'gpuctl ssh --job JOB_ID', 'gpuctl run -g 1 --', 'gpuctl pull --job JOB_ID']) {
    assert.ok(guide.includes(command), `Missing workflow command: ${command}`);
  }
  assert.match(guide, /无需发布或关闭开发终端/);
  assert.match(guide, /默认直接使用当前工作区/);
  assert.match(guide, /断开后进程和 GPU 占用保留/);
  assert.match(guide, /输出目录自行组织/);
  assert.match(guide, /不会自动搬运代码、环境、数据或结果/);
  assert.doesNotMatch(guide, /Podman/, 'Keep engine administration out of the user guide');
});

test('run sync uploads verified files without a publication or mirror', () => {
  assert.match(guide, /gpuctl run --sync -g 1 --/);
  assert.match(guide, /--sync-dir "C:\\研究代码\\我的项目"/);
  assert.match(guide, /上传成功后直接运行工作区/);
  assert.match(guide, /不发布镜像或复制代码快照/);
  assert.match(guide, /不提交训练/);
  assert.match(guide, /不是镜像同步或删除同步/);
  assert.match(guide, /不替你安装依赖/);
});

test('terminal instructions correctly separate new sessions, detach and explicit reconnect', () => {
  assert.match(guide, /每次 `gpuctl ssh` 都会\*\*新建独立终端\*\*/);
  assert.match(guide, /gpuctl ssh --reconnect SESSION_ID/);
  assert.match(guide, /Ctrl\+\]/);
  assert.match(guide, /`exit` 结束的终端不能重连/);
  assert.match(guide, /开发终端\*\*没有 GPU\*\*/);
  assert.match(guide, /不能直接填入 VS Code Remote-SSH/);
});

test('personal file upload explicitly uses relay without changing direct transfer choices',()=>{
  assert.match(guide,/上传单文件到个人数据目录（明确使用 HTTPS 门户中转）/);
  assert.match(guide,/gpuctl data put \.\/labels.json labels.json --via relay/);
  assert.match(guide,/上传与训练独立/);
  assert.match(guide,/显式选择校园直连的上传或下载只走已确认的入口/);
  assert.match(guide,/不自动改用中转、不换新编号/);
  assert.match(guide,/`data put --via relay` 和项目 `push\/pull` 是另外的 HTTPS 门户中转操作/);
  assert.doesNotMatch(guide,/上传完成仍须准备到本次训练机器|训练缓存也须准备到/);
});

test('public guide documents processing local files without requiring cloud publication',()=>{
  assert.doesNotMatch(guide,/云盘|云端副本|阿里云|CD2|分享链接|下载链接|链接导入|HTTPS.*直链/);
  assert.doesNotMatch(guide,/gpuctl data (?:cloud|imports?)(?:\s|-|$)/m);
  assert.match(guide,/在容器内查看、处理数据或下载新数据/);
  assert.match(guide,/mkdir -p \/data\/mine\/processed/);
  assert.match(guide,/不选数据集版本，不先复制到 SSD，也不等待缓存服务/);
  assert.doesNotMatch(guide,/gpuctl data (?:shell|publish|workspace-status)\b/);
});

test('data movement is explicit and only confirmed completed copies are ready to use',()=>{
  assert.match(guide,/跨机复制与训练分开：先完成目标机的数据传输，再在目标机运行/);
  assert.match(guide,/不会因为开始训练而自动搬运数据/);
  assert.match(guide,/不会把另一台机器的目录远程挂进来/);
  assert.match(guide,/gpuctl data copy imagenet datasets\/imagenet --from SOURCE --to TARGET --source-root hdd/);
  assert.match(guide,/来源是源机的 `\/data\/hdd\/imagenet`，目标是目标机的 `\/data\/mine\/datasets\/imagenet`/);
  assert.match(guide,/只有 `SUCCEEDED` 才表示复制完成/);
  assert.match(guide,/不删除源文件或目标额外文件/);
  assert.match(guide,/节点间通道由管理员配置，不需要你提供 SSH 密钥/);
  assert.doesNotMatch(guide,/全部就绪后重新核验项目、授权和额度，才进入显卡队列/);
});

test('collaboration uses posts and chat while root requests stay retired', () => {
  assert.match(guide, /只有“帖子”和“聊天”两个入口/);
  assert.match(guide, /展开聊天里的“任务留言”/);
  assert.match(guide, /旧维护申请流程已停用/);
  assert.match(guide, /原有系统账号、原生 SSH、Tailscale 是独立入口，平台注册不授予这些权限/);
  assert.match(guide, /不改选共享环境绕过/);
});

test('new projects use OCI without a mode choice and distinguish container from host root',()=>{
  assert.match(guide,/新项目默认是个人容器/);
  assert.match(guide,/不需要选择共享、隔离等环境模式/);
  assert.match(guide,/gpuctl project create system-project`/);
  assert.doesNotMatch(guide,/gpuctl project create [^\n`]+--env-mode/);
  assert.match(guide,/容器内 root 不是服务器 root/);
  assert.doesNotMatch(guide,/宿主机 root/);
  assert.match(guide,/机器授权或容器能力尚未确认时会明确拒绝，不会换成另一种环境/);
  assert.match(guide,/先联系管理员核对/);
  assert.match(guide,/网页从「我的项目」进入个人容器/);
  assert.match(guide,/切换顶栏服务器不会搬迁当前容器、文件或开发终端/);
  assert.match(guide,/GPU 仍由调度器分配/);
  assert.match(guide,/项目终端的 `\$HOME` 是可写的 `\/home\/gpuq`/);
  assert.match(guide,/缓存、环境与容器可写层使用工作区磁盘，不是额外免费空间/);
  assert.match(guide,/个人硬限额是否开启以实际配置为准/);
  assert.match(guide,/显示“未启用”或查询失败不代表零用量或无限容量/);
});

test('personal container guidance separates no-GPU development and scheduled persistent training',()=>{
  assert.match(guide,/给项目／容器起能说明研究内容和用途的名字/);
  assert.match(guide,/同一个逻辑项目复用一个工作区，不为每次实验新建容器/);
  assert.match(guide,/实验目录、配置、代码版本和输出路径由你组织/);
  assert.match(guide,/共享的 `\/outputs` 或自选项目子目录/);
  const section=guide.split('### 个人容器\n')[1]?.split('\n### ')[0];
  assert.ok(section,'personal containers have their own concise section');
  assert.match(section,/「新建项目」.*都创建个人容器/);assert.match(section,/容器内 root 不是服务器 root/);
  assert.match(section,/多个终端与训练共用代码、环境、HOME 和输出/);assert.match(section,/不再生成训练版本/);
  assert.match(section,/修改依赖可能影响同时运行的程序/);assert.match(section,/开发终端不占卡/);
  assert.match(section,/GPU 仍由调度器分配/);assert.match(section,/申请 GPU 交互终端/);
  assert.match(guide,/输入未确认，未自动重发.*暂停输入，直到你明确重连/);
  assert.match(guide,/接管会让另一处失去输入权，已发出的命令不能撤回/);
});

test('guide explains quotas, interruption and failure evidence without promising runtime health', () => {
  assert.match(guide, /普通成员的排队、启动、运行和状态待确认任务都会计入额度/);
  assert.match(guide, /共享和独占任务均免个人累计用卡额度，无需执行 `grant --full`/);
  assert.match(guide, /单个任务仍不能超过所选机器的物理卡数，不豁免实际显存、节点授权和调度约束/);
  assert.match(guide, /资源不足时正常排队，不会因为管理员身份抢停其他训练/);
  assert.match(guide, /每人最多 10 个准备中任务、全平台 5000 条任务历史/);
  assert.match(guide, /降为普通成员后，新提交及尚未派发的任务重新受个人额度约束/);
  assert.match(guide, /不自动重跑/);
  assert.match(guide, /不保证每个 worker 都健康/);
  assert.match(guide, /gpuctl diagnostics JOB_ID --json/);
  assert.match(guide, /本次尝试的退出码是 `latestAttempt.exitCode`/);
  assert.match(guide, /`latestAttempt.startedAt` \/ `latestAttempt.finishedAt`（Unix 秒）/);
  assert.match(guide, /`workerStartedAt` \/ `workerFinishedAt` 使用 ISO 日期时间/);
  assert.match(guide, /缺值表示未确认，不猜成退出码 0 或时间 0/);
  assert.match(guide, /不会因显示提醒自动备份或清理结果/);
  assert.match(guide, /不要粘贴密码、令牌、私钥/);
});

test('local reads are independent of cache and free-space admission',()=>{
  assert.match(guide,/数据已在本机就直接读；跨机传输单独操作/);
  assert.match(guide,/读取共享数据不做剩余空间检查；写入只取决于实际目标盘/);
  assert.match(guide,/SSD 空间不足不会因为读 HDD 而触发复制或缓存准入/);
  assert.match(guide,/完全耗尽的工作盘仍可能无法写日志或创建必要的运行文件/);
  assert.match(guide,/每个名字都是本机挂载，不跨网络读取其他机器的目录/);
  assert.match(guide,/以下操作仅针对历史登记的固定数据版本/);
  assert.match(guide,/也不是新训练的前置步骤/);
  assert.doesNotMatch(guide,/仓库所在机器默认也须完成准备|上传完成仍须准备到本次训练机器/);
});

test('troubleshooting separates confirmed misunderstandings from unavailable features', () => {
  const section = guide.split('## 常见问题 {#troubleshooting}\n')[1];
  assert.ok(section);
  assert.match(section, /失败记录会保留，不代表必须重跑/);
  assert.match(section, /gpuctl completion JOB_ID --json/);
  assert.match(section, /只有 `completed:true` 且任务、项目符合预期（历史固定版本还需核对发布版本）/);
  assert.match(section, /节点能力未确认.*503/);
  assert.match(section, /不等于训练程序已经运行并失败/);
  assert.match(section, /保留原任务编号和 `Submission key`，不要另建一份训练/);
  assert.match(section, /节点配置的安全预留；这不是个人容量额度用完/);
  assert.match(section, /上传完成不等于训练完成/);
  assert.match(section, /先确认目标机器的实际路径和文件完整/);
  assert.match(section, /本机已有数据不需要准备缓存/);
  assert.match(section, /上传和跨机复制都不是独立备份/);
  assert.match(section, /已经永久取消的归档要由管理员核查/);
  assert.match(section, /要另开独立会话，选「新建终端」或运行 `gpuctl ssh`/);
  assert.match(section, /同项目可同时打开多个终端/);
  assert.match(section, /新工作区不要求先结束终端再运行/);
  assert.match(section, /gpuctl terminal status SESSION_ID/);
  assert.match(section, /`UNKNOWN` 不能当成已结束/);
  assert.doesNotMatch(section, /确认已结束才新建/);
  assert.match(section, /个人容器内 root 只管理自己的容器/);
  assert.match(section, /`--hami` 可用不代表 `--sm-percent 50` 已开通/);
  assert.match(section, /代码、环境和结果仍留在原实例/);
  assert.match(section, /旧环境不会因分组或归档自动变成个人容器/);
});

test('project manual agrees with the guide on verified upload resumption', () => {
  const projects = readFileSync(new URL('../docs/PROJECTS.md', import.meta.url), 'utf8');
  assert.match(projects, /先核对原上传 ID、路径、文件大小与 SHA-256/);
  assert.match(projects, /从服务器已确认的字节继续/);
  assert.match(projects, /旧记录缺少恢复证明或提交结果未确认时停止/);
  assert.match(projects, /不自动替换未完成上传/);
  assert.doesNotMatch(projects, /失败重跑 `push` 会重新传该文件|同路径重传替换未完成上传/);
});
