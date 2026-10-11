import {transaction, readTransaction} from './transaction.mjs';
import {SqliteSessionReader} from './session-reader.mjs';
import {requireActiveSession} from '../../domain/session-policy.mjs';
import {ApplicationError} from '../../domain/errors.mjs';
import {computeBalance} from '../../domain/compute-balance.mjs';
import {SqliteTaskAuthority} from './task-authority.mjs';
import {requireTaskPlacement} from '../../domain/task-placement.mjs';
import {expansionCompletion} from '../../domain/expansion-confirmation.mjs';

export function createComputeClaimsSchema(database) {
  transaction(database, () => database.exec(`
    CREATE TABLE v2_compute_accounting (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), ready INTEGER NOT NULL CHECK(ready IN (0,1))
    );
    INSERT INTO v2_compute_accounting VALUES(1,0);
    CREATE TABLE v2_compute_claims (
      job_id TEXT PRIMARY KEY REFERENCES v2_training_requests(job_id),
      machine_id TEXT NOT NULL REFERENCES v2_machines(id),
      gpu_count INTEGER NOT NULL CHECK(gpu_count BETWEEN 1 AND 4096),
      reserved_gpu_count INTEGER NOT NULL CHECK(reserved_gpu_count BETWEEN 1 AND 4096),
      state TEXT NOT NULL CHECK(state IN ('HELD','RELEASED')), created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE v2_compute_expansions (
      change_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES v2_compute_claims(job_id),
      from_reserved_gpu_count INTEGER NOT NULL CHECK(from_reserved_gpu_count>=1),
      source_gpu_count INTEGER NOT NULL CHECK(source_gpu_count>=1 AND source_gpu_count<=from_reserved_gpu_count),
      target_gpu_count INTEGER NOT NULL CHECK(target_gpu_count>from_reserved_gpu_count AND target_gpu_count<=4096),
      state TEXT NOT NULL CHECK(state IN ('RESERVED','APPLIED','RELEASED')), created_at_ms INTEGER NOT NULL,
      resolution_json TEXT
    );
    CREATE UNIQUE INDEX v2_compute_expansion_pending ON v2_compute_expansions(job_id) WHERE state='RESERVED';
  `));
}

const receipt = row => ({jobId: row.job_id, machineId: row.machine_id, gpuCount: row.gpu_count,
  reservedGpuCount: row.reserved_gpu_count, state: row.state, createdAtMs: row.created_at_ms});
const expansionReceipt = row => ({changeId: row.change_id, jobId: row.job_id, fromReservedGpuCount: row.from_reserved_gpu_count,
  sourceGpuCount: row.source_gpu_count, targetGpuCount: row.target_gpu_count, state: row.state, createdAtMs: row.created_at_ms});

/** Internal quota ledger, not a GPU lease. Accounting starts unready until cutover/import. */
export class SqliteComputeClaims {
  constructor({database}) {this.database = database; this.sessions = new SqliteSessionReader({database});}

