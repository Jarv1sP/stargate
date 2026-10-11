import {isDeepStrictEqual} from 'node:util';
import {transaction, readTransaction} from './transaction.mjs';
import {nodeDispatchBinding} from '../../domain/node-dispatch.mjs';
import {requireNativeCompletion} from '../../domain/node-completion.mjs';
import {parseNativeCompletionReceipt} from '../gpuq-managed-client.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

export const nodeCompletionsSchema = `CREATE TABLE v2_node_completions (
  dispatch_id TEXT PRIMARY KEY REFERENCES v2_node_runtime_plans(dispatch_id),
  plan_digest TEXT NOT NULL, native_receipt_json TEXT NOT NULL
)`;

/** Explicit upgrade only; ordinary reads never create or migrate tables. */
export function createNodeCompletionsSchema(database) {
  transaction(database, () => database.exec(nodeCompletionsSchema));
}

/** One completed data-cleanup receipt. Original bindings/plans stay authoritative. */
export class SqliteNodeCompletions {
  constructor({database, machineId}) {this.database = database; this.machineId = machineId;}

  #read(dispatchId) {
    const row = this.database.prepare(`SELECT c.*,b.binding_json FROM v2_node_completions c
      JOIN v2_node_dispatch_bindings b USING(dispatch_id) WHERE c.dispatch_id=?`).get(dispatchId);
    if (!row) return null;
    const binding = nodeDispatchBinding(JSON.parse(row.binding_json));
    if (binding.machineId !== this.machineId || binding.dispatchId !== dispatchId) throw new ApplicationError('NODE_COMPLETION_IDENTITY_MISMATCH');
    const native = parseNativeCompletionReceipt(JSON.parse(row.native_receipt_json),
      {submitKey: dispatchId, grantId: dispatchId, expectedDigest: binding.nativeDigest});
    return {binding, planDigest: row.plan_digest, native, dataReleased: true};
  }

  get({machineId, dispatchId}) {
    if (machineId !== this.machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
    return readTransaction(this.database, () => this.#read(dispatchId));
  }

  record({binding, planDigest, native}) {
    if (binding.machineId !== this.machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
    requireNativeCompletion(binding, native);
    return transaction(this.database, () => {
      const row = this.database.prepare(`SELECT p.plan_digest,b.binding_json FROM v2_node_runtime_plans p
        JOIN v2_node_dispatch_bindings b USING(dispatch_id) WHERE p.dispatch_id=?`).get(binding.dispatchId);
      if (!row || row.plan_digest !== planDigest) throw new ApplicationError('NODE_COMPLETION_PLAN_CHANGED');
      if (!isDeepStrictEqual(JSON.parse(row.binding_json), binding)) throw new ApplicationError('NODE_COMPLETION_IDENTITY_MISMATCH');
      const existing = this.#read(binding.dispatchId);
      if (existing) {
        if (existing.planDigest !== planDigest || !isDeepStrictEqual(existing.native, native)) throw new ApplicationError('NODE_COMPLETION_CONFLICT');
        return existing;
      }
      this.database.prepare('INSERT INTO v2_node_completions VALUES(?,?,?)').run(binding.dispatchId, planDigest, JSON.stringify(native));
      return this.#read(binding.dispatchId);
    });
  }
}
