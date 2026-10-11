/** One coordinator instance owns these lanes. Durable dispatches own recovery.
 * Discovery never waits for remote work. Each node has one preparation/send
 * lane, one receipt-query lane and one completion lane, within a shared bound.
 */
export class TrainingDispatchWorker {
  #waiting = new Map();
  #active = new Map();
  #outcomes = [];
  #cursor = null;
  #polling = null;
  #closing = false;

  constructor({work, dispatches, prepare, send, reconcile, finalize, concurrency = 8, pageSize = 100}) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      throw new TypeError('Invalid dispatch worker limits');
    }
    this.work = work; this.dispatches = dispatches;
    this.prepare = prepare; this.send = send; this.reconcile = reconcile; this.finalize = finalize;
    this.concurrency = concurrency; this.pageSize = pageSize;
  }

  poll() {
    if (!this.#polling) this.#polling = this.#scan().finally(() => {this.#polling = null;});
    return this.#polling;
  }

  async #scan() {
    if (!this.#closing) {
      const page = await this.work.pending({limit: this.pageSize, after: this.#cursor});
      if (!this.#closing) {
        const last = page.at(-1);
        this.#cursor = page.length === this.pageSize ? {priority: last.priority, sequence: last.sequence} : null;
        for (const row of page) {
          if (!this.#active.has(row.dispatchId)) this.#waiting.set(row.dispatchId, row);
        }
        this.#pump();
      }
    }
    return {outcomes: this.#outcomes.splice(0), active: this.#active.size, waiting: this.#waiting.size};
  }

  #pump() {
    if (this.#closing) return;
    const ordered = [...this.#waiting].sort(([, a], [, b]) => b.priority - a.priority || a.sequence - b.sequence);
    for (const [dispatchId, row] of ordered) {
      if (this.#active.size >= this.concurrency) break;
      const lane = row.state === 'PREPARED' ? 'send' : row.state === 'ACCEPTED' ? 'finish' : 'recover';
      if ([...this.#active.values()].some(entry => entry.machineId === row.machineId && entry.lane === lane)) continue;
      this.#waiting.delete(dispatchId);
      const operation = this.#run(dispatchId).then(
        result => this.#outcomes.push({dispatchId, jobId: row.jobId, ...result}),
        error => this.#outcomes.push({dispatchId, jobId: row.jobId, kind: 'error', error}),
      ).finally(() => {this.#active.delete(dispatchId); this.#pump();});
      this.#active.set(dispatchId, {machineId: row.machineId, lane, operation});
    }
  }

  async #run(dispatchId) {
    const current = await this.dispatches.delivery(dispatchId);
    if (!current) return {kind: 'missing'};
    if (this.#closing) return {kind: 'deferred'};
    if (current.state === 'ACCEPTED') return this.finalize.execute(dispatchId);
    if (current.state !== 'PREPARED') return this.reconcile.execute(dispatchId);
    await this.prepare.execute(current.jobId);
    // Graceful shutdown lets the original preparation finish, but starts no send.
    if (this.#closing) return {kind: 'deferred'};
    return this.send.execute(current.jobId);
  }

  /** Finish already discovered work, without scanning or retrying it again. */
  async idle() {
    try {await this.#polling;}
    finally {
      while (this.#active.size) await Promise.all([...this.#active.values()].map(entry => entry.operation));
    }
    return this.#outcomes.splice(0);
  }

  /** Does not cancel training, abort writes, release holds or alter task state. */
  async close() {
    this.#closing = true;
    this.#waiting.clear();
    return this.idle();
  }
}
