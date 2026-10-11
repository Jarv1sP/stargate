import {ApplicationError} from '../domain/errors.mjs';

/** Node-private send: persisted spec, fresh admission, managed native submit, exact receipt. */
export class SubmitNodeDispatch {
  constructor({bindings, receipts, admission, native}) {
    this.bindings = bindings; this.receipts = receipts; this.admission = admission; this.native = native;
  }
  async execute({machineId, dispatchId}) {
    const reference = {machineId, dispatchId};
    const existing = await this.receipts.execute(reference);
    if (existing !== null) return {kind: 'accepted', receipt: existing};
    const launch = await this.bindings.launch(reference);
    if (!launch) throw new ApplicationError('NODE_LAUNCH_NOT_PREPARED');
    const {binding, submission} = launch;
    const approval = await this.admission.acquire({...binding});
    const fields = ['dispatchId', 'jobId', 'accountId', 'machineId', 'gpuCount', 'requestHash'];
    if (!approval || approval.scope !== 'launch-ready' || fields.some(field => approval[field] !== binding[field]) || approval.grantId !== dispatchId) {
      throw new ApplicationError('NODE_LAUNCH_NOT_AUTHORIZED');
    }
    // Native cap is the initial reserved quota, not the elastic submission maximum.
    const submitted = await this.native.submit({submission, grantId: dispatchId, maxGpus: binding.gpuCount});
    try {
      const receipt = await this.receipts.execute(reference);
      if (receipt === null) return {kind: 'unconfirmed', ...reference};
      if (receipt.nodeJobId !== submitted.job_id) throw new Error('Submitted and observed native jobs differ');
      return {kind: 'accepted', receipt};
    } catch (cause) {throw new ApplicationError('NATIVE_OUTCOME_UNCONFIRMED', {cause});}
  }
}
