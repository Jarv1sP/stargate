import {ManagedDataLeaser} from '../infrastructure/managed-data-leaser.mjs';
import {createManagedDataLeaseHandler} from '../api/managed-data-lease-handler.mjs';

/** Node-local configuration only; does not start a server or initialize storage. */
export function assembleManagedDataLease({machineId, credential, roots, leaseVersions, python, timeoutMs, reportError}) {
  return createManagedDataLeaseHandler({machineId, credential, reportError,
    leaser: new ManagedDataLeaser({machineId, roots, leaseVersions, python, timeoutMs}),
  });
}
