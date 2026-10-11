import {ApplicationError} from './errors.mjs';

// Readers parse external fields at the process/HTTP boundary. Here we decide
// whether that observation belongs to this request and is usable for this step.
function requireProjectIdentity(actor, request, observed) {
  if (observed.accountId !== actor.id || observed.machineId !== request.machineId
    || observed.project !== request.project || observed.release !== request.release) {
    throw new ApplicationError('PROJECT_OBSERVATION_INVALID');
  }
  if (observed.lifecycle !== 'ACTIVE') throw new ApplicationError('PROJECT_NOT_ACTIVE');
}

export function requireProjectObservation(actor, request, observed) {
  requireProjectIdentity(actor, request, observed);
  if (observed.runtimeVerified !== false) throw new ApplicationError('PROJECT_OBSERVATION_INVALID');
}

export function requireProjectRuntimeObservation(actor, request, observed) {
  requireProjectIdentity(actor, request, observed);
  if (observed.runtimeIdentityVerified !== true) {
    throw new ApplicationError('PROJECT_OBSERVATION_INVALID');
  }
}
