import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {projectFixture, python} from './helpers/v2-project-fixture.mjs';
import {ProjectRunPreparer} from '../src/infrastructure/project-run-preparer.mjs';

const context = {actor: {id: 'alice'}}, hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await projectFixture(t), observed = await f.reader.inspect(f.request, context);
  return {...f, request: {...f.request, jobId: randomUUID(), projectUUID: observed.projectUUID, generation: observed.generation},
    preparer: new ProjectRunPreparer({machineId: 'node-1', root: f.root, basePath: f.basePath, python})};
}

test('real native preparation records one job-bound run and returns no host paths', async t => {
  const f = await fixture(t);
  const result = await f.preparer.prepare(f.request, context);
  assert.equal(result.runPrepared, true); assert.equal(result.runtimeIdentityVerified, true);
  assert.equal(result.jobId, f.request.jobId); assert.equal(result.projectUUID, f.request.projectUUID);
  assert.equal(JSON.stringify(result).includes(f.root), false);
  const claimPath = join(f.root, 'projects-v2', '.run-claims', f.request.jobId + '.json');
  const claim = await readFile(claimPath, 'utf8');
  assert.deepEqual(await f.preparer.prepare(f.request, context), result);
  assert.equal(await readFile(claimPath, 'utf8'), claim);
  assert.equal(JSON.parse(claim).release, f.release);
});

test('wrong instance, node and caller injection never create run claims', async t => {
  const f = await fixture(t), folder = join(f.root, 'projects-v2', '.run-claims');
  const before = await readdir(folder);
  await assert.rejects(f.preparer.prepare({...f.request, generation: '0'.repeat(64)}, context), hasCode('PROJECT_INSTANCE_CHANGED'));
  await assert.rejects(f.preparer.prepare({...f.request, machineId: 'other'}, context), hasCode('PROJECT_NODE_MISMATCH'));
  await assert.rejects(f.preparer.prepare({...f.request, accountId: 'other'}, context), hasCode('INVALID_REQUEST'));
  await assert.rejects(f.preparer.prepare(f.request, {actor: {id: 'bob'}}), hasCode('PROJECT_RUN_UNAVAILABLE'));
  assert.deepEqual(await readdir(folder), before);
});

test('runtime changes reject preparation instead of silently adopting the new interpreter', async t => {
  const f = await fixture(t);
  await writeFile(join(f.basePath, 'bin/python3.12'), 'different synthetic base');
  await assert.rejects(f.preparer.prepare(f.request, context), hasCode('PROJECT_RUNTIME_CHANGED'));
  await assert.rejects(readFile(join(f.root, 'projects-v2', '.run-claims', f.request.jobId + '.json')), {code: 'ENOENT'});
});
