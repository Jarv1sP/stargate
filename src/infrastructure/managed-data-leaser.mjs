import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';
import {jsonProcess} from './json-process.mjs';
import {parseDataReadRequest} from '../contracts/data-read.mjs';
import {parseManagedLeaseRequest, parseManagedLeaseResult} from '../contracts/managed-data-lease.mjs';
import {ApplicationError} from '../domain/errors.mjs';

const script = fileURLToPath(new URL('./legacy-data-leaser.py', import.meta.url));
export class ManagedDataLeaser {
  #roots = new Map();
  #delegated = new Set();
  constructor({machineId, roots, leaseVersions = [], python = 'python3', timeoutMs = 5000}) {
    if (typeof machineId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(machineId)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Invalid lease configuration');
    for (const {kind, root, mountPoint = null} of roots) {
      if (!['cache', 'warehouse'].includes(kind) || this.#roots.has(kind) || typeof root !== 'string' || !isAbsolute(root)
        || (mountPoint !== null && (typeof mountPoint !== 'string' || !isAbsolute(mountPoint)))) throw new TypeError('Invalid lease root');
      this.#roots.set(kind, {kind, root, mountPoint});
    }
    for (const value of leaseVersions) {
      const source = parseDataReadRequest({machineId, source: value}).source;
      const key = `${source.kind}/${source.datasetId}/${source.version}`;
      if (!this.#roots.has(source.kind) || this.#delegated.has(key)) throw new TypeError('Invalid delegated lease version');
      this.#delegated.add(key);
    }
    this.machineId = machineId; this.python = python; this.timeoutMs = timeoutMs;
  }
  acquire(request, context) {return this.#call('acquire', request, context);}
  lookup(request, context) {return this.#call('lookup', request, context);}
  /** Private finalizer: callers must already hold the original native completion. */
  close(request, context) {return this.#call('close', request, context);}
  async #call(operation, request, {actor} = {}) {
    const input = parseManagedLeaseRequest(request), {source} = input;
    if (input.machineId !== this.machineId) throw new ApplicationError('SOURCE_NODE_MISMATCH');
    if (typeof actor?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(actor.id)) throw new ApplicationError('UNAUTHENTICATED');
    const root = this.#roots.get(source.kind);
    if (!root) throw new ApplicationError('MANAGED_DATA_LEASE_UNAVAILABLE');
    const leaseVersion = this.#delegated.has(`${source.kind}/${source.datasetId}/${source.version}`)
      ? {dataset: source.datasetId, version: source.version} : null;
    try {
      const {result} = await jsonProcess({program: this.python, args: ['-B', script], timeoutMs: this.timeoutMs,
        input: {operation, config: {...root, leaseVersion}, request: {userId: actor.id, jobId: input.jobId, dataset: source.datasetId, version: source.version, kind: source.kind}}});
      if (result === null && operation === 'lookup') return null;
      if (result.dataset !== source.datasetId || result.version !== source.version || result.kind !== source.kind
        || result.jobId !== input.jobId || result.accountId !== actor.id) throw new Error('Lease identity mismatch');
      if (operation === 'close') {
        if (typeof result.closed !== 'boolean' || typeof result.released !== 'boolean' || !Number.isSafeInteger(result.removedLeases)
          || result.removedLeases < 0) throw new Error('Lease closure is not confirmed');
        return {...input, accountId: actor.id, closed: result.closed, released: result.released, removedLeases: result.removedLeases};
      }
      return parseManagedLeaseResult({machineId: this.machineId, source, jobId: result.jobId, accountId: result.accountId,
        leaseId: result.leaseId, readOnly: result.readOnly});
    } catch (cause) {
      let code; try {code = JSON.parse(cause.stdout).error?.code;} catch {}
      throw new ApplicationError(code === 'FORBIDDEN' ? code : 'MANAGED_DATA_LEASE_UNAVAILABLE', {cause});
    }
  }
}
