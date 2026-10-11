import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const PROJECT_INSPECTION_ROUTE = '/internal/v2/project/inspect';
export const PROJECT_RUNTIME_ROUTE = '/internal/v2/project/runtime';
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
const observationFields = ['accountId', 'machineId', 'project', 'release', 'projectUUID', 'generation', 'environmentMode', 'lifecycle'];

export function parseProjectInspection(value) {
  if (!exact(value, ['accountId', 'machineId', 'project', 'release'])) throw new InvalidRequest('request');
  if (typeof value.accountId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value.accountId)) throw new InvalidRequest('accountId');
  return {accountId: value.accountId, ...parseProjectReference({machineId: value.machineId, project: value.project, release: value.release})};
}

export function parseProjectReference(value) {
  if (!exact(value, ['machineId', 'project', 'release'])) throw new InvalidRequest('request');
  if (typeof value.machineId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.machineId)) throw new InvalidRequest('machineId');
  if (typeof value.project !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(value.project)) throw new InvalidRequest('project');
  if (typeof value.release !== 'string' || !/^[a-f0-9]{64}$/.test(value.release)) throw new InvalidRequest('release');
  return {machineId: value.machineId, project: value.project, release: value.release};
}

function parseObservationIdentity(value) {
  if (typeof value.projectUUID !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.projectUUID)
    || typeof value.generation !== 'string' || !/^[a-f0-9]{64}$/.test(value.generation)
    || !['shared', 'isolated', 'oci'].includes(value.environmentMode) || !['ACTIVE', 'ARCHIVED'].includes(value.lifecycle)) throw new InvalidResponse();
  const request = parseProjectInspection({accountId: value.accountId, machineId: value.machineId, project: value.project, release: value.release});
  return {...request, projectUUID: value.projectUUID, generation: value.generation, environmentMode: value.environmentMode, lifecycle: value.lifecycle};
}

export function parseProjectObservation(value) {
  try {
    if (!exact(value, [...observationFields, 'runtimeVerified']) || value.runtimeVerified !== false) throw new InvalidResponse();
    return {...parseObservationIdentity(value), runtimeVerified: false};
  } catch {throw new InvalidResponse();}
}

export function parseProjectRuntimeObservation(value) {
  try {
    if (!exact(value, [...observationFields, 'runtimeIdentityVerified', 'runtime'])
      || value.runtimeIdentityVerified !== true || value.lifecycle !== 'ACTIVE'
      || !exact(value.runtime, ['kind', 'identity'])) throw new InvalidResponse();
    const project = parseObservationIdentity(value), {runtime} = value;
    const oci = project.environmentMode === 'oci';
    if (runtime.kind !== (oci ? 'oci' : 'base') || typeof runtime.identity !== 'string'
      || !(oci ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(runtime.identity)) throw new InvalidResponse();
    return {...project, runtimeIdentityVerified: true, runtime: {...runtime}};
  } catch {throw new InvalidResponse();}
}
