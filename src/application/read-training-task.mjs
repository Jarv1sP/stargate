import {ApplicationError} from '../domain/errors.mjs';
import {requireSameTaskRead, projectNodeJobObservation} from '../domain/task-read.mjs';
import {nativeDispatchAcceptance} from '../domain/node-dispatch.mjs';
import {projectNodeDiagnostics, taskDiagnosticFindings, taskDiagnosticUnknowns} from '../domain/task-diagnostics.mjs';

/** Independent observations: no dashboard rebuild, task mutation or retry of a write. */
export class ReadTrainingTask {
  constructor({tasks, nodes, clock = Date.now}) {this.tasks = tasks; this.nodes = nodes; this.clock = clock;}
  async execute(actor, {jobId}, options) {
    const {task, kind, value} = await this.#read(actor, jobId, 'observe', {}, options);
    return {task, observation: {kind, node: value}};
  }
  async logs(actor, {jobId, ...cursor}, options) {
    const {task, kind, value} = await this.#read(actor, jobId, 'logs', cursor, options);
    return {task, log: {kind: kind === 'observed' ? 'chunk' : kind, chunk: value}};
  }
  async diagnostics(actor, {jobId}, options) {
    const {task, kind, value: node, quota} = await this.#read(actor, jobId, 'diagnostics', {}, options);
    return {task, diagnostics: {kind, node}, quota, findings: taskDiagnosticFindings({task, kind, node, quota}),
      unknowns: taskDiagnosticUnknowns(task)};
  }
  async #read(actor, jobId, operation, cursor, {signal} = {}) {
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
        const node = await this.nodes[operation]({...cursor, machineId: before.binding.machineId, dispatchId: before.binding.dispatchId}, {signal, check});
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
    return {task: after.task, kind: observation.kind, value: observation.node, quota: after.quota};
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

  async diagnostics(reference, {signal} = {}) {
    signal?.throwIfAborted();
    const binding = await this.bindings.get(reference);
    if (binding === null) return null;
    const native = await this.native.diagnostics({submitKey: binding.dispatchId, machineId: binding.machineId}, {signal});
    signal?.throwIfAborted();
    return native === null ? null : projectNodeDiagnostics(binding, native);
  }

  async logs({machineId, dispatchId, ...cursor}, {signal} = {}) {
    signal?.throwIfAborted();
    const binding = await this.bindings.get({machineId, dispatchId});
    if (binding === null) return null;
    const result = await this.native.logs({machineId, binding, cursor}, {signal});
    signal?.throwIfAborted();
    if (result === null) return null;
    const {nativeReceipt, ...chunk} = result;
    return {...chunk, receipt: nativeDispatchAcceptance(binding, nativeReceipt)};
  }
}
