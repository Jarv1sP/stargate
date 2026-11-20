import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import packageInfo from '../package.json' with {type:'json'};

const source = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const artifact = new URL('../build/gpuctl.mjs', import.meta.url);

test('source and standalone gpuctl report the client version without opening a session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gpuctl-version-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const session = join(dir, 'session.json');
  await writeFile(session, 'unreadable session JSON');
  // Run the bundled artifact by itself, outside the checkout.
  const text = await readFile(artifact, 'utf8'), standalone = join(dir, 'gpuctl.mjs');
  const {revision} = JSON.parse(/\n\/\/ STARGATE_BUILD_INFO (.+)\n$/.exec(text)[1]);
  assert.ok(revision, 'release test must identify the build');
  await writeFile(standalone, text);
  const env = {...process.env, GPUQ_SESSION_FILE:session, GPUQ_URL:'not a portal URL'};
  for (const [entry, build] of [[source, 'source'], [standalone, revision]]) {
    for (const flag of ['--version', '-V']) {
      const result = spawnSync(process.execPath, [entry, flag], {cwd:dir, env, encoding:'utf8', timeout:10000});
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout.trim(), `gpuctl ${packageInfo.version} (${build})`);
    }
  }
  const help = spawnSync(process.execPath, [standalone, '--help'], {cwd:dir, env, encoding:'utf8', timeout:10000});
  assert.match(help.stdout, /gpuctl --version \/ -V/);
});

test('gpuctl still rejects an unknown command', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gpuctl-unknown-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const session = join(dir, 'session.json'), url = 'http://127.0.0.1:1';
  await writeFile(session, JSON.stringify({url, token:'fixture', principal:{userId:'fixture'}}));
  // Existing logged-in commands read pending announcements before dispatch.
  const stub = 'data:text/javascript,' + encodeURIComponent(
    'globalThis.fetch = async () => Response.json({ok:true,result:{posts:[]}});');
  const result = spawnSync(process.execPath, ['--import', stub, source, '--url', url, '--session-file', session, 'no-such-command'],
    {encoding:'utf8', timeout:10000});
  assert.equal(result.status, 1, String(result.error ?? result.stderr));
  assert.match(result.stderr, /Unknown command/);
  assert.equal(result.stdout, '');
});
