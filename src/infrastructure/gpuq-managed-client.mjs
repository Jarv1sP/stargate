import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {jsonProcess} from './json-process.mjs';
import {ApplicationError} from '../domain/errors.mjs';

const script = fileURLToPath(new URL('./gpuq-managed.py', import.meta.url));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 4096;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const time = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

export function parseNativeCompletionReceipt(result, {submitKey, grantId, expectedDigest}) {
  if (!exact(result, ['protocol', 'job_id', 'submit_key', 'submit_digest', 'grant_id', 'grant_revision', 'state',
    'native_version', 'finished_at', 'sealed_at', 'latest_attempt']) || result.protocol !== 'managed-completion-v1'
    || result.submit_key !== submitKey || typeof result.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.job_id)
    || !digest(result.submit_digest) || !uuid(result.grant_id)
    || (grantId !== undefined && result.grant_id !== grantId) || (expectedDigest !== undefined && result.submit_digest !== expectedDigest)
    || !Number.isSafeInteger(result.grant_revision) || result.grant_revision < 1
    || !Number.isSafeInteger(result.native_version) || result.native_version < 0
    || !['SUCCEEDED', 'FAILED', 'CANCELED'].includes(result.state)
    || !time(result.finished_at) || result.sealed_at === null || !time(result.sealed_at)) throw new Error('Invalid completion receipt');
  const attempt = result.latest_attempt;
  if (attempt !== null && (!exact(attempt, ['id', 'ordinal', 'state', 'exit_code'])
    || typeof attempt.id !== 'string' || !/^A[a-f0-9]{32}$/.test(attempt.id)
    || !Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 1
    || !['EXITED_SUCCESS', 'EXITED_FAILURE', 'CANCELED', 'PREEMPTED'].includes(attempt.state)
    || (attempt.exit_code !== null && !Number.isSafeInteger(attempt.exit_code)))) throw new Error('Invalid completion attempt');
  if (result.state === 'SUCCEEDED' && (attempt?.state !== 'EXITED_SUCCESS' || attempt.exit_code !== 0)) throw new Error('Success attempt missing');
  return result;
}

/** Node-private adapter. No retry or downgrade to ordinary unmanaged submit. */
export class GpuqManagedClient {
  constructor({socketPath, python = 'python3', timeoutMs = 5000, maxRequestBytes = 262144}) {
    if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw new TypeError('Invalid managed client configuration');
    this.socketPath = socketPath; this.python = python; this.timeoutMs = timeoutMs; this.maxRequestBytes = maxRequestBytes;
  }
  async submit({submission, grantId, maxGpus, expectedDigest}) {
    if (!uuid(submission?.submit_key) || !uuid(grantId) || !count(maxGpus)
      || (expectedDigest !== undefined && !digest(expectedDigest))) throw new ApplicationError('INVALID_MANAGED_REQUEST');
    return this.#call('submit', {submission, grant_id: grantId, max_gpu_count: maxGpus}, submission.submit_key, grantId, expectedDigest);
  }
  async allocation({submitKey}) {
    if (!uuid(submitKey)) throw new ApplicationError('INVALID_MANAGED_REQUEST');
    return this.#call('status', {submit_key: submitKey}, submitKey);
  }
  async updateAllocation({submitKey, grantId, expectedRevision, maxGpus}) {
    if (!uuid(submitKey) || !uuid(grantId) || !count(maxGpus) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ApplicationError('INVALID_MANAGED_REQUEST');
    return this.#call('update', {submit_key: submitKey, grant_id: grantId, expected_revision: expectedRevision, max_gpu_count: maxGpus}, submitKey, grantId);
  }
  /** Seal native execution only; data leases and platform quota remain separate. */
  async complete({submitKey, grantId, expectedDigest}) {
    if (!uuid(submitKey) || !uuid(grantId) || !digest(expectedDigest)) throw new ApplicationError('INVALID_MANAGED_REQUEST');
    return this.#call('complete', {submit_key: submitKey, grant_id: grantId, submit_digest: expectedDigest}, submitKey, grantId);
  }
  async completion({submitKey}) {
    if (!uuid(submitKey)) throw new ApplicationError('INVALID_MANAGED_REQUEST');
    return this.#call('completion', {submit_key: submitKey}, submitKey);
  }
  async #call(operation, args, submitKey, grantId, expectedDigest) {
    const uncertain = {status: 'NATIVE_ALLOCATION_UNAVAILABLE', completion: 'NATIVE_COMPLETION_UNAVAILABLE'}[operation] ?? 'NATIVE_OUTCOME_UNCONFIRMED';
    try {
      const {result} = await jsonProcess({program: this.python, args: ['-B', script], timeoutMs: this.timeoutMs, maxBytes: 2 * 1024 * 1024,
        input: {socketPath: this.socketPath, operation, args, maxRequestBytes: this.maxRequestBytes,
          ...(expectedDigest === undefined ? {} : {expectedDigest})}});
      if (result === null && ['status', 'completion'].includes(operation)) return null;
      if (['complete', 'completion'].includes(operation)) return parseNativeCompletionReceipt(result, {submitKey, grantId, expectedDigest: args.submit_digest});
      if (!result || result.submit_key !== submitKey || typeof result.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.job_id)) throw new Error('Managed reply identity mismatch');
      if (['native', 'external-v1'].includes(result.mode) && result.grant === null && operation === 'status') return result;
      const grant = result.grant;
      if (result.mode !== 'external-v1' || !grant || !uuid(grant.grant_id) || !Number.isSafeInteger(grant.revision) || grant.revision < 1
        || !count(grant.max_gpu_count) || (grantId !== undefined && grant.grant_id !== grantId)) throw new Error('Invalid allocation reply');
      if (operation === 'update' && (grant.max_gpu_count !== args.max_gpu_count
        || ![args.expected_revision, args.expected_revision + 1].includes(grant.revision))) throw new Error('Grant update reply mismatch');
      return result;
    } catch (cause) {
      let error;
      try {error = JSON.parse(cause.stdout).error;} catch {}
      if (cause.code === 'NATIVE_REQUEST_TOO_LARGE') error = {code: 'INVALID_MANAGED_REQUEST'};
      if (['INVALID_MANAGED_REQUEST', 'NATIVE_OPERATION_REJECTED'].includes(error?.code)) {
        const failure = new ApplicationError(error.code, {cause});
        if (error.nativeCode) failure.nativeCode = error.nativeCode;
        throw failure;
      }
      throw new ApplicationError(uncertain, {cause});
    }
  }
}
