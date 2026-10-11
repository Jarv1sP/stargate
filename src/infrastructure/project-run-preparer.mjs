import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {jsonProcess} from './json-process.mjs';
import {parseProjectInspection} from '../contracts/project-inspection.mjs';
import {parseProjectRunRequest, parseProjectRunResult} from '../contracts/project-run.mjs';
import {ApplicationError} from '../domain/errors.mjs';

const script = fileURLToPath(new URL('./project-run-preparer.py', import.meta.url));
export class ProjectRunPreparer {
  #config;
  constructor({machineId, root, basePath, runtimeConfig = {}, python = 'python3', timeoutMs = 5000}) {
    if (typeof root !== 'string' || !isAbsolute(root) || typeof basePath !== 'string' || !isAbsolute(basePath)) throw new TypeError('Invalid project roots');
    this.machineId = machineId; this.python = python; this.timeoutMs = timeoutMs;
    this.#config = {root, basePath, runtimeConfig: structuredClone(runtimeConfig)};
  }
  async prepare(request, {actor} = {}) {
    const input = parseProjectRunRequest(request);
    const identity = parseProjectInspection({machineId: input.machineId, project: input.project, release: input.release, accountId: actor?.id});
    if (input.machineId !== this.machineId) throw new ApplicationError('PROJECT_NODE_MISMATCH');
    try {
      const {machineId, ...reference} = input;
      const {result} = await jsonProcess({program: this.python, args: ['-B', script], timeoutMs: this.timeoutMs,
        input: {config: this.#config, request: {...reference, accountId: identity.accountId}}});
      const prepared = parseProjectRunResult({...result, machineId});
      if (Object.entries(input).some(([key, value]) => prepared[key] !== value) || prepared.accountId !== identity.accountId) throw new Error('Project preparation identity mismatch');
      return prepared;
    } catch (cause) {
      let code;
      try {code = JSON.parse(cause.stdout).error?.code;} catch {}
      throw new ApplicationError(['PROJECT_INSTANCE_CHANGED','PROJECT_RUN_CONFLICT','PROJECT_NOT_ACTIVE','PROJECT_RUNTIME_CHANGED'].includes(code) ? code : 'PROJECT_RUN_UNAVAILABLE', {cause});
    }
  }
}
