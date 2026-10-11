import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {jsonProcess} from './json-process.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {NODE_JOB_OBSERVATION_MAX_BYTES} from '../contracts/task-read.mjs';

const script = fileURLToPath(new URL('./gpuq-job-observer.py', import.meta.url));
export class GpuqJobObserver {
  constructor({socketPath, python = 'python3', timeoutMs = 5000}) {
    if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new TypeError('Invalid GPUQ socket');
    this.socketPath = socketPath; this.python = python; this.timeoutMs = timeoutMs;
  }
  async observe({submitKey}, {signal, timeoutMs = this.timeoutMs} = {}) {
    signal?.throwIfAborted();
    if (typeof submitKey !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(submitKey)) throw new ApplicationError('INVALID_NATIVE_SUBMIT_KEY');
    try {
      const response = await jsonProcess({program: this.python, args: ['-B', script], timeoutMs: Math.min(timeoutMs, this.timeoutMs), signal,
        maxBytes: NODE_JOB_OBSERVATION_MAX_BYTES, input: {socketPath: this.socketPath, submitKey}});
      if (!response || !Object.hasOwn(response, 'result')) throw new Error('Missing native job observation');
      return response.result;
    } catch (cause) {
      signal?.throwIfAborted();
      let code; try {code = JSON.parse(cause.stdout).error?.code;} catch {}
      throw new ApplicationError(cause.code === 'ETIMEDOUT' || code === 'TASK_READ_TIMEOUT' ? 'TASK_READ_TIMEOUT' : 'GPUQ_JOB_UNAVAILABLE', {cause});
    }
  }
}
