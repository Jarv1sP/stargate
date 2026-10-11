import {randomUUID} from 'node:crypto';
import {transaction, readTransaction} from './transaction.mjs';
import {SqliteComputeClaims} from './compute-claims.mjs';
import {SqliteSessionReader} from './session-reader.mjs';
import {requireActiveSession} from '../../domain/session-policy.mjs';
import {ApplicationError} from '../../domain/errors.mjs';
import {SqliteTaskAuthority} from './task-authority.mjs';
import {requireTaskPlacement} from '../../domain/task-placement.mjs';

export function createTrainingDispatchSchema(database) {
  transaction(database, () => database.exec(`CREATE TABLE v2_training_dispatches (
    dispatch_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES v2_compute_claims(job_id),
    state TEXT NOT NULL CHECK(state IN ('PREPARED','SENDING','UNKNOWN','ACCEPTED')), created_at_ms INTEGER NOT NULL,
    sender_token TEXT, send_started_at_ms INTEGER, node_job_id TEXT,
    CHECK((state='PREPARED' AND sender_token IS NULL AND send_started_at_ms IS NULL AND node_job_id IS NULL)
      OR (state IN ('SENDING','UNKNOWN') AND sender_token IS NOT NULL AND send_started_at_ms IS NOT NULL AND node_job_id IS NULL)
      OR (state='ACCEPTED' AND sender_token IS NOT NULL AND send_started_at_ms IS NOT NULL AND node_job_id IS NOT NULL))
  )`));
}

const receipt = row => ({dispatchId: row.dispatch_id, jobId: row.job_id, machineId: row.machine_id,
  gpuCount: row.gpu_count, state: row.state, createdAtMs: row.created_at_ms,
  sendStartedAtMs: row.send_started_at_ms, nodeJobId: row.node_job_id});

function requireNodeJobId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new ApplicationError('INVALID_DISPATCH_OUTCOME');
}

/** Durable dispatch intent only: no network, GPU lease, worker or user code. */
export class SqliteTrainingDispatches {
  constructor({database}) {
    this.database = database;
    this.sessions = new SqliteSessionReader({database});
    this.claims = new SqliteComputeClaims({database});
  }

