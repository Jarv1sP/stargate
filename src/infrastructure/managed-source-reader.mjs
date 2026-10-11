import {jsonProcess} from './json-process.mjs';
import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';
import {ApplicationError, TransientReadError} from '../domain/errors.mjs';
import {parseDataReadRequest} from '../contracts/data-read.mjs';

const script = fileURLToPath(new URL('./legacy-cache-reader.py', import.meta.url));

/** Node-local adapter. The caller never supplies a root, interpreter or admin flag. */
export class ManagedSourceReader {
  #roots = new Map();
  #coordinatorVersions = new Set();
  constructor({machineId, roots, coordinatorVersions = [], python = 'python3', timeoutMs = 5000}) {
    if (typeof machineId !== 'string' || !machineId || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid managed reader configuration');
    for (const {kind, root, mountPoint = null} of roots) {
      if (!['cache', 'warehouse'].includes(kind) || this.#roots.has(kind) || typeof root !== 'string' || !isAbsolute(root)
        || (mountPoint !== null && (typeof mountPoint !== 'string' || !isAbsolute(mountPoint)))) throw new TypeError('Invalid managed root configuration');
      this.#roots.set(kind, {kind, root, mountPoint});
    }
    for (const source of coordinatorVersions) {
      const parsed = parseDataReadRequest({machineId, source}).source;
      const key = `${parsed.kind}/${parsed.datasetId}/${parsed.version}`;
      if (parsed.kind === 'directory' || !this.#roots.has(parsed.kind) || this.#coordinatorVersions.has(key)) {
        throw new TypeError('Invalid coordinator-owned version');
      }
      this.#coordinatorVersions.add(key);
    }
    this.machineId = machineId;
    this.python = python;
    this.timeoutMs = timeoutMs;
  }

  async inspect(request, {actor, timeoutMs = this.timeoutMs} = {}) {
    const result = await this.#call('inspect', request, actor, Math.min(timeoutMs, this.timeoutMs));
    if (result.availability === 'available' && Object.keys(result).length === 4) return {availability: 'available'};
    if (result.availability === 'unavailable' && result.reason === 'not-ready' && Object.keys(result).length === 5) return {availability: 'unavailable', reason: 'not-ready'};
    throw new ApplicationError('SOURCE_UNAVAILABLE');
  }

  async exportAccess(request, {actor} = {}) {
    const result = await this.#call('export-access', request, actor);
    if (Object.keys(result).length !== 5 || !Array.isArray(result.legacyOwners) || !result.legacyOwners.length
      || result.legacyOwners.length > 10000 || !result.legacyOwners.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(id))
      || new Set(result.legacyOwners).size !== result.legacyOwners.length || !/^[a-f0-9]{64}$/.test(result.snapshotId)) {
      throw new ApplicationError('SOURCE_UNAVAILABLE');
    }
    return {machineId: request.machineId, source: {...request.source}, legacyOwners: [...result.legacyOwners], snapshotId: result.snapshotId};
  }

  async #call(operation, request, actor, timeoutMs = this.timeoutMs) {
    if (request.machineId !== this.machineId) throw new ApplicationError('SOURCE_NODE_MISMATCH');
    if (!actor?.id) throw new ApplicationError('UNAUTHENTICATED');
    const source = request.source, config = this.#roots.get(source.kind);
    if (!config) throw new ApplicationError('SOURCE_UNAVAILABLE');
    try {
      const coordinatorVersion = this.#coordinatorVersions.has(`${source.kind}/${source.datasetId}/${source.version}`)
        ? {dataset: source.datasetId, version: source.version} : null;
      const response = await jsonProcess({program: this.python, args: ['-B', script], timeoutMs,
        input: {operation, config: {...config, coordinatorVersion}, request: {
        userId: actor.id, dataset: source.datasetId, version: source.version, kind: source.kind,
      }}});
      const result = response.result;
      if (result?.dataset !== source.datasetId || result?.version !== source.version || result?.kind !== source.kind) throw new Error('Managed source identity mismatch');
      return result;
    } catch (cause) {
      let code;
      try {code = JSON.parse(cause.stdout).error?.code;} catch {}
      if (code === 'FORBIDDEN') throw new ApplicationError('FORBIDDEN');
      if (code === 'SOURCE_BUSY') throw new TransientReadError('SOURCE_BUSY', {cause});
      if (cause.code === 'ETIMEDOUT') throw new TransientReadError('SOURCE_READ_TIMEOUT', {cause});
      throw new ApplicationError('SOURCE_UNAVAILABLE', {cause});
    }
  }
}
