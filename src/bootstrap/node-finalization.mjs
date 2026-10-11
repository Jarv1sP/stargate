import {FinalizeNodeDispatch} from '../application/finalize-node-dispatch.mjs';
import {SqliteNodeDispatchBindings} from '../infrastructure/sqlite/node-dispatch-bindings.mjs';
import {SqliteNodeCompletions} from '../infrastructure/sqlite/node-completions.mjs';
import {ManagedDataLeaser} from '../infrastructure/managed-data-leaser.mjs';
import {GpuqManagedClient} from '../infrastructure/gpuq-managed-client.mjs';
import {createNodeFinalizationHandler} from '../api/node-finalization-handler.mjs';

/** Internal node use case only. Caller owns schema and its service lifetime. */
export function assembleNodeFinalization({database, machineId, socketPath, roots, leaseVersions, python, timeoutMs}) {
  return new FinalizeNodeDispatch({bindings: new SqliteNodeDispatchBindings({database, machineId}),
    completions: new SqliteNodeCompletions({database, machineId}),
    native: new GpuqManagedClient({socketPath, python, timeoutMs}),
    leaser: new ManagedDataLeaser({machineId, roots, leaseVersions, python, timeoutMs})});
}

export function assembleNodeFinalizationHandler(options) {
  return createNodeFinalizationHandler({...options, finalize: assembleNodeFinalization(options),
    completions: new SqliteNodeCompletions(options)});
}
