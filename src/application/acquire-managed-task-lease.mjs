import {ApplicationError} from '../domain/errors.mjs';

/** Single managed source only. Raw-directory mounts have a separate runtime path. */
export class AcquireManagedTaskLease {
  constructor({authority, leaser}) {this.authority = authority; this.leaser = leaser;}
  async execute(jobId, request) {
    const reference = {machineId: request.machineId, source: {...request.source}};
    if (!['cache', 'warehouse'].includes(reference.source.kind)) throw new ApplicationError('INVALID_MANAGED_SOURCE');
    const context = await this.authority.context(jobId);
    await this.authority.requireDataRead(jobId, reference);
    let lease;
    try {lease = await this.leaser.acquire({...reference, jobId}, {actor: {id: context.accountId}});}
    finally {await this.authority.requireDataRead(jobId, reference);}
    if (!lease || lease.jobId !== jobId || lease.accountId !== context.accountId || lease.machineId !== reference.machineId
      || lease.source?.kind !== reference.source.kind || lease.source?.datasetId !== reference.source.datasetId
      || lease.source?.version !== reference.source.version || lease.readOnly !== true
      || typeof lease.leaseId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(lease.leaseId)) {
      throw new ApplicationError('DATA_LEASE_IDENTITY_MISMATCH');
    }
    return {...reference, jobId, accountId: context.accountId, leaseId: lease.leaseId, readOnly: true};
  }
}
