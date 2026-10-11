import {ApplicationError} from '../domain/errors.mjs';
import {requireSameTaskRead, projectNodeJobObservation} from '../domain/task-read.mjs';

/** Independent observations: no dashboard rebuild, task mutation or retry of a write. */
export class ReadTrainingTask {
  constructor({tasks, nodes, clock = Date.now}) {this.tasks = tasks; this.nodes = nodes; this.clock = clock;}
  async execute(actor, {jobId}, {signal} = {}) {
    signal?.throwIfAborted();
    const before = await this.tasks.snapshot(actor, jobId, this.clock());
    const check = async () => {
      const current = await this.tasks.snapshot(actor, jobId, this.clock());
      requireSameTaskRead(before.binding, current.binding);
    };
    let observation = {kind: 'not-queried', node: null}, after;
    try {
      if (before.task.dispatch && before.task.dispatch.state !== 'PREPARED') {
        signal?.throwIfAborted();
        const node = await this.nodes.observe({machineId: before.binding.machineId, dispatchId: before.binding.dispatchId}, {signal, check});
        observation = {kind: node === null ? 'not-observed' : 'observed', node};
      }
    } catch (error) {
      if (error.code !== 'NODE_JOB_UNAVAILABLE') throw error;
      observation = {kind: 'unavailable', node: null};
    } finally {
      after = await this.tasks.snapshot(actor, jobId, this.clock());
      requireSameTaskRead(before.binding, after.binding);
      signal?.throwIfAborted();
    }
    if (observation.node) {
      const {receipt} = observation.node;
      if (['jobId', 'accountId', 'requestHash', 'dispatchId', 'machineId', 'gpuCount'].some(key => receipt[key] !== after.binding[key])
        || (after.binding.nodeJobId !== null && receipt.nodeJobId !== after.binding.nodeJobId)) throw new ApplicationError('TASK_OBSERVATION_MISMATCH');
    }
    return {task: after.task, observation};
  }
}

/** Node service only; public callers cannot choose a native job ID or host path. */
export class ObserveNodeJob {
  constructor({bindings, native}) {this.bindings = bindings; this.native = native;}
  async execute(reference, {signal} = {}) {
    signal?.throwIfAborted();
    const binding = await this.bindings.get(reference);
    if (binding === null) return null;
    const native = await this.native.observe({submitKey: binding.dispatchId, machineId: binding.machineId}, {signal});
    signal?.throwIfAborted();
    return native === null ? null : projectNodeJobObservation(binding, native);
  }
}
