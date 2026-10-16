#!/usr/bin/env node
// The editable external command entry is retained. Shared client behavior is
// imported from its source once, so recovery/subtraction fixes are not shadowed
// by a second inlined implementation.
import {dataPath} from './client-file-path.mjs';
import {uploadTransfer,downloadTransfer,transferText,uploadLocalFile,uploadLocalTree} from './client-transfers.mjs';
import {runCloudImport} from './client-cloud-import.mjs';
import {runCloudFiles} from './client-cloud-files.mjs';
import {runCommunityCommand,formatCommunityResult,communityJSON,showCLIAnnouncements,communityHelp} from './community-cli.mjs';
import {watchJob} from './job-watch.mjs';
import {progressText,jobTimingText} from './dist/job-progress.js';
import {elasticAllocation,allocationLabel,gpuPlacement} from './dist/gpu-allocation.js';
import {displayName,taskDescription} from './dist/task-metadata.js';
import {apiPost} from './client-http.mjs';
import {readCLIState,submitJobWithReceipt} from './client-state.mjs';
import {defaultPlatformControlTransport,finishPlatformControlTransport} from './client-windows-control.mjs';
import {downloadResultFile} from './client-result-download.mjs';
import {directoryDownloadStatus} from './client-directory-download.mjs';
import { readFile as readFile2, mkdir as mkdir4, writeFile as writeFile2, chmod, unlink as unlink3, lstat as lstat5 } from "node:fs/promises";
import { dirname as dirname2, join as join5, basename as basename2 } from "node:path";
import { randomUUID as randomUUID7 } from "node:crypto";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";


var daily = `STARGATE — 团队项目、数据集与训练

gpuctl login [USERNAME] / register USERNAME / logout
gpuctl state / use MACHINE_ID / jobs / queue

gpuctl project create NAME [--repo GIT_URL]
gpuctl project list / use NAME / status / quota
gpuctl project copy NAME --from SOURCE --to TARGET [--name NEW_NAME] [--key UUID] [--detach]
gpuctl project label NAME --display-name TEXT
gpuctl project catalog / group UUID --display-name TEXT --members SERVER/PROJECT,...
gpuctl project archive NAME / unarchive NAME / delete NAME
gpuctl project trash list
gpuctl project trash restore|purge KEY --kind project|dataset|output

gpuctl push LOCAL_FILE_OR_DIR [REMOTE_PATH] [--key UUID]
gpuctl push-status LOCAL_FILE_OR_DIR [REMOTE_PATH] --key UUID
gpuctl files [PATH] / pull REMOTE_PATH LOCAL_PATH [--job JOB_ID]
gpuctl pull-status LOCAL_DIRECTORY
数据集只走校园直连，不支持 --via relay/portal；项目文件和任务输出默认直连，失败改经 VPS 继续。
项目和输出可用 --via relay（上传）/portal（下载）直接走 VPS，或 --via direct 固定直连；续传沿用原 --key。

gpuctl ssh [--reconnect SESSION_ID] [--takeover]
gpuctl run -g 1 [--rank P0..P4] -- python train.py --data /datasets/images --output /outputs （P4 最优先，P0 最低）
gpuctl run --sync [--sync-dir LOCAL_DIR] -g 1 -- python train.py
--sync 与 AUTO 同用时，只在本次上传的工作区服务器运行。
gpuctl run --machine auto [--candidates SERVER,SERVER] -g 1 -- python train.py
gpuctl run -g 1 --interactive / ssh --job JOB_ID
gpuctl run --gpu 0 -g 1 --memory-limit-gib 60 -- python train.py
工作区 /workspace，数据集 /datasets；任务输出 /outputs。
未选项目使用默认 OCI 容器。Ctrl+] 只断开终端；exit 结束，GPU 终端结束后释放卡。
gpuctl logs JOB / watch JOB / diagnostics JOB / cancel JOB
gpuctl priority JOB P0|P1|P2|P3|P4 （P4 最优先，P0 最低） / completion JOB / reconcile-resources JOB
gpuctl note TEXT --job JOB / notes / notify JOB on|off|status
gpuctl files rm PATH --job JOB [--recursive] / outputs delete --job JOB

gpuctl data list / files DATASET [PATH]
gpuctl data upload LOCAL_DIR --name DATASET [--key UUID]
gpuctl data put LOCAL_FILE DATASET [REMOTE_FILE] [--key UUID]
gpuctl data download DATASET LOCAL_DIR [--key UUID]
gpuctl data get DATASET REMOTE_FILE LOCAL_FILE
gpuctl data delete DATASET [--key UUID]
gpuctl transfer copy DATASET --from SOURCE --to TARGET [--name DATASET]
gpuctl transfer list / status|watch|cancel|resume ID
gpuctl data import HTTPS_LINK REMOTE_FILE --dataset NAME
也可 --project NAME 导入到 /workspace；阿里分享可加 --file-id。
gpuctl data imports / import-status|import-resume|import-cancel|import-discard ID
gpuctl data cloud list / download FILE_ID REMOTE_PATH --dataset NAME
gpuctl data cloud upload REMOTE_PATH --dataset NAME|--project NAME [--key UUID]
删除后 7 天内所有成员均可从 project trash 恢复，可能影响正在运行的任务。

gpuctl help admin / help community / profile --display-name NAME
全局：--machine SERVER --project NAME --owner USERNAME --url HTTPS_ORIGIN --json --session-file PATH
--owner 选择别人的同名项目，不指定默认自己；列表显示所有人。
密码交互隐藏输入；脚本使用 --password-stdin。完整帮助：平台 /guide。`;
var admin = `STARGATE — 管理员

gpuctl users / user add|enable|disable|delete USERNAME
gpuctl user reset-password USERNAME / user role USERNAME admin|member
gpuctl invites list / rotate member
gpuctl grant USERNAME --machine SERVER=2 --total 2
gpuctl maintenance status / on all|SERVER --reason TEXT / off all|SERVER
gpuctl project trash purge KEY --kind project|dataset|output
清空回收站不可恢复，只允许管理员；团队项目、任务与数据供所有登录成员协作。`;
function cliHelp(topic = "daily") {
  if (topic === "daily") return daily;
  if (topic === "admin") return admin;
  if (topic === "community") return `STARGATE / GPUQ — 协作

${communityHelp}`;
  throw Error("Usage: gpuctl help [daily|admin|community]");
}


