import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {jsonProcess} from './json-process.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {NODE_JOB_OBSERVATION_MAX_BYTES} from '../contracts/task-read.mjs';

const script = fileURLToPath(new URL('./gpuq-job-observer.py', import.meta.url));
const logScript = fileURLToPath(new URL('./gpuq-job-logs.py', import.meta.url));
export class GpuqJobObserver {
  constructor({socketPath, logRoot = null, python = 'python3', timeoutMs = 5000}) {
    if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new TypeError('Invalid GPUQ socket');
    if (logRoot !== null && (typeof logRoot !== 'string' || !isAbsolute(logRoot))) throw new TypeError('Invalid configured log root');
    this.socketPath = socketPath; this.python = python; this.timeoutMs = timeoutMs;
    this.logRoot = logRoot;
  }
  observe(reference, options) {return this.#query('job_observation', reference, options);}
  diagnostics(reference, options) {return this.#query('job_diagnostics', reference, options);}
  async #query(operation, {submitKey}, {signal, timeoutMs = this.timeoutMs} = {}) {
    signal?.throwIfAborted();
    if (typeof submitKey !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(submitKey)) throw new ApplicationError('INVALID_NATIVE_SUBMIT_KEY');
    try {
      const response = await jsonProcess({program: this.python, args: ['-B', script], timeoutMs: Math.min(timeoutMs, this.timeoutMs), signal,
        maxBytes: NODE_JOB_OBSERVATION_MAX_BYTES, input: {socketPath: this.socketPath, submitKey, operation}});
      if (!response || !Object.hasOwn(response, 'result')) throw new Error('Missing native job observation');
      return response.result;
    } catch (cause) {
      signal?.throwIfAborted();
      let code; try {code = JSON.parse(cause.stdout).error?.code;} catch {}
      throw new ApplicationError(cause.code === 'ETIMEDOUT' || code === 'TASK_READ_TIMEOUT' ? 'TASK_READ_TIMEOUT' : 'GPUQ_JOB_UNAVAILABLE', {cause});
    }
  }

  async logs({binding, cursor}, {signal, timeoutMs = this.timeoutMs} = {}) {
    signal?.throwIfAborted();
    if (this.logRoot === null) throw new ApplicationError('TASK_LOG_UNAVAILABLE');
    try {
      const response = await jsonProcess({program: this.python, args: ['-B', logScript], signal,
        timeoutMs: Math.min(timeoutMs, this.timeoutMs), maxBytes: 131072,
        input: {socketPath: this.socketPath, logRoot: this.logRoot, binding, request: cursor}});
      if (!response || !Object.hasOwn(response, 'result')) throw new Error('Missing log result');
      return response.result;
    } catch (cause) {
      signal?.throwIfAborted();
      let code; try {code = JSON.parse(cause.stdout).error?.code;} catch {}
      if (cause.code === 'ETIMEDOUT') code = 'TASK_READ_TIMEOUT';
      throw new ApplicationError(['TASK_LOG_CHANGED', 'TASK_READ_TIMEOUT'].includes(code) ? code : 'TASK_LOG_UNAVAILABLE', {cause});
    }
  }
}
