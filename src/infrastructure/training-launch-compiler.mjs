import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {parseTrainingSubmission} from '../contracts/training-submission.mjs';
import {parseProjectRunResult} from '../contracts/project-run.mjs';
import {parseManagedLeaseResult} from '../contracts/managed-data-lease.mjs';
import {normalizeTrainingRequest, canonicalTrainingPayload} from '../domain/training-request.mjs';
import {nodeDispatchBinding} from '../domain/node-dispatch.mjs';
import {containerPathFor} from '../domain/data-source.mjs';
import {ApplicationError} from '../domain/errors.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const identityFields = ['dispatchId', 'jobId', 'accountId', 'machineId', 'gpuCount', 'requestHash'];
const sourceKey = source => JSON.stringify(source);

/** Private plan plus a fixed host wrapper; the user's command stays inside the plan. */
export class TrainingLaunchCompiler {
  #runner;
  #cwd;
  constructor({runner, cwd, resources, launchSpec}) {
    if (!Array.isArray(runner) || !runner.length || runner.some(part => typeof part !== 'string' || part.includes('\0'))
      || !isAbsolute(runner[0]) || typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('Invalid node runner configuration');
    this.#runner = [...runner]; this.#cwd = cwd;
    this.resources = resources; this.launchSpec = launchSpec;
  }

  /** Inputs come from the persisted task, registered node project and original lease receipts. */
  async compile({identity, submission, project, leases}, pool) {
    return this.compilePrepared(this.intent(identity, parseTrainingSubmission(submission)), {project, leases}, pool);
  }

  /** The shared wire parser owns shape validation; check intent before preparation writes. */
  intent(identity, submission) {
    const request = normalizeTrainingRequest(structuredClone(submission));
    const payload = canonicalTrainingPayload(request);
    if (identity.requestHash !== hash(payload)
      || (request.machines.kind === 'selected' && !request.machines.ids.includes(identity.machineId))) {
      throw new ApplicationError('NODE_RUNTIME_PLAN_IDENTITY_MISMATCH');
    }
    const paths = request.dataSources.map(containerPathFor);
    if (new Set(paths).size !== paths.length) throw new ApplicationError('TRAINING_DATA_PATH_CONFLICT');
    return {identity: Object.fromEntries(identityFields.map(key => [key, identity[key]])), request, payload};
  }

  async compilePrepared({identity, request, payload}, {project, leases}, pool) {
    const prepared = parseProjectRunResult(project.run);
    if (project.id !== request.project.id
      || prepared.release !== request.project.release || prepared.accountId !== identity.accountId
      || prepared.jobId !== identity.jobId || prepared.machineId !== identity.machineId) {
      throw new ApplicationError('NODE_RUNTIME_PLAN_IDENTITY_MISMATCH');
    }
    if (!Array.isArray(leases) || leases.length !== request.dataSources.filter(source => source.kind !== 'directory').length) {
      throw new ApplicationError('NODE_RUNTIME_PLAN_LEASE_MISMATCH');
    }
    const receipts = new Map();
    for (const input of leases) {
      const lease = parseManagedLeaseResult(input), key = sourceKey(lease.source);
      if (lease.accountId !== identity.accountId || lease.jobId !== identity.jobId || lease.machineId !== identity.machineId
        || receipts.has(key)) throw new ApplicationError('NODE_RUNTIME_PLAN_LEASE_MISMATCH');
      receipts.set(key, lease);
    }
    const inputs = request.dataSources.map(source => {
      if (source.kind === 'directory') return {source};
      const lease = receipts.get(sourceKey(source));
      if (!lease) throw new ApplicationError('NODE_RUNTIME_PLAN_LEASE_MISMATCH');
      return {source, leaseId: lease.leaseId};
    });
    // Canonical request keys include env ordering, but exclude the API requestId.
    // Keep exact JSON bytes: Python verifies these bytes, not a second JSON encoder.
    const plan = {schema: 1, identity: Object.fromEntries(identityFields.map(key => [key, identity[key]])),
      submission: JSON.parse(payload), project: {id: project.id, project: prepared.project, release: prepared.release,
        projectUUID: prepared.projectUUID, generation: prepared.generation, runtime: prepared.runtime}, inputs};
    const planJson = JSON.stringify(plan), planDigest = hash(planJson);
    const evaluated = await this.resources.execute(request, pool);
    const built = await this.launchSpec.build({...evaluated.resources, submit_key: identity.dispatchId,
      // Native name is a stable ASCII key. Unicode labels stay in the plan and
      // belong to GPUQ's separate display metadata, not this execution identity.
      name: 'v2-' + identity.jobId, owner: identity.accountId, cwd: this.#cwd,
      // This scheduler-owned marker enables child cgroup delegation for OCI.
      // User environment remains inside the private container plan.
      env: prepared.runtime.kind === 'oci' ? {GPUQ_CONSOLE_OCI: '1'} : {},
      argv: [...this.#runner, '--dispatch-id', identity.dispatchId, '--plan-digest', planDigest]}, pool);
    if (!built.allowedGpuCounts.includes(identity.gpuCount)) throw new ApplicationError('NODE_INITIAL_GPU_COUNT_INVALID');
    const binding = nodeDispatchBinding({...identity, nativeDigest: built.nativeDigest, nativeMaxGpus: built.submission.gpu_count,
      nativeOwner: built.submission.owner, nativeName: built.submission.name});
    return {binding, built, planJson, planDigest};
  }
}

/** Storage integrity, not a new authorization source or a public plan parser. */
export function verifyRuntimePlan({binding, built, planJson, planDigest}) {
  const plan = JSON.parse(planJson), argv = built.submission.argv;
  if (plan.schema !== 1 || hash(planJson) !== planDigest
    || identityFields.some(key => plan.identity[key] !== binding[key])
    || built.submission.submit_key !== binding.dispatchId
    || JSON.stringify(argv.slice(-4)) !== JSON.stringify(['--dispatch-id', binding.dispatchId, '--plan-digest', planDigest])) {
    throw new ApplicationError('NODE_RUNTIME_PLAN_IDENTITY_MISMATCH');
  }
}
