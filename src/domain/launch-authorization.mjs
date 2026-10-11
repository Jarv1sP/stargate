import {ApplicationError} from './errors.mjs';

const sameSource = (left, right) => left.kind === right.kind && (left.kind === 'directory'
  ? left.sourceId === right.sourceId : left.datasetId === right.datasetId && left.version === right.version);

/** Match the prepared node record to the original request and current catalogue.
 * This is not another filesystem-readiness scan or a new data-lease acquisition.
 */
export function requireLaunchPreparation({submission, machineId, project, inputs, snapshot}) {
  const instance = snapshot.instances.find(row => row.machineId === machineId);
  if (project.id !== submission.project.id || project.release !== submission.project.release
    || !snapshot.candidates.some(row => row.machineId === machineId) || !instance
    || project.project !== instance.project || project.projectUUID !== instance.projectUUID || project.generation !== instance.generation) {
    throw new ApplicationError('NODE_LAUNCH_PROJECT_CHANGED');
  }
  if (inputs.length !== submission.dataSources.length || inputs.some((input, index) =>
    !sameSource(input.source, submission.dataSources[index]) || (input.source.kind !== 'directory' && !input.leaseId))) {
    throw new ApplicationError('NODE_LAUNCH_INPUTS_CHANGED');
  }
}
