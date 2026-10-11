import {transaction, readTransaction} from './transaction.mjs';
import {nodeDispatchBinding} from '../../domain/node-dispatch.mjs';
import {ApplicationError} from '../../domain/errors.mjs';
import {verifyRuntimePlan} from '../training-launch-compiler.mjs';

const runtimePlanSchema = `CREATE TABLE v2_node_runtime_plans (
  dispatch_id TEXT PRIMARY KEY REFERENCES v2_node_launch_specs(dispatch_id),
  plan_json TEXT NOT NULL, plan_digest TEXT NOT NULL
)`;

/** Explicit upgrade of an existing experimental node store; never called on read. */
export function createNodeRuntimePlansSchema(database) {
  transaction(database, () => database.exec(runtimePlanSchema));
}

export function createNodeDispatchBindingsSchema(database) {
  transaction(database, () => database.exec(`CREATE TABLE v2_node_dispatch_bindings (
    dispatch_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL
  ); CREATE TABLE v2_node_launch_specs (
    dispatch_id TEXT PRIMARY KEY REFERENCES v2_node_dispatch_bindings(dispatch_id), submission_json TEXT NOT NULL
  ); ${runtimePlanSchema}`));
}

/** Node-local immutable mapping, written by the trusted launch builder, not public input. */
export class SqliteNodeDispatchBindings {
  constructor({database, machineId}) {this.database = database; this.machineId = machineId;}
  #read(dispatchId) {
    const row = this.database.prepare('SELECT binding_json FROM v2_node_dispatch_bindings WHERE dispatch_id=?').get(dispatchId);
    if (!row) return null;
    const binding = nodeDispatchBinding(JSON.parse(row.binding_json));
    if (binding.machineId !== this.machineId || binding.dispatchId !== dispatchId) throw new ApplicationError('NODE_DISPATCH_BINDING_CONFLICT');
    return binding;
  }
  bind(input) {
    const binding = nodeDispatchBinding(input);
    return transaction(this.database, () => this.#bind(binding));
  }
  #bind(binding) {
    if (binding.machineId !== this.machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
    const existing = this.#read(binding.dispatchId), payload = JSON.stringify(binding);
    if (existing) {
      if (JSON.stringify(existing) !== payload) throw new ApplicationError('NODE_DISPATCH_BINDING_CONFLICT');
      return existing;
    }
    this.database.prepare('INSERT INTO v2_node_dispatch_bindings VALUES(?,?)').run(binding.dispatchId, payload);
    return binding;
  }

  /** Called with normalized output from GpuqLaunchSpec; private execution material. */
  prepare(input, built) {
    return transaction(this.database, () => this.#prepare(input, built));
  }
  #prepare(input, built) {
    const binding = nodeDispatchBinding(input), submission = built.submission;
    if (built.nativeDigest !== binding.nativeDigest || submission.submit_key !== binding.dispatchId
      || submission.owner !== binding.nativeOwner || submission.name !== binding.nativeName
      || submission.gpu_count !== binding.nativeMaxGpus) throw new ApplicationError('NODE_LAUNCH_IDENTITY_MISMATCH');
    const payload = JSON.stringify(submission);
    this.#bind(binding);
    const existing = this.database.prepare('SELECT submission_json FROM v2_node_launch_specs WHERE dispatch_id=?').get(binding.dispatchId);
    if (existing && existing.submission_json !== payload) throw new ApplicationError('NODE_LAUNCH_SPEC_CONFLICT');
    if (!existing) this.database.prepare('INSERT INTO v2_node_launch_specs VALUES(?,?)').run(binding.dispatchId, payload);
    return {binding, submission: JSON.parse(existing?.submission_json ?? payload)};
  }

  /** Commit the plan, wrapper and mapping together; never retrofit another launch. */
  prepareTraining(compiled) {
    verifyRuntimePlan(compiled);
    return transaction(this.database, () => {
      const {binding} = this.#prepare(compiled.binding, compiled.built);
      const existing = this.database.prepare('SELECT plan_json,plan_digest FROM v2_node_runtime_plans WHERE dispatch_id=?').get(binding.dispatchId);
      if (existing && (existing.plan_json !== compiled.planJson || existing.plan_digest !== compiled.planDigest)) {
        throw new ApplicationError('NODE_RUNTIME_PLAN_CONFLICT');
      }
      if (!existing) this.database.prepare('INSERT INTO v2_node_runtime_plans VALUES(?,?,?)')
        .run(binding.dispatchId, compiled.planJson, compiled.planDigest);
      // A safe preparation receipt, not the user's argv/env or an execution grant.
      return {binding, planDigest: compiled.planDigest};
    });
  }

  /** Node executor only; public receipt queries never call this method. */
  launch({machineId, dispatchId}) {
    if (machineId !== this.machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
    return readTransaction(this.database, () => {
      const binding = this.#read(dispatchId);
      if (!binding) return null;
      const row = this.database.prepare('SELECT submission_json FROM v2_node_launch_specs WHERE dispatch_id=?').get(dispatchId);
      return row ? {binding, submission: JSON.parse(row.submission_json)} : null;
    });
  }

  /** Only compiled training plans can enter the new sender, not bare legacy specs. */
  training({machineId, dispatchId}) {
    if (machineId !== this.machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
    return readTransaction(this.database, () => {
      const binding = this.#read(dispatchId);
      if (!binding) return null;
      const row = this.database.prepare(`SELECT s.submission_json,p.plan_json,p.plan_digest
        FROM v2_node_launch_specs s JOIN v2_node_runtime_plans p USING(dispatch_id) WHERE s.dispatch_id=?`).get(dispatchId);
      if (!row) return null;
      const submission = JSON.parse(row.submission_json);
      verifyRuntimePlan({binding, built: {submission}, planJson: row.plan_json, planDigest: row.plan_digest});
      return {binding, submission, plan: JSON.parse(row.plan_json), planDigest: row.plan_digest};
    });
  }
  get({machineId, dispatchId}) {
    if (machineId !== this.machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
    return readTransaction(this.database, () => this.#read(dispatchId));
  }
}
