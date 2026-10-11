import {parseDispatchIdentity, parseDispatchReceiptRequest} from './dispatch-receipt.mjs';
import {parseTrainingSubmission} from './training-submission.mjs';
import {parseLaunchProject, parseLaunchAuthorization, launchAuthorizationRequest} from './launch-authorization.mjs';
import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const NODE_PREPARATION_ROUTES = {prepare: '/internal/v2/dispatch/prepare', lookup: '/internal/v2/dispatch/prepared'};
export const NODE_PREPARATION_MAX_BYTES = 131072;
export const NODE_PREPARATION_REPLY_BYTES = 65536;
export {parseDispatchReceiptRequest as parseNodePreparationReference};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function parseNodePreparation(value) {
  if (!exact(value, ['binding', 'submission', 'project'])) throw new InvalidRequest('preparation');
  return {binding: parseDispatchIdentity(value.binding), submission: parseTrainingSubmission(value.submission), project: parseLaunchProject(value.project)};
}

export function parseNodePreparationResult(value) {
  if (value === null) return null;
  try {
    if (!exact(value, ['binding', 'project', 'inputs', 'planDigest']) || typeof value.planDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.planDigest)) throw new InvalidResponse();
    const {planDigest, ...proof} = value;
    return {...parseLaunchAuthorization(proof), planDigest};
  } catch {throw new InvalidResponse();}
}

export function nodePreparationResult(value) {
  return value === null ? null : parseNodePreparationResult({...launchAuthorizationRequest(value), planDigest: value.planDigest});
}
