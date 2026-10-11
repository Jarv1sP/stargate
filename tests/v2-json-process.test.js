import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {jsonProcess} from '../src/infrastructure/json-process.mjs';

test('native JSON transport sends structured input without shell interpretation', async () => {
  const input = {value: '$(not-a-command); 中文'};
  const result = await jsonProcess({program: process.execPath, args: ['-e',
    "const fs=require('node:fs');process.stdout.write(JSON.stringify({result:JSON.parse(fs.readFileSync(0,'utf8'))}))"], input});
  assert.deepEqual(result, {result: input});
});

test('invalid bounds and excessive input are rejected before starting a program', async () => {
  const options = {program: '/no/such/program', args: [], input: {value: 'x'.repeat(100)}};
  await assert.rejects(jsonProcess({...options, timeoutMs: 0}), /bounds/);
  await assert.rejects(jsonProcess({...options, maxBytes: 10}), error => error.code === 'NATIVE_REQUEST_TOO_LARGE');
});

test('malformed or oversized native output cannot be treated as a successful response', async () => {
  await assert.rejects(jsonProcess({program: process.execPath, args: ['-e', "process.stdout.write('not-json')"], input: {}}), SyntaxError);
  await assert.rejects(jsonProcess({program: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(10000))"], input: {}, maxBytes: 64}),
    error => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
});

test('a stuck native query is terminated by its configured deadline', async () => {
  await assert.rejects(jsonProcess({program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], input: {}, timeoutMs: 50}),
    error => error.killed === true);
});

test('a missing native executable preserves its launch error', async () => {
  await assert.rejects(jsonProcess({program: '/no/such/program', args: [], input: {}}),
    error => error.code === 'ENOENT');
});

test('a rejected native query preserves its structured error for the calling adapter', async () => {
  const stdout = JSON.stringify({error: {code: 'FORBIDDEN'}});
  await assert.rejects(jsonProcess({program: process.execPath, args: ['-e',
    `require('node:fs').readFileSync(0); process.stdout.write(${JSON.stringify(stdout)}); process.exitCode=1`], input: {}}),
  error => error.code === 1 && error.stdout === stdout);
});

for (const mode of ['timeout', 'stdout', 'stderr', 'parent-exit']) {
  test(`native query reaps its helper and stops descendants on ${mode}`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'v2-query-group-'));
    const receipt = join(folder, 'pids.json');
    let pids;
    const descendant = "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)";
    const script = `
      const fs = require('node:fs');
      fs.readFileSync(0);
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
        {stdio:['ignore','pipe','inherit']});
      child.stdout.once('data', () => {
        fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify([process.pid, child.pid]));
        if (${JSON.stringify(mode)} === 'parent-exit') { process.stdout.write('{}'); process.exit(0); }
        if (${JSON.stringify(mode)} === 'stdout') process.stdout.write('x'.repeat(10000));
        if (${JSON.stringify(mode)} === 'stderr') process.stderr.write('x'.repeat(10000));
      });
      process.on('SIGTERM',()=>{});
      setInterval(()=>{},1000);
    `;
    try {
      const result = jsonProcess({program: process.execPath, args: ['-e', script], input: {}, timeoutMs: 2000, maxBytes: 1024});
      if (mode === 'parent-exit') assert.deepEqual(await result, {});
      else await assert.rejects(result, error => error.code === (mode === 'timeout' ? 'ETIMEDOUT' : 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'));
      pids = JSON.parse(await readFile(receipt, 'utf8'));
      for (const pid of pids) {
        // Linux may retain an orphan's zombie until init reaps it; it cannot
        // execute or retain an open pipe. The direct helper must be reaped.
        let state;
        for (let attempt = 0; attempt < 100; attempt++) {
          try { state = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1][0]; }
          catch (error) {
            // A process may disappear between procfs open and read. Reopen to
            // prove absence; ESRCH by itself is not a successful cleanup check.
            if (error.code === 'ESRCH') continue;
            if (error.code !== 'ENOENT') throw error;
            state = null;
          }
          if (state === null || (pid === pids[1] && state === 'Z')) break;
          await delay(10);
        }
        assert.ok(state === null || (pid === pids[1] && state === 'Z'), `query process ${pid} still live: ${state}`);
      }
    } finally {
      // If the assertion fails, never leave the fixture running.
      pids ??= await readFile(receipt, 'utf8').then(JSON.parse, () => []);
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await rm(folder, {recursive: true, force: true});
    }
  });
}
