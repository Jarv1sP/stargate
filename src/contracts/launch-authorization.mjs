import {parseDispatchIdentity} from './dispatch-receipt.mjs';
import {parseDataSource} from './data-read.mjs';
import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const LAUNCH_AUTHORIZATION_ROUTE = '/internal/v2/dispatch/authorize-launch';
export const LAUNCH_AUTHORIZATION_MAX_BYTES = 65536;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function parseLaunchAuthorization(value) {
  if (!exact(value, ['binding', 'project', 'inputs'])) throw new InvalidRequest('launch');
  const binding = parseDispatchIdentity(value.binding), project = parseLaunchProject(value.project);
  if (!Array.isArray(value.inputs) || value.inputs.length > 100) throw new InvalidRequest('inputs');
  const inputs = value.inputs.map(input => {
    const source = parseDataSource(input?.source);
    if (!exact(input, source.kind === 'directory' ? ['source'] : ['source', 'leaseId'])
      || (source.kind !== 'directory' && !uuid(input.leaseId))) throw new InvalidRequest('inputs');
    return source.kind === 'directory' ? {source} : {source, leaseId: input.leaseId};
  });
  return {binding, project, inputs};
}

export function parseLaunchProject(project) {
  if (!exact(project, ['id', 'project', 'release', 'projectUUID', 'generation'])
    || typeof project.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(project.id)
    || typeof project.project !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(project.project)
    || !hash(project.release) || !hash(project.generation) || !uuid(project.projectUUID)) throw new InvalidRequest('project');
  return {...project};
}

/** Only permission evidence crosses back to the coordinator, not execution material. */
export function launchAuthorizationRequest({binding, project, inputs}) {
  return parseLaunchAuthorization({binding: {dispatchId: binding.dispatchId, jobId: binding.jobId, accountId: binding.accountId,
    machineId: binding.machineId, gpuCount: binding.gpuCount, requestHash: binding.requestHash},
    project: {id: project.id, project: project.project, release: project.release, projectUUID: project.projectUUID, generation: project.generation}, inputs});
}

export function parseLaunchApproval(value) {
  try {
    if (!exact(value, ['scope', 'grantId', 'dispatchId', 'jobId', 'accountId', 'machineId', 'gpuCount', 'requestHash'])
      || value.scope !== 'launch-ready' || value.grantId !== value.dispatchId) throw new InvalidResponse();
    const {scope, grantId, ...binding} = value;
    return {...parseDispatchIdentity(binding), scope, grantId};
  } catch {throw new InvalidResponse();}
}