  #authorize(actor, jobId, now) {
    requireActiveSession(this.sessions.findByActor(actor), now);
    const job = this.database.prepare('SELECT account_id FROM v2_training_requests WHERE job_id=?').get(jobId);
    if (!job || job.account_id !== actor.id) throw new ApplicationError('FORBIDDEN');
  }

  #find(jobId) {
    return this.database.prepare(`SELECT d.*,c.machine_id,c.gpu_count FROM v2_training_dispatches d
      JOIN v2_compute_claims c ON c.job_id=d.job_id WHERE d.job_id=?`).get(jobId);
  }

  prepare(actor, command, now) {
    return transaction(this.database, () => {
      this.#authorize(actor, command.jobId, now);
      return this.#prepare(command, now, () => this.claims.claimWithinTransaction(actor, command, now, {requireCurrentAccess: true}));
    });
  }

  prepareForTask(jobId, selection, now) {
    return transaction(this.database, () => {
      const context = new SqliteTaskAuthority({database: this.database}).contextWithinTransaction(jobId);
      requireTaskPlacement(context.submission, selection);
      const command = {jobId, machineId: selection.machineId, gpuCount: selection.gpuCount};
      return this.#prepare(command, now, () => this.claims.claimTaskWithinTransaction(jobId, selection, now));
    });
  }

  #prepare(command, now, reserve) {
      const existing = this.#find(command.jobId);
      if (existing) {
        if (existing.machine_id !== command.machineId || existing.gpu_count !== command.gpuCount) {
          throw new ApplicationError('TRAINING_DISPATCH_CONFLICT');
        }
        return receipt(existing);
      }
      const claim = reserve();
      if (claim.state !== 'HELD') throw new ApplicationError('COMPUTE_CLAIM_NOT_HELD');
      this.database.prepare("INSERT INTO v2_training_dispatches(dispatch_id,job_id,state,created_at_ms) VALUES(?,?,'PREPARED',?)")
        .run(randomUUID(), command.jobId, now);
      return receipt(this.#find(command.jobId));
  }

  getForTask(jobId) {
    return readTransaction(this.database, () => {
      new SqliteTaskAuthority({database: this.database}).contextWithinTransaction(jobId);
      const row = this.#find(jobId);
      return row ? receipt(row) : null;
    });
  }

  /** A durable single send permit; repeat callers may only inspect the original attempt. */
  beginSend(jobId, now) {
    return transaction(this.database, () => {
      new SqliteTaskAuthority({database: this.database}).contextWithinTransaction(jobId);
      const row = this.#find(jobId);
      if (!row) throw new ApplicationError('TRAINING_DISPATCH_NOT_PREPARED');
      if (row.state !== 'PREPARED') return {acquired: false, dispatch: receipt(row)};
      const claim = this.claims.claimTaskWithinTransaction(jobId, {machineId: row.machine_id, gpuCount: row.gpu_count}, now);
      if (claim.state !== 'HELD') throw new ApplicationError('COMPUTE_CLAIM_NOT_HELD');
      const senderToken = randomUUID();
      this.database.prepare("UPDATE v2_training_dispatches SET state='SENDING',sender_token=?,send_started_at_ms=? WHERE dispatch_id=?")
        .run(senderToken, now, row.dispatch_id);
      return {acquired: true, senderToken, dispatch: receipt(this.#find(jobId))};
    });
  }

  /** Internal evidence write, permitted after account revocation; never authorizes another send. */
  recordSendOutcome({dispatchId, senderToken, nodeJobId}) {
    if (nodeJobId !== null) requireNodeJobId(nodeJobId);
    return transaction(this.database, () => {
      const row = this.database.prepare(`SELECT d.*,c.machine_id,c.gpu_count FROM v2_training_dispatches d
        JOIN v2_compute_claims c ON c.job_id=d.job_id WHERE d.dispatch_id=?`).get(dispatchId);
      if (!row || !row.sender_token || row.sender_token !== senderToken) throw new ApplicationError('DISPATCH_SEND_CONFLICT');
      return this.#recordOutcome(row, nodeJobId);
    });
  }

  #recordOutcome(row, nodeJobId) {
      if (row.state === 'ACCEPTED') {
        if (nodeJobId !== null && nodeJobId !== row.node_job_id) throw new ApplicationError('DISPATCH_OUTCOME_CONFLICT');
        return receipt(row);
      }
      this.database.prepare('UPDATE v2_training_dispatches SET state=?,node_job_id=? WHERE dispatch_id=?')
        .run(nodeJobId === null ? 'UNKNOWN' : 'ACCEPTED', nodeJobId, row.dispatch_id);
      return receipt(this.#find(row.job_id));
  }

  #delivery(dispatchId) {
    return this.database.prepare(`SELECT d.*,c.machine_id,c.gpu_count,j.payload_hash,j.account_id
      FROM v2_training_dispatches d JOIN v2_compute_claims c ON c.job_id=d.job_id
      JOIN v2_training_requests j ON j.job_id=d.job_id WHERE d.dispatch_id=?`).get(dispatchId);
  }

  /** Internal recovery read; no login requirement and no command/env/sender-token exposure. */
  delivery(dispatchId) {
    return readTransaction(this.database, () => {
      const row = this.#delivery(dispatchId);
      return row ? {...receipt(row), accountId: row.account_id, requestHash: row.payload_hash} : null;
    });
  }

  /** Quota authorization only; project/data leases and runtime admission are still separate. */
  authorizeInitialAllocation(binding) {
    return readTransaction(this.database, () => {
      const row = this.#delivery(binding.dispatchId);
      if (!row || row.state !== 'SENDING' || row.job_id !== binding.jobId || row.account_id !== binding.accountId
        || row.machine_id !== binding.machineId || row.gpu_count !== binding.gpuCount || row.payload_hash !== binding.requestHash) {
        throw new ApplicationError('NODE_LAUNCH_NOT_AUTHORIZED');
      }
      this.claims.requireHeldTaskClaimWithinTransaction(row.job_id, {machineId: row.machine_id, gpuCount: row.gpu_count});
      return {scope: 'initial-quota', dispatchId: row.dispatch_id, jobId: row.job_id, accountId: row.account_id,
        machineId: row.machine_id, gpuCount: row.gpu_count, requestHash: row.payload_hash, grantId: row.dispatch_id};
    });
  }

  /** Trusted node-query evidence, not a user-supplied status or permission to send. */
  confirmAcceptance(observed) {
    requireNodeJobId(observed?.nodeJobId);
    return transaction(this.database, () => {
      const row = this.#delivery(observed.dispatchId);
      if (!row || row.job_id !== observed.jobId || row.machine_id !== observed.machineId
        || row.gpu_count !== observed.gpuCount || row.account_id !== observed.accountId
        || row.payload_hash !== observed.requestHash) throw new ApplicationError('DISPATCH_OBSERVATION_MISMATCH');
      if (row.state === 'PREPARED') throw new ApplicationError('DISPATCH_NOT_SENT');
      return this.#recordOutcome(row, observed.nodeJobId);
    });
  }

  get(actor, jobId, now) {
    return readTransaction(this.database, () => {
      this.#authorize(actor, jobId, now);
      const row = this.#find(jobId);
      return row ? receipt(row) : null;
    });
  }
}
