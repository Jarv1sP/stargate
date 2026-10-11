import {ApplicationError} from '../domain/errors.mjs';
import {requireNativeCompletion} from '../domain/node-completion.mjs';

/** Native execution ends first; then fence/release only this task's data leases. */
export class FinalizeNodeDispatch {
  constructor({bindings, native, leaser, completions}) {
    this.bindings = bindings; this.native = native; this.leaser = leaser; this.completions = completions;
  }

  async execute(reference) {
    const existing = await this.completions.get(reference);
    if (existing) return existing;
    const launch = await this.bindings.training(reference);
    if (!launch) throw new ApplicationError('NODE_LAUNCH_NOT_PREPARED');
    const {binding, plan, planDigest} = launch;
    let receipt = await this.native.completion({submitKey: binding.dispatchId});
    if (receipt === null) receipt = await this.native.complete({submitKey: binding.dispatchId,
      grantId: binding.dispatchId, expectedDigest: binding.nativeDigest});
    requireNativeCompletion(binding, receipt);
    const context = {actor: {id: binding.accountId}};
    for (const {source} of plan.inputs) {
      if (source.kind === 'directory') continue;
      const result = await this.leaser.close({machineId: binding.machineId, jobId: binding.jobId, source}, context);
      if (result?.closed !== true || result.released !== true) throw new ApplicationError('NODE_DATA_RELEASE_UNCONFIRMED');
    }
    return this.completions.record({binding, planDigest, native: receipt});
  }
}
