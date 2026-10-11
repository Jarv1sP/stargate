import {parseProjectReference, parseProjectRuntimeObservation} from './project-inspection.mjs';
import {InvalidRequest, InvalidResponse} from './errors.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function parseProjectRunRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'generation,jobId,machineId,project,projectUUID,release'
    || !uuid(value.jobId) || !uuid(value.projectUUID) || typeof value.generation !== 'string' || !/^[a-f0-9]{64}$/.test(value.generation)) {
    throw new InvalidRequest('projectRun');
  }
  return {...parseProjectReference({machineId: value.machineId, project: value.project, release: value.release}),
    jobId: value.jobId, projectUUID: value.projectUUID, generation: value.generation};
}

export function parseProjectRunResult(value) {
  if (!value || !uuid(value.jobId) || value.runPrepared !== true) throw new InvalidResponse();
  const {jobId, runPrepared, ...observation} = value;
  return {...parseProjectRuntimeObservation(observation), jobId, runPrepared};
}
