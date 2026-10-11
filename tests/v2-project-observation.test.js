import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProjectObservation, parseProjectRuntimeObservation} from '../src/contracts/project-inspection.mjs';
import {requireProjectObservation, requireProjectRuntimeObservation} from '../src/domain/project-observation.mjs';
import {HttpProjectReader} from '../src/infrastructure/http-project-reader.mjs';
import {RegisterProjectRelease} from '../src/application/register-project-release.mjs';

const actor = {id: 'alice'};
const reference = {machineId: 'node-1', project: 'training', release: 'a'.repeat(64)};
const identity = {accountId: actor.id, ...reference, projectUUID: '12345678-1234-1234-1234-123456789abc',
  generation: 'b'.repeat(64), environmentMode: 'shared', lifecycle: 'ACTIVE'};
const metadata = {...identity, runtimeVerified: false};
const runtime = {...identity, runtimeIdentityVerified: true, runtime: {kind: 'base', identity: 'c'.repeat(64)}};
const hasCode = code => error => error.code === code;
const nodes = [{machineId: 'node-1', origin: 'https://node.example', credential: 'd'.repeat(64)}];

function malformedObservations(valid) {
  return [null, [], {}, {...valid, hostPath: '/private'},
    ...Object.keys(valid).map(field => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field))),
    ...Object.entries({accountId: '', machineId: '../other', project: '../training', release: 'not-a-hash',
      projectUUID: 'not-a-uuid', generation: 'not-a-hash', environmentMode: 'unknown', lifecycle: 'unknown'})
      .map(([key, value]) => ({...valid, [key]: value}))];
}

test('external project metadata is parsed before registration, including fields no longer rechecked by the domain', async () => {
  let response = metadata, calls = 0, writes = 0;
  const projects = new HttpProjectReader({nodes, fetch: async () => {
    calls++; return Response.json({result: response});
  }});
  const registrations = {async authorize() {}, async register(_actor, _request, observed) {writes++; return observed;}};
  const app = new RegisterProjectRelease({registrations, projects});
  for (const invalid of [...malformedObservations(metadata), {...metadata, runtimeVerified: true}]) {
    assert.throws(() => parseProjectObservation(invalid), hasCode('INVALID_API_RESPONSE'));
    response = invalid;
    const before = calls;
    await assert.rejects(app.execute(actor, {...reference, projectId: 'logical'}), hasCode('PROJECT_NODE_UNAVAILABLE'));
    assert.equal(calls, before + 1);
    assert.equal(writes, 0);
  }
  response = metadata;
  assert.deepEqual(await app.execute(actor, {...reference, projectId: 'logical'}), metadata);
  assert.equal(writes, 1);
});

test('external runtime shape and environment consistency remain enforced at the reader boundary', async () => {
  let response = runtime;
  const projects = new HttpProjectReader({nodes, fetch: async () => Response.json({result: response})});
  for (const invalid of [...malformedObservations(runtime), metadata,
    {...runtime, runtimeIdentityVerified: false}, {...runtime, lifecycle: 'ARCHIVED'},
    ...[null, {}, {kind: 'base', identity: 'invalid'}, {kind: 'oci', identity: 'sha256:' + 'c'.repeat(64)},
      {...runtime.runtime, hostPath: '/private'}].map(value => ({...runtime, runtime: value}))]) {
    assert.throws(() => parseProjectRuntimeObservation(invalid), hasCode('INVALID_API_RESPONSE'));
    response = invalid;
    await assert.rejects(projects.verifyRuntime(reference, {actor}), hasCode('PROJECT_NODE_UNAVAILABLE'));
  }
  for (const environmentMode of ['shared', 'isolated', 'oci']) {
    response = {...runtime, environmentMode, runtime: environmentMode === 'oci'
      ? {kind: 'oci', identity: 'sha256:' + 'c'.repeat(64)} : runtime.runtime};
    const observed = await projects.verifyRuntime(reference, {actor});
    assert.deepEqual(observed, response);
    assert.doesNotThrow(() => requireProjectRuntimeObservation(actor, reference, observed));
  }
});

test('domain rules still reject mismatched requests, inactive projects and metadata used as runtime readiness', () => {
  for (const [observed, requireObservation] of [[metadata, requireProjectObservation], [runtime, requireProjectRuntimeObservation]]) {
    assert.doesNotThrow(() => requireObservation(actor, reference, observed));
    for (const [key, value] of Object.entries({accountId: 'bob', machineId: 'node-2', project: 'another', release: 'f'.repeat(64)})) {
      assert.throws(() => requireObservation(actor, reference, {...observed, [key]: value}), hasCode('PROJECT_OBSERVATION_INVALID'));
    }
    assert.throws(() => requireObservation(actor, reference, {...observed, lifecycle: 'ARCHIVED'}), hasCode('PROJECT_NOT_ACTIVE'));
  }
  assert.throws(() => requireProjectRuntimeObservation(actor, reference, metadata), hasCode('PROJECT_OBSERVATION_INVALID'));
  assert.throws(() => requireProjectObservation(actor, reference, runtime), hasCode('PROJECT_OBSERVATION_INVALID'));
});
