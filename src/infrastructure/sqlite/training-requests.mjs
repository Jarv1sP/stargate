import {createHash, randomUUID} from 'node:crypto';
import {transaction, readTransaction} from './transaction.mjs';
import {SqliteSessionReader} from './session-reader.mjs';
import {requireActiveSession} from '../../domain/session-policy.mjs';
import {normalizeTrainingRequest, canonicalTrainingPayload} from '../../domain/training-request.mjs';
import {ApplicationError} from '../../domain/errors.mjs';
import {parseTrainingSubmission} from '../../contracts/training-submission.mjs';

export function createTrainingRequestSchema(database) {
  transaction(database, () => database.exec(`CREATE TABLE v2_training_requests (
    job_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES v2_accounts(id),
    task_name TEXT NOT NULL, description TEXT NOT NULL,
    submitter_username TEXT NOT NULL, submitter_name TEXT NOT NULL,
    payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state='RECORDED'), created_at_ms INTEGER NOT NULL
  ); CREATE TABLE v2_training_cancellations (
    job_id TEXT PRIMARY KEY REFERENCES v2_training_requests(job_id),
    canceled_by TEXT NOT NULL REFERENCES v2_accounts(id), canceled_at_ms INTEGER NOT NULL
  )`));
}

function receipt(row) {
  return {jobId: row.job_id, requestId: row.request_id, state: row.state, name: row.task_name, description: row.description,
    submitter: {accountId: row.account_id, username: row.submitter_username, displayName: row.submitter_name}, createdAtMs: row.created_at_ms};
}

/** Durable input journal only. Does not enqueue, admit, allocate or start work. */
export class SqliteTrainingRequests {
  constructor({database}) {this.database = database; this.sessions = new SqliteSessionReader({database});}
  #authorize(actor, now) {requireActiveSession(this.sessions.findByActor(actor), now);}

  record(actor, input, now) {
    return transaction(this.database, () => this.recordWithinTransaction(actor, input, now));
  }

  /** Caller owns the write transaction, e.g. atomic input plus queue insertion. */
  recordWithinTransaction(actor, input, now) {
    const db = this.database;
    this.#authorize(actor, now);
    let parsed;
    try {parsed = parseTrainingSubmission(input);}
    catch (cause) {throw new ApplicationError('INVALID_TRAINING_REQUEST', {cause});}
    const request = normalizeTrainingRequest(parsed);
    const payload = canonicalTrainingPayload(request);
    const digest = createHash('sha256').update(payload).digest('hex');
    const existing = db.prepare('SELECT * FROM v2_training_requests WHERE request_id=?').get(request.requestId);
    if (existing) {
      if (existing.account_id !== actor.id) throw new ApplicationError('FORBIDDEN');
      if (existing.payload_hash !== digest) throw new ApplicationError('TRAINING_REQUEST_CONFLICT');
      return receipt(existing);
    }
    const account = db.prepare('SELECT username,display_name FROM v2_accounts WHERE id=?').get(actor.id);
    const jobId = randomUUID();
    db.prepare(`INSERT INTO v2_training_requests(job_id,request_id,account_id,task_name,description,
      submitter_username,submitter_name,payload_json,payload_hash,state,created_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,'RECORDED',?)`).run(jobId, request.requestId, actor.id, request.name, request.description,
        account.username, account.display_name, payload, digest, now);
    return receipt(db.prepare('SELECT * FROM v2_training_requests WHERE job_id=?').get(jobId));
  }

  get(actor, requestId, now) {
    return readTransaction(this.database, () => this.getWithinTransaction(actor, requestId, now));
  }

  getWithinTransaction(actor, requestId, now) {
    this.#authorize(actor, now);
    const row = this.database.prepare('SELECT * FROM v2_training_requests WHERE request_id=?').get(requestId);
    if (!row) return null;
    if (row.account_id !== actor.id) throw new ApplicationError('FORBIDDEN');
    return receipt(row);
  }

  /** Internal dispatcher read. Execution arguments never appear in public receipts. */
  submission(actor, jobId, now) {
    return readTransaction(this.database, () => {
      this.#authorize(actor, now);
      const row = this.database.prepare('SELECT * FROM v2_training_requests WHERE job_id=?').get(jobId);
      if (!row || row.account_id !== actor.id) throw new ApplicationError('FORBIDDEN');
      try {return parseTrainingSubmission({...JSON.parse(row.payload_json), requestId: row.request_id});}
      catch (cause) {throw new ApplicationError('TRAINING_REQUEST_SCHEMA_MISMATCH', {cause});}
    });
  }
}
