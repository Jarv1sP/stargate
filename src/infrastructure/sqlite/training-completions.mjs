import {isDeepStrictEqual} from 'node:util';
import {transaction, readTransaction} from './transaction.mjs';
import {parseNodeCompletion} from '../../contracts/node-completion.mjs';
import {requireCompletionIdentity} from '../../domain/training-completion.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

export const trainingCompletionsSchema = `CREATE TABLE v2_training_completions (
  dispatch_id TEXT PRIMARY KEY REFERENCES v2_training_dispatches(dispatch_id),
  completion_json TEXT NOT NULL, settled_at_ms INTEGER NOT NULL
)`;

export function createTrainingCompletionsSchema(database) {
  transaction(database, () => database.exec(trainingCompletionsSchema));
}

/** One transaction owns terminal history, quota release and pending expansion closure. */
export class SqliteTrainingCompletions {
  constructor({database}) {this.database = database;}

  #read(dispatchId) {
    const row = this.database.prepare('SELECT * FROM v2_training_completions WHERE dispatch_id=?').get(dispatchId);
    return row ? {...parseNodeCompletion(JSON.parse(row.completion_json)), settledAtMs: row.settled_at_ms} : null;
  }

  get(dispatchId) {return readTransaction(this.database, () => this.#read(dispatchId));}

  settle(value, now) {
    const completed = parseNodeCompletion(value);
    if (completed === null) throw new ApplicationError('TRAINING_COMPLETION_UNCONFIRMED');
    const {dispatchId, jobId} = completed.receipt;
    return transaction(this.database, () => {
      const db = this.database;
      const row = db.prepare(`SELECT d.state,d.dispatch_id dispatchId,d.job_id jobId,d.node_job_id nodeJobId,
        c.machine_id machineId,c.gpu_count gpuCount,c.state quotaState,j.account_id accountId,j.payload_hash requestHash
        FROM v2_training_dispatches d JOIN v2_compute_claims c USING(job_id)
        JOIN v2_training_requests j USING(job_id) WHERE dispatch_id=?`).get(dispatchId);
      if (!row || row.state !== 'ACCEPTED') throw new ApplicationError('TRAINING_DISPATCH_NOT_ACCEPTED');
      requireCompletionIdentity(row, completed.receipt);
      const existing = this.#read(dispatchId);
      if (existing) {
        const {settledAtMs, ...previous} = existing;
        if (!isDeepStrictEqual(previous, completed)) throw new ApplicationError('TRAINING_COMPLETION_CONFLICT');
        return existing;
      }
      if (row.quotaState !== 'HELD') throw new ApplicationError('COMPUTE_CLAIM_NOT_HELD');
      db.prepare('INSERT INTO v2_training_completions VALUES(?,?,?)').run(dispatchId, JSON.stringify(completed), now);
      db.prepare("UPDATE v2_compute_claims SET state='RELEASED' WHERE job_id=?").run(jobId);
      // Native completion has sealed all future allocation; late scale replies
      // cannot apply to this released claim. Keep applied expansion history intact.
      db.prepare("UPDATE v2_compute_expansions SET state='RELEASED',resolution_json=? WHERE job_id=? AND state='RESERVED'")
        .run(JSON.stringify({reason: 'TASK_COMPLETED', dispatchId}), jobId);
      return this.#read(dispatchId);
    });
  }
}
