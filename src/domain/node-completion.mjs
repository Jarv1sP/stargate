import {ApplicationError} from './errors.mjs';

/** The native adapter parses the wire; this rule binds its proof to our task. */
export function requireNativeCompletion(binding, receipt) {
  if (!receipt || receipt.submit_key !== binding.dispatchId || receipt.grant_id !== binding.dispatchId
    || receipt.submit_digest !== binding.nativeDigest) throw new ApplicationError('NODE_COMPLETION_IDENTITY_MISMATCH');
}
