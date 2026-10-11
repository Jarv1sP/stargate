import {TransientReadError} from '../domain/errors.mjs';

/** One candidate observation owns this budget; never share it across requests. */
export class TrainingReadBudget {
  constructor({clock = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), check = async () => {}} = {}) {
    this.clock = clock; this.sleep = sleep; this.check = check; this.remainingMs = 12000;
  }

  /** Only source inspection can be repeated; there is no arbitrary RPC callback. */
  async inspect(sources, request, {actor, check}) {
    for (let attempt = 0; ; attempt++) {
      await this.check(); await check();
      const started = this.clock();
      let result, failure;
      try {
        result = await sources.inspect(request, {actor, ...(attempt ? {timeoutMs: Math.max(1, Math.ceil(this.remainingMs))} : {})});
      } catch (error) {failure = error;}
      finally {await this.check(); await check();}
      // Normal successful reads don't spend the shared extra-wait budget.
      if (attempt || failure) this.remainingMs = Math.max(0, this.remainingMs - Math.max(0, this.clock() - started));
      if (!failure) return result;
      const wait = 250 * 2 ** attempt;
      if (!(failure instanceof TransientReadError) || attempt >= 2 || this.remainingMs <= wait) throw failure;
      const waiting = this.clock();
      await this.sleep(wait);
      this.remainingMs = Math.max(0, this.remainingMs - Math.max(wait, this.clock() - waiting));
      if (this.remainingMs === 0) {
        await this.check(); await check();
        throw failure;
      }
    }
  }
}
