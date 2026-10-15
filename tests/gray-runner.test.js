import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {resultStatus,runStep} from './gray/run.mjs';
import {SkipStep,waiverFor} from './gray/lib/context.mjs';
import {validateStack} from './gray/lib/stack.mjs';
import {InfraError} from './gray/lib/http.mjs';
test('灰度结果不会把失败、跳过或未完成算成通过',async()=>{
  for(const status of ['failed','skipped','incomplete'])assert.equal(resultStatus([{status}]),'failed');
  assert.equal(resultStatus([{status:'passed'}]),'passed');
  assert.equal(resultStatus([]),'failed');
  const ctx={};
  assert.equal((await runStep(ctx,{run(){throw new SkipStep('未测');}})).status,'skipped');
  assert.equal((await runStep(ctx,{run(c){c.step.todo.push({id:'todo'});}})).status,'incomplete');
  assert.equal((await runStep(ctx,{run(){throw Error('断言失败');}})).attempts,1);
});
test('基础设施错误最多重试一次，已经调用业务后不重放',async()=>{
  let calls=0;
  const step={run(){if(++calls===1)throw new InfraError('离线');}};
  assert.equal((await runStep({},step)).attempts,2);
  const result=await runStep({},{run(ctx){ctx.step.calls.push({operation:'jobs.submit'});throw new InfraError('响应未知');}});
  assert.equal(result.attempts,1);assert.equal(result.status,'failed');
});
test('豁免只按预设配置和到期日期生效',()=>{
  const waivers=[{id:'gpu',reason:'没有真卡',owner:'TODO-维护者',expires:'2026-12-31',when:{tier:'cpu'}}];
  assert.ok(waiverFor(waivers,'gpu',{tier:'cpu'},'2026-10-14'));
  assert.equal(waiverFor(waivers,'gpu',{tier:'gpu'},'2026-10-14'),undefined);
  assert.equal(waiverFor(waivers,'gpu',{tier:'cpu'},'2027-01-01'),undefined);
});
test('只接受 127.0.0.1 和固定灰度项目',()=>{
  const stack={origin:'http://127.0.0.1:12345',project:'stargate-gray'};assert.equal(validateStack(stack),stack);
  for(const origin of ['http://localhost:12345','http://172.30.77.5:8080','https://example.invalid','http://127.0.0.1:12345/path'])assert.throws(()=>validateStack({...stack,origin}));
  assert.throws(()=>validateStack({...stack,project:'other'}));
});

test('FEATURES 每条原文有有效映射，变更或过期会失败',async()=>{
  const {checkRepository,checkFeatures}=await import('../scripts/gray-local/check-features.mjs');
  assert.ok((await checkRepository()).total>0);
  const fixture={markdown:'## 一、账号\n- 登录\n## 删除的功能\n- 旧功能\n',features:[{text:'登录',steps:['G01']}],waivers:[],steps:['G01']};
  assert.equal(checkFeatures(fixture).total,1);
  assert.throws(()=>checkFeatures({...fixture,markdown:fixture.markdown.replace('登录','登录和退出')}));
  assert.throws(()=>checkFeatures({...fixture,features:[{text:'登录',waiver:'expired'}],waivers:[{id:'expired',reason:'未测',owner:'维护者',expires:'2020-01-01'}]}));
});

const exporter=fileURLToPath(new URL('../scripts/gray-local/export-source.py',import.meta.url));
async function sourceFixture(){
  const root=await mkdtemp(join(tmpdir(),'gray-source-')),repo=join(root,'trusted');await mkdir(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q');await writeFile(join(repo,'.gitignore'),'ignored.txt\n');await writeFile(join(repo,'code.txt'),'committed\n');
  git('add','.');git('-c','user.name=gray','-c','user.email=gray@example.invalid','commit','-qm','fixture');
  return {root,repo,git,run:(destination,...args)=>spawnSync('python3',[exporter,repo,join(root,destination),...args],{cwd:root,encoding:'utf8'})};
}
test('提交导出使用可信仓库，工作树脏改动须明确选择并如实记录',async()=>{
  const f=await sourceFixture();try{
    await mkdir(join(f.repo,'node_modules'));await writeFile(join(f.repo,'node_modules/dependency.txt'),'installed dependency');
    const clean=f.run('after-install','--worktree',f.repo);assert.equal(clean.status,0,clean.stderr);assert.equal(JSON.parse(clean.stdout).dirty,false);
    await assert.rejects(readFile(join(f.root,'after-install/node_modules/dependency.txt')),{code:'ENOENT'});
    await writeFile(join(f.repo,'code.txt'),'edited\n');await writeFile(join(f.repo,'new.txt'),'new\n');await writeFile(join(f.repo,'ignored.txt'),'local only\n');
    let result=f.run('committed','--commit','HEAD');assert.equal(result.status,0,result.stderr);
    assert.equal(await readFile(join(f.root,'committed/code.txt'),'utf8'),'committed\n');assert.equal(JSON.parse(result.stdout).dirty,false);
    result=f.run('refused','--worktree',f.repo);assert.equal(result.status,2);assert.match(result.stderr,/未提交/);
    result=f.run('dirty','--worktree',f.repo,'--allow-dirty');assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).dirty,true);
    assert.equal(await readFile(join(f.root,'dirty/code.txt'),'utf8'),'edited\n');assert.equal(await readFile(join(f.root,'dirty/new.txt'),'utf8'),'new\n');
    await assert.rejects(readFile(join(f.root,'dirty/ignored.txt')),{code:'ENOENT'});
    await assert.rejects(readFile(join(f.root,'dirty/node_modules/dependency.txt')),{code:'ENOENT'});
    assert.equal(f.run('invalid','--commit','HEAD','--allow-dirty').status,2);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('worktree 导出选择被测仓库 HEAD，FEATURES 用可信映射检查被测文本',async()=>{
  const f=await sourceFixture();try{
    const other=join(f.root,'candidate');execFileSync('git',['clone','-q',f.repo,other]);
    await writeFile(join(other,'code.txt'),'candidate\n');execFileSync('git',['-C',other,'add','.']);
    execFileSync('git',['-C',other,'-c','user.name=gray','-c','user.email=gray@example.invalid','commit','-qm','candidate']);
    const result=f.run('selected','--worktree',other);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).dirty,false);
    assert.notEqual(JSON.parse(result.stdout).commit,f.git('rev-parse','HEAD'));assert.equal(await readFile(join(f.root,'selected/code.txt'),'utf8'),'candidate\n');
    await mkdir(join(other,'docs'));await writeFile(join(other,'docs/FEATURES.md'),'## 一、账号\n- 被测提交新增功能\n');
    const {checkRepository}=await import('../scripts/gray-local/check-features.mjs');await assert.rejects(checkRepository(other),/功能条数不一致/);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
