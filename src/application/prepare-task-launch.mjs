import {ApplicationError} from '../domain/errors.mjs';
import {requirePreparedSources} from '../domain/launch-authorization.mjs';

/** Recover the original prepared record before making one preparation request. */
export class PrepareTaskLaunch {
  constructor({contexts, nodes}) {this.contexts = contexts; this.nodes = nodes;}
  async execute(jobId) {
    const input = await this.contexts.read(jobId), snapshot = JSON.stringify(input);
    const current = async () => {
      if (JSON.stringify(await this.contexts.read(jobId)) !== snapshot) throw new ApplicationError('TRAINING_CONTEXT_CHANGED');
    };
    const reference = {machineId: input.binding.machineId, dispatchId: input.binding.dispatchId};
    let prepared;
    try {prepared = await this.nodes.lookup(reference);}
    finally {await current();}
    if (prepared === null) {
      try {prepared = await this.nodes.prepare(input);}
      finally {await current();}
    }
    if (prepared === null || Object.keys(input.binding).some(key => prepared.binding[key] !== input.binding[key])
      || Object.keys(input.project).some(key => prepared.project[key] !== input.project[key])) {
      throw new ApplicationError('NODE_PREPARATION_CONFLICT');
    }
    requirePreparedSources(input.submission.dataSources, prepared.inputs);
    return prepared;
  }
}
