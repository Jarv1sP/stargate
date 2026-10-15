import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {resultStatus,runStep} from './gray/run.mjs';
import {SkipStep,createContext} from './gray/lib/context.mjs';
import {validateStack} from './gray/lib/stack.mjs';
import {InfraError} from './gray/lib/http.mjs';
import {uncoveredFeatures} from './gray/lib/coverage.mjs';
import {counts,writeReport} from './gray/lib/report.mjs';

test('业务断言失败仍然失败，未测项和跳过只列入报告',async()=>{
  assert.equal(resultStatus([{status:'failed'}]),'failed');
  assert.equal(resultStatus([{status:'passed'}]),'passed');
  assert.equal(resultStatus([{status:'skipped'}]),'passed');
  assert.equal(resultStatus([]),'failed');
  const ctx=createContext({stack:{machines:['gray-node-1'],origin:'http://127.0.0.1:12345'},artifacts:tmpdir()});
  const result=await runStep(ctx,{id:'G01',run(c){c.todo('real-gpu','没有真卡');}});
  assert.equal(result.status,'passed');assert.deepEqual(result.todo,[{id:'real-gpu',text:'没有真卡'}]);
  assert.equal((await runStep(ctx,{run(){throw new SkipStep('未测');}})).status,'skipped');
  const failed=await runStep(ctx,{run(c){c.todo('pending','未测');c.check('业务失败',false);}});
  assert.equal(failed.status,'failed');assert.equal(failed.attempts,1);assert.match(failed.error,/业务失败/);
});
test('基础设施错误最多重试一次，已经调用业务后不重放',async()=>{
  let calls=0;
  const step={run(){if(++calls===1)throw new InfraError('离线');}};
  assert.equal((await runStep({},step)).attempts,2);
  const result=await runStep({},{run(ctx){ctx.step.calls.push({operation:'jobs.submit'});throw new InfraError('响应未知');}});
  assert.equal(result.attempts,1);assert.equal(result.status,'failed');
});
test('只接受 127.0.0.1 和固定灰度项目',()=>{
  const stack={origin:'http://127.0.0.1:12345',project:'stargate-gray'};assert.equal(validateStack(stack),stack);
  for(const origin of ['http://localhost:12345','http://172.30.77.5:8080','https://example.invalid','http://127.0.0.1:12345/path'])assert.throws(()=>validateStack({...stack,origin}));
  assert.throws(()=>validateStack({...stack,project:'other'}));
});
test('覆盖范围由步骤声明，新增功能和未测项只报告，不设到期日',async()=>{
  const markdown='## 存储模型\n- 数据盘\n## 一、账号\n- 登录\n- 新功能\n## 删除的功能\n- 旧功能\n';
  const steps=[{id:'G01',title:'登录',features:['登录'],status:'passed',assertions:[],notes:[],todo:[{id:'external',text:'未接外网'}]}];
  const missing=uncoveredFeatures(markdown,steps);
  assert.deepEqual(missing,['数据盘','新功能']);
  const folder=await mkdtemp(join(tmpdir(),'gray-report-'));
  try{
    await writeReport(folder,{result:resultStatus(steps),revision:'fixture',nodePython:'3.10',level:'full',counts:counts(steps),steps,uncoveredFeatures:missing});
    const report=await readFile(join(folder,'summary.md'),'utf8');
    assert.match(report,/灰度结果：passed/);assert.match(report,/新功能/);assert.match(report,/未接外网/);
    assert.doesNotMatch(report,/豁免|到期|负责人/);
  }finally{await rm(folder,{recursive:true,force:true});}
});

const exporter=fileURLToPath(new URL('../scripts/gray-local/export-source.py',import.meta.url));
async function sourceFixture(){
  const root=await mkdtemp(join(tmpdir(),'gray-source-')),repo=join(root,'trusted');await mkdir(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q');await writeFile(join(repo,'.gitignore'),'ignored.txt\n');await writeFile(join(repo,'code.txt'),'committed\n');
  git('add','.');git('-c','user.name=gray','-c','user.email=gray@example.invalid','commit','-qm','fixture');
  return {root,repo,git,run:(destination,...args)=>spawnSync('python3',[exporter,repo,join(root,destination),...args],{cwd:root,encoding:'utf8'})};
}
test('默认导出HEAD，只读提交内容，忽略所有本地未提交文件和依赖',async()=>{
  const f=await sourceFixture();try{
    await mkdir(join(f.repo,'node_modules'));await writeFile(join(f.repo,'node_modules/dependency.txt'),'dependency');
    await writeFile(join(f.repo,'code.txt'),'edited\n');await writeFile(join(f.repo,'new.txt'),'new\n');await writeFile(join(f.repo,'ignored.txt'),'local only\n');
    const result=f.run('selected');assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{commit:f.git('rev-parse','HEAD'),source:'commit'});
    assert.equal(await readFile(join(f.root,'selected/code.txt'),'utf8'),'committed\n');
    for(const name of ['new.txt','ignored.txt','node_modules/dependency.txt'])await assert.rejects(readFile(join(f.root,'selected',name)),{code:'ENOENT'});
    assert.equal(f.run('invalid','--worktree',f.repo).status,2);
    assert.equal(f.run('invalid-dirty','--allow-dirty').status,2);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('显式commit导出那个提交，不使用后来提交或工作树',async()=>{
  const f=await sourceFixture();try{
    const first=f.git('rev-parse','HEAD');
    await writeFile(join(f.repo,'code.txt'),'second\n');f.git('add','.');f.git('-c','user.name=gray','-c','user.email=gray@example.invalid','commit','-qm','second');
    const result=f.run('selected','--commit',first);assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).commit,first);assert.equal(await readFile(join(f.root,'selected/code.txt'),'utf8'),'committed\n');
    assert.equal(f.run('missing','--commit','not-a-commit').status,2);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
