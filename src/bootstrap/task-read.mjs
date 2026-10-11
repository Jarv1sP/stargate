import {ReadTrainingTask, ObserveNodeJob} from '../application/read-training-task.mjs';
import {TaskReadLane} from '../application/task-read-lane.mjs';
import {AuthenticateSession} from '../application/authenticate-session.mjs';
import {SqliteTaskReads} from '../infrastructure/sqlite/task-reads.mjs';
import {SqliteSessionReader} from '../infrastructure/sqlite/session-reader.mjs';
import {SqliteNodeDispatchBindings} from '../infrastructure/sqlite/node-dispatch-bindings.mjs';
import {GpuqJobObserver} from '../infrastructure/gpuq-job-observer.mjs';
import {createSessionAuthenticator} from '../api/session-authenticator.mjs';
import {createTaskReadHandler, createNodeTaskReadHandler} from '../api/task-read-handlers.mjs';

/** Caller owns the shared database and service lifecycle. Queries install no schema. */
export function assembleSqliteTaskRead({database, nodes, publicOrigin, clock = Date.now, reportError, readBounds = {}}) {
  const authenticateSession = new AuthenticateSession({sessions: new SqliteSessionReader({database}), clock});
  return createTaskReadHandler({authenticate: createSessionAuthenticator({authenticateSession, publicOrigin}), reportError,
    readTask: new ReadTrainingTask({tasks: new SqliteTaskReads({database}), nodes: new TaskReadLane({...readBounds, nodes}), clock})});
}

export function assembleNodeTaskRead({database, machineId, credential, socketPath, python, timeoutMs, reportError, readBounds = {}}) {
  return createNodeTaskReadHandler({machineId, credential, reportError, observeJob: new ObserveNodeJob({
    bindings: new SqliteNodeDispatchBindings({database, machineId}),
    native: new TaskReadLane({...readBounds, nodes: new GpuqJobObserver({socketPath, python, timeoutMs}), maxAttempts: 1})})});
}
