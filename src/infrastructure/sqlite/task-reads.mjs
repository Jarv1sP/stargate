import {sessionColumns, sessionFrom} from './session-reader.mjs';
import {requireTaskRead} from '../../domain/task-read.mjs';

/** One read statement; never reconciles dispatches, updates jobs or reserves quota. */
export class SqliteTaskReads {
  constructor({database}) {this.database = database;}
  snapshot(actor, jobId, now) {
    const row = this.database.prepare(`SELECT ${sessionColumns},j.job_id,j.account_id task_account_id,j.payload_hash,
      j.task_name,j.description,j.submitter_username,j.submitter_name,j.created_at_ms,
      q.sequence,c.canceled_at_ms,d.dispatch_id,d.state dispatch_state,d.node_job_id,claim.machine_id,claim.gpu_count,
      claim.reserved_gpu_count,claim.state quota_state,
      m.enabled machine_enabled,
      EXISTS(SELECT 1 FROM v2_machine_grants g WHERE g.account_id=a.id AND g.machine_id=claim.machine_id) machine_granted
      FROM v2_sessions s JOIN v2_accounts a ON a.id=s.account_id
      LEFT JOIN v2_training_requests j ON j.job_id=?
      LEFT JOIN v2_training_queue q ON q.job_id=j.job_id
      LEFT JOIN v2_training_cancellations c ON c.job_id=j.job_id
      LEFT JOIN v2_training_dispatches d ON d.job_id=j.job_id
      LEFT JOIN v2_compute_claims claim ON claim.job_id=j.job_id
      LEFT JOIN v2_machines m ON m.id=claim.machine_id
      WHERE s.id=? AND a.id=?`).get(jobId, actor.sessionId, actor.id);
    const machineId = row?.dispatch_id ? row.machine_id : null;
    requireTaskRead(actor, {session: sessionFrom(row), accountId: row?.task_account_id, machineId,
      machineEnabled: row?.machine_enabled === 1, machineGranted: row?.machine_granted === 1}, now);
    const dispatch = row.dispatch_id === null ? null : {dispatchId: row.dispatch_id, machineId: row.machine_id,
      gpuCount: row.gpu_count, state: row.dispatch_state, nodeJobId: row.node_job_id};
    return {task: {jobId, name: row.task_name, description: row.description,
      submitter: {accountId: row.task_account_id, username: row.submitter_username, displayName: row.submitter_name},
      createdAtMs: row.created_at_ms, stage: dispatch?.state ?? (row.canceled_at_ms !== null ? 'CANCELED' : row.sequence === null ? 'RECORDED' : 'QUEUED'), dispatch},
      binding: {jobId, accountId: row.task_account_id, requestHash: row.payload_hash, dispatchId: row.dispatch_id,
        machineId, gpuCount: row.dispatch_id === null ? null : row.gpu_count, nodeJobId: row.node_job_id},
      quota: row.quota_state === null ? null : {machineId: row.machine_id, state: row.quota_state,
        initialGpuCount: row.gpu_count, reservedGpuCount: row.reserved_gpu_count}};
  }
}
