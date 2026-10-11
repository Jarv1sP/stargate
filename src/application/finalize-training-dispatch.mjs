import {ApplicationError} from '../domain/errors.mjs';
import {requireCompletionIdentity} from '../domain/training-completion.mjs';

/** Background lifecycle processing, independent of interactive login and read APIs. */
export class FinalizeTrainingDispatch {
  constructor({dispatches, completions, nodes, observations, clock = Date.now}) {
    this.dispatches = dispatches; this.completions = completions;
    this.nodes = nodes; this.observations = observations; this.clock = clock;
  }

  async execute(dispatchId) {
    const existing = await this.completions.get(dispatchId);
    if (existing) return {kind: 'completed', completion: existing};
    const dispatch = await this.dispatches.delivery(dispatchId);
    if (!dispatch || dispatch.state !== 'ACCEPTED') throw new ApplicationError('TRAINING_DISPATCH_NOT_ACCEPTED');
    const reference = {machineId: dispatch.machineId, dispatchId};
    let completed = await this.nodes.lookup(reference);
    if (completed === null) {
      const observation = await this.observations.observe(reference);
      if (observation === null) return {kind: 'unconfirmed', dispatch};
      requireCompletionIdentity(dispatch, observation.receipt);
      if (observation.state === 'LOST') return {kind: 'unconfirmed', dispatch, state: observation.state};
      if (!['SUCCEEDED', 'FAILED', 'CANCELED'].includes(observation.state)) return {kind: 'active', dispatch, state: observation.state};
      completed = await this.nodes.finalize(reference);
    }
    requireCompletionIdentity(dispatch, completed.receipt);
    return {kind: 'completed', completion: await this.completions.settle(completed, this.clock())};
  }
}
