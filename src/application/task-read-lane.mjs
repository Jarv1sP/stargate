import {ApplicationError, TransientReadError} from '../domain/errors.mjs';

function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const finish = callback => value => {signal.removeEventListener('abort', aborted); callback(value);};
    const aborted = () => finish(reject)(signal.reason);
    work.then(finish(resolve), finish(reject));
    signal.addEventListener('abort', aborted, {once: true});
    if (signal.aborted) aborted();
  });
}

function delay(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => {clearTimeout(timer); reject(signal.reason);};
    const timer = setTimeout(() => {signal.removeEventListener('abort', aborted); resolve();}, ms);
    signal.addEventListener('abort', aborted, {once: true});
  });
}

/** One explicitly shared read lane. This object has no submission/mutation API. */
export class TaskReadLane {
  #active = 0;
  #machines = new Map();
  constructor({nodes, totalLimit = 8, machineLimit = 4, timeoutMs = 40000, maxAttempts = 2, clock = () => performance.now()}) {
    if (![totalLimit, machineLimit, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0)
      || timeoutMs > 2147483647 || ![1, 2].includes(maxAttempts)) throw new TypeError('Invalid task read bounds');
    this.nodes = nodes; this.totalLimit = totalLimit; this.machineLimit = machineLimit;
    this.timeoutMs = timeoutMs; this.maxAttempts = maxAttempts; this.clock = clock;
  }

  observe(reference, options) {return this.#run('observe', reference, options);}
  logs(reference, options) {return this.#run('logs', reference, options);}
  diagnostics(reference, options) {return this.#run('diagnostics', reference, options);}

  async #run(operation, reference, {signal, check = async () => {}} = {}) {
    signal?.throwIfAborted();
    reference = structuredClone(reference);
    const count = this.#machines.get(reference.machineId) ?? 0;
    if (this.#active >= this.totalLimit || count >= this.machineLimit) throw new ApplicationError('TASK_READ_BUSY');
    this.#active++; this.#machines.set(reference.machineId, count + 1);
    const controller = new AbortController(), deadline = this.clock() + this.timeoutMs;
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new ApplicationError('TASK_READ_TIMEOUT')), this.timeoutMs);
    const work = this.#read(operation, reference, {signal: controller.signal, deadline, check});
    const release = () => {
      this.#active--;
      const remaining = this.#machines.get(reference.machineId) - 1;
      if (remaining) this.#machines.set(reference.machineId, remaining); else this.#machines.delete(reference.machineId);
    };
    // Client completion is not proof that the underlying read stopped. Keep the
    // permit until the actual work settles, including a cancellation-ignoring adapter.
    work.then(release, release);
    try {return await abortable(work, controller.signal);}
    finally {clearTimeout(timer); signal?.removeEventListener('abort', abort);}
  }

  async #read(operation, reference, {signal, deadline, check}) {
    for (let attempt = 0; ; attempt++) {
      const remaining = this.#remaining(signal, deadline);
      try {
        const value = await this.nodes[operation](structuredClone(reference), {signal, timeoutMs: Math.min(27000, Math.ceil(remaining))});
        this.#remaining(signal, deadline);
        return value;
      } catch (error) {
        signal.throwIfAborted();
        await check();
        const remaining = this.#remaining(signal, deadline);
        if (!(error instanceof TransientReadError) || attempt + 1 >= this.maxAttempts || remaining <= 250) throw error;
        await delay(250, signal);
        await check();
      }
    }
  }

  #remaining(signal, deadline) {
    signal.throwIfAborted();
    const remaining = deadline - this.clock();
    if (remaining <= 0) throw new ApplicationError('TASK_READ_TIMEOUT');
    return remaining;
  }
}
