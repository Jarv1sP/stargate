import {ApplicationError} from '../domain/errors.mjs';

const taskFailures = new Set([
  'TASK_NOT_AUTHORIZED', 'FORBIDDEN', 'PROJECT_ARCHIVED', 'PROJECT_RELEASE_NOT_FOUND',
  'INVALID_SCHEDULING_REQUEST', 'TRAINING_REQUEST_SCHEMA_MISMATCH', 'TRAINING_CONTEXT_CHANGED',
]);

/** One bounded queue page. No timer, retry loop, node send or permanent failure marking. */
export class AdvanceTrainingQueue {
  constructor({queue, prepare}) {this.queue = queue; this.prepare = prepare;}

  async execute({limit = 100, after = null, signal} = {}) {
    const outcomes = [];
    if (signal?.aborted) return {outcomes, nextCursor: null};
    const page = await this.queue.pending({limit, after});
    for (const row of page) {
      // Finish an already started admission, but start no next task on shutdown.
      if (signal?.aborted) return {outcomes, nextCursor: null};
      try {outcomes.push({jobId: row.jobId, ...await this.prepare.execute(row.jobId)});}
      catch (error) {
        if (!(error instanceof ApplicationError) || !taskFailures.has(error.code)) throw error;
        outcomes.push({jobId: row.jobId, kind: 'unavailable', reason: error.code});
      }
    }
    const last = page.at(-1);
    return {outcomes, nextCursor: page.length === limit ? {priority: last.priority, sequence: last.sequence} : null};
  }
}
