import {ApplicationError} from '../domain/errors.mjs';

/** Coordinator single-send journal; recovery queries remain a separate use case. */
export class SendTrainingDispatch {
  constructor({dispatches, nodes, clock = Date.now}) {this.dispatches = dispatches; this.nodes = nodes; this.clock = clock;}
  async execute(jobId) {
    const permit = await this.dispatches.beginSend(jobId, this.clock());
    if (!permit.acquired) return {kind: 'existing', dispatch: permit.dispatch};
    const {dispatchId, machineId} = permit.dispatch;
    const uncertain = () => this.dispatches.recordSendOutcome({dispatchId, senderToken: permit.senderToken, nodeJobId: null});
    let outcome;
    try {outcome = await this.nodes.send({machineId, dispatchId});}
    catch (error) {await uncertain(); throw error;}
    if (outcome.kind === 'unconfirmed') return {kind: 'unconfirmed', dispatch: await uncertain()};
    if (outcome.receipt.dispatchId !== dispatchId || outcome.receipt.machineId !== machineId) {
      await uncertain();
      throw new ApplicationError('DISPATCH_OBSERVATION_MISMATCH');
    }
    try {
      return {kind: 'accepted', dispatch: await this.dispatches.confirmAcceptance(outcome.receipt)};
    } catch (error) {
      if (error.code === 'DISPATCH_OBSERVATION_MISMATCH') await uncertain();
      throw error;
    }
  }
}
