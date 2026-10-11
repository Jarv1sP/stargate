import {NodeJsonTransport} from './node-json-transport.mjs';
import {NODE_SUBMISSION_ROUTE, parseNodeSubmission, parseNodeSubmissionResult} from '../contracts/node-submission.mjs';
import {ApplicationError} from '../domain/errors.mjs';

/** One write attempt. Read retries and cancellation do not apply to this call. */
export class HttpNodeSubmissions {
  constructor(options) {this.transport = new NodeJsonTransport(options);}
  async send(request) {
    const input = parseNodeSubmission(request);
    try {
      const result = parseNodeSubmissionResult(await this.transport.request(input.machineId, NODE_SUBMISSION_ROUTE, input));
      const identity = result.kind === 'accepted' ? result.receipt : result;
      if (identity.machineId !== input.machineId || identity.dispatchId !== input.dispatchId) throw new Error('Node send receipt identity mismatch');
      return result;
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      throw new ApplicationError('DISPATCH_SEND_UNCONFIRMED', {cause});
    }
  }
}
