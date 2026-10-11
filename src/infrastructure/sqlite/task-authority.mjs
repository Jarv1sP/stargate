import {readTransaction} from './transaction.mjs';
import {parseTrainingSubmission} from '../../contracts/training-submission.mjs';
import {parseDataReadRequest} from '../../contracts/data-read.mjs';
import {permissionResourceFor} from '../../domain/data-source.mjs';
import {requireDataSourcePermission} from '../../domain/read-access.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

/** Internal worker identity only. Never authenticates an HTTP request or creates a session. */
export class SqliteTaskAuthority {
  constructor({database}) {this.database = database;}

  /** Caller owns a read/write transaction for a consistent authorization snapshot. */
  contextWithinTransaction(jobId) {
    const row = this.database.prepare(`SELECT j.account_id,j.request_id,j.payload_json,a.enabled,a.role
      FROM v2_training_requests j JOIN v2_training_queue q ON q.job_id=j.job_id
      JOIN v2_accounts a ON a.id=j.account_id WHERE j.job_id=?
      AND NOT EXISTS(SELECT 1 FROM v2_training_cancellations c WHERE c.job_id=j.job_id)`).get(jobId);
    if (!row || row.enabled !== 1) throw new ApplicationError('TASK_NOT_AUTHORIZED');
    let submission;
    try {submission = parseTrainingSubmission({...JSON.parse(row.payload_json), requestId: row.request_id});}
    catch (cause) {throw new ApplicationError('TRAINING_REQUEST_SCHEMA_MISMATCH', {cause});}
    return {jobId, accountId: row.account_id, accountRole: row.role, submission};
  }

  context(jobId) {return readTransaction(this.database, () => this.contextWithinTransaction(jobId));}

  requireDataRead(jobId, request) {
    const input = parseDataReadRequest(request);
    return readTransaction(this.database, () => this.requireDataReadWithinTransaction(this.contextWithinTransaction(jobId), input));
  }

  /** The caller holds one authorization snapshot; input is already parsed. */
  requireDataReadWithinTransaction(context, input) {
    const {submission, accountId, accountRole} = context;
    if (submission.machines.kind === 'selected' && !submission.machines.ids.includes(input.machineId)) {
      throw new ApplicationError('TASK_SCOPE_MISMATCH');
    }
    if (!submission.dataSources.some(source => JSON.stringify(source) === JSON.stringify(input.source))) {
      throw new ApplicationError('TASK_SCOPE_MISMATCH');
    }
    const resource = permissionResourceFor(input);
    const row = this.database.prepare(`SELECT m.enabled,r.id resource_id,r.visibility,r.owner_id,
      EXISTS(SELECT 1 FROM v2_machine_grants g WHERE g.account_id=? AND g.machine_id=m.id) machine_granted,
      EXISTS(SELECT 1 FROM v2_data_readers d WHERE d.account_id=? AND d.resource_id=r.id) reader_granted
      FROM v2_machines m LEFT JOIN v2_data_resources r
        ON r.kind=? AND r.machine_id IS ? AND r.source_id=? AND r.version IS ? WHERE m.id=?`)
      .get(accountId, accountId, resource.kind, resource.machineId, resource.sourceId, resource.version, input.machineId);
    requireDataSourcePermission(accountId, accountRole, {machineEnabled: row?.enabled === 1, machineGranted: row?.machine_granted === 1,
      source: row?.resource_id ? {visibility: row.visibility, ownerId: row.owner_id, readerGranted: row.reader_granted === 1} : null});
  }
}
