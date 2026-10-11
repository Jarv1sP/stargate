import {HttpProjectReader} from '../infrastructure/http-project-reader.mjs';
import {HttpSourceReader} from '../infrastructure/http-source-reader.mjs';
import {HttpGpuPoolReader} from '../infrastructure/http-gpu-pool-reader.mjs';
import {assembleTrainingQueue} from './training-queue.mjs';
import {assembleTrainingDispatchWorker, startTrainingDispatchWorker} from './training-dispatch-worker.mjs';

/** Assemble the existing admission and dispatch use cases; no service starts here. */
export function assembleTrainingCoordinator({database, nodes, python, clock, concurrency, pageSize, ...transport}) {
  const remote = {nodes, ...transport};
  return {
    queue: assembleTrainingQueue({database, python, clock,
      projects: new HttpProjectReader(remote), sources: new HttpSourceReader(remote), pools: new HttpGpuPoolReader(remote)}),
    worker: assembleTrainingDispatchWorker({database, clock, concurrency, pageSize, ...remote}),
  };
}

/** Admission never overlaps itself; dispatch discovery runs independently.
 * The caller owns schema/HTTP/database lifetime and provides private reporting.
 */
export function startTrainingCoordinator({queue, worker, onOutcome, reportError, intervalMs = 1000, queuePageSize = 100}) {
  if (!Number.isSafeInteger(queuePageSize) || queuePageSize < 1 || queuePageSize > 1000) {
    throw new TypeError('Invalid admission page size');
  }
  const stopping = new AbortController();
  let admission = null, cursor = null, stopped = null;
  const dispatch = startTrainingDispatchWorker({worker, intervalMs,
    onOutcome: result => onOutcome({phase: 'dispatch', ...result}),
    reportError: error => reportError(error, {phase: 'dispatch'})});
  const poll = () => {
    if (stopping.signal.aborted || admission) return;
    admission = queue.execute({limit: queuePageSize, after: cursor, signal: stopping.signal}).then(result => {
      cursor = result.nextCursor;
      for (const outcome of result.outcomes) onOutcome({phase: 'admission', ...outcome});
    }).catch(error => reportError(error, {phase: 'admission'})).finally(() => {admission = null;});
  };
  const timer = setInterval(poll, intervalMs);
  poll();
  return {stop() {
    if (!stopped) {
      stopping.abort();
      clearInterval(timer);
      // Both loops must finish before the caller can close their shared DB,
      // even if reporting or one loop's final discovery failed.
      stopped = Promise.allSettled([admission, dispatch.stop()]).then(results => {
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      });
    }
    return stopped;
  }};
}
