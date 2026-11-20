import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {spawnSync} from 'node:child_process';

const notPosix = process.platform === 'win32';
const source = 'console.log("fixture client");\n';
const pathLine = 'export PATH="$HOME/.local/bin:$PATH"';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stargate install '));
  t.after(() => rm(root, {recursive:true, force:true}));
  const home = join(root, 'home'), tools = join(root, 'tools'), payload = join(root, 'payload.mjs');
  await mkdir(home);
  await mkdir(tools);
  await writeFile(payload, source);
  // Serve known bytes through curl's existing stdout and header-file contract.
  await writeFile(join(tools, 'curl'), `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  if [ "$1" = --dump-header ]; then header=$2; shift; fi
  shift
done
bytes=$(wc -c < "$CLI002_PAYLOAD")
printf 'HTTP/1.1 200 OK\\r\\nContent-Length: %s\\r\\n\\r\\n' "$bytes" > "$header"
cat "$CLI002_PAYLOAD"
`, {mode:0o700});
  const installer = (await readFile(new URL('../deploy/install-client.sh', import.meta.url), 'utf8'))
    .replace('__GPUQ_PUBLIC_ORIGIN__', 'https://portal.example');
  const env = {...process.env, HOME:home, SHELL:'/bin/bash', CLI002_PAYLOAD:payload,
    PATH:[tools, dirname(process.execPath), '/usr/bin', '/bin'].join(':')};
  return {
    bin:join(home, '.local/bin'), client:join(home, '.local/share/gpuq-console/gpuctl.mjs'),
    rc:join(home, '.bashrc'), payload,
    run:() => spawnSync('/bin/sh', [], {input:installer, env, encoding:'utf8', timeout:10000}),
  };
}

function assertInstalledWithoutEntry(result, client) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('安装完成：客户端已保存到 ' + client), result.stdout);
  assert.match(result.stdout, /未创建 gpuctl 命令入口/);
  assert.match(result.stdout, /node "\$HOME\/\.local\/share\/gpuq-console\/gpuctl\.mjs" --help/);
  assert.match(result.stdout, /PATH 中可写的目录/);
  assert.doesNotMatch(result.stdout, /请重新打开终端/);
}

test('POSIX installer saves runnable client when the bin directory is unwritable',
  {skip:notPosix || process.getuid?.() === 0}, async t => {
    const f = await fixture(t);
    await mkdir(f.bin, {recursive:true});
    await chmod(f.bin, 0o500);
    try {
      const result = f.run();
      assertInstalledWithoutEntry(result, f.client);
      assert.match(result.stdout, /写入软链接/);
      assert.equal(await readFile(f.client, 'utf8'), source);
      assert.deepEqual(await readdir(f.bin), []);
      await assert.rejects(stat(f.rc), {code:'ENOENT'});
      const direct = spawnSync(process.execPath, [f.client], {encoding:'utf8', timeout:10000});
      assert.equal(direct.status, 0, direct.stderr);
      assert.equal(direct.stdout, 'fixture client\n');
    } finally { await chmod(f.bin, 0o700); }
  });

test('POSIX installer completes when the bin directory cannot be created', {skip:notPosix}, async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.bin), {recursive:true});
  await writeFile(f.bin, 'existing file');
  const result = f.run();
  assertInstalledWithoutEntry(result, f.client);
  assert.match(result.stdout, /无法创建目录/);
  assert.equal(await readFile(f.client, 'utf8'), source);
  assert.equal(await readFile(f.bin, 'utf8'), 'existing file');
  await assert.rejects(stat(f.rc), {code:'ENOENT'});
});

test('POSIX installer links the client normally and adds PATH only once', {skip:notPosix}, async t => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /安装完成：gpuctl login/);
    assert.doesNotMatch(result.stdout, /未创建 gpuctl/);
  }
  assert.equal(await readlink(join(f.bin, 'gpuctl')), f.client);
  assert.equal(await readFile(f.client, 'utf8'), source);
  assert.equal((await stat(f.client)).mode & 0o777, 0o700);
  assert.deepEqual((await readFile(f.rc, 'utf8')).trim().split('\n'), [pathLine]);
});

test('POSIX installer reports a PATH write failure after creating a valid entry', {skip:notPosix}, async t => {
  const f = await fixture(t);
  await mkdir(f.rc);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /已创建命令入口.*无法更新/);
  assert.ok(result.stderr.includes(pathLine));
  assert.equal(await readlink(join(f.bin, 'gpuctl')), f.client);
});

test('POSIX installer rejects a broken download before replacing the client', {skip:notPosix}, async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.client), {recursive:true});
  await writeFile(f.client, 'previous client');
  await writeFile(f.payload, 'export const broken = ;\n');
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /安装完成/);
  assert.equal(await readFile(f.client, 'utf8'), 'previous client');
  await assert.rejects(stat(f.bin), {code:'ENOENT'});
});