// cli.mjs
var maintenanceVisible = (value, multiline = false) => String(value ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => multiline && c === "\n" ? c : "\\u{" + c.codePointAt(0).toString(16).padStart(4, "0") + "}");
var maintenanceJSON = (value) => JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => c.split("").map((unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0")).join(""));
var terminalErrorMetadata = (error2) => ({
  ...Number.isInteger(error2.status) && error2.status >= 100 && error2.status <= 599 ? { status: error2.status } : {},
  ...typeof error2.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error2.code) ? { code: error2.code } : {}
});
var terminalMetadata = (value, key = "") => typeof value === "string" ? maintenanceVisible(value, ["description", "body"].includes(key)) : Array.isArray(value) ? value.map((item) => terminalMetadata(item, key)) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, item]) => [maintenanceVisible(name), terminalMetadata(item, name)])) : value;
var args = process.argv.slice(2);
var options;
var positionals;
var training;
var wantsJSON = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length).includes("--json");
function fail9(message) {
  throw Error(message);
}
var CLI_OPTIONS = new Map([
  ...['overwrite','json','password-stdin','credentials-stdin','help','full','detach','takeover','general','checkpointable','auto-expand','dry-run','share','hami','recursive','interactive','pin','sync'].map(key=>[key,'flag']),
  ...['url','session-file','total','cards','role','name','description','display-name','min-vram','key','project','job','priority','timeout','reconnect','rank','yield','restart-policy','mode','min-cards','global-batch','micro-batch','interval','from','to','gpu','vram-mib','sm-percent','reason','revision','cursor','limit','members','primary','owner','via','memory-limit-gib','repo','dataset','kind','status','title','body','body-file','announcement-type','layout','background','text-color','accent','file-id','password-code','source-url','sync-dir','candidates'].map(key=>[key,'value']),
  ['machine','machines']
]);
function parseCLIOptions(argv) {
  const options2 = { machines: [] }, positionals2 = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") return { options: options2, positionals: positionals2, training: argv.slice(i + 1) };
    const item = argv[i] === "-g" ? "--cards" : argv[i] === "--on" ? "--machine" : argv[i];
    if (!item.startsWith("--")) {
      positionals2.push(item);
      continue;
    }
    const key = item.slice(2), kind = CLI_OPTIONS.get(key);
    if (!kind) fail9(`Unknown option: ${item}`);
    if (Object.hasOwn(options2, key)) fail9(`Duplicate option: ${item}`);
    if (kind === "flag") {
      options2[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === void 0 || value === "" && key !== "description" || value.startsWith("--")) fail9(`Missing value: ${item}`);
    if (kind === "value") options2[key] = value;
    else options2[kind].push(value);
  }
  return { options: options2, positionals: positionals2, training: [] };
}
async function uploadCodeFiles(call,{machine,context,local,remote='.',inspectOnly=false,key,progress=message=>process.stderr.write(message),stateDirectory,via}){
  return uploadLocalTree(call,{machine,context:{area:'code',...context},local,remote,key,inspectOnly,stateDirectory,via,exclude:name=>['.git','.ssh','.aws','.azure','.venv','venv','node_modules','__pycache__','id_rsa','id_ed25519','.env'].includes(name)||name.startsWith('.env.')&&name!=='.env.example',progress:row=>progress(`${row.path||''} · ${row.offset??'?'} / ${row.totalSize??'?'} · ${row.key}\n`)});
}
async function secret(label = "Password") {
  if (options["password-stdin"]) {
    let value = "";
    for await (const chunk of process.stdin) {
      value += chunk;
      if (value.length > 1024) fail9("Password input too long");
    }
    return value.replace(/\r?\n$/, "");
  }
  if (!process.stdin.isTTY) fail9("Use --password-stdin for non-interactive password input.");
  process.stderr.write(`${label}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve5, reject) => {
    let value = "";
    const finish = (error2) => {
      process.stdin.off("data", listener);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      error2 ? reject(error2) : resolve5(value);
    };
    const listener = (chunk) => {
      for (const char of chunk.toString()) {
        if (char === "") return finish(Error("Cancelled"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
        if (value.length > 128) return finish(Error("Password too long"));
      }
    };
    process.stdin.on("data", listener);
  });
}
async function main() {
  ({ options, positionals, training } = parseCLIOptions(args));
  const ownerUsername=options.owner;
  if(ownerUsername!==undefined&&!['project','files','outputs','pull','push','upload','upload-status','push-status','run','ssh','shell','data','terminal','jobs','queue'].includes(positionals[0]))fail9('--owner 用于项目、文件、数据、终端或任务命令。');
  delete options.owner;
  if (positionals[0] === "pull-status") {
    if (positionals.length !== 2 || training.length || options.machines.length || Object.keys(options).some(k => !["machines","json","url","session-file"].includes(k))) fail9("Usage: gpuctl pull-status LOCAL_DIRECTORY [--json]");
    const result=await directoryDownloadStatus(positionals[1]);
    if(options.json)console.log(maintenanceJSON({ok:true,data:result}));else console.log(JSON.stringify(result,null,2));
    return;
  }
  if (positionals[0] === "help") {
    if (positionals.length > 2 || training.length) fail9("Usage: gpuctl help [daily|admin|community]");
    console.log(cliHelp(positionals[1]));
    return;
  }
  if (options.help || !positionals.length) {
    console.log(cliHelp());
    return;
  }
  if(positionals[0]!=='run'&&options.machines.includes('auto'))fail9('自动选机仅用于 run。');
  if(options.sync&&positionals[0]!=='run'||options['sync-dir']!==undefined&&!options.sync)fail9('--sync 仅用于 run；--sync-dir 配合 run --sync。');
  const transferCopy=positionals[0]==='transfer'&&positionals[1]==='copy';
  const outputDelete=positionals[0]==='files'&&positionals[1]==='rm'||positionals[0]==='outputs'&&positionals[1]==='delete';
  if(outputDelete&&(!options.job||positionals.length!==(positionals[0]==='files'?3:2)))fail9('Usage: files rm PATH --job JOB [--recursive] | outputs delete --job JOB');
  if(outputDelete){if(positionals[0]==='files')dataPath(positionals[2]);if(options.project!==undefined)fail9('输出使用 --job 定位，请勿同时指定 --project。');}
  if(options.limit!==undefined&&(!Number.isSafeInteger(Number(options.limit))||Number(options.limit)<1||Number(options.limit)>1000))fail9('--limit 使用 1–1000 的整数。');
  if(options.key!==undefined&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.key))fail9('--key 必须为原操作的完整 UUID。');
  if(options.repo!==undefined&&!(positionals[0]==='project'&&positionals[1]==='create'))fail9('--repo 仅用于 project create。');
  if(options.via!==undefined&&!['auto','direct','relay','portal'].includes(options.via))fail9('--via 使用 direct、relay 或 portal。');
  if(positionals[0]==='data'&&['put','get','upload','download'].includes(positionals[1])&&options.via!==undefined&&!['auto','direct'].includes(options.via))fail9('数据集只走校园网直连，不支持 --via relay/portal。');
  const customScheduling = ["rank", "yield", "restart-policy", "checkpointable", "mode"].some((k) => Object.hasOwn(options, k));
  if (customScheduling && (positionals[0] !== "run" || options.priority)) fail9("Custom scheduling is only valid for run and cannot mix with --priority presets");
  const scheduling = customScheduling ? { rank: options.rank || "P2", yieldPolicy: options.yield || "never", restartPolicy: options["restart-policy"] || "never", checkpointable: options.checkpointable === true } : null;
  if (options.mode) {
    const modes = { queue: "queue", preempt1: "preempt-save", preempt2: "preempt-now", "preempt-save": "preempt-save", "preempt-now": "preempt-now" };
    if (!Object.hasOwn(modes, options.mode)) fail9("Use --mode queue|preempt1|preempt2");
    if (modes[options.mode] !== "queue") scheduling.mode = modes[options.mode];
  }
  const elasticKeys = ["min-cards", "global-batch", "micro-batch", "auto-expand"];
  const placementKeys = ["gpu", "share", "vram-mib", "hami", "sm-percent"];
  if (placementKeys.some((k) => Object.hasOwn(options, k)) && positionals[0] !== "run") fail9("Placement options are only valid for run");
  if (elasticKeys.some((k) => Object.hasOwn(options, k)) && positionals[0] !== "run") fail9("Elastic GPU options are only valid for run");
  if (scheduling) {
    if (!/^P[0-4]$/.test(scheduling.rank) || !["never", "now", "save"].includes(scheduling.yieldPolicy) || !["never", "on-preempt"].includes(scheduling.restartPolicy)) fail9("Use --rank P0..P4, --yield never|now|save, --restart-policy never|on-preempt");
    if (scheduling.yieldPolicy === "save" && !scheduling.checkpointable) fail9("--yield save requires --checkpointable and an epoch checkpoint adapter");
    if (scheduling.restartPolicy === "on-preempt" && (scheduling.yieldPolicy !== "save" || !scheduling.checkpointable)) fail9("Automatic resume requires --yield save --checkpointable");
  }
  const memoryLimitGiB = options["memory-limit-gib"] === void 0 ? void 0 : Number(options["memory-limit-gib"]);
  if (memoryLimitGiB !== void 0 && (positionals[0] !== "run" || !Number.isSafeInteger(memoryLimitGiB) || memoryLimitGiB < 1 || memoryLimitGiB > 1048576)) fail9("--memory-limit-gib 仅用于 run，须为正整数 GiB");
  const projectSlug = (value) => {
    if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,47}$/.test(value)) fail9("Project must start with a lowercase letter and use 1–48 lowercase letters, digits, _ or -");
    return value;
  };
  if (options.project) projectSlug(options.project);
  if (options.job && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.job)) fail9("Use --job JOB_UUID from gpuctl jobs");
  const explicitSession = options["session-file"] || process.env.GPUQ_SESSION_FILE;
  let sessionFile = explicitSession || join5(homedir(), ".config", "gpuq-console", "session.json");
  let session;
  try {
    session = JSON.parse(await readFile2(sessionFile, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") fail9("Unable to read session cache.");
  }
  const bundled = "__GPUQ_PUBLIC_ORIGIN__";
  const target = options.url || process.env.GPUQ_URL || (bundled.startsWith("https://") ? bundled : session?.url);
  if (!target) fail9("首次运行源码客户端请指定 --url https://你的服务域名，或从门户安装客户端。");
  const base = new URL(target);
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash) fail9("Use a base URL without credentials, path or query.");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && base.hostname === "127.0.0.1")) fail9("Remote APIs require HTTPS.");
  if (session && session.url !== base.origin) session = void 0;
  const controlTransport = await defaultPlatformControlTransport(base);
  try {
  async function post(path, body2, requestSignal) {
    return apiPost(base, path, body2, { token: session?.token, signal: requestSignal, fetchImpl:controlTransport.fetchImpl });
  }
  let targetOwnerId;
  const call = (operation, args2 = {}, signal) => post("call", { operation, args: {...(targetOwnerId&&/^(projects\.|files\.|data\.|datasets\.|cloud\.|terminal\.|jobs\.submit$)/.test(operation)?{ownerId:targetOwnerId}:{}),...args2} }, signal);
  let command = positionals[0];
  let result, mode = { demo: true, gpuqConnected: false };
  if (command === "register") {
    if (positionals.length !== 2) fail9("Usage: register USERNAME");
    if (options["password-stdin"]) fail9("Use --credentials-stdin with JSON {invite,password} for registration.");
    let credentials;
    if (options["credentials-stdin"]) {
      let value = "";
      for await (const chunk of process.stdin) {
        value += chunk;
        if (value.length > 1024) fail9("Registration input too long");
      }
      try {
        credentials = JSON.parse(value);
      } catch {
        fail9("Expected JSON {invite,password} on stdin");
      }
      if (!credentials || typeof credentials !== "object" || Array.isArray(credentials) || Object.keys(credentials).some((key) => !["invite", "password"].includes(key))) fail9("Expected only invite and password");
    } else credentials = { invite: await secret("Invite code"), password: await secret() };
    result = await post("register", { username: positionals[1], ...credentials, ...options["display-name"] ? { name: displayName(options["display-name"]) } : {} });
    mode = { demo: false, gpuqConnected: false };
  } else if (command === "login") {
    if (positionals.length === 1 && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      positionals.push(await rl.question("用户名: "));
      rl.close();
    }
    if (positionals.length !== 2) fail9("Usage: login USERNAME");
    const login = await post("login", { username: positionals[1], password: await secret() });
    mode = { demo: login.state.demo, gpuqConnected: login.state.gpuqConnected === true };
    await mkdir4(dirname2(sessionFile), { recursive: true, mode: 448 });
    const previous = session?.principal?.userId === login.principal.userId ? session : null;
    await writeFile2(sessionFile, JSON.stringify({ url: base.origin, token: login.token, principal: login.principal, ...previous?.machine ? { machine: previous.machine } : {}, ...previous?.projectsByMachine ? { projectsByMachine: previous.projectsByMachine } : {} }), { mode: 384 });
    await chmod(sessionFile, 384);
    result = { loggedIn: true, principal: login.principal };
  } else {
    if (!session) fail9("请先登录：gpuctl login");
    const pulling=['pull','download'].includes(command);
    const state = pulling&&options.job?(await call('state',{view:'summary',jobId:options.job})).state
      :ownerUsername!==undefined||options.job&&!outputDelete?(await call('state',pulling?{view:'summary'}:{})).state:outputDelete?{machines:[],users:[]}:await readCLIState(call,command);
    if(ownerUsername!==undefined){const owner=state.users?.find(user=>user.username===ownerUsername);if(!owner)fail9('没有这个用户名：'+ownerUsername);targetOwnerId=owner.id;}
    if(!(command==='community'&&['announcements','ack'].includes(positionals[1])))await showCLIAnnouncements(call,state.announcements?.pending);
    const machineName = (value) => {
      const exact = state.machines.find((m) => m.id === value);
      if (exact) return exact.id;
      const short = state.machines.filter((m) => m.id.endsWith("-" + value));
      return short.length === 1 ? short[0].id : value;
    };
    const jobTarget=()=>options.job?state.jobs?.find(job=>job.id===options.job):null;
    const selectedMachine = () => jobTarget()?.machine||session.machine || (state.machines?.length === 1 ? state.machines[0].id : null) || fail9("先选择一次服务器：gpuctl use MACHINE_ID");
    const defaultMachine = () => {
      if (options.machines.length) {
        if (options.machines.length !== 1 || options.machines[0].includes("=")) fail9("Use one --machine SERVER outside grant");
        return machineName(options.machines[0]);
      }
      return selectedMachine();
    };
    const selectedProject = (machine) => jobTarget()?.project || options.project || session.projectsByMachine?.[machine] || null;
    const projectArgs = (machine) => {
      const project = selectedProject(machine);
      return {...(targetOwnerId?{ownerId:targetOwnerId}:{}),...(project?{project:projectSlug(project)}:{})};
    };
    const fileArgs = (machine) => {
      const context = projectArgs(machine);
      return {...context,...(options.job?{area:"output",runId:options.job,...(jobTarget()?{ownerId:jobTarget().ownerId||jobTarget().userId}:{})}:{area:"code"})};
    };
    const saveSession = async () => {
      await writeFile2(sessionFile, JSON.stringify(session), { mode: 384 });
      await chmod(sessionFile, 384);
    };
    const shortcut = command;
    if (command === "ssh") command = "shell";
    if (command === "push") command = "upload";
    if (command === "push-status") command = "upload-status";
    if (command === "pull") command = "download";
    if ((options.reconnect || options.takeover) && command !== "shell") fail9("--reconnect/--takeover are only valid for ssh");
    if (command === "run" && positionals.length > 1 && options.machines.length) fail9("Select a server once, either positionally or with --machine/--on");
    if (["run", "shell"].includes(command) && positionals.length === 1) positionals.push(defaultMachine());
    if (["push", "push-status", "pull"].includes(shortcut)) positionals.splice(1, 0, defaultMachine());
    if (["push", "push-status"].includes(shortcut) && positionals.length === 3 && (await lstat5(positionals[2])).isDirectory()) positionals.push(".");
    if (!outputDelete&&command === "files" && (positionals.length === 1 || !state.machines.some((m) => m.id === machineName(positionals[1])))) positionals.splice(1, 0, defaultMachine());
    if (!outputDelete&&["run", "shell", "upload", "upload-status", "download", "files", "use"].includes(command) && positionals[1]) positionals[1] = machineName(positionals[1]);
    mode = { demo: state.demo, gpuqConnected: state.gpuqConnected === true };
    const find = (username) => {
      const user = state.users.find((u) => u.username === username);
      if (!user) fail9("Unknown or unauthorized username");
      return user.id;
    };
        if (command === "transfer") {
      const action = positionals[1], common2 = ["machines", "url", "session-file", "json", "key"], specific = { upload: ["name", "via"], download: ["via"], copy: ["from", "to", "name", "timeout", "detach"], list: ["cursor", "limit"], status: [], watch: ["interval"], cancel: [], resume: [] }[action];
      if (!specific || training.length || Object.keys(options).some((k) => !common2.includes(k) && !specific.includes(k))) fail9("Usage: transfer upload|download|copy|list|status|watch|cancel|resume");
      const progress = (phase, v) => process.stderr.write(`${phase} · ${v.transferId || v.uploadId || v.key || v.path || ""}${v.bytes !== void 0 ? " · " + v.bytes + " / " + (v.totalBytes ?? "?") + " bytes" : ""}
`);
      if (action === "upload") {
        if (positionals.length !== 3) fail9("Usage: transfer upload LOCAL_DIR --name DATASET");
        result = await uploadTransfer(call, { machine: defaultMachine(), name: options.name, userId: session.principal.userId, directory: positionals[2], key: options.key, progress, stateDirectory:sessionFile+".uploads",via: options.via || "auto" });
      } else if (action === "download" || action === "copy") {
        if (positionals.length !== (action === "download" ? 4 : 3)) fail9("Usage: transfer download DATASET NEW_DIR | transfer copy DATASET --from SOURCE --to TARGET --name NAME");
        const dataset=positionals[2];dataPath(dataset);
        if (action === "download") result = await downloadTransfer(call, { machine: defaultMachine(), dataset, origin:base.origin,userId:session.principal.userId,via:options.via,destination: positionals[3], key: options.key, progress });
        else {
          if (options.machines.length || !options.from || !options.to) fail9("copy requires --from and --to; no auto placement");
          const key = options.key || randomUUID7();
          process.stderr.write("重试键：" + key + "（未确认时重复原命令并加 --key，不要换键）\n");
          result = (await call("transfers.create", { key, kind: "copy", from: machineName(options.from), machine: machineName(options.to), name:options.name,reference:{dataset}, ...options.timeout ? { timeoutSec: Number(options.timeout) } : {} })).result;
          if (!options.detach) {
            while (!["SUCCEEDED", "FAILED", "PAUSED", "CANCELED", "UNKNOWN"].includes(result.state)) {
              process.stderr.write(transferText(result) + "\n");
              await new Promise((r) => setTimeout(r, 2e3));
              result = (await call("transfers.status", { id: result.id })).result;
            }
          }
        }
      } else if (action === "list") {
        if (positionals.length !== 2) fail9("Usage: transfer list");
        result = (await call("transfers.list", { ...options.cursor ? { cursor: Number(options.cursor) } : {}, ...options.limit ? { limit: Number(options.limit) } : {} })).result;
      } else {
        if (positionals.length !== 3) fail9("Usage: transfer " + action + " ID");
        if (action === "watch") {
          const interval = Number(options.interval ?? 2);
          if (!Number.isFinite(interval) || interval < 1 || interval > 60) fail9("Watch interval must be 1–60 seconds");
          do {
            result = (await call("transfers.status", { id: positionals[2] })).result;
            process.stderr.write(transferText(result) + "\n");
            if (["SUCCEEDED", "FAILED", "PAUSED", "CANCELED", "UNKNOWN", "WAITING_CLIENT"].includes(result.state)) break;
            await new Promise((r) => setTimeout(r, interval * 1e3));
          } while (true);
        } else result = (await call("transfers." + action, { id: positionals[2] })).result;
      }
    } else if (command === "community") {
      result = await runCommunityCommand({ positionals, options, training, call });
    } else if (command === "queue") {
      if (positionals.length !== 1 || training.length || options.machines.length > 1 || Object.keys(options).some((k) => !["machines", "url", "session-file", "json"].includes(k))) fail9("Usage: queue [--machine SERVER]");
      const selected = options.machines.length ? machineName(options.machines[0]) : null;
      if (selected && !state.machines.some((m) => m.id === selected)) fail9("这台机器未授权或不存在");
      result = { stale: state.gpuq?.stale !== false, hosts: (state.gpuq?.hosts || []).filter((h) => !selected || h.id === selected).map((h) => ({ machine: h.id, reachable: h.reachable, checkedAt: state.gpuq.checkedAt, tasks: (h.tasks||[]).filter(task=>!targetOwnerId||(task.ownerId||task.userId||task.owner?.id)===targetOwnerId) })) };
    } else if (command === "task-label") {
      const action = positionals[1], setting = action === "set", allowed = ["machines", "url", "session-file", "json", ...setting ? ["name", "description"] : []];
      if (!["get", "set"].includes(action) || positionals.length !== 4 || training.length || options.machines.length || Object.keys(options).some((k) => !allowed.includes(k))) fail9("Usage: task-label get|set SERVER NODE_JOB_ID [--name TEXT --description TEXT]");
      const machine = machineName(positionals[2]), nodeJobId = positionals[3];
      if (!state.machines.some((m) => m.id === machine) || !/^J[a-f0-9]{12}$/.test(nodeJobId)) fail9("Use an authorized server and the complete original native job ID.");
      if (setting && (typeof options.name !== "string" || typeof options.description !== "string")) fail9("Supply --name and --description.");
      result = (await call("tasks.display." + action, { machine, nodeJobId, ...setting ? { name: options.name, description: taskDescription(options.description) } : {} })).result;
    } else if (command === "profile") {
      if (positionals.length !== 1 || training.length || options.machines.length || Object.keys(options).some((k) => !["machines", "url", "session-file", "json", "display-name"].includes(k))) fail9("Usage: profile [--display-name NAME]");
      if (options["display-name"]) {
        result = (await call("profile.update", { name: displayName(options["display-name"]) })).result;
      } else result = state.users.find((u) => u.id === session.principal.userId);
    } else if (command === "use" && positionals.length === 2) {
      if (!state.machines.some((m) => m.id === positionals[1])) fail9("这台机器未授权或不存在");
      session.machine = positionals[1];
      await saveSession();
      result = { selected: session.machine, project: selectedProject(session.machine) };
    } else if (command === "maintenance") {
      const action = positionals[1];
      if (["status", "on", "off"].includes(action)) {
        const allowed = ["machines", "url", "session-file", "json", ...action === "status" ? [] : ["reason"]];
        if (training.length || options.machines.length || Object.keys(options).some((k) => !allowed.includes(k)) || positionals.length !== (action === "status" ? 2 : 3)) fail9("Usage: maintenance status | maintenance on all|SERVER --reason TEXT | maintenance off all|SERVER");
        if (action === "status") result = (await call("maintenance.status")).result;
        else {
          if (session.principal.role !== "admin") fail9("仅管理员可设置或解除维护状态。");
          result = (await call("maintenance.set", { scope: positionals[2], enabled: action === "on", ...options.reason !== void 0 ? { reason: options.reason } : {} })).result;
        }
      } else fail9('Usage: maintenance status | on all|SERVER --reason TEXT | off all|SERVER');
    } else if(command==='project'){
      const action=positionals[1],machine=action==='copy'?options.from:defaultMachine();
      if(action==='trash'){
        const verb=positionals[2];if(!['list','restore','purge','empty'].includes(verb))fail9('Usage: project trash list | restore|purge KEY --kind project|dataset|output');
        if(['purge','empty'].includes(verb)&&session.principal.role!=='admin')fail9('彻底清除只允许管理员。');
        if(['purge','empty'].includes(verb)&&!options.json&&process.stdin.isTTY){const rl=createInterface({input:process.stdin,output:process.stderr});const answer=await rl.question('彻底删除后不能恢复，输入 DELETE 继续：');rl.close();if(answer!=='DELETE')fail9('已取消。');}
        const args={machine,...(targetOwnerId?{ownerId:targetOwnerId}:{})};
        if(!['list','empty'].includes(verb)){args.key=options.key||positionals[3];args.kind=options.kind;if(!args.key||!['project','dataset','output'].includes(args.kind))fail9('使用回收站原编号及 --kind project|dataset|output。');if(options.project)args.project=options.project;}
        result=(await call('projects.retire.'+verb,args)).result;
      }else if(action==='copy'){
        if(positionals.length!==3||!options.from||!options.to||options.machines.length||training.length)fail9('Usage: project copy NAME --from SOURCE --to TARGET [--name NEW_NAME] [--key UUID] [--detach]');
        const key=options.key||randomUUID7(),project=projectSlug(positionals[2]);
        process.stderr.write('复制编号：'+key+'；查询或续传使用 transfer status/resume '+key+'\n');
        result=(await call('transfers.create',{key,kind:'copy',from:machineName(options.from),machine:machineName(options.to),name:projectSlug(options.name||project),reference:{project,ownerId:targetOwnerId||session.principal.userId,environment:true}})).result;
        if(!options.detach)while(!['SUCCEEDED','FAILED','PAUSED','CANCELED','UNKNOWN','ABSENT'].includes(result.state)){
          process.stderr.write(transferText(result)+'\n');await new Promise(resolve=>setTimeout(resolve,2000));
          result=(await call('transfers.status',{id:key})).result;
        }
      }else if(action==='catalog')result=(await call('projects.catalog',{includeArchived:options.full===true})).result;
      else if(action==='group'){
        const id=positionals[2];if(!id)fail9('Usage: project group UUID [--display-name NAME --members SERVER/PROJECT,...]');
        if(options['display-name']===undefined)result=(await call('projects.group.get',{id})).result;
        else{const ref=value=>{const parts=value.split('/');if(parts.length!==2)fail9('组成员使用 SERVER/PROJECT。');return {machine:machineName(parts[0]),project:projectSlug(parts[1]),...(targetOwnerId?{ownerId:targetOwnerId}:{})};};result=(await call('projects.group.set',{id,displayName:options['display-name'],members:options.members==='none'?[]:String(options.members||'').split(',').filter(Boolean).map(ref),...(options.primary?{primary:ref(options.primary)}:{})})).result;}
      }else if(['list','quota'].includes(action))result=(await call('projects.'+action,{machine,...(targetOwnerId?{ownerId:targetOwnerId}:{}),...(action==='quota'&&options.project?{project:projectSlug(options.project)}:{})})).result;
      else if(['create','use','status','label','archive','unarchive','delete','retire'].includes(action)){
        const project=projectSlug(positionals[2]||options.project||selectedProject(machine)),args={machine,project,...(targetOwnerId?{ownerId:targetOwnerId}:{})};
        if(action==='label')result=(await call('projects.label.'+(options['display-name']===undefined?'get':'set'),{...args,...(options['display-name']===undefined?{}:{displayName:options['display-name']})})).result;
        else if(action==='delete'||action==='retire'){args.key=options.key||randomUUID7();process.stderr.write('删除编号：'+args.key+'；重试沿用 --key '+args.key+'\n');result=(await call('projects.retire',args)).result;}
        else result=(await call('projects.'+(action==='use'?'status':action),{...args,...(action==='status'?{diagnoseNetwork:true}:{}),...(action==='create'?{...(options.repo?{repo:options.repo}:{})}:{})})).result;
        if(action==='create'||action==='use'){session.projectsByMachine={...session.projectsByMachine,[machine]:project};await saveSession();result={...result,machine,selectedProject:project};}
      }else fail9('Usage: project create|list|use|status|copy|label|group|catalog|archive|unarchive|delete|quota|trash');
    } else if (command === "terminal" && ["status", "close"].includes(positionals[1])) {
      const allowed = ["machines", "url", "session-file", "json", "project"];
      if (positionals.length !== 3 || training.length || Object.keys(options).some((k) => !allowed.includes(k))) fail9("Usage: terminal status|close SESSION [--machine SERVER] [--project NAME]");
      const id2 = positionals[2], machine = defaultMachine();
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id2)) fail9("Terminal requires the complete original session UUID");
      const context = projectArgs(machine);
      result = (await call("terminal." + positionals[1], { machine, id: id2, ...context })).result;
      if (positionals[1] === "close" && result?.closed !== true && result?.state !== "STOPPED") fail9("终端状态未知，请按原编号查询："+id2);
    } else if (command === "shell" && positionals.length === 2) {
      if (!process.stdin.isTTY) fail9("交互终端需要 TTY；非交互任务使用 gpuctl run");
      const machine = positionals[1];
      if (options.takeover && !options.reconnect) fail9("--takeover requires --reconnect SESSION");
      if (options.reconnect && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.reconnect)) fail9("Reconnect requires a complete terminal UUID");
      const context = projectArgs(machine);
      if (options.job) {
        const job = state.jobs.find((job2) => job2.id === options.job);
        if (!job?.interactive || job.machine !== machine) fail9("请选择这台服务器上正在运行的 GPU 交互任务。");
        if (job.state !== "RUNNING") fail9("GPU 交互任务尚未运行；使用 gpuctl jobs 查看排队状态。");
        context.project = job.project;context.ownerId=job.ownerId||job.userId;
        options.reconnect = job.id;
      }
      const key = randomUUID7(), clientId = randomUUID7(), id2 = options.reconnect || key, openMode = options.reconnect ? "reconnect" : "new";
      const scope = context.project ? ["--project", context.project] : [];
      const scopeOwner=ownerUsername||state.users?.find(user=>user.id===context.ownerId)?.username;
      if(scopeOwner)scope.push('--owner',scopeOwner);
      const commandText = (parts) => parts.map((value) => /^[A-Za-z0-9_.:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'").join(" ");
      const statusCommand = commandText(["gpuctl", "terminal", "status", id2, "--machine", machine, ...scope,"--url",base.origin,"--session-file",sessionFile]);
      const reconnectCommand = commandText([
        "gpuctl",
        "ssh",
        "--machine",
        machine,
        ...scope,
        "--reconnect",
        id2,"--url",base.origin,"--session-file",sessionFile
      ]);
      const terminal = { id: id2, machine, project: context.project || null, ownerId:context.ownerId||targetOwnerId||session.principal.userId, mode: openMode, state: "UNKNOWN", statusCommand,reconnectCommand };
      const unconfirmed = (error2) => Object.assign(Error(`${terminal.state==='REJECTED'?'':error2.message}
${terminal.state==='REJECTED'?`终端未创建：${terminal.reason||error2.message}`:terminal.state==='ALIVE'?`原终端仍在运行，尚未附着。重连原会话：${reconnectCommand}`:terminal.state==='STOPPED'?'原终端已结束，未新建会话。':terminal.state==='NOT_FOUND'?`原终端未创建，可以直接新建：${terminal.newCommand}`:`终端状态未确认，未重开或重放输入。只读查询原会话：${statusCommand}`}`), { terminal, status: terminal.state==='REJECTED'?400:error2.status, code: terminal.state==='REJECTED'?'TERMINAL_OPEN_REJECTED':error2.code });
      const observeOriginal=async()=>{
        try{
          const observed=(await call('terminal.status',{machine,id:id2,...context},AbortSignal.timeout(10000))).result;
          if(['ALIVE','STOPPED'].includes(observed.state)){terminal.state=observed.state;if(typeof observed.writerLeaseExpired==='boolean')terminal.writerLeaseExpired=observed.writerLeaseExpired;}
          if(observed.state==='NOT_FOUND'&&observed.canCreate===true){terminal.state='NOT_FOUND';terminal.newCommand=commandText(['gpuctl','ssh','--machine',machine,...scope,'--url',base.origin,'--session-file',sessionFile]);}
          if(observed.state==='REJECTED'&&observed.created===false&&typeof observed.reason==='string'){terminal.state='REJECTED';terminal.reason=observed.reason;}
        }catch{/* A read cannot acquire a writer or replay the original input. */}
      };
      await new Promise((resolve5, reject) => process.stderr.write("Terminal: " + maintenanceJSON(terminal) + "\n", (error2) => error2 ? reject(error2) : resolve5()));
      let opened,openDispatched=false,openResponded=false;
      try {
        openDispatched=true;
        opened = (await call("terminal.open", { machine, key, clientId, mode: openMode, ...options.reconnect ? { id: id2, takeover: options.takeover === true } : {}, ...context })).result;
        openResponded=true;
        if(!opened?.id||!opened.writerToken)fail9('终端连接结果未知，未发送输入；请按原编号查询：'+id2);
      } catch (error2) {
        if(error2.status===400&&error2.code==='TERMINAL_OPEN_REJECTED'){terminal.state='REJECTED';terminal.reason=error2.message;}
        if(openDispatched&&!openResponded&&(error2.status===undefined||[502,503,504].includes(error2.status)))await observeOriginal();
        throw unconfirmed(error2);
      }
      let input = Buffer.alloc(0), offset = 0, done = false, closed = false, delay2 = 250, lastSize = "";
      const sessionArgs = { machine, id: opened.id, clientId, writerToken: opened.writerToken, ...context };
      process.stderr.write(`\r
${machine} · ${context.project ? "项目 " + context.project : "默认 OCI 项目"} · ${opened.id}（Ctrl+] 仅断开；exit 结束此会话）\r
`);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const listener = (chunk) => {
        if (chunk.includes(29)) {
          done = true;
          return;
        }
        input = Buffer.concat([input, chunk]);
        if (input.length > 262144) process.stdin.pause();
      };
      process.stdin.on("data", listener);
      try {
        while (!done) {
          const sent = input.subarray(0, 8192);
          input = input.subarray(sent.length);
          if (input.length < 131072) process.stdin.resume();
          const size = { cols: process.stdout.columns || 110, rows: process.stdout.rows || 32 }, sizeKey = JSON.stringify(size);
          const response = (await call("terminal.exchange", { ...sessionArgs, offset, input: sent.toString("base64"), ...sizeKey === lastSize ? {} : { cols: size.cols, rows: size.rows } })).result;
          lastSize = sizeKey;
          offset = response.offset;
          if (response.data) process.stdout.write(Buffer.from(response.data, "base64"));
          if (response.exited) {
            closed = true;
            await observeOriginal();
            break;
          }
          await new Promise((r) => setTimeout(r, delay2));
        }
      } catch (error2) {
        if([400,401,403,409,429].includes(error2.status)){
          // Release only this writer; never turn an authorization refusal into
          // a successful observation or replay the failed input.
          if([401,403].includes(error2.status))await call('terminal.detach',sessionArgs).catch(()=>{});
          throw unconfirmed(error2);
        }
        await observeOriginal();
        if(terminal.state==='STOPPED')closed=true;else throw unconfirmed(error2);
      } finally {
        process.stdin.off("data", listener);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stderr.write(`\r
${closed ? "此终端已结束。" : `已断开。只读查询：${statusCommand}\r
重连：${reconnectCommand}`}\r
`);
      }
      return;
    } else if (command === "invites" && positionals[1] === "list" && positionals.length === 2) result = (await call("invites.list")).result;
    else if (command === "invites" && ["rotate", "disable"].includes(positionals[1]) && ["admin", "member"].includes(positionals[2]) && positionals.length === 3) result = (await call(`invites.${positionals[1]}`, { role: positionals[2] })).result;
    else if (command === "users" && positionals.length === 1) result = state.users;
    else if (command === "state" && positionals.length === 1) result = state;
    else if (command === "logout" && positionals.length === 1) {
      result = (await call("logout")).result;
      await unlink3(sessionFile).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    } else if (command === "user" && positionals[1] === "role" && positionals.length === 4) result = (await call("users.role", { userId: find(positionals[2]), role: positionals[3] })).result;
    else if (command === "user" && positionals.length === 3) {
      const [_, action, username] = positionals;
      if (action === "add") result = (await call("users.create", { username, password: await secret(), role: options.role || "member" })).result;
      else if (action === "reset-password") result = (await call("users.reset", { userId: find(username), password: await secret() })).result;
      else if (action === "enable" || action === "disable") result = (await call("users.enabled", { userId: find(username), enabled: action === "enable" })).result;
      else if (action === "delete") result = (await call("users.delete", { userId: find(username) })).result;
      else fail9("Unknown user command");
    } else if(command==='data'){
      const action=positionals[1],machine=defaultMachine(),dataset=positionals[2];
      const progress=(phase,row)=>process.stderr.write(`${phase} · ${row.path||row.transferId||row.key||''} · ${row.offset??row.bytes??'?'} / ${row.totalSize??row.totalBytes??'?'}\n`);
      if(action==='cloud')result=await runCloudFiles({positionals,options,machine,call});
      else if(['import','imports','import-status','import-resume','import-cancel','import-discard'].includes(action))result=await runCloudImport({action,positionals,options,machine,call});
      else if(action==='list')result=(await call('datasets.list',{machine})).result;
      else if(action==='files'){if(!dataset)fail9('Usage: data files DATASET [PATH]');result=(await call('files.list',{machine,area:'dataset',dataset,path:positionals[3]||'.',...(options.cursor?{cursor:options.cursor}:{}),...(options.limit?{limit:Number(options.limit)}:{})})).result;}
      else if(action==='delete'){if(!dataset)fail9('Usage: data delete DATASET [--key UUID]');const key=options.key||randomUUID7();process.stderr.write('删除编号：'+key+'；重试沿用 --key '+key+'\n');result=(await call('datasets.delete',{machine,dataset,key})).result;}
      else if(action==='put'){if(positionals.length<4||positionals.length>5)fail9('Usage: data put LOCAL_FILE DATASET [REMOTE_FILE]');result=await uploadLocalFile(call,{machine,context:{area:'dataset',dataset:positionals[3]},path:positionals[4]||basename2(positionals[2]),local:positionals[2],key:options.key,stateDirectory:sessionFile+'.uploads',via:options.via||'auto',progress:row=>progress('UPLOADING',row)});}
      else if(action==='upload'){if(!dataset||!options.name)fail9('Usage: data upload LOCAL_DIR --name DATASET [--key UUID]');result=await uploadTransfer(call,{machine,name:options.name,directory:positionals[2],key:options.key,via:options.via||'auto',stateDirectory:sessionFile+'.uploads',progress});}
      else if(action==='get'){if(positionals.length!==5)fail9('Usage: data get DATASET REMOTE_FILE LOCAL_FILE');result=await downloadResultFile(call,{machine,context:{area:'dataset',dataset},path:positionals[3],destination:positionals[4],origin:base.origin,userId:session.principal.userId,via:options.via});}
      else if(action==='download'){if(positionals.length!==4)fail9('Usage: data download DATASET LOCAL_DIR');result=await downloadTransfer(call,{machine,dataset,destination:positionals[3],key:options.key,origin:base.origin,userId:session.principal.userId,via:options.via,progress});}
      else fail9('Usage: data list|files|put|upload|get|download|delete|import|imports|import-status|import-resume|import-cancel|import-discard|cloud');
    } else if (command === "run" && positionals.length === 2) {
      const automatic = positionals[1] === "auto";
      if (options.candidates !== void 0 && !automatic) fail9("--candidates requires --machine auto");
      if (options.interactive) {
        if(training.length)fail9("--interactive 不接受额外命令。");
        training = ["/bin/bash", "--noprofile", "--norc", "-i"];
      }
      if (!training.length) fail9("Put the training command after --");
      const developmentMachine = automatic ? options.sync?selectedMachine():session.machine : positionals[1], context = projectArgs(developmentMachine);
      let candidates = options.candidates?.split(",").map(machineName);
      if (candidates && (!candidates.length || new Set(candidates).size !== candidates.length)) fail9("--candidates must list unique authorized server IDs separated by commas");
          const key = options.key || randomUUID7();
      process.stderr.write(`Submission key: ${key}
`);
      const indices = options.gpu?.split(",").map((n) => /^\d+$/.test(n) ? Number(n) : NaN), cards = Number(options.cards || indices?.length || 1);
      const elastic = elasticKeys.some((k) => Object.hasOwn(options, k)) ? elasticAllocation({ minCards: Number(options["min-cards"]), globalBatch: Number(options["global-batch"]), microBatch: Number(options["micro-batch"]), autoExpand: options["auto-expand"] === true }, cards, scheduling).elastic : null;
      const placement = placementKeys.some((k) => Object.hasOwn(options, k)) ? gpuPlacement({ gpuIndices: indices, shared: options.share === true, ...options["vram-mib"] ? { vramMiB: Number(options["vram-mib"]) } : {}, hami: options.hami === true, ...options["sm-percent"] ? { smPercent: Number(options["sm-percent"]) } : {} }, cards, elastic, scheduling, options.priority) : null;
      if(options.sync){if(!context.project)fail9('run --sync 请先用 project create/use 选择项目。');await uploadCodeFiles(call,{machine:developmentMachine,context,local:options['sync-dir']||process.cwd(),remote:'.',key,stateDirectory:sessionFile+'.uploads',via:options.via});}
      process.stderr.write('工作区：'+(context.project||'默认 OCI 项目')+' · 数据集 /datasets\n');
      if (options.interactive) context.interactive = true;
      if(automatic)context.sourceMachine=developmentMachine;
      if (memoryLimitGiB !== void 0) context.memoryLimitGiB = memoryLimitGiB;
      const submission = await submitJobWithReceipt(call, { machine: positionals[1], ...automatic ? { machineSelection: { mode: "auto", ...candidates ? { candidates } : {} } } : {}, cards, minVramGiB: Number(options["min-vram"] || 0), name: options.name || "train", ...options.description !== void 0 ? { description: taskDescription(options.description) } : {}, argv: training, key, ...options.priority ? { priority: options.priority } : {}, ...scheduling ? { scheduling } : {}, ...elastic ? { elastic } : {}, ...placement ? { placement } : {}, ...context },session.principal);
      result=submission.result;if(submission.receiptRecovered)process.stderr.write("按原 key 找回已登记任务："+result.id+"\n");
    } else if (command === "jobs" && positionals.length === 1) result = targetOwnerId?state.jobs.filter(job=>(job.ownerId||job.userId)===targetOwnerId):state.jobs;
    else if (command === "priority" && positionals.length === 3) {
      if (!["idle", "normal", "high", "P0", "P1", "P2", "P3", "P4"].includes(positionals[2])) fail9("Queue rank must be P0..P4 (or idle, normal, high); yielding/restart stay unchanged");
      if (options.key || training.length) fail9("priority does not accept a submission key or command argv");
      result = (await call("jobs.priority", { jobId: positionals[1], priority: positionals[2] })).result;
    } else if (command === "reconcile-resources") {
      if (positionals.length !== 2 || training.length || options.machines.length || Object.keys(options).some((k) => !["machines", "json", "url", "session-file"].includes(k))) fail9("Usage: reconcile-resources JOB [--json]; no paths, machine or execution options");
      result = (await call("jobs.reconcile-resources", { jobId: positionals[1] })).result;
    } else if (command === "completion") {
      if (positionals.length !== 2 || training.length || options.machines.length || Object.keys(options).some((k) => !["machines", "json", "url", "session-file"].includes(k))) fail9("Usage: completion JOB [--json]; no paths, machine or execution options");
      result = (await call("jobs.completion", { jobId: positionals[1] })).result;
      if (result.completed !== true) process.exitCode = 2;
    } else if (command === "diagnostics") {
      if (positionals.length !== 2 || training.length || options.machines.length || Object.keys(options).some((k) => !["machines", "json", "url", "session-file"].includes(k))) fail9("Usage: diagnostics JOB [--json]; no paths, machine or execution options");
      result = (await call("jobs.diagnostics", { jobId: positionals[1] })).result;
    } else if (command === "watch" && positionals.length === 2) {
      const controller = new AbortController(), stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        process.exitCode = await watchJob(call, positionals[1], { interval: options.interval === void 0 ? 5 : Number(options.interval), json: options.json === true, signal: controller.signal });
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
      return;
    } else if (command === "notify" && positionals.length === 3) result = (await call("notifications.job", { jobId: positionals[1], ...positionals[2] === "status" ? {} : { enabled: positionals[2] === "on" } })).result;
    else if (command === "notes" && positionals.length === 1) {
      result = (await call("community.notes.list", {})).result;
    } else if (command === "note" && positionals.length === 2) {
      if (Boolean(options.general) === Boolean(options.job)) fail9("Choose --job JOB_ID or --general for a note");
      const key = options.key || randomUUID7();
      process.stderr.write(`Note key: ${key}; reuse --key after an uncertain response.
`);
      result = (await call("community.notes.create", { body: positionals[1], key, ...options.job ? { jobId: options.job } : {} })).result;
    } else if (command === "note-delete" && positionals.length === 2) {
      result = (await call("community.notes.delete", { id: positionals[1] })).result;
    } else if (["logs", "cancel"].includes(command) && positionals.length === 2) result = (await call(command === "logs" ? "jobs.logs" : "jobs.cancel", { jobId: positionals[1] })).result;
    else if(outputDelete){
      const key=options.key||randomUUID7();
      if(!options.json)process.stderr.write('删除编号：'+key+'；重试沿用 --key '+key+'\n');
      try{result=(await call('outputs.delete',{key,jobId:options.job,path:command==='files'?positionals[2]:'.',recursive:command==='outputs'||options.recursive===true,dryRun:options['dry-run']===true})).result;}
      catch(error){error.message+='\n原删除编号：'+key+'；重试沿用 --key '+key;throw error;}
    }
    else if (command === "files" && positionals.length <= 3){
      result=(await call('files.list',{machine:positionals[1],path:positionals[2]||'.',...fileArgs(positionals[1]),...(options.cursor===undefined?{}:{cursor:options.cursor}),...(options.limit===undefined?{}:{limit:Number(options.limit)})})).result;
    }
    else if (["upload", "upload-status"].includes(command) && positionals.length >= 3 && positionals.length <= 4) {
      if (options.job) fail9("Job outputs cannot be uploaded; upload project code without --job");
      const machine = positionals[1], context = fileArgs(machine);
      result = await uploadCodeFiles(call, { machine, context, local: positionals[2], remote: positionals[3] || basename2(positionals[2]), inspectOnly: command === "upload-status",key:options.key,stateDirectory:sessionFile+".uploads",via:options.via });
    } else if (command === "download" && positionals.length === 4) {
      const context = fileArgs(positionals[1]);
      result = await downloadResultFile(call, { machine: positionals[1], context, path: positionals[2], destination: positionals[3], origin: base.origin, userId: session.principal.userId,sessionFile,via:options.via });
    } else if (command === "grant" && positionals.length === 2) {
      const userId = find(positionals[1]);
      if (options.full) {
        result = (await call("policy.full", { userId })).result;
      } else {
        const limits = {};
        for (const spec of options.machines) {
          const pair = spec.split("=");
          if (pair.length !== 2 || !/^\d+$/.test(pair[1]) || Object.hasOwn(limits, pair[0])) fail9("Expected unique --machine NAME=CARDS");
          limits[pair[0]] = Number(pair[1]);
        }
        if (!/^\d+$/.test(options.total || "")) fail9("--total must be an integer");
        result = (await call("policy.save", { userId, limits, total: Number(options.total) })).result;
      }
    }     else fail9("Unknown command. Use --help.");
  }
  if (options.json) {
    console.log((command === "community" ? communityJSON : maintenanceJSON)({ ok: true, ...mode, data: result }));
    return;
  }
  if (!["logs", "maintenance", "community"].includes(command)) result = terminalMetadata(result);
  if (command === "community") {
    console.log(formatCommunityResult(result));
    return;
  }
  if (command === "login") {
    console.log(`已登录：${result.principal.username}`);
    return;
  }
  if(outputDelete){if(!result.dryRun&&result.state!=='TRASHED'){console.log('结果未知，请按原编号查询：'+(result.key||options.key||''));process.exitCode=2;return;}console.log(result.dryRun?`将删除 ${result.files} 个文件 · ${result.bytes} B`:`已删除，7 天内可在项目回收站恢复`);return;}
  if (command === "profile") {
    console.log(`姓名／显示名：${result.name}
登录用户名：${result.username}`);
    return;
  }
  if (command === "task-label") {
    console.log(`${result.nodeJobId||positionals[3]} · ${result.name??'名称未知'}
描述：${result.description||'未填写描述'}`);
    return;
  }
  if (command === "queue") {
    if (result.stale) console.log("监控已过期；以下是平台记录与上次核对状态，不代表空闲。");
    for (const h of result.hosts) {
      console.log(`${h.machine} · ${h.reachable ? "可采集" : "监控不可用"} · ${h.checkedAt || "暂无采集时间"}`);
      for (const t of h.tasks) console.log(`  ${t.id} · ${t.state} · ${t.name}
  提交者：${t.submitter?.name || "未知"}${t.submitter?.username && t.submitter.username !== t.submitter.name ? "（" + t.submitter.username + "）" : ""}
  描述：${t.description || "未填写描述"}
  分配 GPU：${t.assignedGpuIndices?.join(", ") || "—"}`);
      if (!h.tasks.length) console.log("  暂无任务记录。");
    }
    return;
  }
  if (command === "logout") {
    console.log("已退出登录。");
    return;
  }
  if (command === "use") {
    console.log(`当前服务器：${result.selected}
${result.project ? "当前项目：" + result.project : "未选择项目；可用 gpuctl project create NAME 或 project use NAME"}`);
    return;
  }
  if (command === "project" && positionals[1] === "quota") {
    const bytes=value=>Number.isFinite(value)?value.toLocaleString('en-US')+' B':'未知',usage=result.projectUsage;
    for (const row of result.volumes||[])console.log(`${row.kind==='shared'?'SSD · 工作区与数据集共用':row.kind==='workspace'?'工作区盘（SSD）':'数据集盘（HDD）'}\n  已用 ${bytes(row.usedBytes)} / 总量 ${bytes(row.totalBytes)}；可用 ${bytes(row.availableBytes)}`);
    if(usage)console.log(`项目 ${usage.project} 文件用量：${usage.complete===false&&Number.isFinite(usage.size)?'至少 ':''}${bytes(usage.size)}`);
    return;
  }
  if (command === "run") {
    console.log(`已提交 ${result.id}
${result.machine} · ${allocationLabel(result)} GPU · ${result.state}
查看日志：gpuctl logs ${result.id}`);
    return;
  }
  if (command === "transfer") {
    if(result.state==='UNKNOWN'||result.transfers===null){console.log('传输状态未知，请稍后按原编号查询。');return;}
    if (result.transfers) {
      console.log(result.transfers.map(transferText).join("\n") || "暂无传输。");
      if (result.nextCursor) console.log("下一页：gpuctl transfer list --cursor " + result.nextCursor);
    } else if (result.transferId) console.log(`传输 ${result.transferId} · ${result.state}
${result.downloaded || result.dataset || ""}`);
    else console.log(transferText(result));
    return;
  }
  if (command === "notes") {
    for (const n of result.notes) console.log(`${n.id} · ${n.author.username} · ${n.jobId || "非任务留言"}
${n.body}
`);
    if (!result.notes.length) console.log("暂无留言。");
    if (result.nextCursor) console.log("更多留言可通过 API before=" + result.nextCursor + " 查询。");
    return;
  }
  if (command === "note" || command === "note-delete") {
    console.log(result.deleted ? `留言 ${result.id} 已删除。` : `留言 ${result.note?.id || result.id} 已保存。`);
    return;
  }
  if (command === "priority") {
    console.log(`任务 ${result.id}：优先级 ${result.priority || "normal"}${result.priorityPending ? "（等待节点确认）" : ""}`);
    return;
  }
  if (command === "notify") {
    console.log(`Telegram：${result.configured ? "收件人已配置" : "收件人尚未配置"} · ${result.degraded ? "通知存储暂不可用" : result.enabled ? "通知已开启" : "通知关闭"} · 待发 ${result.pending ?? "未知"} · 失败 ${result.failed ?? "未知"}`);
    return;
  }
  if (command === "logs") {
    process.stdout.write(result.text + (result.text.endsWith("\n") ? "" : "\n"));
    return;
  }
  if (command === "cancel") {
    console.log(`任务 ${result.id}：${result.state}${result.cancelRequested ? "（已请求取消，等待节点确认）" : ""}`);
    return;
  }
  if (command === "upload") {
    console.log(`已上传 ${result.uploaded} 个文件到 ${result.machine} 的${result.project ? "项目 " + result.project : "默认 OCI 项目"}。${result.skipped ? "跳过 " + result.skipped + " 项。" : ""}`);
    return;
  }
  if (command === "upload-status") {
    console.log(result.files.map((file) => `${file.path}: ${file.state} ${file.offset ?? "?"}/${file.totalSize ?? "?"} B${file.uploadId ? " · " + file.uploadId : ""}`).join("\n") || "没有可查询的文件。");
    return;
  }
  if (command === "download") {
    console.log(`已下载：${result.downloaded}（${result.bytes} 字节）`);
    return;
  }
  if (command === "jobs") {
    console.log(result.length ? [...result].slice(-50).reverse().map((j) => `${j.id}  ${j.state}${j.preempted ? "（让位中断，不会自动重跑）" : ""}
  ${j.machine} · ${allocationLabel(j)} · ${j.name || "train"} · 优先级 ${Number.isInteger(j.schedulerPriority) ? 'P'+j.schedulerPriority : ["idle", "normal", "high"].includes(j.priority) ? j.priority : "未提供"}${j.schedulerState ? " · 调度 " + j.schedulerState : ""}${j.queueReason ? "\n  排队原因：" + j.queueReason : ""}
  ${progressText(j.progress)}${jobTimingText(j) ? "\n  " + jobTimingText(j) : ""}`).join("\n") : "暂无任务。");
    if (result.length > 50) console.log("显示最近 50 条；完整记录：gpuctl jobs --json");
    return;
  }
  if (command === "files") {
    console.log(result.entries.map((f) => `${f.type === "directory" ? "[目录]" : "[文件]"} ${f.name}${f.type === "file" ? "  " + f.size + " B" : ""}`).join("\n") || "目录为空。");
    if(result.protocol===1)console.log(`本页 ${result.returned} / 共 ${result.total} 项${result.hasMore?'，还有下一页':'，本目录已列完'}`);
    if(result.nextCursor)console.log('下一页：gpuctl files '+(positionals[2]||'.')+' --cursor '+result.nextCursor);
    if(result.retention?.status==='UNCONFIRMED')console.log('到期时间未确认');
    return;
  }
  if(command==='maintenance'){console.log(JSON.stringify(result,null,2));return;}
  if (command === "users") {
    console.log(result.map((u) => `${u.username}  ${u.role === "admin" ? "管理员" : "普通用户"}  ${u.enabled ? "启用" : "暂停"}  总额度 ${u.total} 张
  ${Object.entries(u.limits).map(([m, n]) => `${m}: ${n}`).join("，") || "尚未授权机器"}`).join("\n"));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
  } finally { await finishPlatformControlTransport(controlTransport); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error2) => {
    console.error(wantsJSON ? maintenanceJSON({ ok: false, error: error2.message, ...error2.terminal ? { terminal: error2.terminal, ...terminalErrorMetadata(error2) } : {}, ...error2.receipt ? {receipt:error2.receipt} : {}, ...error2.download ? {download:error2.download} : {} }) : `Error: ${maintenanceVisible(error2.message)}`);
    process.exitCode = 1;
  });
}
export {
  parseCLIOptions,
  uploadCodeFiles
};
