import {ApplicationError} from '../domain/errors.mjs';

const projectFields = ['id', 'project', 'release', 'projectUUID', 'generation'];

/** One node-service instance coalesces preparation by the original dispatch.
 * Persistent project claims, data leases and final plans retain their own IDs.
 * No copy, node selection, native send, or release is hidden in this workflow.
 */
export class PrepareNodeWorkload {
  #pending = new Map();
  constructor({compiler, bindings, projects, leaser, pools}) {
    this.compiler = compiler; this.bindings = bindings; this.projects = projects; this.leaser = leaser; this.pools = pools;
  }
  async lookup(reference) {
    const stored = await this.bindings.training(reference);
    return stored ? {binding: stored.binding, planDigest: stored.planDigest, project: stored.plan.project, inputs: stored.plan.inputs} : null;
  }
  async execute({binding, submission, project}) {
    const intent = this.compiler.intent(binding, submission), selected = structuredClone(project);
    if (selected.id !== intent.request.project.id || selected.release !== intent.request.project.release) {
      throw new ApplicationError('NODE_RUNTIME_PLAN_IDENTITY_MISMATCH');
    }
    const {dispatchId} = intent.identity;
    const key = JSON.stringify([intent.identity, ...projectFields.map(field => selected[field])]);
    const pending = this.#pending.get(dispatchId);
    if (pending) {
      if (pending.key !== key) throw new ApplicationError('NODE_PREPARATION_CONFLICT');
      return structuredClone(await pending.operation);
    }
    const operation = this.#prepare(intent, selected).finally(() => this.#pending.delete(dispatchId));
    this.#pending.set(dispatchId, {key, operation});
    return structuredClone(await operation);
  }
  async #prepare(intent, project) {
    const {identity, request} = intent;
    const reference = {machineId: identity.machineId, dispatchId: identity.dispatchId};
    const existing = await this.lookup(reference);
    if (existing) {
      if (Object.keys(identity).some(key => existing.binding[key] !== identity[key])
        || projectFields.some(key => existing.project[key] !== project[key])) throw new ApplicationError('NODE_PREPARATION_CONFLICT');
      return existing;
    }
    const context = {actor: {id: identity.accountId}};
    const run = await this.projects.prepare({machineId: identity.machineId, jobId: identity.jobId,
      project: project.project, release: project.release, projectUUID: project.projectUUID, generation: project.generation}, context);
    const leases = [];
    for (const source of request.dataSources) {
      if (source.kind === 'directory') continue;
      const input = {machineId: identity.machineId, jobId: identity.jobId, source: {...source}};
      const existingLease = await this.leaser.lookup(input, context);
      leases.push(existingLease ?? await this.leaser.acquire(input, context));
    }
    const pool = await this.pools.inspect({machineId: identity.machineId});
    const compiled = await this.compiler.compilePrepared(intent, {project: {id: project.id, run}, leases}, pool);
    await this.bindings.prepareTraining(compiled);
    return this.lookup(reference);
  }
}