  #authorize(actor, now) {
    const session = this.sessions.findByActor(actor);
    requireActiveSession(session, now);
    return session;
  }

  #balance(actor, machineId, accountRole) {
    const db = this.database;
    const machine = db.prepare(`SELECT m.enabled,m.cards,g.max_cards,g.account_id granted
      FROM v2_machines m LEFT JOIN v2_machine_grants g ON g.machine_id=m.id AND g.account_id=? WHERE m.id=?`).get(actor.id, machineId);
    const accountingReady = db.prepare('SELECT ready FROM v2_compute_accounting WHERE singleton=1').get()?.ready === 1;
    const totalLimit = db.prepare('SELECT total_cards FROM v2_compute_policies WHERE account_id=?').get(actor.id)?.total_cards ?? null;
    const used = db.prepare(`SELECT COALESCE(SUM(c.reserved_gpu_count),0) total,
      COALESCE(SUM(CASE WHEN c.machine_id=? THEN c.reserved_gpu_count ELSE 0 END),0) on_machine
      FROM v2_compute_claims c JOIN v2_training_requests j ON j.job_id=c.job_id
      WHERE j.account_id=? AND c.state='HELD'`).get(machineId, actor.id);
    return computeBalance({machineId, admin: accountRole === 'admin', accountingReady, totalLimit,
      heldOnMachine: used.on_machine, heldTotal: used.total,
      machine: machine ? {enabled: machine.enabled === 1, cards: machine.cards, maxCards: machine.max_cards, granted: machine.granted !== null} : null});
  }

  balance(actor, machineId, now) {
    return this.balances(actor, [machineId], now)[0];
  }

  balances(actor, machineIds, now) {
    return readTransaction(this.database, () => {
      const session = this.#authorize(actor, now);
      return machineIds.map(machineId => this.#balance(actor, machineId, session.accountRole));
    });
  }

  /** Task-scoped balance observation, with no fabricated session or quota mutation. */
  balancesForTask(jobId, machineIds) {
    return readTransaction(this.database, () => {
      const context = new SqliteTaskAuthority({database: this.database}).contextWithinTransaction(jobId);
      if (context.submission.machines.kind === 'selected'
        && machineIds.some(id => !context.submission.machines.ids.includes(id))) throw new ApplicationError('TASK_SCOPE_MISMATCH');
      return machineIds.map(machineId => this.#balance({id: context.accountId}, machineId, context.accountRole));
    });
  }

  claim(actor, command, now) {
    return transaction(this.database, () => this.claimWithinTransaction(actor, command, now));
  }

  /** Caller owns BEGIN IMMEDIATE; new dispatch preparation also rechecks existing holds. */
  claimWithinTransaction(actor, command, now, {requireCurrentAccess = false} = {}) {
    const session = this.#authorize(actor, now);
    return this.#claim(actor, session.accountRole, command, now, requireCurrentAccess);
  }

  claimTaskWithinTransaction(jobId, selection, now) {
    const context = new SqliteTaskAuthority({database: this.database}).contextWithinTransaction(jobId);
    requireTaskPlacement(context.submission, selection);
    return this.#claim({id: context.accountId}, context.accountRole,
      {jobId, machineId: selection.machineId, gpuCount: selection.gpuCount}, now, true);
  }

  #claim(actor, accountRole, {jobId, machineId, gpuCount}, now, requireCurrentAccess) {
    const db = this.database;
    if (!Number.isSafeInteger(gpuCount) || gpuCount < 1 || gpuCount > 4096) throw new ApplicationError('INVALID_COMPUTE_CLAIM');
    const job = db.prepare('SELECT account_id FROM v2_training_requests WHERE job_id=?').get(jobId);
    if (!job || job.account_id !== actor.id) throw new ApplicationError('FORBIDDEN');
    if (db.prepare('SELECT 1 FROM v2_training_cancellations WHERE job_id=?').get(jobId)) throw new ApplicationError('TRAINING_CANCELED');
    const existing = db.prepare('SELECT * FROM v2_compute_claims WHERE job_id=?').get(jobId);
    if (existing) {
      if (existing.machine_id !== machineId || existing.gpu_count !== gpuCount) throw new ApplicationError('COMPUTE_CLAIM_CONFLICT');
      if (requireCurrentAccess) {
        const balance = this.#balance(actor, machineId, accountRole);
        if (balance.heldOnMachine > balance.machineLimit || (balance.totalLimit !== null && balance.heldTotal > balance.totalLimit)) {
          throw new ApplicationError('COMPUTE_QUOTA_EXCEEDED');
        }
      }
      return receipt(existing);
    }
    const balance = this.#balance(actor, machineId, accountRole);
    if (gpuCount > balance.remainingGpus) throw new ApplicationError('COMPUTE_QUOTA_EXCEEDED');
    db.prepare("INSERT INTO v2_compute_claims VALUES(?,?,?,?,'HELD',?)").run(jobId, machineId, gpuCount, gpuCount, now);
    return receipt(db.prepare('SELECT * FROM v2_compute_claims WHERE job_id=?').get(jobId));
  }

  get(actor, jobId, now) {
    return readTransaction(this.database, () => {
      this.#authorize(actor, now);
      const job = this.database.prepare('SELECT account_id FROM v2_training_requests WHERE job_id=?').get(jobId);
      if (!job || job.account_id !== actor.id) throw new ApplicationError('FORBIDDEN');
      const row = this.database.prepare('SELECT * FROM v2_compute_claims WHERE job_id=?').get(jobId);
      return row ? receipt(row) : null;
    });
  }

  /** Reserve extra quota before a native scale plan; never release on timeout. */
  reserveExpansionForTask(jobId, {changeId, fromReservedGpuCount, sourceGpuCount, targetGpuCount}, now) {
    return transaction(this.database, () => {
      const db = this.database, context = new SqliteTaskAuthority({database: db}).contextWithinTransaction(jobId);
      if (typeof changeId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(changeId)
        || !Number.isSafeInteger(fromReservedGpuCount) || !Number.isSafeInteger(targetGpuCount) || targetGpuCount <= fromReservedGpuCount
        || !Number.isSafeInteger(sourceGpuCount) || sourceGpuCount < 1 || sourceGpuCount > fromReservedGpuCount
        || !context.submission.resources.elastic || !context.submission.resources.autoScaleUp) throw new ApplicationError('INVALID_COMPUTE_EXPANSION');
      const claim = db.prepare('SELECT * FROM v2_compute_claims WHERE job_id=?').get(jobId);
      if (!claim || claim.state !== 'HELD') throw new ApplicationError('COMPUTE_CLAIM_NOT_HELD');
      requireTaskPlacement(context.submission, {machineId: claim.machine_id, gpuCount: fromReservedGpuCount});
      requireTaskPlacement(context.submission, {machineId: claim.machine_id, gpuCount: sourceGpuCount});
      requireTaskPlacement(context.submission, {machineId: claim.machine_id, gpuCount: targetGpuCount});
      const existing = db.prepare('SELECT * FROM v2_compute_expansions WHERE change_id=?').get(changeId);
      if (existing) {
        if (existing.job_id !== jobId || existing.from_reserved_gpu_count !== fromReservedGpuCount || existing.source_gpu_count !== sourceGpuCount || existing.target_gpu_count !== targetGpuCount) {
          throw new ApplicationError('COMPUTE_EXPANSION_CONFLICT');
        }
        return expansionReceipt(existing);
      }
      if (db.prepare('SELECT state FROM v2_training_dispatches WHERE job_id=?').get(jobId)?.state !== 'ACCEPTED') {
        throw new ApplicationError('TRAINING_DISPATCH_NOT_ACCEPTED');
      }
      if (db.prepare("SELECT 1 FROM v2_compute_expansions WHERE job_id=? AND state='RESERVED'").get(jobId)) {
        throw new ApplicationError('COMPUTE_EXPANSION_PENDING');
      }
      if (claim.reserved_gpu_count !== fromReservedGpuCount) throw new ApplicationError('COMPUTE_CLAIM_CHANGED');
      const balance = this.#balance({id: context.accountId}, claim.machine_id, context.accountRole);
      if (targetGpuCount - fromReservedGpuCount > balance.remainingGpus) throw new ApplicationError('COMPUTE_QUOTA_EXCEEDED');
      db.prepare("INSERT INTO v2_compute_expansions(change_id,job_id,from_reserved_gpu_count,source_gpu_count,target_gpu_count,state,created_at_ms) VALUES(?,?,?,?,?,'RESERVED',?)")
        .run(changeId, jobId, fromReservedGpuCount, sourceGpuCount, targetGpuCount, now);
      db.prepare('UPDATE v2_compute_claims SET reserved_gpu_count=? WHERE job_id=?').run(targetGpuCount, jobId);
      return expansionReceipt(db.prepare('SELECT * FROM v2_compute_expansions WHERE change_id=?').get(changeId));
    });
  }

  #expansion(changeId) {
    return this.database.prepare(`SELECT e.*,c.machine_id,c.reserved_gpu_count,c.state claim_state,
      d.dispatch_id,d.node_job_id,d.state dispatch_state,j.account_id,j.payload_hash
      FROM v2_compute_expansions e JOIN v2_compute_claims c ON c.job_id=e.job_id
      JOIN v2_training_dispatches d ON d.job_id=e.job_id JOIN v2_training_requests j ON j.job_id=e.job_id
      WHERE e.change_id=?`).get(changeId);
  }

  #expansionView(row) {
    return {...expansionReceipt(row), machineId: row.machine_id, dispatchId: row.dispatch_id,
      nodeJobId: row.node_job_id, accountId: row.account_id, requestHash: row.payload_hash};
  }

  /** Internal reconciliation read; account revocation must not erase prior outcomes. */
  expansion(changeId) {
    return readTransaction(this.database, () => {
      const row = this.#expansion(changeId);
      return row ? this.#expansionView(row) : null;
    });
  }

  confirmExpansionApplied(observed) {
    return transaction(this.database, () => {
      const row = this.#expansion(observed.changeId);
      if (!row) throw new ApplicationError('COMPUTE_EXPANSION_NOT_FOUND');
      const proof = expansionCompletion(this.#expansionView(row), observed);
      if (row.state === 'APPLIED') {
        if (row.resolution_json !== JSON.stringify(proof)) throw new ApplicationError('COMPUTE_EXPANSION_CONFLICT');
        return this.#expansionView(row);
      }
      if (row.state !== 'RESERVED' || row.claim_state !== 'HELD' || row.reserved_gpu_count !== row.target_gpu_count
        || row.dispatch_state !== 'ACCEPTED') throw new ApplicationError('COMPUTE_CLAIM_CHANGED');
      this.database.prepare("UPDATE v2_compute_expansions SET state='APPLIED',resolution_json=? WHERE change_id=?")
        .run(JSON.stringify(proof), observed.changeId);
      return this.#expansionView(this.#expansion(observed.changeId));
    });
  }
}
