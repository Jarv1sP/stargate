import {readTransaction} from './transaction.mjs';

/** Internal work discovery only. Dispatch records, not this list, own state. */
export class SqliteDispatchWork {
  constructor({database}) {this.database = database;}

  pending({limit, after}) {
    return readTransaction(this.database, () => this.database.prepare(`
      SELECT d.dispatch_id,d.job_id,d.state,c.machine_id,q.priority,q.sequence
      FROM v2_training_queue q JOIN v2_training_dispatches d ON d.job_id=q.job_id
      JOIN v2_compute_claims c ON c.job_id=d.job_id
      WHERE d.state<>'ACCEPTED'
        AND (? IS NULL OR q.priority<? OR (q.priority=? AND q.sequence>?))
      ORDER BY q.priority DESC,q.sequence ASC LIMIT ?`)
      .all(after?.priority ?? null, after?.priority ?? null, after?.priority ?? null, after?.sequence ?? null, limit)
      .map(row => ({dispatchId: row.dispatch_id, jobId: row.job_id, machineId: row.machine_id,
        state: row.state, priority: row.priority, sequence: row.sequence})));
  }
}
