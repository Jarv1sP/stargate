import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {jsonProcess} from './json-process.mjs';
import {ApplicationError} from '../domain/errors.mjs';

const script = fileURLToPath(new URL('./gpuq-managed.py', import.meta.url));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 4096;

/** Node-private adapter. No retry or downgrade to ordinary unmanaged submit. */
export class GpuqManagedClient {
  constructor({socketPath, python = 'python3', timeoutMs = 5000, maxRequestBytes = 262144}) {
    if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw new TypeError('Invalid managed client configuration');
    this.socketPath = socketPath; this.python = python; this.timeoutMs = timeoutMs; this.maxRequestBytes = maxRequestBytes;
  }
  async submit({submission, grantId, maxGpus, expectedDigest}) {
    if (!uuid(submission?.submit_key) || !uuid(grantId) || !count(maxGpus)
      || (expectedDigest !== undefined && (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)))) throw new ApplicationError('INVALID_MANAGED_REQUEST');
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
  async #call(operation, args, submitKey, grantId, expectedDigest) {
    const uncertain = operation === 'status' ? 'NATIVE_ALLOCATION_UNAVAILABLE' : 'NATIVE_OUTCOME_UNCONFIRMED';
    try {
      const {result} = await jsonProcess({program: this.python, args: ['-B', script], timeoutMs: this.timeoutMs, maxBytes: 2 * 1024 * 1024,
        input: {socketPath: this.socketPath, operation, args, maxRequestBytes: this.maxRequestBytes,
          ...(expectedDigest === undefined ? {} : {expectedDigest})}});
      if (result === null && operation === 'status') return null;
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
