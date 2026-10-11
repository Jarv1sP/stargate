import {TrainingDispatchWorker} from '../application/training-dispatch-worker.mjs';
import {ReconcileTrainingDispatch} from '../application/reconcile-training-dispatch.mjs';
import {SqliteTrainingDispatches} from '../infrastructure/sqlite/training-dispatches.mjs';
import {SqliteDispatchWork} from '../infrastructure/sqlite/dispatch-work.mjs';
import {HttpDispatchReceipts} from '../infrastructure/http-dispatch-receipts.mjs';
import {assembleTaskPreparation} from './node-preparation.mjs';
import {assembleTrainingSender} from './training-send.mjs';

/** Caller owns the database, schema and single coordinator service lifetime. */
export function assembleTrainingDispatchWorker({database, nodes, concurrency, pageSize, clock, ...transport}) {
  const dispatches = new SqliteTrainingDispatches({database});
  return new TrainingDispatchWorker({dispatches, work: new SqliteDispatchWork({database}), concurrency, pageSize,
    prepare: assembleTaskPreparation({database, nodes, ...transport}),
    send: assembleTrainingSender({database, nodes, clock, ...transport}),
    reconcile: new ReconcileTrainingDispatch({dispatches, nodes: new HttpDispatchReceipts({nodes, ...transport})})});
}

/** Explicit start/stop only. Call stop before closing the shared database. */
export function startTrainingDispatchWorker({worker, onOutcome, reportError, intervalMs = 1000}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) {
    throw new TypeError('Invalid dispatch worker interval');
  }
  let stopped = false, polling = null;
  const report = outcomes => {for (const outcome of outcomes) onOutcome(outcome);};
  const poll = () => {
    if (stopped || polling) return;
    polling = worker.poll().then(result => report(result.outcomes)).catch(reportError).finally(() => {polling = null;});
  };
  const timer = setInterval(poll, intervalMs);
  poll();
  return {async stop() {
    stopped = true;
    clearInterval(timer);
    const outcomes = await worker.close();
    await polling;
    report(outcomes);
  }};
}
