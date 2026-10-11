import {parseDispatchReceiptRequest, parseDispatchReceipt} from './dispatch-receipt.mjs';
import {InvalidResponse} from './errors.mjs';

export const NODE_SUBMISSION_ROUTE = '/internal/v2/dispatch/submit';
export {parseDispatchReceiptRequest as parseNodeSubmission};

export function parseNodeSubmissionResult(value) {
  try {
    if (value?.kind === 'accepted' && Object.keys(value).sort().join(',') === 'kind,receipt') {
      const receipt = parseDispatchReceipt(value.receipt);
      if (receipt === null) throw new InvalidResponse();
      return {kind: 'accepted', receipt};
    }
    if (value?.kind === 'unconfirmed' && Object.keys(value).sort().join(',') === 'dispatchId,kind,machineId') {
      return {kind: 'unconfirmed', ...parseDispatchReceiptRequest({machineId: value.machineId, dispatchId: value.dispatchId})};
    }
    throw new InvalidResponse();
  } catch {throw new InvalidResponse();}
}
